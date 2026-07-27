const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController.js');
const authMiddleware = require('../middlewares/authMiddleware');

router.get('/clients', authMiddleware.verificarToken, clientController.listarClients);
router.post('/clients', authMiddleware.verificarToken, clientController.criarClient);
router.put('/clients/:id', authMiddleware.verificarToken, clientController.atualizarClient);
router.delete('/clients/:id', authMiddleware.verificarToken, clientController.excluirClient);

module.exports = router;
