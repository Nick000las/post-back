const userService = require('../services/userService.js');
const { responderComErro } = require('../utils/httpErrorHandler.js');

class UserController {

    static async listarContas (req, res) {
        try {
            const { clientId } = req.query;
            const contas = await userService.listarContas(clientId, req.user.id);
            res.status(200).json({ message: 'Contas listadas com sucesso', contas });
        } catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao listar contas:',
                mensagemPadrao: 'Erro ao listar contas',
                statusOperacional: 404
            });
        }
    }

    static async criarConta (req, res) {
        try {
            const { nome, plataforma, platformAccountId, access_token, clientId } = req.body;
            const conta = await userService.criarConta(clientId, req.user.id, { nome, plataforma, platformAccountId, access_token });
            res.status(201).json({ message: 'Conta criada com sucesso', conta });
        } catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao criar conta:',
                mensagemPadrao: 'Erro ao criar conta'
            });
        }
    }

    static async atualizarConta (req, res) {
        try {
            const { id } = req.params;
            const { nome, plataforma, platformAccountId, access_token, clientId } = req.body;
            const conta = await userService.atualizarConta(id, clientId, req.user.id, { nome, plataforma, platformAccountId, access_token });
            res.status(200).json({ message: 'Conta atualizada com sucesso', conta });
        } catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao atualizar conta:',
                mensagemPadrao: 'Erro ao atualizar conta'
            });
        }
    }

    static async excluirConta (req, res) {
        try {
            const { id } = req.params;
            const { clientId } = req.query;
            await userService.excluirConta(id, clientId, req.user.id);
            res.status(200).json({ message: 'Conta excluída com sucesso' });
        } catch (error) {
            responderComErro(res, error, {
                logContext: 'Erro ao excluir conta:',
                mensagemPadrao: 'Erro ao excluir conta'
            });
        }
    }
}

module.exports = UserController;
