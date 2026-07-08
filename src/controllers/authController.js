const authService = require('../services/authService');

class AuthController {

    static async login(req, res) {
        try {
            const { email, password } = req.body;
            const resultado = await authService.login(email, password);
            
            res.cookie('token', resultado.token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: 24 * 60 * 60 * 1000 // 1 dia
            });

            res.status(200).json({ message: 'Login bem-sucedido', user: resultado.user });
        } catch (error) {
            console.error('Erro ao fazer login:', error);
            res.status(401).json({ error: error.message });
        }
    }

    static async register(req, res) {
        try {
            const { username, email, password } = req.body;
            const usuário = await authService.registrar(username, email, password);
            res.status(201).json({ message: 'Registro bem-sucedido', usuário });
        } catch (error) {
            console.error('Erro ao registrar usuário:', error);
            res.status(400).json({ error: 'Erro ao registrar usuário' });
        }
    }

    static async logout(req, res) {
        try{
            res.clearCookie('token');
            res.status(200).json({ message: 'Logout bem-sucedido' });
        }catch (error) {
            console.error('Erro ao fazer logout', error);
            res.status(500).json({ error: 'Erro ao fazer logout' });
        }
    }

    static async me(req, res) {
        try {
            const usuario = await authService.me(req.user.id);
            res.status(200).json({ user: usuario });
        } catch (error) {
            console.error('Erro ao buscar sessão:', error);
            res.status(401).json({ error: 'Sessão inválida' });
        }
    }
}

module.exports = AuthController;

