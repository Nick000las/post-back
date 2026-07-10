class AppError extends Error {
    constructor(message) {
        super(message);
        this.isOperational = true;
    }
}

module.exports = AppError;
