const express = require('express');
const router = express.Router();
const storyController = require('../controllers/storyController.js');
const authMiddleware = require('../middlewares/authMiddleware.js');
const { uploadMidia } = require('../config/uploadConfig.js');

// Story é sempre 1 mídia — a API de Stories da Meta não tem carrossel. Por isso .single em vez do
// .array usado nas rotas de FEED: o multer já barra o segundo arquivo, sem precisar de checagem
// de contagem no controller.
const uploadStory = uploadMidia.single('arquivo');

router.post('/stories/publish', authMiddleware.verificarToken, uploadStory, storyController.publicarStory);
router.post('/stories/schedule', authMiddleware.verificarToken, uploadStory, storyController.agendarStory);
router.post('/stories/draft', authMiddleware.verificarToken, uploadStory, storyController.salvarDraft);
router.get('/stories/drafts', authMiddleware.verificarToken, storyController.listarDrafts);

// /stories/recurrence/:recurrenceId precisa vir ANTES de /stories/:id, senão o Express casaria
// "recurrence" como valor de :id.
router.get('/stories/recurrence', authMiddleware.verificarToken, storyController.listarSeries);
router.get('/stories/recurrence/:recurrenceId', authMiddleware.verificarToken, storyController.listarSerie);
router.delete('/stories/recurrence/:recurrenceId', authMiddleware.verificarToken, storyController.cancelarSerie);
router.post('/stories/recurrence/:recurrenceId/occurrences', authMiddleware.verificarToken, storyController.estenderSerie);
// Diferente do DELETE acima (cancela — colapsa, preserva histórico): apaga a série inteira, sem
// deixar rascunho. Mesmo sufixo /occurrences do POST de estender: um representa o recurso "todas
// as ocorrências da série", o outro apaga esse recurso por completo.
router.delete('/stories/recurrence/:recurrenceId/occurrences', authMiddleware.verificarToken, storyController.excluirSerie);

router.get('/stories/:id', authMiddleware.verificarToken, storyController.buscarStory);
router.put('/stories/:id/media', authMiddleware.verificarToken, uploadStory, storyController.atualizarMidiaStory);
router.put('/stories/:id/accounts', authMiddleware.verificarToken, storyController.vincularContas);
router.delete('/stories/:id', authMiddleware.verificarToken, storyController.excluirStory);
router.post('/stories/:id/publish', authMiddleware.verificarToken, storyController.publicarDraftStory);
router.post('/stories/:id/schedule', authMiddleware.verificarToken, storyController.agendarDraftStory);
router.put('/stories/:id/schedule', authMiddleware.verificarToken, storyController.alterarDataStory);
router.delete('/stories/:id/schedule', authMiddleware.verificarToken, storyController.cancelarAgendamentoStory);
router.get('/stories/:id/status', authMiddleware.verificarToken, storyController.consultarStatus);

module.exports = router;
