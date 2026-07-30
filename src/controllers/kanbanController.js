const kanbanService = require('../services/kanbanService.js');
const { responderComErro } = require('../utils/httpErrorHandler.js');

class KanbanController {

    static async buscarQuadro (req, res) {
        try {
            const { clientId } = req.query;
            const resultado = await kanbanService.listarQuadro(clientId, req.user.id);
            return res.status(200).json({ columns: resultado.columns });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao buscar quadro kanban:',
                mensagemPadrao: 'Erro ao carregar o quadro'
            });
        }
    }

    static async listarColunas (req, res) {
        try {
            const { clientId } = req.query;
            const columns = await kanbanService.listarColunas(clientId, req.user.id);
            return res.status(200).json({ columns });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao listar colunas:',
                mensagemPadrao: 'Erro ao listar as colunas'
            });
        }
    }

    static async criarColuna (req, res) {
        try {
            const { clientId, name } = req.body;
            const column = await kanbanService.criarColuna(clientId, req.user.id, name);
            return res.status(201).json({ message: 'Coluna criada com sucesso', column });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao criar coluna:',
                mensagemPadrao: 'Erro ao criar a coluna'
            });
        }
    }

    static async renomearColuna (req, res) {
        try {
            const { id } = req.params;
            const { clientId, name } = req.body;
            const column = await kanbanService.renomearColuna(id, clientId, req.user.id, name);
            return res.status(200).json({ message: 'Coluna renomeada com sucesso', column });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao renomear coluna:',
                mensagemPadrao: 'Erro ao renomear a coluna'
            });
        }
    }

    static async excluirColuna (req, res) {
        try {
            const { id } = req.params;
            const { clientId } = req.query;
            await kanbanService.excluirColuna(id, clientId, req.user.id);
            return res.status(200).json({ message: 'Coluna excluída com sucesso' });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao excluir coluna:',
                mensagemPadrao: 'Erro ao excluir a coluna'
            });
        }
    }
}

module.exports = KanbanController;
