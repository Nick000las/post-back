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
}

module.exports = UserController;
