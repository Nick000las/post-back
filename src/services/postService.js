const prismaAdapter = require('../adapters/prismaAdapter.js');
const AppError = require('../errors/AppError.js');
const { publishQueue } = require('../queues/publishQueue.js');
const kanbanService = require('./kanbanService.js');
const thumbnailService = require('./thumbnailService.js');
const { FIXED_COLUMN_KEYS } = require('../constants/kanban.js');
const { FEED_STATUS_FILTER_MAP, FEED_DATE_FILTERS } = require('../constants/feed.js');
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = '.uploads';
const FORMATO_ISO_COM_FUSO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

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

    // Salto automático de coluna no Kanban: quando um post muda pra um status "de fase" (agendado ou
    // finalizado, nos dois sentidos do termo), ele pula pra coluna fixa correspondente, sem passar pela
    // validação de kanbanService.moverPost (que só existe pra bloquear o usuário movendo manualmente —
    // esse bloqueio não se aplica aqui, é o próprio sistema movendo). Silencioso por design: um post
    // sem coluna fixa configurada (inconsistência de dados) não pode derrubar o fluxo de publicação.
    static async #moverParaColunaFixa (postId, clientId, fixedKey) {
        try {
            const coluna = await prismaAdapter.buscarColunaPorFixedKey(clientId, fixedKey);
            if (!coluna) return;
            await prismaAdapter.moverPostDeColuna(postId, clientId, coluna.id);
        } catch (erro) {
            console.error('Falha ao mover post automaticamente de coluna', { postId, clientId, fixedKey, erro: erro.message });
        }
    }

    // A tentativa de publicar em si (e o registro de sucesso/falha por conta) migrou pro worker
    // (src/workers/publishWorker.js) — aqui só marcamos o post e enfileiramos.
    // opts.delayMs: usado pelo agendamento (undefined = publica assim que possível).
    // opts.statusInicial: 'PROCESSING' (padrão, publicação imediata) ou 'SCHEDULED' (aguardando o horário agendado).
    static async #enfileirarContas (post, accountsList, clientId, opts = {}) {
        const { delayMs, statusInicial = 'PROCESSING' } = opts;

        await prismaAdapter.atualizarStatusPost(post.id, statusInicial);
        if (statusInicial === 'SCHEDULED') {
            await this.#moverParaColunaFixa(post.id, clientId, FIXED_COLUMN_KEYS.AGENDADO);
        }

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

    // Resolve o filtro de data (query param, ex.: 'hoje'/'7dias'/'mes') pro intervalo [from, to] usado
    // nos where dos feeds. undefined quando não houver filtro (sem corte de data).
    static #resolverIntervaloData(dateFilter) {
        if (!dateFilter) return undefined;

        const agora = new Date();
        const from = new Date(agora);

        switch (dateFilter) {
            case FEED_DATE_FILTERS.HOJE:
                from.setHours(0, 0, 0, 0);
                break;
            case FEED_DATE_FILTERS.SETE_DIAS:
                from.setDate(from.getDate() - 7);
                break;
            case FEED_DATE_FILTERS.ESTE_MES:
                from.setDate(1);
                from.setHours(0, 0, 0, 0);
                break;
            default:
                throw new AppError('Filtro de data inválido');
        }

        return { from, to: agora };
    }

    // Resolve mês/ano (query params do Feed do Cliente) pro intervalo [from, to]. year é obrigatório
    // (sem ele, undefined = sem filtro); month é opcional — se vier, restringe àquele mês, senão
    // cobre o ano inteiro (caso do dropdown "Todos os meses" + um ano específico).
    static #resolverIntervaloMesAno(month, year) {
        if (!year) return undefined;

        const from = month ? new Date(year, month - 1, 1, 0, 0, 0, 0) : new Date(year, 0, 1, 0, 0, 0, 0);
        const to = month ? new Date(year, month, 0, 23, 59, 59, 999) : new Date(year, 11, 31, 23, 59, 59, 999);
        return { from, to };
    }

    static async #validarDataFutura(scheduledFor){
        if (typeof scheduledFor !== 'string' || !FORMATO_ISO_COM_FUSO.test(scheduledFor)) {
            throw new AppError('Data de agendamento inválida. Use ISO 8601 com fuso horário explícito (ex.: 2026-08-01T10:00:00-03:00).');
        }
    }

    // Chamado pelo worker depois de cada job (sucesso ou falha definitiva) pra fechar o status do post
    // quando todas as contas já tiverem sido processadas.
    static async finalizarStatusSeCompleto (postId) {
        const contas = await prismaAdapter.listarStatusContasDoPost(postId);

        const aindaProcessando = contas.some(conta => conta.delivery_status === 'PENDING');
        if (aindaProcessando) return;

        const sucessos = contas.filter(conta => conta.delivery_status === 'SUCCESS').length;
        const statusFinal = sucessos === 0 ? 'FAILED' : sucessos === contas.length ? 'PUBLISHED' : 'PARTIAL';

        await prismaAdapter.atualizarStatusPost(postId, statusFinal, { published_at: new Date() });

        // O worker só tem postId/accountId no job.data — precisa buscar o post pra saber o client_id
        // antes de conseguir resolver a coluna Finalizado desse client.
        const post = await prismaAdapter.buscarPostPorId(postId);
        if (post) await this.#moverParaColunaFixa(postId, post.client_id, FIXED_COLUMN_KEYS.FINALIZADO);
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
        await this.#validarDataFutura(scheduledFor);

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

    // Cancelar agendamento NÃO apaga o post — reverte pra DRAFT (arte/legenda preservadas) e move o
    // card de volta pra coluna Ideias, pra a agência poder reeditar/reagendar depois sem reupload.
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

        const postRevertido = await prismaAdapter.reverterAgendamentoParaDraft(postId, clientId);
        if (!postRevertido) throw new AppError('Post agendado não encontrado ou já iniciado');

        await this.#moverParaColunaFixa(postId, clientId, FIXED_COLUMN_KEYS.IDEIAS);

        return { message: 'Agendamento cancelado. O post voltou a ser um rascunho.', postId: postRevertido.id };
    }

    // "Alterar Data" no popup: post JÁ está SCHEDULED (ao contrário de agendarDraft, que exige DRAFT).
    // Em vez de cancelar+reagendar (recriaria jobs do zero), usa job.changeDelay do BullMQ pra
    // reagendar os jobs já existentes na fila com o novo horário — mais barato e não perde o job_id
    // já registrado em post_accounts.
    static async alterarDataAgendamento (postId, clientId, userId, scheduledFor) {
        await this.#validarCliente(clientId, userId);
        await this.#validarDataFutura(scheduledFor);

        const data = new Date(scheduledFor);
        const novoDelayMs = data.getTime() - Date.now();
        if (Number.isNaN(novoDelayMs) || novoDelayMs <= 0) {
            throw new AppError('A data de agendamento precisa estar no futuro.');
        }

        const post = await prismaAdapter.buscarPostAgendadoComJobs(postId, clientId);
        if (!post) throw new AppError('Post agendado não encontrado ou já iniciado');

        await Promise.all(post.post_accounts.map(async ({ job_id }) => {
            if (!job_id) return;
            try {
                const job = await publishQueue.getJob(job_id);
                if (job && (await job.getState()) === 'delayed') await job.changeDelay(novoDelayMs);
            } catch (erro) {
                console.warn('Falha ao reagendar job', { postId, job_id, erro: erro.message });
            }
        }));

        await prismaAdapter.atualizarScheduledFor(postId, data);

        return { message: 'Data de agendamento atualizada com sucesso', postId, scheduled_for: data };
    }

    // Exclusão definitiva de post em qualquer status — usada pela lixeira do popup do Kanban. Some
    // com o card, o arquivo em disco, o thumbnail e os comentários (cascade no schema). Se o post ainda
    // estiver SCHEDULED com job(s) na fila, eles precisam ser removidos antes de excluir (mesmo cuidado
    // de cancelarAgendamento — um job 'delayed' órfão tentaria publicar um post que não existe mais).
    static async excluirPost (postId, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        // Só existe job pra remover se o post ainda estava SCHEDULED — null aqui é esperado (e não é
        // erro) pra draft/publicado/etc., que nunca tiveram job pendente na fila.
        const postAgendado = await prismaAdapter.buscarPostAgendadoComJobs(postId, clientId);
        if (postAgendado) {
            await Promise.all(postAgendado.post_accounts.map(async ({ job_id }) => {
                if (!job_id) return;
                try {
                    const job = await publishQueue.getJob(job_id);
                    if (job && (await job.getState()) === 'delayed') await job.remove();
                } catch (erro) {
                    console.warn('Falha ao remover job agendado da fila', { postId, job_id, erro: erro.message });
                }
            }));
        }

        const post = await prismaAdapter.excluirPostDefinitivo(postId, clientId);
        if (!post) throw new AppError('Post não encontrado');

        // file_path pode ser null (post sem mídia — removida no editor do Kanban antes da exclusão).
        if (post.file_path) this.#removerArquivoLocal({ path: path.join(UPLOADS_DIR, post.file_path) });

        return { message: 'Post excluído com sucesso', postId };
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

        if (!draft.file_path) throw new AppError('Adicione uma mídia antes de publicar');
        const contasVinculadas = await prismaAdapter.listarContasDoDraft(draftId, clientId);
        if (contasVinculadas.length === 0) throw new AppError('Este rascunho não possui contas vinculadas');

        return this.#enfileirarContas(draft, contasVinculadas, clientId);
    }

    // Análogo de publicarDraft, mas agendando em vez de publicar imediatamente. Existe pra permitir
    // agendar um post que já está no Kanban (ex.: card em "Ideias") sem duplicar o post nem reenviar o
    // arquivo — ao contrário de agendarPostagem (multipart, sempre cria um post novo).
    static async agendarDraft (draftId, clientId, userId, scheduledFor) {
        await this.#validarCliente(clientId, userId);
        await this.#validarDataFutura(scheduledFor);


        const data = new Date(scheduledFor);
        const delayMs = data.getTime() - Date.now();
        if (Number.isNaN(delayMs) || delayMs <= 0) {
            throw new AppError('A data de agendamento precisa estar no futuro.');
        }

        const draft = await prismaAdapter.buscarDraftPorId(draftId, clientId);
        if (!draft) throw new AppError('Draft não encontrado');

        if (!draft.file_path) throw new AppError('Adicione uma mídia antes de agendar');

        const contasVinculadas = await prismaAdapter.listarContasDoDraft(draftId, clientId);
        if (contasVinculadas.length === 0) throw new AppError('Este rascunho não possui contas vinculadas');

        await prismaAdapter.atualizarScheduledFor(draftId, data);

        return this.#enfileirarContas(draft, contasVinculadas, clientId, { delayMs, statusInicial: 'SCHEDULED' });
    }

    static async atualizarDraft (draftId, caption, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const draftAtualizado = await prismaAdapter.atualizarDraft(draftId, caption, clientId);
        if (!draftAtualizado) throw new AppError('Draft não encontrado');
        return draftAtualizado;
    }

    // Substitui a mídia de um draft existente (drag&drop ou clique no lápis, no popup do Kanban).
    // arquivo vem de req.file (multer), já salvo em disco pelo controller antes de chegar aqui.
    static async atualizarMidiaDraft (draftId, clientId, userId, arquivo) {
        await this.#validarCliente(clientId, userId);
        const draftAtual = await prismaAdapter.buscarDraftPorId(draftId, clientId);
        if (!draftAtual) throw new AppError('Draft não encontrado');

        const thumbnailPath = await thumbnailService.gerar(arquivo);
        const draftAtualizado = await prismaAdapter.atualizarMidiaDraft(draftId, clientId, {
            filePath: arquivo.filename,
            fileName: arquivo.originalname,
            fileType: arquivo.mimetype,
            thumbnailPath
        });
        if (!draftAtualizado) throw new AppError('Draft não encontrado');

        if (draftAtual.file_path) this.#removerArquivoLocal({ path: path.join(UPLOADS_DIR, draftAtual.file_path) });
        if (draftAtual.thumbnail_path) this.#removerArquivoLocal({ path: path.join(UPLOADS_DIR, 'thumbs', draftAtual.thumbnail_path) });
        return draftAtualizado;
    }

    // Remove a mídia de um draft (lixeira no popup) — post continua DRAFT, só fica sem arquivo até o
    // usuário anexar outro (ou publicar/agendar, o que passa a ser bloqueado enquanto estiver vazio).
    static async removerMidiaDraft (draftId, clientId, userId) {
        await this.#validarCliente(clientId, userId);
        const draftAtual = await prismaAdapter.buscarDraftPorId(draftId, clientId);
        if (!draftAtual) throw new AppError('Draft não encontrado');
        const draftAtualizado = await prismaAdapter.removerMidiaDraft(draftId, clientId);
        if (!draftAtualizado) throw new AppError('Draft não encontrado');
        if (draftAtual.file_path) this.#removerArquivoLocal({ path: path.join(UPLOADS_DIR, draftAtual.file_path) });
        if (draftAtual.thumbnail_path) this.#removerArquivoLocal({ path: path.join(UPLOADS_DIR, 'thumbs', draftAtual.thumbnail_path) });
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

        // file_path pode ser null (draft sem mídia — removida no editor do Kanban antes da exclusão).
        if (draft.file_path) this.#removerArquivoLocal({ path: path.join(UPLOADS_DIR, draft.file_path) });
        return draft;
    }

    // Feed Global ("torre de controle"): cross-client, escopado ao usuário autenticado. filtros:
    // { status, clientId?, date? } — status já validado/default no controller (#parseFiltrosFeedGlobal).
    static async listarFeedGlobal (userId, filtros, page, limit) {
        if (filtros.clientId) await this.#validarCliente(filtros.clientId, userId);

        const statusList = FEED_STATUS_FILTER_MAP[filtros.status];
        const intervalo = this.#resolverIntervaloData(filtros.date);

        const { posts, total } = await prismaAdapter.listarFeedGlobal({
            userId,
            clientId: filtros.clientId,
            statusList,
            intervalo,
            page,
            limit
        });

        return {
            feed: posts,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        };
    }

    // Feed do Cliente ("vitrine/portfólio"): sempre de um único client. filtros:
    // { clientId, platform?, month?, year? } — clientId é obrigatório (garantido no controller).
    static async listarFeedCliente (userId, filtros, page, limit) {
        await this.#validarCliente(filtros.clientId, userId);

        const intervalo = this.#resolverIntervaloMesAno(filtros.month, filtros.year);

        const { posts, total } = await prismaAdapter.listarFeedCliente({
            clientId: filtros.clientId,
            platform: filtros.platform,
            intervalo,
            page,
            limit
        });

        return {
            feed: posts,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        };
    }

    // TODO (implementação manual): decidir e implementar a regra de republicação do botão
    // "Republicar" do Feed Global, disparado sobre posts FAILED/PARTIAL.
    // Sugestão de esqueleto do fluxo:
    //   1. localizar post + post_accounts com delivery_status FAILED (novo método no adapter);
    //   2. decidir escopo: só as contas FAILED, ou o post inteiro volta a PROCESSING?
    //   3. resetar delivery_status/error_message pra PENDING nas contas relevantes;
    //   4. reaproveitar o padrão de #enfileirarContas (publishQueue.add) pra re-enfileirar.
    static async republicarPost (postId, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const post = await prismaAdapter.buscarPostComStatusContas(postId, clientId);
        if (!post) throw new AppError('Post não encontrado');

        const contasFailed = post.accounts.filter(account => account.delivery_status === 'FAILED');
        if (contasFailed.length === 0) throw new AppError('Não há contas com falha para republicar');

        await Promise.all(contasFailed.map(account =>
            prismaAdapter.vincularPostConta(postId, account.accountId, 'PENDING', null, null)
        ));

        return this.#enfileirarContas(
            post,
            contasFailed.map(account => ({ id: account.accountId })),
            clientId
        );
    }
}

module.exports = PostService;
