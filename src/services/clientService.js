const prismaAdapter = require('../adapters/prismaAdapter.js');
const AppError = require('../errors/AppError.js');

class ClientService {

    static async criarClient (name, userId) {
        if (!name) throw new AppError('Campo obrigatório: name');

        return prismaAdapter.criarClient(name, userId);
    }

    static async listarClients (userId) {
        return prismaAdapter.listarClients(userId);
    }

    static async atualizarClient (id, userId, name) {
        if (!name) throw new AppError('Campo obrigatório: name');

        const client = await prismaAdapter.atualizarClient(id, userId, name);
        if (!client) throw new AppError('Cliente não encontrado');
        return client;
    }

    static async excluirClient (id, userId) {
        const client = await prismaAdapter.excluirClient(id, userId);
        if (!client) throw new AppError('Cliente não encontrado');
        return client;
    }
}

module.exports = ClientService;
