const AppError = require('../errors/AppError.js');

const GRAPH_API_BASE_URL = 'https://graph.facebook.com/v25.0';
const POLLING_IMAGEM = { tentativas: 10, intervaloMs: 2000 };
const POLLING_VIDEO = { tentativas: 30, intervaloMs: 5000 };
// Limite da própria Graph API. Espelha MAX_CAROUSEL_ITEMS em postRoutes.js, que já barra no upload
// — este aqui é a última linha de defesa (ex.: post criado antes daquele limite existir).
const MAX_ITENS_CARROSSEL = 10;

class MetaAdapter {
    static async publicarNoInstagram (post, accessToken, instagramId) {
        if (!instagramId) throw new AppError('ID da conta do Instagram ausente.');
        if (post.media.length === 0) throw new AppError('Post sem mídia para publicar.');

        if (post.media.length > 1) {
            return this.#publicarCarrosselInstagram(post, accessToken, instagramId);
        }

        const [midia] = post.media;
        const urlPublica = this.#construirUrlPublicaMidia(midia.file_path);
        const isVideo = midia.file_type.startsWith('video/');
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
        if (post.media.length === 0) throw new AppError('Post sem mídia para publicar.');

        if (post.media.length > 1) {
            return this.#publicarCarrosselFacebook(post, accessToken, pageId);
        }

        const [midia] = post.media;
        const urlPublica = this.#construirUrlPublicaMidia(midia.file_path);
        const isVideo = midia.file_type.startsWith('video/');

        const externalId = isVideo
            ? await this.#publicarVideoFacebook(pageId, accessToken, urlPublica, post.caption)
            : await this.#publicarFotoFacebook(pageId, accessToken, urlPublica, post.caption);

        return { success: true, externalId };
    }

    // Carrossel do Instagram: um container filho por item -> container pai CAROUSEL -> publish.
    // Só é chamado com 2+ itens (garantido por publicarNoInstagram).
    static async #publicarCarrosselInstagram (post, accessToken, instagramId) {
        if (post.media.length > MAX_ITENS_CARROSSEL) {
            throw new AppError(`Carrossel do Instagram aceita no máximo ${MAX_ITENS_CARROSSEL} itens.`);
        }

        // Promise.all preserva a ordem do array de ENTRADA no array de resultado — é isso que
        // garante que o carrossel saia na mesma ordem em que o usuário subiu os arquivos. Um
        // push() dentro do map daria a ordem de CONCLUSÃO das chamadas (que depende da rede),
        // embaralhando o carrossel de forma silenciosa.
        const childrenIds = await Promise.all(post.media.map(async midia => {
            const urlPublica = this.#construirUrlPublicaMidia(midia.file_path);
            const isVideo = midia.file_type.startsWith('video/');
            const { tentativas, intervaloMs } = isVideo ? POLLING_VIDEO : POLLING_IMAGEM;

            // Filho vai sem caption de propósito: a legenda pertence só ao container pai.
            const creationId = isVideo
                ? await this.#criarContainerVideo(instagramId, accessToken, urlPublica, undefined, { itemDeCarrossel: true })
                : await this.#criarContainerMidia(instagramId, accessToken, urlPublica, undefined, { itemDeCarrossel: true });

            await this.#aguardarContainerPronto(creationId, accessToken, tentativas, intervaloMs);
            return creationId;
        }));

        const temVideo = post.media.some(midia => midia.file_type.startsWith('video/'));
        const { tentativas, intervaloMs } = temVideo ? POLLING_VIDEO : POLLING_IMAGEM;

        const creationIdPai = await this.#criarContainerCarrossel(instagramId, accessToken, post.caption, childrenIds);
        await this.#aguardarContainerPronto(creationIdPai, accessToken, tentativas, intervaloMs);

        const externalId = await this.#publicarContainerCriado(instagramId, accessToken, creationIdPai);
        return { success: true, externalId };
    }

    // Carrossel do Facebook: sobe cada foto SEM publicar e depois cria um único post no feed
    // referenciando todas. Só é chamado com 2+ itens (garantido por publicarNoFacebook).
    static async #publicarCarrosselFacebook (post, accessToken, pageId) {
        // attached_media só aceita foto — vídeo em carrossel não existe nessa API. Melhor um erro
        // claro aqui do que deixar a Meta devolver algo genérico depois de já ter subido arquivos.
        if (post.media.some(midia => midia.file_type.startsWith('video/'))) {
            throw new AppError('Carrossel do Facebook não suporta vídeos nessa integração.');
        }

        // Mesma garantia de ordem do Instagram: o resultado do Promise.all segue a ordem da entrada.
        const mediaIds = await Promise.all(post.media.map(midia =>
            this.#subirFotoNaoPublicadaFacebook(pageId, accessToken, this.#construirUrlPublicaMidia(midia.file_path))
        ));

        const url = `${GRAPH_API_BASE_URL}/${pageId}/feed`;
        const data = await this.#postToGraphApi(url, accessToken,
            { message: post.caption, attached_media: mediaIds.map(id => ({ media_fbid: id })) },
            'Erro ao criar post de carrossel no Facebook');

        return { success: true, externalId: data.post_id ?? data.id };
    }

    static #construirUrlPublicaMidia (filePath) {
        return `${process.env.BASE_URL}/uploads/${filePath}`;
    }

    static async #criarContainerCarrossel (instagramId, token, caption, childrenIds) {
        const url = `${GRAPH_API_BASE_URL}/${instagramId}/media`;
        const data = await this.#postToGraphApi(url, token,
            { media_type: 'CAROUSEL', caption, children: childrenIds },
            'Erro ao criar container de carrossel');
        return data.id;
    }

    // Sobe a foto SEM publicar: ela existe só pra ser anexada ao post do carrossel. Diferente de
    // #publicarFotoFacebook em dois pontos que importam: manda published: false (senão cada foto
    // vira um post separado na página, além do carrossel) e devolve data.id — o id da FOTO, que é
    // o que attached_media espera em media_fbid (post_id não existe numa foto não publicada).
    static async #subirFotoNaoPublicadaFacebook (pageId, token, urlPublicaImagem) {
        const url = `${GRAPH_API_BASE_URL}/${pageId}/photos`;
        const data = await this.#postToGraphApi(url, token,
            { url: urlPublicaImagem, published: false },
            'Erro ao subir foto do carrossel no Facebook');
        return data.id;
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

    // itemDeCarrossel: marca o container como filho de um carrossel (is_carousel_item). Sem essa
    // flag a Graph API não aceita o id em `children` do container pai.
    static async #criarContainerMidia (instagramId, token, urlPublicaImagem, caption, { itemDeCarrossel = false } = {}) {
        const url = `${GRAPH_API_BASE_URL}/${instagramId}/media`;
        const data = await this.#postToGraphApi(url, token,
            { image_url: urlPublicaImagem, caption, ...(itemDeCarrossel && { is_carousel_item: true }) },
            'Erro ao criar container de mídia');
        return data.id;
    }

    static async #criarContainerVideo (instagramId, token, urlPublicoVideo, caption, { itemDeCarrossel = false } = {}) {
        const url = `${GRAPH_API_BASE_URL}/${instagramId}/media`;
        // Vídeo solto vira REELS (e aparece no feed); dentro de carrossel é VIDEO comum — mandar
        // REELS/share_to_feed num filho de carrossel é rejeitado pela API.
        const body = itemDeCarrossel
            ? { video_url: urlPublicoVideo, media_type: 'VIDEO', is_carousel_item: true }
            : { video_url: urlPublicoVideo, caption, media_type: 'REELS', share_to_feed: true };

        const data = await this.#postToGraphApi(url, token, body, 'Erro ao criar container de vídeo');
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
