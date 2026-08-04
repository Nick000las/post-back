const postService = require('../services/postService.js');
const kanbanService = require('../services/kanbanService.js');
const AppError = require('../errors/AppError.js');
const { responderComErro } = require('../utils/httpErrorHandler.js');
const { FEED_STATUS_FILTERS, FEED_DATE_FILTERS, PLATAFORMAS_VALIDAS } = require('../constants/feed.js');
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

    static #parseFiltrosFeedGlobal (query) {
        const { status = FEED_STATUS_FILTERS.TODOS, clientId, date } = query;

        if (!Object.values(FEED_STATUS_FILTERS).includes(status)) {
            throw new AppError('Filtro de status inválido');
        }
        if (date !== undefined && !Object.values(FEED_DATE_FILTERS).includes(date)) {
            throw new AppError('Filtro de data inválido');
        }

        return { status, clientId, date };
    }

    static #parseFiltrosFeedCliente (query) {
        const { clientId, platform, month, year } = query;

        if (!clientId) throw new AppError('clientId é obrigatório');
        if (platform !== undefined && !PLATAFORMAS_VALIDAS.includes(platform)) {
            throw new AppError('Rede social inválida');
        }

        return {
            clientId,
            platform,
            month: month !== undefined ? Number.parseInt(month, 10) : undefined,
            year: year !== undefined ? Number.parseInt(year, 10) : undefined
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

    // A barreira de segurança real contra mover pra Agendado/Finalizado vive em kanbanService.moverPost
    // (lança AppError se a coluna de destino for fixa) — o bloqueio no frontend é só UX.
    static async moverPost (req, res) {
        const { id } = req.params;
        try {
            const { clientId, columnId } = req.body;
            const post = await kanbanService.moverPost(id, clientId, req.user.id, columnId);
            return res.status(200).json({ message: 'Post movido com sucesso', post });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao mover post:',
                mensagemPadrao: 'Erro ao mover o post'
            });
        }
    }

    // Não exclui mais o post — reverte pra DRAFT. Ver postService.cancelarAgendamento.
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

    // "Alterar Data" no popup do card — post já está SCHEDULED, só reagenda os jobs existentes.
    static async alterarDataAgendamento (req, res) {
        const { id } = req.params;
        try {
            const { clientId, scheduled_for } = req.body;
            const resultado = await postService.alterarDataAgendamento(id, clientId, req.user.id, scheduled_for);
            return res.status(200).json(resultado);
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao alterar data de agendamento:',
                mensagemPadrao: 'Erro ao alterar a data de agendamento'
            });
        }
    }

    // Lixeira do popup do Kanban — exclusão definitiva, em qualquer status.
    static async excluirPost (req, res) {
        const { id } = req.params;
        try {
            const { clientId } = req.query;
            const resultado = await postService.excluirPost(id, clientId, req.user.id);
            return res.status(200).json(resultado);
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao excluir post:',
                mensagemPadrao: 'Erro ao excluir o post'
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

    // Agenda um draft/post existente sem duplicá-lo nem reenviar arquivo — diferente de
    // agendarPostagem (multipart, sempre cria um post novo). Usado pelo Kanban pra agendar um card
    // que já existe no quadro (ex.: em "Ideias").
    static async agendarDraft (req, res) {
        const { id } = req.params;
        try {
            const { clientId, scheduled_for } = req.body;
            const resultado = await postService.agendarDraft(id, clientId, req.user.id, scheduled_for);
            return res.status(202).json({ message: 'Draft agendado com sucesso', detalhes: resultado });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao agendar draft:',
                mensagemPadrao: 'Erro ao agendar o draft'
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

    // Editor de mídia do popup do Kanban — drag&drop ou clique no lápis substituem o arquivo do draft.
    static async atualizarMidiaDraft (req, res) {
        const { id } = req.params;
        const arquivo = req.file;
        try {
            if (!arquivo) throw new AppError('Nenhum arquivo enviado');

            const { clientId } = req.body;
            const draftAtualizado = await postService.atualizarMidiaDraft(id, clientId, req.user.id, arquivo);
            return res.status(200).json({ message: 'Mídia atualizada com sucesso', draft: draftAtualizado });
        } catch (error) {
            if (arquivo && fs.existsSync(arquivo.path)) fs.unlinkSync(arquivo.path);
            return responderComErro(res, error, {
                logContext: 'Erro ao atualizar mídia do draft:',
                mensagemPadrao: 'Erro ao atualizar a mídia'
            });
        }
    }

    // Lixeira do popup do Kanban — remove a mídia, post continua DRAFT (só fica vazio).
    static async removerMidiaDraft (req, res) {
        const { id } = req.params;
        try {
            const { clientId } = req.query;
            const draftAtualizado = await postService.removerMidiaDraft(id, clientId, req.user.id);
            return res.status(200).json({ message: 'Mídia removida com sucesso', draft: draftAtualizado });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao remover mídia do draft:',
                mensagemPadrao: 'Erro ao remover a mídia'
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

    // Torre de controle: cross-client, escopado ao usuário autenticado (req.user.id). Filtros:
    // status (Todos/Falhas/Publicados), clientId (isola um client) e date (Hoje/7 dias/Este mês).
    static async listarFeedGlobal (req, res) {
        try {
            const { page, limit } = PostController.#parsePaginacao(req.query);
            const filtros = PostController.#parseFiltrosFeedGlobal(req.query);
            const { feed, pagination } = await postService.listarFeedGlobal(req.user.id, filtros, page, limit);

            return res.status(200).json({ feed, pagination });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao listar feed global:',
                mensagemPadrao: 'Não foi possível carregar as postagens da equipe'
            });
        }
    }

    // Vitrine/portfólio de um único client. Filtros: platform (rede social) e month/year (mês
    // específico, pra montagem de relatório).
    static async listarFeedCliente (req, res) {
        try {
            const { page, limit } = PostController.#parsePaginacao(req.query);
            const filtros = PostController.#parseFiltrosFeedCliente(req.query);
            const { feed, pagination } = await postService.listarFeedCliente(req.user.id, filtros, page, limit);

            return res.status(200).json({ feed, pagination });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao listar feed do cliente:',
                mensagemPadrao: 'Não foi possível carregar as postagens do cliente'
            });
        }
    }

    // Botão "Republicar" do Feed Global (posts FAILED/PARTIAL). Rota e assinatura já ligadas
    // ponta a ponta — postService.republicarPost ainda é um stub (ver TODO lá) até a regra de
    // negócio ser implementada manualmente.
    static async republicarPost (req, res) {
        const { id } = req.params;
        try {
            const { clientId } = req.body;
            const resultado = await postService.republicarPost(id, clientId, req.user.id);
            return res.status(202).json(resultado);
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao republicar post:',
                mensagemPadrao: 'Erro ao republicar o post'
            });
        }
    }
}

module.exports = PostController;