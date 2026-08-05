const aiLabService = require('../services/aiLabService.js');
const AppError = require('../errors/AppError.js');
const { responderComErro } = require('../utils/httpErrorHandler.js');

class AiLabController {

    static async extrairPostsDoPdf (req, res) {
        try {
            const arquivo = req.file;
            const { clientId } = req.body;

            if (!arquivo) throw new AppError('Nenhum PDF enviado');

            const posts = await aiLabService.extrairPostsDoPdf(arquivo, clientId, req.user.id);
            return res.status(200).json({ posts });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao extrair posts do PDF:',
                mensagemPadrao: 'Erro ao extrair posts do PDF'
            });
        }
    }

    static async importarPostsExtraidos (req, res) {
        try {
            const { clientId, posts } = req.body;
            const resultado = await aiLabService.importarPostsExtraidos(posts, clientId, req.user.id);
            return res.status(201).json(resultado);
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao importar posts extraídos:',
                mensagemPadrao: 'Erro ao importar os posts'
            });
        }
    }
}

module.exports = AiLabController;
