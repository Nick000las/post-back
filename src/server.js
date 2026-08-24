const express = require('express');
const cors = require('cors');
require('dotenv').config();
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { UPLOADS_DIR } = require('./config/uploadConfig.js');
const AppError = require('./errors/AppError.js');
const postRoutes = require('./routes/postRoutes.js');
const userRoutes = require('./routes/userRoutes.js');
const authRoutes = require('./routes/authRoutes.js');
const clientRoutes = require('./routes/clientRoutes.js');
const kanbanRoutes = require('./routes/kanbanRoutes.js');
const commentRoutes = require('./routes/commentRoutes.js');
const aiLabRoutes = require('./routes/aiLabRoutes.js');
const storyRoutes = require('./routes/storyRoutes.js');

const app = express();
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 3001;

// crossOriginResourcePolicy do helmet (aplicado globalmente acima) tem default 'same-origin', que
// bloquearia o frontend (origem diferente, ver FRONTEND_URL) de carregar as imagens/vídeos daqui
// via <img>/<video> — o próprio propósito desta rota é servir mídia pra um domínio diferente.
// Relaxado só aqui, não pro resto da API.
app.use('/uploads', helmet.crossOriginResourcePolicy({ policy: 'cross-origin' }), express.static(UPLOADS_DIR));
app.use(morgan('dev'));

app.use('/', postRoutes);
app.use('/', userRoutes);
app.use('/', authRoutes);
app.use('/', clientRoutes);
app.use('/', kanbanRoutes);
app.use('/', commentRoutes);
app.use('/', aiLabRoutes);
app.use('/', storyRoutes);

// Rede de segurança final: cobre qualquer erro que escape dos try/catch dos controllers (body
// JSON malformado, rejeição de arquivo pelo multer, uma exceção síncrona esquecida) — sem isso o
// handler default do Express devolve o stack trace completo (com caminho absoluto do servidor) pra
// qualquer cliente. Precisa ser o ÚLTIMO app.use, com 4 argumentos (é o que o Express usa pra
// identificar um error handler).
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(400).json({ error: err.message });
  }
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
    return res.status(400).json({ error: 'Corpo da requisição inválido (JSON malformado).' });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  console.error('Erro não tratado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

