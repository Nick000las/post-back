const express = require('express');
const multer = require('multer');
const router = express.Router();
const aiLabController = require('../controllers/aiLabController.js');
const authMiddleware = require('../middlewares/authMiddleware.js');

// PDF nunca vira mídia de post — só passa pela extração de texto e é descartado, por isso memória
// em vez de disco (ao contrário de postRoutes.js/commentRoutes.js, que salvam em .uploads).
const uploadPdf = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') cb(null, true);
        else cb(new Error(`Apenas PDF é aceito: ${file.mimetype}`), false);
    },
    limits: { fileSize: 50 * 1024 * 1024 }
});

router.post('/ai-lab/extrair', authMiddleware.verificarToken, uploadPdf.single('arquivo'), aiLabController.extrairPostsDoPdf);
router.post('/ai-lab/importar', authMiddleware.verificarToken, aiLabController.importarPostsExtraidos);

module.exports = router;
