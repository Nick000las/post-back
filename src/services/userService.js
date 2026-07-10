const prismaAdapter = require('../adapters/prismaAdapter.js');
const AppError = require('../errors/AppError.js');

class UserService {

    static async listarContas (userId) {
        const contas = await prismaAdapter.listarContas(userId);

        if(!contas || contas.length === 0) throw new AppError('Nenhuma conta encontrada');

        return contas;
    }

    static async criarConta (userId, { nome, plataforma, instagramId, access_token }) {
        if(!nome || !plataforma || !access_token) {
            throw new AppError('Campos obrigatórios: nome, plataforma e access_token');
        }

        if(instagramId) {
            const contaExiste = await prismaAdapter.buscarContaPorIdInstagram(instagramId);
            if(contaExiste) throw new AppError('Conta já existe');
        }

        const conta = await prismaAdapter.criarConta({
            name: nome,
            platform: plataforma,
            instagram_user_id: instagramId,
            access_token,
            user_id: userId
        });
        if(!conta) throw new Error('Erro ao criar conta');

        return conta;
    }

    static async atualizarConta (id, userId, { nome, plataforma, instagramId, access_token }) {
        const contaExiste = await prismaAdapter.buscarContaPorId(id, userId);
        if(!contaExiste) throw new AppError('Conta não encontrada');

        if(instagramId) {
            const outraConta = await prismaAdapter.buscarContaPorIdInstagram(instagramId);
            if(outraConta && outraConta.id !== parseInt(id)) {
                throw new AppError('Outra conta com o mesmo Instagram ID já existe');
            }
        }

        const atualizacoes = {};
        if(nome !== undefined) atualizacoes.name = nome;
        if(plataforma !== undefined) atualizacoes.platform = plataforma;
        if(instagramId !== undefined) atualizacoes.instagram_user_id = instagramId;
        if(access_token !== undefined) atualizacoes.access_token = access_token;

        const conta = await prismaAdapter.atualizarConta(id, userId, atualizacoes);

        return conta ?? [];
    }

    static async excluirConta (id, userId) {
        const conta = await prismaAdapter.excluirConta(id, userId);
        if(!conta) throw new AppError('Conta não encontrada');

        return conta;
    }
}

module.exports = UserService;
