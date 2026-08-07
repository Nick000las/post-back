const fs = require('fs');
const path = require('path');
const AppError = require('../errors/AppError.js');

const UPLOADS_DIR = '.uploads';
const TIKTOK_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';

class TiktokAdapter {
    static async publicarContainer (post, accessToken, tiktokAccountId) {
        if (!tiktokAccountId) throw new AppError('ID da conta do TikTok ausente.');
        if (post.media.length === 0) throw new AppError('Post sem mídia para publicar.');

        if (post.media.length > 1) {
            return this.#publicarCarrosselFotos(post, accessToken);
        }

        const [midia] = post.media;
        if (!midia.file_type.startsWith('video/')) {
            throw new AppError('O TikTok suporta apenas uploads de vídeo nessa integração.');
        }

        return this.#publicarVideo(post, midia, accessToken);
    }

    // Carrossel do TikTok: a API não publica carrossel de vídeo — "carrossel" lá é sempre um post
    // de N FOTOS (media_type: 'PHOTO'), num fluxo de init separado do vídeo (endpoint, corpo e
    // forma de envio do arquivo são todos diferentes de #inicializarUpload/#enviarArquivoBinario).
    // Só é chamado com 2+ itens (garantido por publicarContainer).
    static async #publicarCarrosselFotos (post, accessToken) {
        if (post.media.some(midia => midia.file_type.startsWith('video/'))) {
            throw new AppError('O TikTok não suporta carrossel com vídeo.');
        }

        // PULL_FROM_URL: a TikTok busca a imagem direto na nossa URL pública, sem precisar
        // reimplementar o upload binário em chunks que #enviarArquivoBinario faz pro vídeo. .map
        // (síncrono) já preserva a ordem de post.media, sem precisar de Promise.all aqui.
        const photoImages = post.media.map(midia => this.#construirUrlPublicaMidia(midia.file_path));

        const body = {
            post_info: {
                title: post.caption,
                privacy_level: 'PUBLIC_TO_EVERYONE',
                disable_comment: false,
                disable_duet: false,
                disable_stitch: false
            },
            post_mode: 'DIRECT_POST',
            media_type: 'PHOTO',
            source_info: {
                source: 'PULL_FROM_URL',
                photo_cover_index: 0,
                photo_images: photoImages
            }
        };

        const response = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8'
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (!response.ok || (data.error && data.error.code !== 'ok')) {
            const mensagemErro = data.error ? data.error.message : 'Erro desconhecido';
            console.error('Erro ao inicializar carrossel de fotos no TikTok', { httpStatus: response.status, error: data.error });
            throw new AppError(`Erro no init do TikTok: ${mensagemErro}`);
        }

        return { success: true, externalId: data.data.publish_id };
    }

    static #construirUrlPublicaMidia (filePath) {
        return `${process.env.BASE_URL}/uploads/${filePath}`;
    }

    static async #publicarVideo (post, midia, accessToken) {
        const caminhoCompleto = path.join(UPLOADS_DIR, midia.file_path);
        const { size: tamanhoArquivo } = fs.statSync(caminhoCompleto);

        const initData = await this.#inicializarUpload(post, accessToken, tamanhoArquivo);

        await this.#enviarArquivoBinario(caminhoCompleto, initData.upload_url, midia.file_type, tamanhoArquivo);

        return { success: true, externalId: initData.publish_id };
    }

    static async #inicializarUpload (post, accessToken, tamanhoArquivo) {
        const body = {
            post_info: {
                title: post.caption,
                privacy_level: 'PUBLIC_TO_EVERYONE',
                disable_duet: false,
                disable_comment: false,
                disable_stitch: false
            },
            source_info: {
                source: 'FILE_UPLOAD',
                video_size: tamanhoArquivo,
                chunk_size: tamanhoArquivo,
                total_chunk_count: 1
            }
        };

        const response = await fetch(TIKTOK_INIT_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8'
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (!response.ok || (data.error && data.error.code !== 'ok')) {
            const mensagemErro = data.error ? data.error.message : 'Erro desconhecido';
            console.error('Erro ao inicializar upload no TikTok', { httpStatus: response.status, error: data.error });
            throw new AppError(`Erro no init do TikTok: ${mensagemErro}`);
        }

        return data.data;
    }

    static async #enviarArquivoBinario (caminhoCompleto, uploadUrl, fileType, tamanhoArquivo) {
        const fileBuffer = fs.readFileSync(caminhoCompleto);

        const response = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': fileType,
                'Content-Range': `bytes 0-${tamanhoArquivo - 1}/${tamanhoArquivo}`
            },
            body: fileBuffer
        });

        if (!response.ok) {
            console.error('Erro no upload binário para o TikTok', { httpStatus: response.status });
            throw new AppError('Falha ao enviar os dados do vídeo para o TikTok.');
        }
    }
}

module.exports = TiktokAdapter;
