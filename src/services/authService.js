const prismaAdapter = require('../adapters/prismaAdapter.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const AppError = require('../errors/AppError.js');

class AuthService {

    static async registrar(name, email, password) {
        const usuarioExiste = await prismaAdapter.buscarUsuarioPorEmail(email);
        if (usuarioExiste) throw new AppError('Usuário já existe');
        
        const hashedPassword = await bcrypt.hash(password, 10);

        const novoUsuario = await prismaAdapter.criarUsuario(name, email, hashedPassword);

        return {
            id: novoUsuario.id,
            name: novoUsuario.name,
            email: novoUsuario.email
        };
    }

    static async login(email, password) {
        const usuario = await prismaAdapter.buscarUsuarioPorEmail(email);
        if (!usuario) throw new AppError('Usuário não encontrado');

        const senhaValida = await bcrypt.compare(password, usuario.password_hash);
        if (!senhaValida) throw new AppError('Senha inválida');

        const token = jwt.sign({ id: usuario.id, email: usuario.email }, process.env.JWT_SECRET, { expiresIn: '1h' });

        return {
            token,
            user: {
                id: usuario.id,
                name: usuario.name,
                email: usuario.email
            }
        };
    }

    static async me(id) {
        const usuario = await prismaAdapter.buscarUsuarioPorId(id);
        if (!usuario) throw new AppError('Usuário não encontrado');

        return {
            id: usuario.id,
            name: usuario.name,
            email: usuario.email
        };
    }
}

module.exports = AuthService;
