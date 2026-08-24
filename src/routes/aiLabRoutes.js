const express = require('express');
const multer = require('multer');
const router = express.Router();
const aiLabController = require('../controllers/aiLabController.js');
const authMiddleware = require('../middlewares/authMiddleware.js');
const AppError = require('../errors/AppError.js');

// PDF nunca vira mídia de post — só passa pela extração de texto e é descartado, por isso memória
// em vez de disco (ao contrário de postRoutes.js/commentRoutes.js, que salvam em .uploads).
const uploadPdf = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') cb(null, true);
        // AppError (não Error genérico): o handler global de erros (server.js) só devolve a
        // mensagem ao cliente pra esse tipo — senão o rejeito de arquivo vazaria como stack trace.
        else cb(new AppError(`Apenas PDF é aceito: ${file.mimetype}`), false);
    },
    limits: { fileSize: 50 * 1024 * 1024 }
});

router.post('/ai-lab/extrair', authMiddleware.verificarToken, uploadPdf.single('arquivo'), aiLabController.extrairPostsDoPdf);
router.post('/ai-lab/importar', authMiddleware.verificarToken, aiLabController.importarPostsExtraidos);

module.exports = router;
