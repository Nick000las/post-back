const fs = require('fs');
const path = require('path');
const AppError = require('../errors/AppError.js');
const { UPLOADS_DIR } = require('../config/uploadConfig.js');

const TIKTOK_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
// A Content Posting API exige o vídeo inteiro num chunk só (chunk_size = video_size,
// total_chunk_count = 1) SÓ quando ele cabe dentro do teto documentado por chunk (64MB) — acima
// disso, precisa dividir em N chunks de tamanho fixo dentro da faixa aceita (5–64MB), com o último
// chunk carregando o resto. uploadConfig.js aceita mídia de até 300MB, então sem isso qualquer
// vídeo grande seria enviado como um único PUT que a API rejeitaria.
// ALERTA: os limites exatos vêm da documentação pública da Content Posting API — não foram
// validados contra uma conta real (sem acesso ao TikTok neste projeto no momento). Se a publicação
// de um vídeo grande falhar, este é o primeiro lugar a conferir.
const TIKTOK_MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const TIKTOK_CHUNK_BYTES = 10 * 1024 * 1024;

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
        const { chunkSize, totalChunkCount } = this.#calcularPlanoDeChunks(tamanhoArquivo);

        const initData = await this.#inicializarUpload(post, accessToken, tamanhoArquivo, chunkSize, totalChunkCount);

        await this.#enviarArquivoBinario(caminhoCompleto, initData.upload_url, midia.file_type, tamanhoArquivo, chunkSize, totalChunkCount);

        return { success: true, externalId: initData.publish_id };
    }

    // Vídeo que cabe no teto de um chunk só vai inteiro de uma vez (chunk_size = video_size,
    // mesma matemática de sempre); acima disso, divide em chunks fixos de TIKTOK_CHUNK_BYTES —
    // todos do mesmo tamanho, exceto o último, que carrega só o resto.
    static #calcularPlanoDeChunks (tamanhoArquivo) {
        if (tamanhoArquivo <= TIKTOK_MAX_CHUNK_BYTES) {
            return { chunkSize: tamanhoArquivo, totalChunkCount: 1 };
        }
        return { chunkSize: TIKTOK_CHUNK_BYTES, totalChunkCount: Math.ceil(tamanhoArquivo / TIKTOK_CHUNK_BYTES) };
    }

    static async #inicializarUpload (post, accessToken, tamanhoArquivo, chunkSize, totalChunkCount) {
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
                chunk_size: chunkSize,
                total_chunk_count: totalChunkCount
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

    // Sequencial de propósito: o protocolo do TikTok manda todos os chunks pra MESMA upload_url,
    // em ordem — mandar em paralelo arriscaria a API receber fora de ordem. Pára no primeiro chunk
    // que falhar (não faz sentido continuar enviando o resto de um upload que já foi rejeitado).
    static async #enviarArquivoBinario (caminhoCompleto, uploadUrl, fileType, tamanhoArquivo, chunkSize, totalChunkCount) {
        const fileBuffer = fs.readFileSync(caminhoCompleto);

        for (let indice = 0; indice < totalChunkCount; indice++) {
            const inicio = indice * chunkSize;
            const fim = Math.min(inicio + chunkSize, tamanhoArquivo);

            const response = await fetch(uploadUrl, {
                method: 'PUT',
                headers: {
                    'Content-Type': fileType,
                    'Content-Range': `bytes ${inicio}-${fim - 1}/${tamanhoArquivo}`
                },
                body: fileBuffer.subarray(inicio, fim)
            });

            if (!response.ok) {
                console.error('Erro no upload binário para o TikTok', { httpStatus: response.status, chunk: indice + 1, totalChunkCount });
                throw new AppError(`Falha ao enviar os dados do vídeo para o TikTok (chunk ${indice + 1}/${totalChunkCount}).`);
            }
        }
    }
}

module.exports = TiktokAdapter;
