const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController.js');
const authMiddleware = require('../middlewares/authMiddleware');

router.get('/contas', authMiddleware.verificarToken, userController.listarContas);
router.post('/contas', authMiddleware.verificarToken, userController.criarConta);
router.put('/contas/:id', authMiddleware.verificarToken, userController.atualizarConta);
router.delete('/contas/:id', authMiddleware.verificarToken, userController.excluirConta);

module.exports = router;
