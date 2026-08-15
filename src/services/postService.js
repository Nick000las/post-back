const prismaAdapter = require('../adapters/prismaAdapter.js');
const AppError = require('../errors/AppError.js');
const { publishQueue } = require('../queues/publishQueue.js');
const schedulingHelpers = require('./schedulingHelpers.js');
const { FIXED_COLUMN_KEYS } = require('../constants/kanban.js');
const { FEED_STATUS_FILTER_MAP, FEED_DATE_FILTERS } = require('../constants/feed.js');

class PostService {

    // Resolve o filtro de data (query param, ex.: 'hoje'/'7dias'/'mes') pro intervalo [from, to] usado
    // nos where dos feeds. undefined quando não houver filtro (sem corte de data).
    static #resolverIntervaloData(dateFilter) {
        if (!dateFilter) return undefined;

        const agora = new Date();
        const from = new Date(agora);

        switch (dateFilter) {
            case FEED_DATE_FILTERS.HOJE:
                from.setHours(0, 0, 0, 0);
                break;
            case FEED_DATE_FILTERS.SETE_DIAS:
                from.setDate(from.getDate() - 7);
                break;
            case FEED_DATE_FILTERS.ESTE_MES:
                from.setDate(1);
                from.setHours(0, 0, 0, 0);
                break;
            default:
                throw new AppError('Filtro de data inválido');
        }

        return { from, to: agora };
    }

    // Resolve mês/ano (query params do Feed do Cliente) pro intervalo [from, to]. year é obrigatório
    // (sem ele, undefined = sem filtro); month é opcional — se vier, restringe àquele mês, senão
    // cobre o ano inteiro (caso do dropdown "Todos os meses" + um ano específico).
    static #resolverIntervaloMesAno(month, year) {
        if (!year) return undefined;

        const from = month ? new Date(year, month - 1, 1, 0, 0, 0, 0) : new Date(year, 0, 1, 0, 0, 0, 0);
        const to = month ? new Date(year, month, 0, 23, 59, 59, 999) : new Date(year, 11, 31, 23, 59, 59, 999);
        return { from, to };
    }

    // Chamado pelo worker depois de cada job (sucesso ou falha definitiva) pra fechar o status do post
    // quando todas as contas já tiverem sido processadas.
    static async finalizarStatusSeCompleto (postId) {
        const contas = await prismaAdapter.listarStatusContasDoPost(postId);

        const aindaProcessando = contas.some(conta => conta.delivery_status === 'PENDING');
        if (aindaProcessando) return;

        const sucessos = contas.filter(conta => conta.delivery_status === 'SUCCESS').length;
        const statusFinal = sucessos === 0 ? 'FAILED' : sucessos === contas.length ? 'PUBLISHED' : 'PARTIAL';

        await prismaAdapter.atualizarStatusPost(postId, statusFinal, { published_at: new Date() });

        // O worker só tem postId/accountId no job.data — precisa buscar o post pra saber o client_id
        // antes de conseguir resolver a coluna Finalizado desse client.
        const post = await prismaAdapter.buscarPostPorId(postId);
        if (post) await schedulingHelpers.moverParaColunaFixa(postId, post.client_id, FIXED_COLUMN_KEYS.FINALIZADO);
    }

    // arquivos: array de req.files (multer). 1 item = post simples, 2+ = carrossel — o backend não
    // trata os dois casos de forma diferente, só a contagem muda.
    static async gerenciarPostagemEmLote (arquivos, caption, accountsList, clientId, userId, columnIdExplicito) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const columnId = await schedulingHelpers.resolverColumnId(clientId, columnIdExplicito);
        const midiaItems = await schedulingHelpers.montarMidiaItems(arquivos);
        const novoPost = await prismaAdapter.criarPost(caption, midiaItems, 'DRAFT', clientId, null, columnId);

        return schedulingHelpers.enfileirarContas(novoPost, accountsList, clientId);
    }

    static async agendarPostagem (arquivos, caption, accountsList, scheduledFor, clientId, userId, columnIdExplicito) {
        await schedulingHelpers.validarCliente(clientId, userId);
        schedulingHelpers.validarFormatoData(scheduledFor);

        const data = new Date(scheduledFor);
        const delayMs = data.getTime() - Date.now();
        if (Number.isNaN(delayMs) || delayMs <= 0) {
            throw new AppError('A data de agendamento precisa estar no futuro.');
        }

        const columnId = await schedulingHelpers.resolverColumnId(clientId, columnIdExplicito);
        const midiaItems = await schedulingHelpers.montarMidiaItems(arquivos);
        const novoPost = await prismaAdapter.criarPost(caption, midiaItems, 'SCHEDULED', clientId, data, columnId);

        return schedulingHelpers.enfileirarContas(novoPost, accountsList, clientId, { delayMs, statusInicial: 'SCHEDULED' });
    }

    static async consultarStatusPost (postId, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const post = await prismaAdapter.buscarPostComStatusContas(postId, clientId);
        if (!post) throw new AppError('Post não encontrado');

        return { postId: post.id, status: post.status, accounts: post.accounts };
    }

    // Cancelar agendamento NÃO apaga o post — reverte pra DRAFT (arte/legenda preservadas) e move o
    // card de volta pra coluna Rascunhos, pra a agência poder reeditar/reagendar depois sem reupload.
    static async cancelarAgendamento (postId, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const post = await prismaAdapter.buscarPostAgendadoComJobs(postId, clientId);
        if (!post) throw new AppError('Post agendado não encontrado ou já iniciado');

        await Promise.all(post.post_accounts.map(async ({ job_id }) => {
            if (!job_id) return;
            try {
                const job = await publishQueue.getJob(job_id);
                if (job && (await job.getState()) === 'delayed') await job.remove();
            } catch (erro) {
                console.warn('Falha ao remover job agendado da fila', { postId, job_id, erro: erro.message });
            }
        }));

        const postRevertido = await prismaAdapter.reverterAgendamentoParaDraft(postId, clientId);
        if (!postRevertido) throw new AppError('Post agendado não encontrado ou já iniciado');

        await schedulingHelpers.moverParaColunaFixa(postId, clientId, FIXED_COLUMN_KEYS.IDEIAS);

        return { message: 'Agendamento cancelado. O post voltou a ser um rascunho.', postId: postRevertido.id };
    }

    // "Alterar Data" no popup: post JÁ está SCHEDULED (ao contrário de agendarDraft, que exige DRAFT).
    // Em vez de cancelar+reagendar (recriaria jobs do zero), usa job.changeDelay do BullMQ pra
    // reagendar os jobs já existentes na fila com o novo horário — mais barato e não perde o job_id
    // já registrado em post_accounts.
    static async alterarDataAgendamento (postId, clientId, userId, scheduledFor) {
        await schedulingHelpers.validarCliente(clientId, userId);
        schedulingHelpers.validarFormatoData(scheduledFor);

        const data = new Date(scheduledFor);
        const novoDelayMs = data.getTime() - Date.now();
        if (Number.isNaN(novoDelayMs) || novoDelayMs <= 0) {
            throw new AppError('A data de agendamento precisa estar no futuro.');
        }

        const post = await prismaAdapter.buscarPostAgendadoComJobs(postId, clientId);
        if (!post) throw new AppError('Post agendado não encontrado ou já iniciado');

        await Promise.all(post.post_accounts.map(async ({ job_id }) => {
            if (!job_id) return;
            try {
                const job = await publishQueue.getJob(job_id);
                if (job && (await job.getState()) === 'delayed') await job.changeDelay(novoDelayMs);
            } catch (erro) {
                console.warn('Falha ao reagendar job', { postId, job_id, erro: erro.message });
            }
        }));

        await prismaAdapter.atualizarScheduledFor(postId, data);

        return { message: 'Data de agendamento atualizada com sucesso', postId, scheduled_for: data };
    }

    // Exclusão definitiva de post em qualquer status — usada pela lixeira do popup do Kanban. Some
    // com o card, o arquivo em disco, o thumbnail e os comentários (cascade no schema). Se o post ainda
    // estiver SCHEDULED com job(s) na fila, eles precisam ser removidos antes de excluir (mesmo cuidado
    // de cancelarAgendamento — um job 'delayed' órfão tentaria publicar um post que não existe mais).
    static async excluirPost (postId, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        // Só existe job pra remover se o post ainda estava SCHEDULED — null aqui é esperado (e não é
        // erro) pra draft/publicado/etc., que nunca tiveram job pendente na fila.
        const postAgendado = await prismaAdapter.buscarPostAgendadoComJobs(postId, clientId);
        if (postAgendado) {
            await Promise.all(postAgendado.post_accounts.map(async ({ job_id }) => {
                if (!job_id) return;
                try {
                    const job = await publishQueue.getJob(job_id);
                    if (job && (await job.getState()) === 'delayed') await job.remove();
                } catch (erro) {
                    console.warn('Falha ao remover job agendado da fila', { postId, job_id, erro: erro.message });
                }
            }));
        }

        const post = await prismaAdapter.excluirPostDefinitivo(postId, clientId);
        if (!post) throw new AppError('Post não encontrado');

        await schedulingHelpers.removerMidiaDoDisco(post.media);

        return { message: 'Post excluído com sucesso', postId };
    }

    static async criarDraft (caption, arquivos, accountIds, clientId, userId, columnIdExplicito) {
        await schedulingHelpers.validarCliente(clientId, userId);

        if (!Array.isArray(accountIds) || accountIds.length === 0) {
            throw new AppError('Selecione ao menos uma conta para o rascunho');
        }

        const columnId = await schedulingHelpers.resolverColumnId(clientId, columnIdExplicito);
        const midiaItems = await schedulingHelpers.montarMidiaItems(arquivos);
        return prismaAdapter.criarDraftComContas(caption, midiaItems, clientId, accountIds, columnId);
    }

    static async publicarDraft (draftId, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const draft = await prismaAdapter.buscarDraftPorId(draftId, clientId);
        if (!draft) throw new AppError('Draft não encontrado');

        if (draft.media.length === 0) throw new AppError('Adicione uma mídia antes de publicar');
        const contasVinculadas = await prismaAdapter.listarContasDoDraft(draftId, clientId);
        if (contasVinculadas.length === 0) throw new AppError('Este rascunho não possui contas vinculadas');

        return schedulingHelpers.enfileirarContas(draft, contasVinculadas, clientId);
    }

    // Análogo de publicarDraft, mas agendando em vez de publicar imediatamente. Existe pra permitir
    // agendar um post que já está no Kanban (ex.: card em "Rascunhos") sem duplicar o post nem reenviar o
    // arquivo — ao contrário de agendarPostagem (multipart, sempre cria um post novo).
    static async agendarDraft (draftId, clientId, userId, scheduledFor) {
        await schedulingHelpers.validarCliente(clientId, userId);
        schedulingHelpers.validarFormatoData(scheduledFor);


        const data = new Date(scheduledFor);
        const delayMs = data.getTime() - Date.now();
        if (Number.isNaN(delayMs) || delayMs <= 0) {
            throw new AppError('A data de agendamento precisa estar no futuro.');
        }

        const draft = await prismaAdapter.buscarDraftPorId(draftId, clientId);
        if (!draft) throw new AppError('Draft não encontrado');

        if (draft.media.length === 0) throw new AppError('Adicione uma mídia antes de agendar');

        const contasVinculadas = await prismaAdapter.listarContasDoDraft(draftId, clientId);
        if (contasVinculadas.length === 0) throw new AppError('Este rascunho não possui contas vinculadas');

        await prismaAdapter.atualizarScheduledFor(draftId, data);

        return schedulingHelpers.enfileirarContas(draft, contasVinculadas, clientId, { delayMs, statusInicial: 'SCHEDULED' });
    }

    static async atualizarDraft (draftId, caption, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const draftAtualizado = await prismaAdapter.atualizarDraft(draftId, caption, clientId);
        if (!draftAtualizado) throw new AppError('Draft não encontrado');
        return draftAtualizado;
    }

    // Substitui TODA a mídia de um draft (drag&drop ou clique no lápis, no popup do Kanban) — o
    // conjunto novo troca o antigo por inteiro, não soma. arquivos vem de req.files (multer), já
    // salvos em disco pelo controller antes de chegar aqui.
    static async atualizarMidiaDraft (draftId, clientId, userId, arquivos) {
        await schedulingHelpers.validarCliente(clientId, userId);
        const draftAtual = await prismaAdapter.buscarDraftPorId(draftId, clientId);
        if (!draftAtual) throw new AppError('Draft não encontrado');

        const midiaItems = await schedulingHelpers.montarMidiaItems(arquivos);
        const draftAtualizado = await prismaAdapter.substituirMidiaDoPost(draftId, clientId, midiaItems);
        if (!draftAtualizado) throw new AppError('Draft não encontrado');

        await schedulingHelpers.removerMidiaDoDisco(draftAtual.media);
        return draftAtualizado;
    }

    // Remove a mídia de um draft (lixeira no popup) — post continua DRAFT, só fica sem arquivo até o
    // usuário anexar outro (ou publicar/agendar, o que passa a ser bloqueado enquanto estiver vazio).
    // Substituir por conjunto vazio é exatamente "remover tudo", por isso reusa substituirMidiaDoPost.
    static async removerMidiaDraft (draftId, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);
        const draftAtual = await prismaAdapter.buscarDraftPorId(draftId, clientId);
        if (!draftAtual) throw new AppError('Draft não encontrado');

        const draftAtualizado = await prismaAdapter.substituirMidiaDoPost(draftId, clientId, []);
        if (!draftAtualizado) throw new AppError('Draft não encontrado');

        await schedulingHelpers.removerMidiaDoDisco(draftAtual.media);
        return draftAtualizado;
    }

    // Remove só um item do carrossel (o "X" na miniatura, no popup do Kanban), mantendo os demais
    // intocados — ao contrário de removerMidiaDraft, que zera tudo. Reaproveita a busca do draft
    // atualizado em vez de montar a resposta à mão, pra bater exatamente com o shape que o
    // frontend já espera de qualquer outra leitura de draft.
    static async removerItemDeMidia (draftId, mediaId, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const itemRemovido = await prismaAdapter.removerItemDeMidia(mediaId, draftId, clientId);
        if (!itemRemovido) throw new AppError('Mídia não encontrada neste draft');

        await schedulingHelpers.removerMidiaDoDisco([itemRemovido]);
        return prismaAdapter.buscarDraftPorId(draftId, clientId);
    }

    static async buscarDraft (draftId, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const draft = await prismaAdapter.buscarDraftComContas(draftId, clientId);
        if (!draft) throw new AppError('Draft não encontrado');
        return draft;
    }

    static async listarDrafts (clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const drafts = await prismaAdapter.listarDrafts(clientId);
        return drafts;
    }

    static async excluirDraft (draftId, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const draft = await prismaAdapter.excluirDraft(draftId, clientId);
        if (!draft) throw new AppError('Draft não encontrado');

        await schedulingHelpers.removerMidiaDoDisco(draft.media);
        return draft;
    }

    // Feed Global ("torre de controle"): cross-client, escopado ao usuário autenticado. filtros:
    // { status, clientId?, date? } — status já validado/default no controller (#parseFiltrosFeedGlobal).
    static async listarFeedGlobal (userId, filtros, page, limit) {
        if (filtros.clientId) await schedulingHelpers.validarCliente(filtros.clientId, userId);

        const statusList = FEED_STATUS_FILTER_MAP[filtros.status];
        const intervalo = this.#resolverIntervaloData(filtros.date);

        const { posts, total } = await prismaAdapter.listarFeedGlobal({
            userId,
            clientId: filtros.clientId,
            statusList,
            intervalo,
            page,
            limit
        });

        return {
            feed: posts,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        };
    }

    // Feed do Cliente ("vitrine/portfólio"): sempre de um único client. filtros:
    // { clientId, platform?, month?, year? } — clientId é obrigatório (garantido no controller).
    static async listarFeedCliente (userId, filtros, page, limit) {
        await schedulingHelpers.validarCliente(filtros.clientId, userId);

        const intervalo = this.#resolverIntervaloMesAno(filtros.month, filtros.year);

        const { posts, total } = await prismaAdapter.listarFeedCliente({
            clientId: filtros.clientId,
            platform: filtros.platform,
            intervalo,
            page,
            limit
        });

        return {
            feed: posts,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        };
    }

    // TODO (implementação manual): decidir e implementar a regra de republicação do botão
    // "Republicar" do Feed Global, disparado sobre posts FAILED/PARTIAL.
    // Sugestão de esqueleto do fluxo:
    //   1. localizar post + post_accounts com delivery_status FAILED (novo método no adapter);
    //   2. decidir escopo: só as contas FAILED, ou o post inteiro volta a PROCESSING?
    //   3. resetar delivery_status/error_message pra PENDING nas contas relevantes;
    //   4. reaproveitar o padrão de #enfileirarContas (publishQueue.add) pra re-enfileirar.
    static async republicarPost (postId, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const post = await prismaAdapter.buscarPostComStatusContas(postId, clientId);
        if (!post) throw new AppError('Post não encontrado');

        const contasFailed = post.accounts.filter(account => account.delivery_status === 'FAILED');
        if (contasFailed.length === 0) throw new AppError('Não há contas com falha para republicar');

        await Promise.all(contasFailed.map(account =>
            prismaAdapter.vincularPostConta(postId, account.accountId, 'PENDING', null, null)
        ));

        return schedulingHelpers.enfileirarContas(
            post,
            contasFailed.map(account => ({ id: account.accountId })),
            clientId
        );
    }

    // buscarDraftPorId já filtra status: 'DRAFT' — se achou o post, ele é DRAFT por definição, não
    // precisa reconferir. Substitui TODAS as contas vinculadas pelo conjunto novo enviado (não
    // soma às existentes) — decisão consistente com o formulário de seleção de contas ser um
    // multi-select que reflete o estado final desejado, igual a qualquer outro formulário de edição.
    static async vincularContasAoDraft (draftId, clientId, userId, accountIds) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const draft = await prismaAdapter.buscarDraftPorId(draftId, clientId);
        if (!draft) throw new AppError('Draft não encontrado');

        if (!Array.isArray(accountIds) || accountIds.length === 0) {
            throw new AppError('Selecione ao menos uma conta');
        }

        await Promise.all(accountIds.map(async accountId => {
            const conta = await prismaAdapter.buscarContaPorId(accountId, clientId);
            if (!conta) throw new AppError(`Conta ${accountId} não pertence ao cliente ${clientId}`);
        }));

        const accounts = await prismaAdapter.substituirContasDoDraft(draftId, clientId, accountIds);

        return { message: 'Contas vinculadas com sucesso', draftId, accounts };
    }
}

module.exports = PostService;
