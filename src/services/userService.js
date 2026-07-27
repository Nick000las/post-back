const prismaAdapter = require('../adapters/prismaAdapter.js');
const AppError = require('../errors/AppError.js');

class UserService {

    // Confere que o client pertence ao usuário autenticado (agência) antes de liberar qualquer
    // operação nas contas dele.
    static async #validarCliente (clientId, userId) {
        const cliente = await prismaAdapter.buscarClientePorId(clientId, userId);
        if (!cliente) throw new AppError('Cliente não encontrado');
        return cliente;
    }

    static async listarContas (clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const contas = await prismaAdapter.listarContas(clientId);

        if(!contas || contas.length === 0) throw new AppError('Nenhuma conta encontrada');

        return contas;
    }

    static async criarConta (clientId, userId, { nome, plataforma, platformAccountId, access_token }) {
        await this.#validarCliente(clientId, userId);

        if(!nome || !plataforma || !access_token) {
            throw new AppError('Campos obrigatórios: nome, plataforma e access_token');
        }

        if(platformAccountId) {
            const contaExiste = await prismaAdapter.buscarContaPorPlatformAccountId(platformAccountId);
            if(contaExiste) throw new AppError('Conta já existe');
        }

        const conta = await prismaAdapter.criarConta({
            name: nome,
            platform: plataforma,
            platform_account_id: platformAccountId,
            access_token,
            client_id: parseInt(clientId)
        });
        if(!conta) throw new Error('Erro ao criar conta');

        return conta;
    }

    static async atualizarConta (id, clientId, userId, { nome, plataforma, platformAccountId, access_token }) {
        await this.#validarCliente(clientId, userId);

        const contaExiste = await prismaAdapter.buscarContaPorId(id, clientId);
        if(!contaExiste) throw new AppError('Conta não encontrada');

        if(platformAccountId) {
            const outraConta = await prismaAdapter.buscarContaPorPlatformAccountId(platformAccountId);
            if(outraConta && outraConta.id !== parseInt(id)) {
                throw new AppError('Outra conta com o mesmo ID de plataforma já existe');
            }
        }

        const atualizacoes = {};
        if(nome !== undefined) atualizacoes.name = nome;
        if(plataforma !== undefined) atualizacoes.platform = plataforma;
        if(platformAccountId !== undefined) atualizacoes.platform_account_id = platformAccountId;
        if(access_token !== undefined) atualizacoes.access_token = access_token;

        const conta = await prismaAdapter.atualizarConta(id, clientId, atualizacoes);

        return conta ?? [];
    }

    static async excluirConta (id, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const conta = await prismaAdapter.excluirConta(id, clientId);
        if(!conta) throw new AppError('Conta não encontrada');

        return conta;
    }
}

module.exports = UserService;
