const fs = require('fs');
const path = require('path');
const AppError = require('../errors/AppError.js');

const UPLOADS_DIR = '.uploads';
const TIKTOK_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';

class TiktokAdapter {
    static async publicarContainer (post, accessToken, tiktokAccountId) {
        if (!tiktokAccountId) throw new AppError('ID da conta do TikTok ausente.');

        if (!post.file_path || !post.file_type.startsWith('video/')) {
            throw new AppError('O TikTok suporta apenas uploads de vídeo nessa integração.');
        }

        return this.#publicarVideo(post, accessToken);
    }

    static async #publicarVideo (post, accessToken) {
        const caminhoCompleto = path.join(UPLOADS_DIR, post.file_path);
        const { size: tamanhoArquivo } = fs.statSync(caminhoCompleto);

        const initData = await this.#inicializarUpload(post, accessToken, tamanhoArquivo);

        await this.#enviarArquivoBinario(caminhoCompleto, initData.upload_url, post.file_type, tamanhoArquivo);

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
