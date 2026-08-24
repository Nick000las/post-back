const jwt = require('jsonwebtoken');

// Sem fallback de propósito: um secret adivinhável (string fixa no código) permitiria forjar um
// token válido pra qualquer usuário caso JWT_SECRET não esteja definido no ambiente. Falha alto e
// claro no boot em vez de silenciosamente aceitar tokens assinados com uma chave conhecida.
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET não definido — defina a variável de ambiente antes de iniciar o servidor.');
}
const JWT_SECRET = process.env.JWT_SECRET;

class AuthMiddleware {
    static verificarToken(req, res, next) {
        const token = req.cookies.token;

        if (!token) {
            return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            
            req.user = decoded; 
            
            next();
        } catch (error) {
            return res.status(401).json({ error: 'Token inválido ou expirado.' });
        }
    }
}

module.exports = AuthMiddleware;