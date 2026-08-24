const fs = require('fs');
const path = require('path');
const AppError = require('../errors/AppError.js');
const { UPLOADS_DIR } = require('../config/uploadConfig.js');

const UGC_POSTS_URL = 'https://api.linkedin.com/v2/ugcPosts';
const ASSETS_REGISTER_UPLOAD_URL = 'https://api.linkedin.com/v2/assets?action=registerUpload';
const VISIBILITY_PUBLIC = { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' };
// Mesma ordem de grandeza do polling de vídeo do metaAdapter.js (30 tentativas x 5s = até 150s) —
// não há um SLA documentado publicamente pro tempo de processamento de vídeo do Linkedin, mas o
// vídeo do Instagram/Facebook é a única referência de mesma escala que já validamos neste projeto.
const LINKEDIN_POLLING_VIDEO = { tentativas: 30, intervaloMs: 5000 };
// A Assets API só aceita vídeo num único PUT até 200MB; acima disso exigiria registrar como
// MULTIPART_UPLOAD e subir em partes. Não é caso hipotético: o multer aceita até 300MB
// (uploadConfig.js) e não há validação de tamanho no caminho até aqui, então a faixa de 200-300MB
// chega neste adapter — e é recusada em #validarTamanhoDeVideo enquanto o multipart não existe.
const LIMITE_UPLOAD_UNICO_BYTES = 200 * 1024 * 1024;
// Valores de recipes[].status documentados na Assets API. Enumerados de propósito, em vez de
// "qualquer coisa que não seja PROCESSING": os status de falha precisam ser distinguidos de
// sucesso, senão o post é criado apontando pra um asset quebrado (e o publishWorker registra isso
// como SUCCESS, porque pra ele o adapter ter retornado sem lançar já é sucesso).
// MUTATING conta como pronto porque a doc diz que o asset segue servível durante o reprocessamento.
const ASSET_STATUS_PRONTO = ['AVAILABLE', 'MUTATING'];
const ASSET_STATUS_FALHA = ['CLIENT_ERROR', 'SERVER_ERROR', 'INCOMPLETE'];
// Status do asset (não do recipe) em que o conteúdo não pode ser servido, mesmo com o recipe
// AVAILABLE — publicar apontando pra um destes daria post quebrado do mesmo jeito.
const ASSET_STATUS_SERVIVEL = 'ALLOWED';

class LinkedinAdapter {
    static async publicarContainer (post, accessToken, authorUrn) {
        if (!authorUrn || !authorUrn.startsWith('urn:li:')) {
            throw new AppError('URN do Linkedin inválido ou ausente.');
        }

        if (post.media.length > 1) {
            return this.#publicarCarrosselFotos(post, accessToken, authorUrn);
        }

        const [midia] = post.media;
        if (!midia) {
            return this.#publicarTexto(post.caption, accessToken, authorUrn);
        }

        return this.#publicarComMedia(post, midia, accessToken, authorUrn);
    }

    // Carrossel do Linkedin: a UGC API aceita múltiplas imagens no MESMO post (array `media` com
    // 2+ entradas, cada uma com seu próprio asset registrado), mas não existe carrossel de vídeo.
    // Só é chamado com 2+ itens (garantido por publicarContainer).
    static async #publicarCarrosselFotos (post, accessToken, authorUrn) {
        if (post.media.some(midia => midia.file_type.startsWith('video/'))) {
            throw new AppError('O Linkedin não suporta carrossel com vídeo.');
        }

        // Promise.all preserva a ordem do array de ENTRADA no resultado — garante que o carrossel
        // saia na mesma ordem em que o usuário subiu os arquivos, mesmo que os uploads (rede)
        // terminem fora de ordem (mesma garantia já usada no carrossel da Meta, ver metaAdapter.js).
        const itensCarrossel = await Promise.all(post.media.map(async midia => {
            const { uploadUrl, assetUrn } = await this.#registrarUploadMidia(authorUrn, accessToken, midia.file_type);
            await this.#enviarArquivoBinario(midia.file_path, uploadUrl, accessToken);

            return { assetUrn, fileName: midia.file_name };
        }));

        const body = {
            author: authorUrn,
            lifecycleState: 'PUBLISHED',
            specificContent: {
                'com.linkedin.ugc.ShareContent': {
                    shareCommentary: { text: post.caption },
                    shareMediaCategory: 'IMAGE',
                    media: itensCarrossel.map(({ assetUrn, fileName }) => ({
                        status: 'READY',
                        description: { text: fileName },
                        media: assetUrn,
                        title: { text: fileName }
                    }))
                }
            },
            visibility: VISIBILITY_PUBLIC
        };

        const data = await this.#postUgc(body, accessToken, 'Erro ao criar post de carrossel de fotos no Linkedin');
        return { success: true, externalId: data.id };
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
        this.#validarTamanhoDeVideo(midia);

        const { uploadUrl, assetUrn, isVideo } = await this.#registrarUploadMidia(authorUrn, accessToken, midia.file_type);

        await this.#enviarArquivoBinario(midia.file_path, uploadUrl, accessToken);
        // Só vídeo precisa esperar — imagem processa rápido o bastante pra criar o post logo em
        // seguida sem problema (mesmo raciocínio do metaAdapter.js: POLLING_IMAGEM vs POLLING_VIDEO).
        if (isVideo) await this.#aguardarAssetPronto(assetUrn, accessToken);

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

    // Roda ANTES do registerUpload de propósito: registrar primeiro e só depois descobrir que o
    // arquivo é grande demais deixaria um asset órfão no Linkedin a cada tentativa. O carrossel não
    // precisa deste guard porque já rejeita vídeo antes (ver #publicarCarrosselFotos).
    static #validarTamanhoDeVideo (midia) {
        if (!midia.file_type.startsWith('video/')) return;

        const { size } = fs.statSync(path.join(UPLOADS_DIR, midia.file_path));
        if (size > LIMITE_UPLOAD_UNICO_BYTES) {
            console.error('Vídeo acima do limite de upload único do Linkedin', { fileName: midia.file_name, size });
            // Mensagem precisa dizer o limite: o upload do projeto aceita mais que isso (300MB), então
            // o arquivo já está no disco e o usuário não tem como adivinhar que o corte é do Linkedin.
            throw new AppError('O Linkedin não aceita vídeo acima de 200MB. Envie um arquivo menor.');
        }
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


    static async #aguardarAssetPronto (assetUrn, accessToken) {
        const assetId = assetUrn.split(':').pop();
        const url = `https://api.linkedin.com/v2/assets/${assetId}`;

        for (let i = 0; i < LINKEDIN_POLLING_VIDEO.tentativas; i++) {
            const response = await fetch(url, { headers: this.#getHeaders(accessToken) });
            const data = await response.json();

            if (!response.ok) {
                console.error('Erro ao consultar status do asset no Linkedin', { assetUrn, httpStatus: response.status, data });
                throw new AppError('Erro ao consultar status do vídeo no Linkedin.');
            }

            const status = data.recipes?.[0]?.status;
            if (ASSET_STATUS_FALHA.includes(status)) {
                console.error('Asset de vídeo falhou ao processar no Linkedin', { assetUrn, status });
                throw new AppError('O Linkedin falhou ao processar o vídeo enviado.');
            }
            if (data.status && data.status !== ASSET_STATUS_SERVIVEL) {
                console.error('Asset de vídeo não pode ser servido pelo Linkedin', { assetUrn, statusDoAsset: data.status });
                throw new AppError('O Linkedin bloqueou o vídeo enviado.');
            }
            if (ASSET_STATUS_PRONTO.includes(status)) return;

            // NEW, PROCESSING, WAITING_UPLOAD ou qualquer status não documentado: segue aguardando.
            await new Promise(resolve => setTimeout(resolve, LINKEDIN_POLLING_VIDEO.intervaloMs));
        }

        console.error('Tempo esgotado aguardando o processamento do vídeo no Linkedin', { assetUrn });
        throw new AppError('Tempo esgotado aguardando o processamento do vídeo no Linkedin.');
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
