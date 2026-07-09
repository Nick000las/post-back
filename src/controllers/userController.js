const userService = require('../services/userService.js');

class UserController {

    static async listarContas (req, res) {
        try {
            const contas = await userService.listarContas();
            res.status(200).json({ message: 'Contas listadas com sucesso', contas });
        } catch (error) {
            console.error('Erro ao listar contas:', error);
            res.status(500).json({ error: 'Erro ao listar contas' });
        }
    }

    static async criarConta (req, res) {
        try {
            const { nome, plataforma, instagramId, access_token } = req.body;
            const conta = await userService.criarConta({ nome, plataforma, instagramId, access_token });
            res.status(201).json({ message: 'Conta criada com sucesso', conta });
        } catch (error) {
            console.error('Erro ao criar conta:', error);
            res.status(400).json({ error: error.message });
        }
    }

    static async atualizarConta (req, res) {
        try {
            const { id } = req.params;
            const { nome, plataforma, instagramId, access_token } = req.body;
            const conta = await userService.atualizarConta(id, { nome, plataforma, instagramId, access_token });
            res.status(200).json({ message: 'Conta atualizada com sucesso', conta });
        } catch (error) {
            console.error('Erro ao atualizar conta:', error);
            res.status(400).json({ error: error.message });
        }
    }

    static async excluirConta (req, res) {
        try {
            const { id } = req.params;
            await userService.excluirConta(id);
            res.status(200).json({ message: 'Conta excluída com sucesso' });
        } catch (error) {
            console.error('Erro ao excluir conta:', error);
            res.status(400).json({ error: error.message });
        }
    }
}

module.exports = UserController;
