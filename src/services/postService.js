const prismaAdapter = require('../adapters/prismaAdapter.js');
const AppError = require('../errors/AppError.js');
const { publishQueue } = require('../queues/publishQueue.js');
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = '.uploads';

class PostService {

    static #removerArquivoLocal (arquivo) {
        if (fs.existsSync(arquivo.path)) {
            fs.unlinkSync(arquivo.path);
        }
    }

    // A tentativa de publicar em si (e o registro de sucesso/falha por conta) migrou pro worker
    // (src/workers/publishWorker.js) — aqui só marcamos o post como "em processamento" e enfileiramos.
    static async #enfileirarContas (post, accountsList, userId) {
        await prismaAdapter.atualizarStatusPost(post.id, 'PROCESSING');

        await Promise.all(
            accountsList.map(account => publishQueue.add('publicar-conta', { postId: post.id, accountId: account.id, userId }))
        );

        return { status: 'queued', postId: post.id, totalContas: accountsList.length };
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

    static async gerenciarPostagemEmLote (arquivo, caption, accountsList, userId) {
        const novoPost = await prismaAdapter.criarPost(caption, arquivo.filename, arquivo.originalname, arquivo.mimetype, 'DRAFT', userId);

        const post = {
            id: novoPost.id,
            caption,
            file_path: arquivo.filename,
            file_name: arquivo.originalname,
            file_type: arquivo.mimetype
        };
        return this.#enfileirarContas(post, accountsList, userId);
    }

    static async criarDraft (caption, arquivo, accountIds, userId) {
        if (!Array.isArray(accountIds) || accountIds.length === 0) {
            throw new AppError('Selecione ao menos uma conta para o rascunho');
        }

        return prismaAdapter.criarDraftComContas(caption, arquivo.originalname, arquivo.filename, arquivo.mimetype, userId, accountIds);
    }

    static async publicarDraft (draftId, userId) {
        const draft = await prismaAdapter.buscarDraftPorId(draftId, userId);
        if (!draft) throw new AppError('Draft não encontrado');

        const contasVinculadas = await prismaAdapter.listarContasDoDraft(draftId, userId);
        if (contasVinculadas.length === 0) throw new AppError('Este rascunho não possui contas vinculadas');

        return this.#enfileirarContas(draft, contasVinculadas, userId);
    }

    static async atualizarDraft (draftId, caption, userId) {
        const draftAtualizado = await prismaAdapter.atualizarDraft(draftId, caption, userId);
        if (!draftAtualizado) throw new AppError('Draft não encontrado');
        return draftAtualizado;
    }

    static async buscarDraft (draftId, userId) {
        const draft = await prismaAdapter.buscarDraftComContas(draftId, userId);
        if (!draft) throw new AppError('Draft não encontrado');
        return draft;
    }

    static async listarDrafts (userId) {
        const drafts = await prismaAdapter.listarDrafts(userId);
        return drafts;
    }

    static async excluirDraft (draftId, userId) {
        const draft = await prismaAdapter.excluirDraft(draftId, userId);
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
