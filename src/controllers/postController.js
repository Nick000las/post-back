const postService = require('../services/postService.js');
const AppError = require('../errors/AppError.js');
const { responderComErro } = require('../utils/httpErrorHandler.js');
const fs = require('fs');

class PostController {

    static #parseAccounts (rawAccounts) {
        let accounts;
        try {
            accounts = JSON.parse(rawAccounts);
        } catch {
            throw new AppError('Lista de contas inválida');
        }

        if(!Array.isArray(accounts) || accounts.length === 0) throw new AppError('Nenhuma conta selecionada');
        if(!accounts.every(account => Number.isInteger(account?.id))) throw new AppError('Cada conta deve ter um id numérico');

        return accounts;
    }

    static async publicarEmLote (req, res) {
        const arquivo = req.file;

        try {
            const { caption } = req.body;

            if(!arquivo) throw new AppError('Nenhum arquivo enviado');

            const accounts = PostController.#parseAccounts(req.body.accounts);

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

    static async salvarDraft (req, res) {
        const arquivo = req.file;
        try {
            const { caption } = req.body;

            if(!arquivo) throw new AppError('Nenhum arquivo enviado');

            const accounts = PostController.#parseAccounts(req.body.accounts);

            const draft = await postService.criarDraft(caption, arquivo, accounts.map(conta => conta.id), req.user.id);
            return res.status(201).json({ message: 'Draft salvo com sucesso', postId: draft.id });
        } catch (error) {
            if (arquivo && fs.existsSync(arquivo.path)) fs.unlinkSync(arquivo.path);
            return responderComErro(res, error, {
                logContext: 'Erro ao salvar draft:',
                mensagemPadrao: 'Erro ao salvar o draft'
            });
        }
    }

    static async publicarDraft (req, res) {
        const { id } = req.params;
        try {
            const resultado = await postService.publicarDraft(id, req.user.id);
            return res.status(200).json({ message: 'Draft publicado com sucesso', detalhes: resultado });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao publicar draft:',
                mensagemPadrao: 'Erro ao publicar o draft'
            });
        }
    }

    static async atualizarDraft (req, res) {
        const { id } = req.params;
        try {
            const { caption } = req.body;
            const draftAtualizado = await postService.atualizarDraft(id, caption, req.user.id);
            return res.status(200).json({ message: 'Draft atualizado com sucesso', draft: draftAtualizado });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao atualizar draft:',
                mensagemPadrao: 'Erro ao atualizar o draft'
            });
        }
    }

    static async listarDrafts (req, res) {
        try {
            const drafts = await postService.listarDrafts(req.user.id);
            return res.status(200).json({ drafts });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao listar drafts:',
                mensagemPadrao: 'Erro ao listar os drafts'
            });
        }
    }

    static async buscarDraft (req, res) {
        const { id } = req.params;
        try {
            const draft = await postService.buscarDraft(id, req.user.id);
            return res.status(200).json({ draft });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao buscar draft:',
                mensagemPadrao: 'Erro ao buscar o draft'
            });
        }
    }

    static async excluirDraft (req, res) {
        const { id } = req.params;
        try {
            await postService.excluirDraft(id, req.user.id);
            return res.status(200).json({ message: 'Draft excluído com sucesso' });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao excluir draft:',
                mensagemPadrao: 'Erro ao excluir o draft'
            });
        }
    }

}

module.exports = PostController;