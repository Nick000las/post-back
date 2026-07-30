const prismaAdapter = require('../adapters/prismaAdapter.js');
const AppError = require('../errors/AppError.js');
const { publishQueue } = require('../queues/publishQueue.js');
const kanbanService = require('./kanbanService.js');
const thumbnailService = require('./thumbnailService.js');
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = '.uploads';

class PostService {

    static #removerArquivoLocal (arquivo) {
        if (fs.existsSync(arquivo.path)) {
            fs.unlinkSync(arquivo.path);
        }
    }

    // Confere que o client pertence ao usuário autenticado (agência) antes de liberar qualquer
    // operação nas contas/posts desse client.
    static async #validarCliente (clientId, userId) {
        const cliente = await prismaAdapter.buscarClientePorId(clientId, userId);
        if (!cliente) throw new AppError('Cliente não encontrado');
        return cliente;
    }

    // Gancho de IA (Kanban): todo post criado passa por aqui pra decidir sua column_id. Se
    // columnIdExplicito vier definido (futura rota de IA que já escolhe a coluna), usa ele; senão,
    // cai por padrão na coluna "Ideias" do client. Este é o ÚNICO lugar que decide esse default —
    // gerenciarPostagemEmLote/agendarPostagem/criarDraft chamam este método antes de criar o post.
    static async #resolverColumnId (clientId, columnIdExplicito) {
        if (columnIdExplicito !== undefined && columnIdExplicito !== null) {
            return parseInt(columnIdExplicito);
        }
        return await kanbanService.resolverColunaIdeias(clientId);
    }

    // A tentativa de publicar em si (e o registro de sucesso/falha por conta) migrou pro worker
    // (src/workers/publishWorker.js) — aqui só marcamos o post e enfileiramos.
    // opts.delayMs: usado pelo agendamento (undefined = publica assim que possível).
    // opts.statusInicial: 'PROCESSING' (padrão, publicação imediata) ou 'SCHEDULED' (aguardando o horário agendado).
    static async #enfileirarContas (post, accountsList, clientId, opts = {}) {
        const { delayMs, statusInicial = 'PROCESSING' } = opts;

        await prismaAdapter.atualizarStatusPost(post.id, statusInicial);

        const jobOpts = delayMs ? { delay: delayMs } : {};
        await Promise.all(accountsList.map(async account => {
            const job = await publishQueue.add('publicar-conta', { postId: post.id, accountId: account.id, clientId }, jobOpts);
            if (statusInicial === 'SCHEDULED') {
                await prismaAdapter.registrarJobAgendado(post.id, account.id, job.id);
            }
        }));

        return {
            status: statusInicial === 'SCHEDULED' ? 'scheduled' : 'queued',
            postId: post.id,
            totalContas: accountsList.length
        };
    }

    // Chamado pelo worker depois de cada job (sucesso ou falha definitiva) pra fechar o status do post
    // quando todas as contas já tiverem sido processadas.
    static async finalizarStatusSeCompleto (postId) {
        const contas = await prismaAdapter.listarStatusContasDoPost(postId);

        const aindaProcessando = contas.some(conta => conta.delivery_status === 'PENDING');
        if (aindaProcessando) return;

        const sucessos = contas.filter(conta => conta.delivery_status === 'SUCCESS').length;
        const statusFinal = sucessos === 0 ? 'FAILED' : sucessos === contas.length ? 'PUBLISHED' : 'PARTIAL';

        await prismaAdapter.atualizarStatusPost(postId, statusFinal);
    }

    static async gerenciarPostagemEmLote (arquivo, caption, accountsList, clientId, userId, columnIdExplicito) {
        await this.#validarCliente(clientId, userId);

        const columnId = await this.#resolverColumnId(clientId, columnIdExplicito);
        const thumbnailPath = await thumbnailService.gerar(arquivo);
        const novoPost = await prismaAdapter.criarPost(caption, arquivo.filename, arquivo.originalname, arquivo.mimetype, 'DRAFT', clientId, null, columnId, thumbnailPath);

        const post = {
            id: novoPost.id,
            caption,
            file_path: arquivo.filename,
            file_name: arquivo.originalname,
            file_type: arquivo.mimetype
        };
        return this.#enfileirarContas(post, accountsList, clientId);
    }

    static async agendarPostagem (arquivo, caption, accountsList, scheduledFor, clientId, userId, columnIdExplicito) {
        await this.#validarCliente(clientId, userId);

        const FORMATO_ISO_COM_FUSO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
        if (typeof scheduledFor !== 'string' || !FORMATO_ISO_COM_FUSO.test(scheduledFor)) {
            throw new AppError('Data de agendamento inválida. Use ISO 8601 com fuso horário explícito (ex.: 2026-08-01T10:00:00-03:00).');
        }

        const data = new Date(scheduledFor);
        const delayMs = data.getTime() - Date.now();
        if (Number.isNaN(delayMs) || delayMs <= 0) {
            throw new AppError('A data de agendamento precisa estar no futuro.');
        }

        const columnId = await this.#resolverColumnId(clientId, columnIdExplicito);
        const thumbnailPath = await thumbnailService.gerar(arquivo);
        const novoPost = await prismaAdapter.criarPost(caption, arquivo.filename, arquivo.originalname, arquivo.mimetype, 'SCHEDULED', clientId, data, columnId, thumbnailPath);

        const post = {
            id: novoPost.id,
            caption,
            file_path: arquivo.filename,
            file_name: arquivo.originalname,
            file_type: arquivo.mimetype
        };

        return this.#enfileirarContas(post, accountsList, clientId, { delayMs, statusInicial: 'SCHEDULED' });
    }

    static async consultarStatusPost (postId, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const post = await prismaAdapter.buscarPostComStatusContas(postId, clientId);
        if (!post) throw new AppError('Post não encontrado');

        return { postId: post.id, status: post.status, accounts: post.accounts };
    }

    static async cancelarAgendamento (postId, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const post = await prismaAdapter.buscarPostAgendadoComJobs(postId, clientId);
        if (!post) throw new AppError('Post agendado não encontrado ou já iniciado');

        await Promise.all(post.post_accounts.map(async ({ job_id }) => {
            if (!job_id) return;
            try {
                const job = await publishQueue.getJob(job_id);
                if (job && (await job.getState()) === 'delayed') await job.remove();
            } catch (erro) {
                console.warn('Falha ao remover job agendado da fila', { postId, job_id, erro: erro.message });
            }
        }));

        const postExcluido = await prismaAdapter.excluirPostAgendado(postId, clientId);
        this.#removerArquivoLocal({ path: path.join(UPLOADS_DIR, postExcluido.file_path) });

        return { message: 'Agendamento cancelado com sucesso', postId };
    }

    static async criarDraft (caption, arquivo, accountIds, clientId, userId, columnIdExplicito) {
        await this.#validarCliente(clientId, userId);

        if (!Array.isArray(accountIds) || accountIds.length === 0) {
            throw new AppError('Selecione ao menos uma conta para o rascunho');
        }

        const columnId = await this.#resolverColumnId(clientId, columnIdExplicito);
        const thumbnailPath = await thumbnailService.gerar(arquivo);
        return prismaAdapter.criarDraftComContas(caption, arquivo.originalname, arquivo.filename, arquivo.mimetype, clientId, accountIds, columnId, thumbnailPath);
    }

    static async publicarDraft (draftId, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const draft = await prismaAdapter.buscarDraftPorId(draftId, clientId);
        if (!draft) throw new AppError('Draft não encontrado');

        const contasVinculadas = await prismaAdapter.listarContasDoDraft(draftId, clientId);
        if (contasVinculadas.length === 0) throw new AppError('Este rascunho não possui contas vinculadas');

        return this.#enfileirarContas(draft, contasVinculadas, clientId);
    }

    static async atualizarDraft (draftId, caption, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const draftAtualizado = await prismaAdapter.atualizarDraft(draftId, caption, clientId);
        if (!draftAtualizado) throw new AppError('Draft não encontrado');
        return draftAtualizado;
    }

    static async buscarDraft (draftId, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const draft = await prismaAdapter.buscarDraftComContas(draftId, clientId);
        if (!draft) throw new AppError('Draft não encontrado');
        return draft;
    }

    static async listarDrafts (clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const drafts = await prismaAdapter.listarDrafts(clientId);
        return drafts;
    }

    static async excluirDraft (draftId, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const draft = await prismaAdapter.excluirDraft(draftId, clientId);
        if (!draft) throw new AppError('Draft não encontrado');

        this.#removerArquivoLocal({ path: path.join(UPLOADS_DIR, draft.file_path) });
        return draft;
    }

    static async listarFeed (page, limit) {
        const { posts, total } = await prismaAdapter.listarFeed(page, limit);

        return {
            feed: posts,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    }
}

module.exports = PostService;
