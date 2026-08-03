const commentService = require('../services/commentService.js');
const { responderComErro } = require('../utils/httpErrorHandler.js');
const fs = require('fs');

class CommentController {

    static async listarComentarios (req, res) {
        try {
            const { id } = req.params; // postId
            const { clientId } = req.query;
            const comentarios = await commentService.listarComentarios(id, clientId, req.user.id);
            return res.status(200).json({ comentarios });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao listar comentários do card:',
                mensagemPadrao: 'Erro ao carregar as mensagens'
            });
        }
    }

    static async criarComentario (req, res) {
        const arquivo = req.file;
        try {
            const { id } = req.params; // postId
            const { clientId, text } = req.body;
            const comentario = await commentService.criarComentario(id, clientId, req.user.id, text, arquivo);
            return res.status(201).json({ message: 'Mensagem enviada com sucesso', comentario });
        } catch (error) {
            if (arquivo && fs.existsSync(arquivo.path)) fs.unlinkSync(arquivo.path);
            return responderComErro(res, error, {
                logContext: 'Erro ao enviar mensagem no card:',
                mensagemPadrao: 'Erro ao enviar a mensagem'
            });
        }
    }
}

module.exports = CommentController;
