const metaAdapter = require('../adapters/metaAdapter.js');
const prismaAdapter = require('../adapters/prismaAdapter.js');
const cryptoUtil = require('../utils/cryptoUtil.js');
const AppError = require('../errors/AppError.js');
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = '.uploads';

class PostService {

    static #removerArquivoLocal (arquivo) {
        if (fs.existsSync(arquivo.path)) {
            fs.unlinkSync(arquivo.path);
        }
    }

    static async #registrarResultado (postId, accountId, status, apiPostId, errorMessage) {
        try {
            await prismaAdapter.vincularPostConta(postId, accountId, status, apiPostId, errorMessage);
        } catch (dbError) {
            console.error('Falha ao registrar resultado da conta no post', { postId, accountId, erro: dbError.message });
        }
    }

    static async #processarConta (account, post, userId) {
        let contaId = account.id;
        try {
            const contaReal = await prismaAdapter.buscarContaPorId(account.id, userId);
            if (!contaReal) throw new AppError(`Conta com ID ${account.id} não encontrada`);
            contaId = contaReal.id;

            const accessToken = cryptoUtil.decrypt(contaReal.access_token);
            const { externalId } = await metaAdapter.publicarNoInstagram(post, accessToken, contaReal.instagram_user_id);

            await this.#registrarResultado(post.id, contaId, 'SUCCESS', externalId, null);
            return { accountId: contaId, status: 'success', apiPostId: externalId };
        } catch (error) {
            const isOperational = error instanceof AppError;
            const mensagemExposta = isOperational
                ? error.message
                : 'Erro ao publicar nesta conta. Tente novamente mais tarde.';

            const contexto = { postId: post.id, contaId, userId, erro: error.message };
            if (isOperational) {
                console.warn(`Falha ao publicar post ${post.id} na conta ${contaId}`, contexto);
            } else {
                console.error(`Erro inesperado ao publicar post ${post.id} na conta ${contaId}`, { ...contexto, stack: error.stack });
            }

            await this.#registrarResultado(post.id, contaId, 'FAILED', null, mensagemExposta);
            return { accountId: contaId, status: 'failed', error: mensagemExposta };
        }
    }

    static async #executarEnvioParaContas (post, accountsList, userId) {
        const relatorioEnvio = await Promise.all(
            accountsList.map(account => this.#processarConta(account, post, userId))
        );

        const sucessos = relatorioEnvio.filter(item => item.status === 'success').length;
        const statusFinal = sucessos === 0 ? 'FAILED' : sucessos === relatorioEnvio.length ? 'PUBLISHED' : 'PARTIAL';
        await prismaAdapter.atualizarStatusPost(post.id, statusFinal);

        return relatorioEnvio;
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
        return this.#executarEnvioParaContas(post, accountsList, userId);
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

        return this.#executarEnvioParaContas(draft, contasVinculadas, userId);
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
