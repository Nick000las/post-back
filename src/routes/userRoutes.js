const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController.js');

router.get('/contas', userController.listarContas);

module.exports = router;
