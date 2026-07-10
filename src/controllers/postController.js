const postService = require('../services/postService.js');
const AppError = require('../errors/AppError.js');
const { responderComErro } = require('../utils/httpErrorHandler.js');
const fs = require('fs');

class PostController {

    static async publicarEmLote (req, res) {
        const arquivo = req.file;

        try {
            const { caption } = req.body;

            if(!arquivo) throw new AppError('Nenhum arquivo enviado');

            let accounts;
            try {
                accounts = JSON.parse(req.body.accounts);
            } catch {
                throw new AppError('Lista de contas inválida');
            }

            if(!Array.isArray(accounts) || accounts.length === 0) throw new AppError('Nenhuma conta selecionada');
            if(!accounts.every(account => Number.isInteger(account?.id))) throw new AppError('Cada conta deve ter um id numérico');

            try {
                const resultado = await postService.gerenciarPostagemEmLote(arquivo, caption, accounts, req.user.id);
                return res.status(200).json({ message: 'Postagem em lote concluída', detalhes: resultado });
            } catch (erroInterno) {
                return responderComErro(res, erroInterno, {
                    logContext: 'Erro inesperado ao processar postagem em lote:',
                    mensagemPadrao: 'Erro ao processar a postagem em lote'
                });
            }
        } catch (error) {
            if (arquivo && fs.existsSync(arquivo.path)) fs.unlinkSync(arquivo.path);
            return responderComErro(res, error, {
                logContext: 'Erro ao validar postagem em lote:',
                mensagemPadrao: 'Erro ao processar a postagem em lote'
            });
        }
    }
}

module.exports = PostController;