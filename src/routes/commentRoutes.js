const express = require('express');
const multer = require('multer');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const commentController = require('../controllers/commentController.js');
const authMiddleware = require('../middlewares/authMiddleware.js');

// Pasta separada de posts (mesmo nível de .uploads/thumbs/) — anexos de chat não são "mídia de post".
const ATTACHMENTS_DIR = '.uploads/comment-attachments';

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(ATTACHMENTS_DIR)) fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
        cb(null, ATTACHMENTS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

// Whitelist validada com o usuário: imagem, pdf, zip, docx, vídeo — até 50MB.
const ALLOWED_ATTACHMENT_MIME_TYPES = [
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
    'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'video/mp4', 'video/quicktime'
];

const fileFilter = (req, file, cb) => {
    if (ALLOWED_ATTACHMENT_MIME_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Formato de anexo não suportado: ${file.mimetype}`), false);
};

const uploadAnexo = multer({
    storage,
    fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 }
});

// Campo do multipart se chama 'anexo' (não 'arquivo', pra não confundir com o campo de mídia de post).
router.get('/posts/:id/comments', authMiddleware.verificarToken, commentController.listarComentarios);
router.post('/posts/:id/comments', authMiddleware.verificarToken, uploadAnexo.single('anexo'), commentController.criarComentario);

module.exports = router;
