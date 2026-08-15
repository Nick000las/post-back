const express = require('express');
const router = express.Router();
const postController = require('../controllers/postController.js');
const authMiddleware = require('../middlewares/authMiddleware.js');
const { uploadMidia } = require('../config/uploadConfig.js');

// Teto do carrossel do Instagram — as outras plataformas rejeitam antes disso de qualquer forma
// (TikTok/Linkedin nem aceitam carrossel de vídeo nesta integração).
const MAX_CAROUSEL_ITEMS = 10;

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