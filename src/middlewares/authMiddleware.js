const jwt = require('jsonwebtoken');

class AuthMiddleware {
    static verificarToken(req, res, next) {
        const token = req.cookies.token;

        if (!token) {
            return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
        }

        try {
            const secret = process.env.JWT_SECRET || 'chave_padrao_desenvolvimento';
            const decoded = jwt.verify(token, secret);
            
            req.user = decoded; 
            
            next();
        } catch (error) {
            return res.status(401).json({ error: 'Token inválido ou expirado.' });
        }
    }
}

module.exports = AuthMiddleware;