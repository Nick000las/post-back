const express = require('express');
const router = express.Router();
const kanbanController = require('../controllers/kanbanController.js');
const authMiddleware = require('../middlewares/authMiddleware.js');

router.get('/kanban', authMiddleware.verificarToken, kanbanController.buscarQuadro);
router.get('/columns', authMiddleware.verificarToken, kanbanController.listarColunas);
router.post('/columns', authMiddleware.verificarToken, kanbanController.criarColuna);
router.put('/columns/:id', authMiddleware.verificarToken, kanbanController.renomearColuna);
router.delete('/columns/:id', authMiddleware.verificarToken, kanbanController.excluirColuna);

module.exports = router;
