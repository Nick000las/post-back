const clientService = require('../services/clientService.js');
const { responderComErro } = require('../utils/httpErrorHandler.js');

class ClientController {

    static async criarClient (req, res) {
        try {
            const { name } = req.body;
            const client = await clientService.criarClient(name, req.user.id);
            res.status(201).json({ message: 'Cliente criado com sucesso', client });
        } catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao criar cliente:',
                mensagemPadrao: 'Erro ao criar cliente'
            });
        }
    }

    static async listarClients (req, res) {
        try {
            const clients = await clientService.listarClients(req.user.id);
            res.status(200).json({ clients });
        } catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao listar clientes:',
                mensagemPadrao: 'Erro ao listar clientes'
            });
        }
    }

    static async atualizarClient (req, res) {
        try {
            const { id } = req.params;
            const { name } = req.body;
            const client = await clientService.atualizarClient(id, req.user.id, name);
            res.status(200).json({ message: 'Cliente atualizado com sucesso', client });
        } catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao atualizar cliente:',
                mensagemPadrao: 'Erro ao atualizar cliente'
            });
        }
    }

    static async excluirClient (req, res) {
        try {
            const { id } = req.params;
            await clientService.excluirClient(id, req.user.id);
            res.status(200).json({ message: 'Cliente excluído com sucesso' });
        } catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao excluir cliente:',
                mensagemPadrao: 'Erro ao excluir cliente'
            });
        }
    }
}

module.exports = ClientController;
