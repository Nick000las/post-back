
class MetaAdapter {
    static async #postToGraphApi (url, token, body, errorContext) {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(`${errorContext}: ${data.error.message}`);
        return data;
    }

    static async criarContainerMidia (instagramId, token, urlPublicaImagem, caption) {
        const url = `https://graph.facebook.com/v25.0/${instagramId}/media`;
        const data = await this.#postToGraphApi(url, token,
            { image_url: urlPublicaImagem, caption },
            'Erro ao criar container de mídia');
        return data.id;
    }

    static async criarContainerVideo (instagramId, token, urlPublicoVideo, caption) {
        const url = `https://graph.facebook.com/v25.0/${instagramId}/media`;
        const data = await this.#postToGraphApi(url, token,
            { video_url: urlPublicoVideo, caption, media_type: 'REELS', share_to_feed: true },
            'Erro ao criar container de vídeo');
        return data.id;
    }

    static async aguardarContainerPronto (creationId, token, tentativas = 10, intervaloMs = 2000) {
        const url = `https://graph.facebook.com/v25.0/${creationId}?fields=status_code&access_token=${token}`;

        for (let i = 0; i < tentativas; i++) {
            const response = await fetch(url);
            const data = await response.json();
            if (!response.ok) throw new Error(`Erro ao consultar status do container: ${data.error.message}`);

            if (data.status_code === 'FINISHED') return;
            if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
                throw new Error(`Container falhou ao processar mídia: status ${data.status_code}`);
            }

            await new Promise(resolve => setTimeout(resolve, intervaloMs));
        }

        throw new Error('Tempo esgotado aguardando o processamento da mídia');
    }

    static async publicarContainer (instagramId, token, creationId) {
        const url = `https://graph.facebook.com/v25.0/${instagramId}/media_publish`;
        const data = await this.#postToGraphApi(url, token,
            { creation_id: creationId },
            'Erro ao publicar container');
        return data.id;
    }
}

module.exports = MetaAdapter;
