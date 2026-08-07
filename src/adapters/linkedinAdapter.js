const fs = require('fs');
const path = require('path');
const AppError = require('../errors/AppError.js');

const UPLOADS_DIR = '.uploads';
const UGC_POSTS_URL = 'https://api.linkedin.com/v2/ugcPosts';
const ASSETS_REGISTER_UPLOAD_URL = 'https://api.linkedin.com/v2/assets?action=registerUpload';
const VISIBILITY_PUBLIC = { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' };

class LinkedinAdapter {
    static async publicarContainer (post, accessToken, authorUrn) {
        if (!authorUrn || !authorUrn.startsWith('urn:li:')) {
            throw new AppError('URN do Linkedin inválido ou ausente.');
        }

        // Rejeita carrossel explicitamente: sem isso, os itens extras seriam ignorados em silêncio
        // e o usuário publicaria só o primeiro achando que publicou todos.
        if (post.media.length > 1) {
            throw new AppError('O Linkedin não suporta carrossel nessa integração.');
        }

        const [midia] = post.media;
        if (!midia) {
            return this.#publicarTexto(post.caption, accessToken, authorUrn);
        }

        return this.#publicarComMedia(post, midia, accessToken, authorUrn);
    }

    static async #publicarTexto (texto, accessToken, authorUrn) {
        const body = {
            author: authorUrn,
            lifecycleState: 'PUBLISHED',
            specificContent: {
                'com.linkedin.ugc.ShareContent': {
                    shareCommentary: { text: texto },
                    shareMediaCategory: 'NONE'
                }
            },
            visibility: VISIBILITY_PUBLIC
        };

        const data = await this.#postUgc(body, accessToken, 'Erro ao criar post de texto no Linkedin');
        return { success: true, externalId: data.id };
    }

    static async #publicarComMedia (post, midia, accessToken, authorUrn) {
        const { uploadUrl, assetUrn, isVideo } = await this.#registrarUploadMidia(authorUrn, accessToken, midia.file_type);

        await this.#enviarArquivoBinario(midia.file_path, uploadUrl, accessToken);

        const body = {
            author: authorUrn,
            lifecycleState: 'PUBLISHED',
            specificContent: {
                'com.linkedin.ugc.ShareContent': {
                    shareCommentary: { text: post.caption },
                    shareMediaCategory: isVideo ? 'VIDEO' : 'IMAGE',
                    media: [
                        {
                            status: 'READY',
                            description: { text: midia.file_name },
                            media: assetUrn,
                            title: { text: midia.file_name }
                        }
                    ]
                }
            },
            visibility: VISIBILITY_PUBLIC
        };

        const data = await this.#postUgc(body, accessToken, 'Erro ao criar post com mídia no Linkedin');
        return { success: true, externalId: data.id };
    }

    static async #registrarUploadMidia (authorUrn, accessToken, fileType) {
        const isVideo = fileType.startsWith('video/');
        const recipe = isVideo ? 'urn:li:digitalmediaRecipe:feedshare-video' : 'urn:li:digitalmediaRecipe:feedshare-image';

        const body = {
            registerUploadRequest: {
                recipes: [recipe],
                owner: authorUrn,
                serviceRelationships: [
                    {
                        relationshipType: 'OWNER',
                        identifier: 'urn:li:userGeneratedContent'
                    }
                ]
            }
        };

        const response = await fetch(ASSETS_REGISTER_UPLOAD_URL, {
            method: 'POST',
            headers: this.#getHeaders(accessToken),
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Erro ao registrar upload no Linkedin', { httpStatus: response.status, errorData });
            throw new AppError('Falha ao registrar upload no Linkedin.');
        }

        const data = await response.json();
        const uploadUrl = data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
        const assetUrn = data.value.asset;

        return { uploadUrl, assetUrn, isVideo };
    }

    static async #enviarArquivoBinario (filePath, uploadUrl, accessToken) {
        const caminhoCompleto = path.join(UPLOADS_DIR, filePath);
        const fileBuffer = fs.readFileSync(caminhoCompleto);

        const response = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/octet-stream'
            },
            body: fileBuffer
        });

        if (!response.ok) {
            console.error('Erro no upload binário para o Linkedin', { httpStatus: response.status });
            throw new AppError('Falha no upload binário do arquivo para o Linkedin.');
        }
    }

    static async #postUgc (body, accessToken, errorContext) {
        const response = await fetch(UGC_POSTS_URL, {
            method: 'POST',
            headers: this.#getHeaders(accessToken),
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error(errorContext, { httpStatus: response.status, errorData });
            throw new AppError(`${errorContext}: ${errorData}`);
        }

        return response.json();
    }

    static #getHeaders (accessToken) {
        return {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202401'
        };
    }
}

module.exports = LinkedinAdapter;
