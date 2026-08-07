const express = require('express');
const multer = require('multer');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const postController = require('../controllers/postController.js');
const authMiddleware = require('../middlewares/authMiddleware.js');

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
const ALLOWED_MIDIA_MIME_TYPES = [...ALLOWED_IMAGE_MIME_TYPES, ...ALLOWED_VIDEO_MIME_TYPES];

const criarFiltroDeArquivo = (tiposPermitidos, mensagemErro) => (req, file, cb) => {
    if (tiposPermitidos.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`${mensagemErro}: ${file.mimetype}`), false);
    }
};

// Teto do carrossel do Instagram — as outras plataformas rejeitam antes disso de qualquer forma
// (TikTok/Linkedin nem aceitam carrossel nesta integração).
const MAX_CAROUSEL_ITEMS = 10;

const uploadMidia = multer({
    storage,
    fileFilter: criarFiltroDeArquivo(ALLOWED_MIDIA_MIME_TYPES, 'Formato não suportado. Use JPEG, PNG, MP4 ou MOV'),
    limits: { fileSize: 300 * 1024 * 1024 }
});

// Todas as rotas de mídia aceitam N arquivos no MESMO campo 'arquivo': 1 = post simples, 2+ =
// carrossel. Não há rota separada pra carrossel — a contagem é o que distingue.
const uploadCarrossel = uploadMidia.array('arquivo', MAX_CAROUSEL_ITEMS);

router.post('/upload/lote', authMiddleware.verificarToken, uploadCarrossel, postController.publicarEmLote);
router.post('/upload/draft', authMiddleware.verificarToken, uploadCarrossel, postController.salvarDraft);
router.post('/upload/schedule', authMiddleware.verificarToken, uploadCarrossel, postController.agendarPostagem);
router.delete('/schedule/:id', authMiddleware.verificarToken, postController.cancelarAgendamento);
router.put('/schedule/:id', authMiddleware.verificarToken, postController.alterarDataAgendamento);
router.delete('/posts/:id', authMiddleware.verificarToken, postController.excluirPost);
router.post('/draft/:id/publish', authMiddleware.verificarToken, postController.publicarDraft);
router.post('/draft/:id/schedule', authMiddleware.verificarToken, postController.agendarDraft);
router.put('/draft/:id', authMiddleware.verificarToken, postController.atualizarDraft);
router.put('/draft/:id/media', authMiddleware.verificarToken, uploadCarrossel, postController.atualizarMidiaDraft);
router.put('/draft/:id/accounts', authMiddleware.verificarToken, postController.vincularContasAoDraft);
router.delete('/draft/:id/media', authMiddleware.verificarToken, postController.removerMidiaDraft);
router.delete('/draft/:id/media/:mediaId', authMiddleware.verificarToken, postController.removerItemDeMidia);
router.delete('/draft/:id', authMiddleware.verificarToken, postController.excluirDraft);
router.get('/draft/:id', authMiddleware.verificarToken, postController.buscarDraft);
router.get('/drafts', authMiddleware.verificarToken, postController.listarDrafts);

router.get('/feed', authMiddleware.verificarToken, postController.listarFeedGlobal);
router.get('/feed/cliente', authMiddleware.verificarToken, postController.listarFeedCliente);
router.post('/posts/:id/republicar', authMiddleware.verificarToken, postController.republicarPost);
router.get('/posts/:id/status', authMiddleware.verificarToken, postController.consultarStatusPost);
router.put('/posts/:id/move', authMiddleware.verificarToken, postController.moverPost);

module.exports = router;