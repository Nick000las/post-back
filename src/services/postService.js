const metaAdapter = require('../adapters/metaAdapter.js');
const fs = require('fs');

class PostService {

    static #obterCredenciaisInstagram () {
        return {
            instagramId: process.env.INSTAGRAM_USER_ID,
            token: process.env.META_ACCESS_TOKEN
        };
    }

    static #construirUrlPublica (arquivo) {
        return `${process.env.BASE_URL}/uploads/${arquivo.filename}`;
    }

    static #removerArquivoLocal (arquivo) {
        if (fs.existsSync(arquivo.path)) {
            fs.unlinkSync(arquivo.path);
        }
    }

    static async executarPostagemImagemInstagram (arquivo, caption) {
        const { instagramId, token } = this.#obterCredenciaisInstagram();
        const urlPublicaImagem = this.#construirUrlPublica(arquivo);

        const creationId = await metaAdapter.criarContainerMidia(instagramId, token, urlPublicaImagem, caption);
        await metaAdapter.aguardarContainerPronto(creationId, token);
        const postId = await metaAdapter.publicarContainer(instagramId, token, creationId);

        this.#removerArquivoLocal(arquivo);
        return postId;
    }

    static async executarPostagemVideoInstagram (arquivo, caption) {
        const { instagramId, token } = this.#obterCredenciaisInstagram();
        const urlPublicaVideo = this.#construirUrlPublica(arquivo);

        const creationId = await metaAdapter.criarContainerVideo(instagramId, token, urlPublicaVideo, caption);
        await metaAdapter.aguardarContainerPronto(creationId, token, 30, 5000);
        const postId = await metaAdapter.publicarContainer(instagramId, token, creationId);

        this.#removerArquivoLocal(arquivo);
        return postId;
    }
}

module.exports = PostService;