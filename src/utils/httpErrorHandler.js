const AppError = require('../errors/AppError.js');

function responderComErro (res, error, { logContext, mensagemPadrao, statusOperacional = 400, statusPadrao = 500 }) {
    if (error instanceof AppError) {
        return res.status(statusOperacional).json({ error: error.message });
    }

    console.error(logContext, error);
    return res.status(statusPadrao).json({ error: mensagemPadrao });
}

module.exports = { responderComErro };
