const prismaAdapter = require('../adapters/prismaAdapter.js');
const postService = require('./postService.js');
const schedulingHelpers = require('./schedulingHelpers.js');
const recurrenceService = require('./recurrenceService.js');
const AppError = require('../errors/AppError.js');

// Fluxo de Stories, separado do de FEED/carrossel (postService) por três diferenças de fundo:
// Story é sempre 1 mídia só (a API de Stories da Meta não tem carrossel), só Story tem agendamento
// recorrente, e Story não tem legenda (a Meta não aceita caption no endpoint de Stories, e a
// discussão interna do card já vive no chat — card_comments). O que os dois fluxos compartilham
// (posse do client, coluna do Kanban, thumbnail, enfileiramento) vem de schedulingHelpers.
const FORMATO_STORY = 'STORY';
const SEM_LEGENDA = null;

// prismaAdapter.criarPost espera midiaItems no shape de CRIAÇÃO (filePath/fileName/fileType,
// camelCase — o que #montarMidiaParaCriacao lê). Um `media` vindo de leitura (buscarDraftPorId,
// buscarPostDetalhado) está no shape de RESPOSTA (file_path/file_name/file_type, snake_case, já
// gravado no banco). Precisa dessa conversão sempre que uma ocorrência nova reaproveita a mídia de
// outra já existente, em vez de vir de um upload novo.
function midiaExistenteParaCriacao (media) {
    return media.map(item => ({
        filePath: item.file_path,
        fileName: item.file_name,
        fileType: item.file_type,
        thumbnailPath: item.thumbnail_path
    }));
}

class StoryService {

    // Publicação imediata — recorrência não se aplica ("postar recorrente agora" não existe).
    static async publicarStory (arquivo, accountsList, clientId, userId, columnIdExplicito) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const columnId = await schedulingHelpers.resolverColumnId(clientId, columnIdExplicito);
        const midiaItems = await schedulingHelpers.montarMidiaItems([arquivo]);
        const novoPost = await prismaAdapter.criarPost(
            SEM_LEGENDA, midiaItems, 'DRAFT', clientId, null, columnId, { format: FORMATO_STORY }
        );

        return schedulingHelpers.enfileirarContas(novoPost, accountsList, clientId);
    }

    // scheduledDates: array de strings ISO 8601 com fuso explícito, mesmo formato que scheduled_for
    // usa nas outras rotas — só que aqui pode vir mais de uma. Mesma filosofia de post_media: a
    // CONTAGEM decide, sem bifurcar "avulso" vs "recorrente" em dois caminhos de código diferentes.
    // 1 data = agendamento normal (sem post_recurrences); 2+ = série (agrupada por post_recurrences).
    static async agendarStory (arquivo, accountsList, scheduledDates, clientId, userId, columnIdExplicito) {
        await schedulingHelpers.validarCliente(clientId, userId);
        recurrenceService.validarRegra(scheduledDates);

        const columnId = await schedulingHelpers.resolverColumnId(clientId, columnIdExplicito);
        // Gerado UMA vez e reaproveitado por todas as ocorrências: o arquivo em disco é o mesmo,
        // então regerar thumbnail por ocorrência só queimaria CPU pra produzir bytes idênticos.
        const midiaItems = await schedulingHelpers.montarMidiaItems([arquivo]);

        // null quando for só 1 data, pra não inventar um grupo de 1 membro.
        const recurrenceId = scheduledDates.length === 1
            ? null
            : (await prismaAdapter.criarRegraRecorrencia(clientId)).id;

        // Sequencial de propósito (não Promise.all): são N inserts + N*contas jobs — disparar tudo
        // em paralelo satura o pool do Prisma e o Redis. Cada ocorrência já fica agendada assim que
        // seu próprio insert+enfileiramento termina; se uma do meio falhar, as anteriores continuam
        // válidas (sem transação — a fila do BullMQ está fora do banco e não faz rollback junto).
        for (const dataStr of scheduledDates) {
            const data = new Date(dataStr);
            const post = await prismaAdapter.criarPost(
                SEM_LEGENDA, midiaItems, 'SCHEDULED', clientId, data, columnId, { format: FORMATO_STORY, recurrenceId }
            );
            await schedulingHelpers.enfileirarContas(post, accountsList, clientId, {
                delayMs: data.getTime() - Date.now(),
                statusInicial: 'SCHEDULED'
            });
        }

        return {
            status: 'scheduled',
            recorrenciaId: recurrenceId,
            totalOcorrencias: scheduledDates.length,
            totalContas: accountsList.length
        };
    }

    // Espelha postService.criarDraft: cria o post em status DRAFT, sem enfileirar nada — só depois
    // de publish/schedule ele entra na fila. Sempre 1 arquivo (Story não tem carrossel).
    static async criarDraftStory (arquivo, accountIds, clientId, userId, columnIdExplicito) {
        await schedulingHelpers.validarCliente(clientId, userId);
        if (!Array.isArray(accountIds) || accountIds.length === 0) {
            throw new AppError('Informe ao menos uma conta para o rascunho de Story.');
        }
        const columnId = await schedulingHelpers.resolverColumnId(clientId, columnIdExplicito);
        const midiaItems = await schedulingHelpers.montarMidiaItems([arquivo]);
        return prismaAdapter.criarDraftComContas(SEM_LEGENDA, midiaItems, clientId, accountIds, columnId, { format: FORMATO_STORY });
    }

    // Agenda um rascunho JÁ EXISTENTE (mídia/legenda já salvas) — não recebe arquivo. Mesma
    // expansão em N ocorrências de agendarStory, só que a partir de um draft em vez de upload
    // fresco (por isso a 1ª ocorrência pode reaproveitar a linha já existente).
    static async agendarDraftStory (draftId, scheduledDates, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);
        recurrenceService.validarRegra(scheduledDates);

        const draft = await prismaAdapter.buscarDraftPorId(draftId, clientId);
        if (!draft) throw new AppError(`Rascunho de Story não encontrado: ${draftId}`);
        if (draft.media.length === 0) throw new AppError(`Rascunho de Story sem mídia: ${draftId}`);

        const accountsList = await prismaAdapter.listarContasDoDraft(draftId, clientId);
        if (!accountsList || accountsList.length === 0) throw new AppError(`Rascunho de Story sem contas vinculadas: ${draftId}`);

        const recurrenceId = scheduledDates.length === 1
            ? null
            : (await prismaAdapter.criarRegraRecorrencia(clientId)).id;

        // 1ª data REAPROVEITA a linha do draft (mesmo padrão que agendarDraft genérico já usa pra
        // 1 data só) — scheduled_for e recurrence_id entram na MESMA escrita que já muda o status.
        const [primeiraData, ...demaisDatas] = scheduledDates;
        const dataPrimeira = new Date(primeiraData);
        const resultado = await schedulingHelpers.enfileirarContas(draft, accountsList, clientId, {
            delayMs: dataPrimeira.getTime() - Date.now(),
            statusInicial: 'SCHEDULED',
            extra: { scheduled_for: dataPrimeira, recurrence_id: recurrenceId }
        });

        // Demais datas: novas ocorrências, mesmo loop sequencial de agendarStory.
        const midiaItems = midiaExistenteParaCriacao(draft.media);
        for (const dataStr of demaisDatas) {
            const data = new Date(dataStr);
            const post = await prismaAdapter.criarPost(
                SEM_LEGENDA, midiaItems, 'SCHEDULED', clientId, data, draft.column_id, { format: FORMATO_STORY, recurrenceId }
            );
            await schedulingHelpers.enfileirarContas(post, accountsList, clientId, {
                delayMs: data.getTime() - Date.now(),
                statusInicial: 'SCHEDULED'
            });
        }

        return {
            ...resultado,
            recorrenciaId: recurrenceId,
            totalOcorrencias: scheduledDates.length
        };
    }

    static async buscarStoryDetalhado (storyId, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const story = await prismaAdapter.buscarPostDetalhado(storyId, clientId);
        if (!story) throw new AppError(`Story não encontrado: ${storyId}`);
        return story;
    }

    static async listarSeries (clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);
        return prismaAdapter.listarSeriesDoCliente(clientId);
    }

    // Cria mais N ocorrências pra uma série já existente, clonando mídia/contas da ocorrência
    // MAIS RECENTE (critério: scheduled_for mais alto) — como cada ocorrência pode ter tido a
    // mídia trocada independentemente, "a mais recente" é a aproximação mais razoável do estado
    // atual que o usuário quer continuar repetindo.
    static async estenderSerie (recurrenceIdParam, scheduledDates, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);
        recurrenceService.validarRegra(scheduledDates);

        // Chega como string de req.params — normaliza uma vez, pra gravar Int no banco e devolver
        // recorrenciaId no mesmo tipo que agendarStory/agendarDraftStory já devolvem.
        const recurrenceId = parseInt(recurrenceIdParam);
        if (Number.isNaN(recurrenceId)) throw new AppError(`Série de Story inválida: ${recurrenceIdParam}`);

        const ocorrencias = await StoryService.listarOcorrenciasDaSerie(recurrenceId, clientId, userId);

        const referencia = ocorrencias.reduce((maisRecente, post) =>
            (!maisRecente || post.scheduled_for > maisRecente.scheduled_for) ? post : maisRecente, null);

        const detalhe = await prismaAdapter.buscarPostDetalhado(referencia.id, clientId);
        if (!detalhe) throw new AppError(`Não foi possível buscar detalhes da ocorrência de referência: ${referencia.id}`);

        const contas = await prismaAdapter.listarContasDoDraft(referencia.id, clientId);
        if (!contas || contas.length === 0) throw new AppError(`Não foi possível listar contas da ocorrência de referência: ${referencia.id}`);

        const midiaItems = midiaExistenteParaCriacao(detalhe.media);

        // Sequencial (mesmo motivo de agendarStory: não saturar o pool/fila disparando em paralelo).
        for (const dataStr of scheduledDates) {
            const data = new Date(dataStr);
            const post = await prismaAdapter.criarPost(
                SEM_LEGENDA, midiaItems, 'SCHEDULED', clientId, data, detalhe.column_id, { format: FORMATO_STORY, recurrenceId }
            );
            await schedulingHelpers.enfileirarContas(post, contas, clientId, {
                delayMs: data.getTime() - Date.now(),
                statusInicial: 'SCHEDULED'
            });
        }

        return {
            recorrenciaId: recurrenceId,
            totalNovasOcorrencias: scheduledDates.length
        };
    }

    // Todas as ocorrências (passadas E futuras) de uma série, pra UI mostrar "essa Story repete em
    // tais datas" ou permitir cancelar a série inteira.
    static async listarOcorrenciasDaSerie (recurrenceId, clientId, userId) {
        await schedulingHelpers.validarCliente(clientId, userId);

        const ocorrencias = await prismaAdapter.listarPostsPorRecorrencia(recurrenceId, clientId);
        if (!ocorrencias || ocorrencias.length === 0) {
            throw new AppError(`Série de Story não encontrada ou sem ocorrências: ${recurrenceId}`);
        }
        return ocorrencias;
    }

    // Colapsa as ocorrências FUTURAS e ainda SCHEDULED da série numa só: a mais próxima volta a
    // ser rascunho solto (mesma mídia de sempre), as demais são excluídas de vez — não faz sentido
    // virar N rascunhos idênticos. Ocorrências já publicadas/falhas/em processamento não são
    // tocadas (histórico preservado).
    static async cancelarSerie (recurrenceId, clientId, userId) {
        const ocorrenciasSerie = await StoryService.listarOcorrenciasDaSerie(recurrenceId, clientId, userId);

        const futurasScheduled = ocorrenciasSerie.filter(post => post.status === 'SCHEDULED');
        if (futurasScheduled.length === 0) {
            throw new AppError(`Série de Story não tem ocorrências futuras SCHEDULED: ${recurrenceId}`);
        }

        // listarOcorrenciasDaSerie já vem em ordem cronológica — a mais próxima é quem sobra.
        const [mantida, ...restantes] = futurasScheduled;

        await postService.cancelarAgendamento(mantida.id, clientId, userId);
        for (const post of restantes) {
            await postService.excluirPost(post.id, clientId, userId);
        }

        return { totalCanceladas: futurasScheduled.length, draftId: mantida.id };
    }

    // Diferente de cancelarSerie (colapsa só as SCHEDULED, preserva histórico): exclui a série
    // POR COMPLETO — todas as ocorrências em QUALQUER status (mesmo escopo de excluirPost, que já
    // apaga em qualquer status) e o grupo em si. Não sobra rascunho nenhum.
    static async excluirSerie (recurrenceId, clientId, userId) {
        const ocorrencias = await StoryService.listarOcorrenciasDaSerie(recurrenceId, clientId, userId);

        // Sequencial (mesmo motivo de sempre — não saturar o pool/fila disparando em paralelo).
        for (const post of ocorrencias) {
            await postService.excluirPost(post.id, clientId, userId);
        }

        // Só depois de excluir todas as ocorrências: post_recurrences.posts é SetNull, não
        // Cascade — apagar o grupo antes deixaria os posts órfãos em vez de excluí-los.
        await prismaAdapter.excluirRegraRecorrencia(recurrenceId, clientId);

        return { totalExcluidas: ocorrencias.length };
    }
}

module.exports = StoryService;
