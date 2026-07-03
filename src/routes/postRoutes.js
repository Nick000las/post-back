const express = require('express');
const multer = require('multer');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const postController = require('../controllers/postController.js');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = '.uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
})

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'];
const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'];

const criarFiltroDeArquivo = (tiposPermitidos, mensagemErro) => (req, file, cb) => {
    if (tiposPermitidos.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`${mensagemErro}: ${file.mimetype}`), false);
    }
};

const uploadImagem = multer({
    storage,
    fileFilter: criarFiltroDeArquivo(ALLOWED_IMAGE_MIME_TYPES, 'Formato de imagem não suportado. Use JPEG ou PNG')
});

const uploadVideo = multer({
    storage,
    fileFilter: criarFiltroDeArquivo(ALLOWED_VIDEO_MIME_TYPES, 'Formato de vídeo não suportado. Use MP4 ou MOV'),
    limits: { fileSize: 300 * 1024 * 1024 }
});

router.post('/upload/img', uploadImagem.single('image'), postController.publicarImagemInstagram);
router.post('/upload/vid', uploadVideo.single('video'), postController.publicarVideoInstagram);

module.exports = router;