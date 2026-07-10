const metaAdapter = require('../adapters/metaAdapter.js');
const prismaAdapter = require('../adapters/prismaAdapter.js');
const cryptoUtil = require('../utils/cryptoUtil.js');
const AppError = require('../errors/AppError.js');
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = '.uploads';

class PostService {

    static #construirUrlPublica (arquivo) {
        return `${process.env.BASE_URL}/uploads/${arquivo.filename}`;
    }

    static #removerArquivoLocal (arquivo) {
        if (fs.existsSync(arquivo.path)) {
            fs.unlinkSync(arquivo.path);
        }
    }

    static async #publicarMidia (instagramId, token, urlPublica, caption, ehVideo) {
        const [tentativas, intervaloMs] = ehVideo ? [30, 5000] : [10, 2000];

        const creationId = ehVideo
            ? await metaAdapter.criarContainerVideo(instagramId, token, urlPublica, caption)
            : await metaAdapter.criarContainerMidia(instagramId, token, urlPublica, caption);

        await metaAdapter.aguardarContainerPronto(creationId, token, tentativas, intervaloMs);
        return metaAdapter.publicarContainer(instagramId, token, creationId);
    }

    static async #registrarResultado (postId, accountId, status, apiPostId, errorMessage) {
        try {
            await prismaAdapter.vincularPostConta(postId, accountId, status, apiPostId, errorMessage);
        } catch (dbError) {
            console.error('Falha ao registrar resultado da conta no post', { postId, accountId, erro: dbError.message });
        }
    }

    static async #processarConta (postId, account, ehVideo, urlPublica, caption, userId) {
        let contaId = account.id;
        try {
            const contaReal = await prismaAdapter.buscarContaPorId(account.id, userId);
            if (!contaReal) throw new AppError(`Conta com ID ${account.id} não encontrada`);
            contaId = contaReal.id;

            const accessToken = cryptoUtil.decrypt(contaReal.access_token);
            const apiPostId = await this.#publicarMidia(contaReal.instagram_user_id, accessToken, urlPublica, caption, ehVideo);

            await this.#registrarResultado(postId, contaId, 'SUCCESS', apiPostId, null);
            return { accountId: contaId, status: 'success', apiPostId };
        } catch (error) {
            const isOperational = error instanceof AppError;
            const mensagemExposta = isOperational
                ? error.message
                : 'Erro ao publicar nesta conta. Tente novamente mais tarde.';

            const contexto = { postId, contaId, userId, urlPublica, ehVideo, erro: error.message };
            if (isOperational) {
                console.warn(`Falha ao publicar post ${postId} na conta ${contaId}`, contexto);
            } else {
                console.error(`Erro inesperado ao publicar post ${postId} na conta ${contaId}`, { ...contexto, stack: error.stack });
            }

            await this.#registrarResultado(postId, contaId, 'FAILED', null, mensagemExposta);
            return { accountId: contaId, status: 'failed', error: mensagemExposta };
        }
    }

    static async #executarEnvioParaContas (post, arquivo, accountsList, userId) {
        const ehVideo = arquivo.mimetype.startsWith('video/');
        const urlPublica = this.#construirUrlPublica(arquivo);

        const relatorioEnvio = await Promise.all(
            accountsList.map(account => this.#processarConta(post.id, account, ehVideo, urlPublica, post.caption, userId))
        );

        const sucessos = relatorioEnvio.filter(item => item.status === 'success').length;
        const statusFinal = sucessos === 0 ? 'FAILED' : sucessos === relatorioEnvio.length ? 'PUBLISHED' : 'PARTIAL';
        await prismaAdapter.atualizarStatusPost(post.id, statusFinal);

        return relatorioEnvio;
    }

    static async gerenciarPostagemEmLote (arquivo, caption, accountsList, userId) {
        const novoPost = await prismaAdapter.criarPost(caption, arquivo.filename, 'DRAFT', userId);

        try {
            return await this.#executarEnvioParaContas({ id: novoPost.id, caption }, arquivo, accountsList, userId);
        } finally {
            this.#removerArquivoLocal(arquivo);
        }
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

        const arquivo = { filename: draft.file_path, mimetype: draft.file_type };
        return this.#executarEnvioParaContas(draft, arquivo, contasVinculadas, userId);
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
}

module.exports = PostService;
