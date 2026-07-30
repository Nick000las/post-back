const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const UPLOADS_DIR = path.join(__dirname, '..', '..', '.uploads');
const THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbs');
const THUMB_WIDTH = 400;

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'];
const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'];

// Mesmo padrão de postRoutes.js pra garantir a pasta de uploads: efeito colateral de import, roda uma
// vez quando o módulo é carregado.
if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });

class ThumbnailService {

    // Ponto de entrada único, chamado pelo controller logo após o multer salvar o arquivo original.
    // NÃO deve lançar erro pra fora — falha na geração de thumb não pode derrubar o upload principal.
    // Retorna o nome do arquivo de thumb gerado (relativo a THUMBS_DIR), ou null se não gerou.
    static async gerar (arquivo) {
        try {
            const caminhoOriginal = path.join(UPLOADS_DIR, arquivo.filename);
            const nomeThumb = ThumbnailService.#gerarNomeThumb(arquivo.filename);

            if (ALLOWED_IMAGE_MIME_TYPES.includes(arquivo.mimetype)) {
                return await ThumbnailService.#gerarThumbImagem(caminhoOriginal, nomeThumb);
            }

            if (ALLOWED_VIDEO_MIME_TYPES.includes(arquivo.mimetype)) {
                return await ThumbnailService.#gerarThumbVideo(caminhoOriginal, nomeThumb);
            }

            return null;
        } catch (erro) {
            // TODO: logar o erro (console.error com contexto tipo 'Falha ao gerar thumbnail:') e
            // retornar null — o upload principal (arquivo.filename/file_path) já está salvo e válido,
            // um post sem thumbnail_path é um estado aceitável (frontend cai pro arquivo original).
            
            console.error('Falha ao gerar Thumbnail: ', erro.message);       
            
            return null;
        }
    }

    // Deriva o nome do arquivo de thumb a partir do nome do arquivo original, sempre terminando em
    // .jpg (mesmo pra vídeo, já que a thumb de vídeo é sempre um frame estático).
    static #gerarNomeThumb (nomeArquivoOriginal) {
        // TODO: `${path.parse(nomeArquivoOriginal).name}.jpg`
        const nomeThumb = `${path.parse(nomeArquivoOriginal).name}.jpg`;
        return nomeThumb;
    }

    // TODO: usar sharp(caminhoOriginal).resize(THUMB_WIDTH).jpeg({ quality: 70 }).toFile(caminho
    // completo em THUMBS_DIR + nomeThumb). Retornar nomeThumb ao final.
    static async #gerarThumbImagem (caminhoOriginal, nomeThumb) {
        await sharp(caminhoOriginal).resize(THUMB_WIDTH).jpeg({ quality: 70 }).toFile(path.join(THUMBS_DIR, nomeThumb));
        return nomeThumb;
    }

    // TODO: usar fluent-ffmpeg (ffmpeg(caminhoOriginal).screenshots({ timestamps: ['00:00:01'],
    // filename: nomeThumb, folder: THUMBS_DIR, size: `${THUMB_WIDTH}x?` })) — a API do fluent-ffmpeg é
    // baseada em eventos ('end'/'error'), então esta função precisa envolver a chamada numa Promise
    // manual (new Promise((resolve, reject) => { ... })) pra poder usar await aqui.
    // Ponto de atenção: se o vídeo durar menos de 1s, o timestamp '00:00:01' pode falhar — considerar
    // um timestamp mais seguro tipo '00:00:00.5' ou tratar o evento 'error' rejeitando a Promise (o
    // catch em gerar() já cobre isso retornando null).
    static async #gerarThumbVideo(caminhoOriginal, nomeThumb) {
            await new Promise((resolve, reject) => {
                ffmpeg(caminhoOriginal)
                    .on('end', () => resolve())
                    .on('error', (err) => {
                        console.error('Erro ao gerar thumb do vídeo:', err);
                        reject(err);
                    })
                    .screenshots({ 
                        timestamps: ['00:00:00.5'], 
                        filename: nomeThumb, 
                        folder: THUMBS_DIR, 
                        size: `${THUMB_WIDTH}x?` 
                    });
            });
            
            return nomeThumb; 
        }
}

module.exports = ThumbnailService;
