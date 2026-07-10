const authService = require('../services/authService');
const { responderComErro } = require('../utils/httpErrorHandler.js');

class AuthController {

    static async login(req, res) {
        try {
            const isProduction = process.env.NODE_ENV === 'production';
            const { email, password } = req.body;
            const resultado = await authService.login(email, password);

            res.cookie('token', resultado.token, {
                httpOnly: true,
                secure: isProduction, // Use secure cookies in production
                sameSite: isProduction ? 'None' : 'Lax', // Use 'None' for cross-site cookies in production
                maxAge: 24 * 60 * 60 * 1000 // 1 dia
            });

            res.status(200).json({ message: 'Login bem-sucedido', user: resultado.user });
        } catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao fazer login:',
                mensagemPadrao: 'Erro ao processar login',
                statusOperacional: 401
            });
        }
    }

    static async register(req, res) {
        try {
            const { username, email, password } = req.body;
            const usuário = await authService.registrar(username, email, password);
            res.status(201).json({ message: 'Registro bem-sucedido', usuário });
        } catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao registrar usuário:',
                mensagemPadrao: 'Erro ao registrar usuário',
                statusOperacional: 400
            });
        }
    }

    static async logout(req, res) {
        try{
            const isProduction = process.env.NODE_ENV === 'production';
            res.clearCookie('token', {
                httpOnly: true,
                secure: isProduction,
                sameSite: isProduction ? 'None' : 'Lax'
            });
            res.status(200).json({ message: 'Logout bem-sucedido' });
        }catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao fazer logout:',
                mensagemPadrao: 'Erro ao fazer logout'
            });
        }
    }

    static async me(req, res) {
        try {
            const usuario = await authService.me(req.user.id);
            res.status(200).json({ user: usuario });
        } catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao buscar sessão:',
                mensagemPadrao: 'Sessão inválida',
                statusOperacional: 401,
                statusPadrao: 401
            });
        }
    }
}

module.exports = AuthController;

