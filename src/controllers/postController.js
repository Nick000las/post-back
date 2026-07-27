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

    static #parsePaginacao (query) {
        const PAGE_PADRAO = 1;
        const LIMITE_PADRAO = 10;
        const LIMITE_MAXIMO = 50;

        const page = Number.parseInt(query.page, 10);
        const limit = Number.parseInt(query.limit, 10);

        return {
            page: Number.isInteger(page) && page > 0 ? page : PAGE_PADRAO,
            limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, LIMITE_MAXIMO) : LIMITE_PADRAO
        };
    }

    static async publicarEmLote (req, res) {
        const arquivo = req.file;

        try {
            const { caption, clientId } = req.body;

            if(!arquivo) throw new AppError('Nenhum arquivo enviado');

            const accounts = PostController.#parseAccounts(req.body.accounts);

            try {
                const resultado = await postService.gerenciarPostagemEmLote(arquivo, caption, accounts, clientId, req.user.id);
                return res.status(202).json({ message: 'Postagem em lote recebida e em processamento', detalhes: resultado });
            } catch (erroInterno) {
                if (arquivo && fs.existsSync(arquivo.path)) fs.unlinkSync(arquivo.path);
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

    static async agendarPostagem (req, res) {
        const arquivo = req.file;

        try {
            const { caption, clientId, scheduled_for } = req.body;

            if (!arquivo) throw new AppError('Nenhum arquivo enviado');

            const accounts = PostController.#parseAccounts(req.body.accounts);

            try {
                const resultado = await postService.agendarPostagem(arquivo, caption, accounts, scheduled_for, clientId, req.user.id);
                return res.status(202).json({ message: 'Postagem agendada com sucesso', detalhes: resultado });
            } catch (erroInterno) {
                if (arquivo && fs.existsSync(arquivo.path)) fs.unlinkSync(arquivo.path);
                return responderComErro(res, erroInterno, {
                    logContext: 'Erro inesperado ao agendar postagem:',
                    mensagemPadrao: 'Erro ao agendar a postagem'
                });
            }
        } catch (error) {
            if (arquivo && fs.existsSync(arquivo.path)) fs.unlinkSync(arquivo.path);
            return responderComErro(res, error, {
                logContext: 'Erro ao validar agendamento de postagem:',
                mensagemPadrao: 'Erro ao processar o agendamento'
            });
        }
    }

    static async consultarStatusPost (req, res) {
        try {
            const { id } = req.params;
            const { clientId } = req.query;

            const status = await postService.consultarStatusPost(id, clientId, req.user.id);

            return res.status(200).json({ status });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao consultar status da postagem:',
                mensagemPadrao: 'Erro ao consultar o status da postagem'
            });
        }
    }

    static async cancelarAgendamento (req, res) {
        const { id } = req.params;
        try {
            const { clientId } = req.query;
            const resultado = await postService.cancelarAgendamento(id, clientId, req.user.id);
            return res.status(200).json(resultado);
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao cancelar agendamento:',
                mensagemPadrao: 'Erro ao cancelar o agendamento'
            });
        }
    }

    static async salvarDraft (req, res) {
        const arquivo = req.file;
        try {
            const { caption, clientId } = req.body;

            if(!arquivo) throw new AppError('Nenhum arquivo enviado');

            const accounts = PostController.#parseAccounts(req.body.accounts);

            const draft = await postService.criarDraft(caption, arquivo, accounts.map(conta => conta.id), clientId, req.user.id);
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
            const { clientId } = req.body;
            const resultado = await postService.publicarDraft(id, clientId, req.user.id);
            return res.status(202).json({ message: 'Draft recebido e em processamento', detalhes: resultado });
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
            const { caption, clientId } = req.body;
            const draftAtualizado = await postService.atualizarDraft(id, caption, clientId, req.user.id);
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
            const { clientId } = req.query;
            const drafts = await postService.listarDrafts(clientId, req.user.id);
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
            const { clientId } = req.query;
            const draft = await postService.buscarDraft(id, clientId, req.user.id);
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
            const { clientId } = req.query;
            await postService.excluirDraft(id, clientId, req.user.id);
            return res.status(200).json({ message: 'Draft excluído com sucesso' });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao excluir draft:',
                mensagemPadrao: 'Erro ao excluir o draft'
            });
        }
    }

    static async listarFeed (req, res) {
        try {
            const { page, limit } = PostController.#parsePaginacao(req.query);
            const { feed, pagination } = await postService.listarFeed(page, limit);

            return res.status(200).json({ feed, pagination });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao listar feed:',
                mensagemPadrao: 'Não foi possível carregar as postagens da equipe'
            });
        }
    }
}

module.exports = PostController;