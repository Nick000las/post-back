const express = require('express');
const cors = require('cors');
require('dotenv').config();
const morgan = require('morgan');
const postRoutes = require('./routes/postRoutes.js');
const userRoutes = require('./routes/userRoutes.js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

app.use('/uploads', express.static('.uploads'));
app.use(morgan('dev'));

app.use('/', postRoutes);
app.use('/', userRoutes);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

