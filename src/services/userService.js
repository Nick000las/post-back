const prismaAdapter = require('../adapters/prismaAdapter.js');

class UserService {

    static async listarContas () {
        const contas = await prismaAdapter.listarContas();

        if(!contas || contas.length === 0) throw new Error('Nenhuma conta encontrada');

        return contas;
    }

    static async criarConta ({ nome, plataforma, instagramId, access_token }) {
        if(!nome || !plataforma || !access_token) {
            throw new Error('Campos obrigatórios: nome, plataforma e access_token');
        }

        if(instagramId) {
            const contaExiste = await prismaAdapter.buscarContaPorIdInstagram(instagramId);
            if(contaExiste) throw new Error('Conta já existe');
        }

        const conta = await prismaAdapter.criarConta({
            name: nome,
            platform: plataforma,
            instagram_user_id: instagramId,
            access_token
        });
        if(!conta) throw new Error('Erro ao criar conta');

        return conta;
    }

    static async atualizarConta (id, { nome, plataforma, instagramId, access_token }) {
        const contaExiste = await prismaAdapter.buscarContaPorId(id);
        if(!contaExiste) throw new Error('Conta não encontrada');

        if(instagramId) {
            const outraConta = await prismaAdapter.buscarContaPorIdInstagram(instagramId);
            if(outraConta && outraConta.id !== parseInt(id)) {
                throw new Error('Outra conta com o mesmo Instagram ID já existe');
            }
        }

        const atualizacoes = {};
        if(nome !== undefined) atualizacoes.name = nome;
        if(plataforma !== undefined) atualizacoes.platform = plataforma;
        if(instagramId !== undefined) atualizacoes.instagram_user_id = instagramId;
        if(access_token !== undefined) atualizacoes.access_token = access_token;

        const conta = await prismaAdapter.atualizarConta(id, atualizacoes);

        return conta ?? [];
    }

    static async excluirConta (id) {
        const contaExiste = await prismaAdapter.buscarContaPorId(id);
        if(!contaExiste) throw new Error('Conta não encontrada');

        const conta = await prismaAdapter.excluirConta(id);
        if(!conta) throw new Error('Erro ao excluir conta');

        return conta;
    }
}

module.exports = UserService;
