const metaAdapter = require('../adapters/metaAdapter.js');
const prismaAdapter = require('../adapters/prismaAdapter.js');
const cryptoUtil = require('../utils/cryptoUtil.js');
const AppError = require('../errors/AppError.js');
const fs = require('fs');

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
            console.error(`Falha ao registrar resultado da conta ${accountId} no post ${postId}:`, dbError.message);
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
            if (!isOperational) {
                console.error(`Erro inesperado ao publicar na conta ${contaId}:`, error);
            }
            const mensagemExposta = isOperational
                ? error.message
                : 'Erro ao publicar nesta conta. Tente novamente mais tarde.';

            await this.#registrarResultado(postId, contaId, 'FAILED', null, mensagemExposta);
            return { accountId: contaId, status: 'failed', error: mensagemExposta };
        }
    }

    static async gerenciarPostagemEmLote (arquivo, caption, accountsList, userId) {
        const novoPost = await prismaAdapter.criarPost(caption, arquivo.filename, 'DRAFT', userId);

        try {
            const ehVideo = arquivo.mimetype.startsWith('video/');
            const urlPublica = this.#construirUrlPublica(arquivo);

            const relatorioEnvio = await Promise.all(
                accountsList.map(account => this.#processarConta(novoPost.id, account, ehVideo, urlPublica, caption, userId))
            );

            const sucessos = relatorioEnvio.filter(item => item.status === 'success').length;
            const statusFinal = sucessos === 0 ? 'FAILED' : sucessos === relatorioEnvio.length ? 'PUBLISHED' : 'PARTIAL';
            await prismaAdapter.atualizarStatusPost(novoPost.id, statusFinal);

            return relatorioEnvio;
        } finally {
            this.#removerArquivoLocal(arquivo);
        }
    }
}

module.exports = PostService;
