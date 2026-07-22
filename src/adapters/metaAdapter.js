const AppError = require('../errors/AppError.js');

const GRAPH_API_BASE_URL = 'https://graph.facebook.com/v25.0';
const POLLING_IMAGEM = { tentativas: 10, intervaloMs: 2000 };
const POLLING_VIDEO = { tentativas: 30, intervaloMs: 5000 };

class MetaAdapter {
    static async publicarNoInstagram (post, accessToken, instagramId) {
        if (!instagramId) throw new AppError('ID da conta do Instagram ausente.');

        const urlPublica = this.#construirUrlPublicaMidia(post.file_path);
        const isVideo = post.file_type.startsWith('video/');
        const { tentativas, intervaloMs } = isVideo ? POLLING_VIDEO : POLLING_IMAGEM;

        const creationId = isVideo
            ? await this.#criarContainerVideo(instagramId, accessToken, urlPublica, post.caption)
            : await this.#criarContainerMidia(instagramId, accessToken, urlPublica, post.caption);

        await this.#aguardarContainerPronto(creationId, accessToken, tentativas, intervaloMs);

        const externalId = await this.#publicarContainerCriado(instagramId, accessToken, creationId);
        return { success: true, externalId };
    }

    static async publicarNoFacebook (post, accessToken, pageId) {
        if (!pageId) throw new AppError('ID da página do Facebook ausente.');

        const urlPublica = this.#construirUrlPublicaMidia(post.file_path);
        const isVideo = post.file_type.startsWith('video/');

        const externalId = isVideo
            ? await this.#publicarVideoFacebook(pageId, accessToken, urlPublica, post.caption)
            : await this.#publicarFotoFacebook(pageId, accessToken, urlPublica, post.caption);

        return { success: true, externalId };
    }

    static #construirUrlPublicaMidia (filePath) {
        return `${process.env.BASE_URL}/uploads/${filePath}`;
    }

    static async #postToGraphApi (url, token, body, errorContext) {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify(body)
        });
        const data = await response.json();

        if (!response.ok) {
            console.error(errorContext, {
                url,
                body,
                httpStatus: response.status,
                tokenSufixo: token ? token.slice(-6) : null,
                graphError: data.error
            });
            throw new AppError(`${errorContext}: ${data.error.message}`);
        }

        return data;
    }

    static async #criarContainerMidia (instagramId, token, urlPublicaImagem, caption) {
        const url = `${GRAPH_API_BASE_URL}/${instagramId}/media`;
        const data = await this.#postToGraphApi(url, token,
            { image_url: urlPublicaImagem, caption },
            'Erro ao criar container de mídia');
        return data.id;
    }

    static async #criarContainerVideo (instagramId, token, urlPublicoVideo, caption) {
        const url = `${GRAPH_API_BASE_URL}/${instagramId}/media`;
        const data = await this.#postToGraphApi(url, token,
            { video_url: urlPublicoVideo, caption, media_type: 'REELS', share_to_feed: true },
            'Erro ao criar container de vídeo');
        return data.id;
    }

    static async #aguardarContainerPronto (creationId, token, tentativas, intervaloMs) {
        const url = `${GRAPH_API_BASE_URL}/${creationId}?fields=status_code&access_token=${token}`;

        for (let i = 0; i < tentativas; i++) {
            const response = await fetch(url);
            const data = await response.json();
            if (!response.ok) {
                console.error('Erro ao consultar status do container', { creationId, httpStatus: response.status, graphError: data.error });
                throw new AppError(`Erro ao consultar status do container: ${data.error.message}`);
            }

            if (data.status_code === 'FINISHED') return;
            if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
                console.error('Container falhou ao processar mídia', { creationId, statusCode: data.status_code });
                throw new AppError(`Container falhou ao processar mídia: status ${data.status_code}`);
            }

            await new Promise(resolve => setTimeout(resolve, intervaloMs));
        }

        console.error('Tempo esgotado aguardando o processamento da mídia', { creationId, tentativas, intervaloMs });
        throw new AppError('Tempo esgotado aguardando o processamento da mídia');
    }

    static async #publicarContainerCriado (instagramId, token, creationId) {
        const url = `${GRAPH_API_BASE_URL}/${instagramId}/media_publish`;
        const data = await this.#postToGraphApi(url, token,
            { creation_id: creationId },
            'Erro ao publicar container');
        return data.id;
    }

    static async #publicarFotoFacebook (pageId, token, urlPublicaImagem, caption) {
        const url = `${GRAPH_API_BASE_URL}/${pageId}/photos`;
        const data = await this.#postToGraphApi(url, token,
            { url: urlPublicaImagem, caption },
            'Erro ao publicar foto no Facebook');
        return data.post_id ?? data.id;
    }

    static async #publicarVideoFacebook (pageId, token, urlPublicoVideo, caption) {
        const url = `${GRAPH_API_BASE_URL}/${pageId}/videos`;
        const data = await this.#postToGraphApi(url, token,
            { file_url: urlPublicoVideo, description: caption },
            'Erro ao publicar vídeo no Facebook');
        return data.post_id ?? data.id;
    }
}

module.exports = MetaAdapter;
