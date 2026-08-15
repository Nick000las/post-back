const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Config de upload compartilhada entre postRoutes (FEED/carrossel) e storyRoutes (Stories):
// mesmo destino em disco, mesmo padrão de nome de arquivo e mesmos tipos aceitos. Só a aridade
// muda (.array pra carrossel, .single pra Story), e isso fica com cada rota.

const UPLOADS_DIR = '.uploads';

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'];
const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'];
const ALLOWED_MIDIA_MIME_TYPES = [...ALLOWED_IMAGE_MIME_TYPES, ...ALLOWED_VIDEO_MIME_TYPES];

const criarFiltroDeArquivo = (tiposPermitidos, mensagemErro) => (req, file, cb) => {
    if (tiposPermitidos.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`${mensagemErro}: ${file.mimetype}`), false);
    }
};

const uploadMidia = multer({
    storage,
    fileFilter: criarFiltroDeArquivo(ALLOWED_MIDIA_MIME_TYPES, 'Formato não suportado. Use JPEG, PNG, MP4 ou MOV'),
    limits: { fileSize: 300 * 1024 * 1024 }
});

module.exports = { uploadMidia };
