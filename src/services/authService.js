const prismaAdapter = require('../adapters/prismaAdapter.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const AppError = require('../errors/AppError.js');

// Hash de custo idêntico ao usado em registrar() (bcrypt.hash(senha, 10)), comparado quando o
// e-mail não existe — sem isso, login com e-mail desconhecido responde mais rápido (pula o
// bcrypt.compare) do que login com senha errada, um timing side-channel que permite enumerar
// e-mails cadastrados testando contra /login.
const DUMMY_HASH = bcrypt.hashSync('senha-fixa-so-para-normalizar-o-tempo-de-resposta', 10);

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

    // Mensagem e caminho de execução uniformes entre "e-mail não existe" e "senha errada": evita
    // que a API sirva de oráculo pra enumerar e-mails cadastrados (nem pela mensagem, nem pelo
    // tempo de resposta — ver DUMMY_HASH acima).
    static async login(email, password) {
        const usuario = await prismaAdapter.buscarUsuarioPorEmail(email);
        const senhaValida = await bcrypt.compare(password, usuario?.password_hash ?? DUMMY_HASH);
        if (!usuario || !senhaValida) throw new AppError('E-mail ou senha inválidos');

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
