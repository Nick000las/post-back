const express = require('express');
const cors = require('cors');
require('dotenv').config();
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const path = require('path');
const postRoutes = require('./routes/postRoutes.js');
const userRoutes = require('./routes/userRoutes.js');
const authRoutes = require('./routes/authRoutes.js');
const clientRoutes = require('./routes/clientRoutes.js');

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 3001;

app.use('/uploads', express.static(path.join(__dirname, '..', '.uploads')));
app.use(morgan('dev'));

app.use('/', postRoutes);
app.use('/', userRoutes);
app.use('/', authRoutes);
app.use('/', clientRoutes);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

