const storyService = require('../services/storyService.js');
const postService = require('../services/postService.js');
const AppError = require('../errors/AppError.js');
const { responderComErro } = require('../utils/httpErrorHandler.js');
const { parseAccounts, limparArquivosEnviados } = require('../utils/uploadRequest.js');

class StoryController {

    // scheduledDates chega como string JSON no corpo multipart, mesma limitação que já obriga
    // `accounts` a vir serializado (não dá pra mandar array estruturado junto de arquivo binário
    // sem serializar). Validação estrutural só (é JSON? é array não-vazio?) — o conteúdo de cada
    // data (formato ISO, está no futuro, sem duplicata) é validado por recurrenceService, que é
    // regra de negócio, não parsing de request.
    // Chega como string JSON nas rotas multipart (POST /stories/schedule — vai junto de um
    // arquivo, e multipart só carrega string) mas já chega como array de verdade nas rotas sem
    // upload (POST /stories/:id/schedule, POST /stories/recurrence/:id/occurrences — corpo
    // application/json puro, o express.json() já parseia). Aceita os dois formatos.
    static #parseScheduledDates (raw) {
        let dates = raw;
        if (typeof raw === 'string') {
            try {
                dates = JSON.parse(raw);
            } catch {
                throw new AppError('Lista de datas de agendamento inválida');
            }
        }

        if (!Array.isArray(dates) || dates.length === 0) throw new AppError('Informe ao menos uma data de agendamento');

        return dates;
    }

    // req.file: arquivo único do multer. Story não tem carrossel — ver storyRoutes.js. Também não
    // tem legenda: a Meta não aceita caption no endpoint de Stories, e a discussão interna do card
    // vive no chat (card_comments).
    static async publicarStory (req, res) {
        const arquivo = req.file;
        try {
            const { clientId } = req.body;

            if (!arquivo) throw new AppError('Nenhum arquivo enviado');

            const accounts = parseAccounts(req.body.accounts);

            const resultado = await storyService.publicarStory(arquivo, accounts, clientId, req.user.id);
            return res.status(202).json({ message: 'Story recebido e em processamento', detalhes: resultado });
        } catch (error) {
            limparArquivosEnviados(arquivo);
            return responderComErro(res, error, {
                logContext: 'Erro ao publicar story:',
                mensagemPadrao: 'Erro ao publicar o story'
            });
        }
    }

    // body: clientId, accounts (JSON) e scheduled_dates (JSON, array de 1+ strings ISO 8601 com
    // fuso explícito — 1 item = agendamento avulso, 2+ = série recorrente; mesma filosofia de
    // "arquivo" em postRoutes.js, a contagem decide, sem rota separada).
    static async agendarStory (req, res) {
        const arquivo = req.file;
        try {
            const { clientId } = req.body;

            if (!arquivo) throw new AppError('Nenhum arquivo enviado');

            const accounts = parseAccounts(req.body.accounts);
            const scheduledDates = StoryController.#parseScheduledDates(req.body.scheduled_dates);

            const resultado = await storyService.agendarStory(arquivo, accounts, scheduledDates, clientId, req.user.id);
            return res.status(202).json({ message: 'Story agendado com sucesso', detalhes: resultado });
        } catch (error) {
            limparArquivosEnviados(arquivo);
            return responderComErro(res, error, {
                logContext: 'Erro ao agendar story:',
                mensagemPadrao: 'Erro ao agendar o story'
            });
        }
    }

    // req.file: arquivo único do multer, igual a publicarStory/agendarStory.
    static async salvarDraft (req, res) {
        const arquivo = req.file;
        try {
            const { clientId } = req.body;
            if (!arquivo) throw new AppError('Nenhum arquivo enviado');

            const accounts = parseAccounts(req.body.accounts);

            const draft = await storyService.criarDraftStory(arquivo, accounts.map(conta => conta.id), clientId, req.user.id);
            return res.status(201).json({ message: 'Rascunho de story salvo com sucesso', postId: draft.id });
        } catch (error) {
            limparArquivosEnviados(arquivo);
            return responderComErro(res, error, {
                logContext: 'Erro ao salvar rascunho de story:',
                mensagemPadrao: 'Erro ao salvar o rascunho de story'
            });
        }
    }

    static async buscarStory (req, res) {
        const { id } = req.params;
        try {
            const { clientId } = req.query;
            const story = await storyService.buscarStoryDetalhado(id, clientId, req.user.id);
            return res.status(200).json({ story });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao buscar story:',
                mensagemPadrao: 'Erro ao buscar o story'
            });
        }
    }

    // Reaproveita postService.listarDrafts (não filtra por format) e restringe a Stories aqui —
    // é a única linha diferente de um passthrough puro.
    static async listarDrafts (req, res) {
        try {
            const { clientId } = req.query;
            const drafts = await postService.listarDrafts(clientId, req.user.id);
            return res.status(200).json({ drafts: drafts.filter(draft => draft.format === 'STORY') });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao listar rascunhos de story:',
                mensagemPadrao: 'Erro ao listar os rascunhos de story'
            });
        }
    }

    // req.file: arquivo único (Story não tem carrossel) — postService.atualizarMidiaDraft espera um
    // array (mesmo formato usado pro FEED), por isso o wrap em [arquivo] aqui.
    static async atualizarMidiaStory (req, res) {
        const { id } = req.params;
        const arquivo = req.file;
        try {
            if (!arquivo) throw new AppError('Nenhum arquivo enviado');

            const { clientId } = req.body;
            const draftAtualizado = await postService.atualizarMidiaDraft(id, clientId, req.user.id, [arquivo]);
            return res.status(200).json({ message: 'Mídia do story atualizada com sucesso', draft: draftAtualizado });
        } catch (error) {
            limparArquivosEnviados(arquivo);
            return responderComErro(res, error, {
                logContext: 'Erro ao atualizar mídia do story:',
                mensagemPadrao: 'Erro ao atualizar a mídia do story'
            });
        }
    }

    static async vincularContas (req, res) {
        const { id } = req.params;
        try {
            const { clientId, accountIds } = req.body;
            const resultado = await postService.vincularContasAoDraft(id, clientId, req.user.id, accountIds);
            return res.status(200).json(resultado);
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao vincular contas ao story:',
                mensagemPadrao: 'Erro ao vincular contas ao story'
            });
        }
    }

    static async excluirStory (req, res) {
        const { id } = req.params;
        try {
            const { clientId } = req.query;
            const resultado = await postService.excluirPost(id, clientId, req.user.id);
            return res.status(200).json(resultado);
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao excluir story:',
                mensagemPadrao: 'Erro ao excluir o story'
            });
        }
    }

    static async publicarDraftStory (req, res) {
        const { id } = req.params;
        try {
            const { clientId } = req.body;
            const resultado = await postService.publicarDraft(id, clientId, req.user.id);
            return res.status(202).json({ message: 'Story recebido e em processamento', detalhes: resultado });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao publicar rascunho de story:',
                mensagemPadrao: 'Erro ao publicar o story'
            });
        }
    }

    // body: clientId, scheduled_dates (JSON, mesmo formato de agendarStory — 1 item = avulso, 2+ =
    // série). Diferente de agendarStory: não recebe arquivo, o draft já tem mídia salva.
    static async agendarDraftStory (req, res) {
        const { id } = req.params;
        try {
            const { clientId } = req.body;
            const scheduledDates = StoryController.#parseScheduledDates(req.body.scheduled_dates);

            const resultado = await storyService.agendarDraftStory(id, scheduledDates, clientId, req.user.id);
            return res.status(202).json({ message: 'Story agendado com sucesso', detalhes: resultado });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao agendar rascunho de story:',
                mensagemPadrao: 'Erro ao agendar o story'
            });
        }
    }

    // Reagenda 1 ocorrência só (post já SCHEDULED) — não mexe na série inteira.
    static async alterarDataStory (req, res) {
        const { id } = req.params;
        try {
            const { clientId, scheduled_for } = req.body;
            const resultado = await postService.alterarDataAgendamento(id, clientId, req.user.id, scheduled_for);
            return res.status(200).json(resultado);
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao alterar data de agendamento do story:',
                mensagemPadrao: 'Erro ao alterar a data de agendamento do story'
            });
        }
    }

    static async cancelarAgendamentoStory (req, res) {
        const { id } = req.params;
        try {
            const { clientId } = req.query;
            const resultado = await postService.cancelarAgendamento(id, clientId, req.user.id);
            return res.status(200).json(resultado);
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao cancelar agendamento de story:',
                mensagemPadrao: 'Erro ao cancelar o agendamento do story'
            });
        }
    }

    static async consultarStatus (req, res) {
        try {
            const { id } = req.params;
            const { clientId } = req.query;
            const status = await postService.consultarStatusPost(id, clientId, req.user.id);
            return res.status(200).json({ status });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao consultar status do story:',
                mensagemPadrao: 'Erro ao consultar o status do story'
            });
        }
    }

    // Todas as ocorrências (passadas e futuras) da série, ordenadas por data — pra UI mostrar "essa
    // Story repete em tais datas" ou alimentar a tela que chama DELETE /stories/recurrence/:id.
    static async listarSerie (req, res) {
        const { recurrenceId } = req.params;
        try {
            const { clientId } = req.query;
            const ocorrencias = await storyService.listarOcorrenciasDaSerie(recurrenceId, clientId, req.user.id);
            return res.status(200).json({ ocorrencias });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao listar série de story:',
                mensagemPadrao: 'Erro ao listar a série de story'
            });
        }
    }

    // Cancela (reverte pra DRAFT) todas as ocorrências futuras ainda SCHEDULED da série — as já
    // publicadas/falhas não são tocadas.
    static async cancelarSerie (req, res) {
        const { recurrenceId } = req.params;
        try {
            const { clientId } = req.query;
            const resultado = await storyService.cancelarSerie(recurrenceId, clientId, req.user.id);
            return res.status(200).json(resultado);
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao cancelar série de story:',
                mensagemPadrao: 'Erro ao cancelar a série de story'
            });
        }
    }

    static async listarSeries (req, res) {
        try {
            const { clientId } = req.query;
            const series = await storyService.listarSeries(clientId, req.user.id);
            return res.status(200).json({ series });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao listar séries de story:',
                mensagemPadrao: 'Erro ao listar as séries de story'
            });
        }
    }

    static async estenderSerie (req, res) {
        const { recurrenceId } = req.params;
        try {
            const { clientId } = req.body;
            const scheduledDates = StoryController.#parseScheduledDates(req.body.scheduled_dates);

            const resultado = await storyService.estenderSerie(recurrenceId, scheduledDates, clientId, req.user.id);
            return res.status(202).json({ message: 'Série estendida com sucesso', detalhes: resultado });
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao estender série de story:',
                mensagemPadrao: 'Erro ao estender a série de story'
            });
        }
    }

    // Diferente de cancelarSerie (DELETE /stories/recurrence/:id — colapsa, preserva histórico):
    // exclui a série inteira, qualquer status, sem deixar rascunho nenhum.
    static async excluirSerie (req, res) {
        const { recurrenceId } = req.params;
        try {
            const { clientId } = req.query;
            const resultado = await storyService.excluirSerie(recurrenceId, clientId, req.user.id);
            return res.status(200).json(resultado);
        } catch (error) {
            return responderComErro(res, error, {
                logContext: 'Erro ao excluir série de story:',
                mensagemPadrao: 'Erro ao excluir a série de story'
            });
        }
    }
}

module.exports = StoryController;
