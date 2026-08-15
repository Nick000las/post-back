const prismaAdapter = require('../adapters/prismaAdapter.js');
const AppError = require('../errors/AppError.js');
const { publishQueue } = require('../queues/publishQueue.js');
const kanbanService = require('./kanbanService.js');
const thumbnailService = require('./thumbnailService.js');
const { FIXED_COLUMN_KEYS } = require('../constants/kanban.js');
const fs = require('fs');
const path = require('path');

// Peças compartilhadas entre postService (FEED/carrossel) e storyService (Stories): validação de
// posse, resolução de coluna do Kanban, geração de mídia e enfileiramento na fila de publicação.
// Extraído de PostService (onde eram métodos privados, inacessíveis de fora) sem mudança de
// comportamento — os dois fluxos precisam exatamente da mesma lógica pra criar um post agendado.

const UPLOADS_DIR = '.uploads';
const FORMATO_ISO_COM_FUSO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function removerArquivoLocal (arquivo) {
    if (fs.existsSync(arquivo.path)) {
        fs.unlinkSync(arquivo.path);
    }
}

// Apaga do disco o arquivo original e o thumbnail de cada item de mídia de um post. Ponto único
// usado por toda exclusão/substituição de mídia. Tolera media undefined/vazio (post sem mídia é
// estado válido).
// Antes de apagar, confere se algum OUTRO post_media ainda referencia o mesmo arquivo — ocorrências
// de uma série de Story compartilham o mesmo arquivo físico entre si (ver
// prismaAdapter#contarUsosDeArquivo), então apagar a mídia de UMA ocorrência não pode levar junto o
// arquivo que outra ocorrência (draft sobrevivente de um cancelamento em colapso, ou uma já
// publicada) ainda precisa. Sequencial de propósito, mesmo motivo de sempre: evita disparar N
// contagens em paralelo pra um post com poucos itens de mídia (quase sempre 1).
async function removerMidiaDoDisco (media = []) {
    for (const item of media) {
        if (item.file_path && (await prismaAdapter.contarUsosDeArquivo(item.file_path)) === 0) {
            removerArquivoLocal({ path: path.join(UPLOADS_DIR, item.file_path) });
        }
        if (item.thumbnail_path && (await prismaAdapter.contarUsosDeThumbnail(item.thumbnail_path)) === 0) {
            removerArquivoLocal({ path: path.join(UPLOADS_DIR, 'thumbs', item.thumbnail_path) });
        }
    }
}

// Converte os arquivos do multer (req.files) no shape que o adapter espera, gerando o thumbnail
// de cada um. A ordem do array é a ordem do carrossel. thumbnailService.gerar nunca lança (já
// devolve null em caso de falha), então um thumbnail quebrado não derruba o upload inteiro.
async function montarMidiaItems (arquivos) {
    return Promise.all(arquivos.map(async arquivo => ({
        filePath: arquivo.filename,
        fileName: arquivo.originalname,
        fileType: arquivo.mimetype,
        thumbnailPath: await thumbnailService.gerar(arquivo)
    })));
}

// Confere que o client pertence ao usuário autenticado (agência) antes de liberar qualquer
// operação nas contas/posts desse client.
async function validarCliente (clientId, userId) {
    const cliente = await prismaAdapter.buscarClientePorId(clientId, userId);
    if (!cliente) throw new AppError('Cliente não encontrado');
    return cliente;
}

// Gancho de IA (Kanban): todo post criado passa por aqui pra decidir sua column_id. Se
// columnIdExplicito vier definido, usa ele; senão, cai por padrão na coluna "Rascunhos" do client.
// Este é o ÚNICO lugar que decide esse default.
async function resolverColumnId (clientId, columnIdExplicito) {
    if (columnIdExplicito !== undefined && columnIdExplicito !== null) {
        return parseInt(columnIdExplicito);
    }
    return await kanbanService.resolverColunaIdeias(clientId);
}

// Salto automático de coluna no Kanban: quando um post muda pra um status "de fase" (agendado ou
// finalizado), ele pula pra coluna fixa correspondente, sem passar pela validação de
// kanbanService.moverPost (que só existe pra bloquear o usuário movendo manualmente — esse bloqueio
// não se aplica aqui, é o próprio sistema movendo). Silencioso por design: um post sem coluna fixa
// configurada (inconsistência de dados) não pode derrubar o fluxo de publicação.
async function moverParaColunaFixa (postId, clientId, fixedKey) {
    try {
        const coluna = await prismaAdapter.buscarColunaPorFixedKey(clientId, fixedKey);
        if (!coluna) return;
        await prismaAdapter.moverPostDeColuna(postId, clientId, coluna.id);
    } catch (erro) {
        console.error('Falha ao mover post automaticamente de coluna', { postId, clientId, fixedKey, erro: erro.message });
    }
}

// A tentativa de publicar em si (e o registro de sucesso/falha por conta) vive no worker
// (src/workers/publishWorker.js) — aqui só marcamos o post e enfileiramos.
// opts.delayMs: usado pelo agendamento (undefined = publica assim que possível).
// opts.statusInicial: 'PROCESSING' (padrão, publicação imediata) ou 'SCHEDULED'.
// opts.extra: campos adicionais mesclados na mesma atualização de status (ex.: scheduled_for e
// recurrence_id ao transformar um draft de Story na 1ª ocorrência de uma série) — evita um update
// separado quando o chamador já sabe de antemão o que precisa gravar junto com o status.
async function enfileirarContas (post, accountsList, clientId, opts = {}) {
    const { delayMs, statusInicial = 'PROCESSING', extra = {} } = opts;

    await prismaAdapter.atualizarStatusPost(post.id, statusInicial, extra);
    if (statusInicial === 'SCHEDULED') {
        await moverParaColunaFixa(post.id, clientId, FIXED_COLUMN_KEYS.AGENDADO);
    }

    const jobOpts = delayMs ? { delay: delayMs } : {};
    await Promise.all(accountsList.map(async account => {
        const job = await publishQueue.add('publicar-conta', { postId: post.id, accountId: account.id, clientId }, jobOpts);
        if (statusInicial === 'SCHEDULED') {
            await prismaAdapter.registrarJobAgendado(post.id, account.id, job.id);
        }
    }));

    return {
        status: statusInicial === 'SCHEDULED' ? 'scheduled' : 'queued',
        postId: post.id,
        totalContas: accountsList.length
    };
}

// Só valida o FORMATO da string (ISO 8601 com fuso explícito). A checagem de "está no futuro" fica
// com quem chama, que já precisa do delayMs calculado de qualquer forma.
function validarFormatoData (scheduledFor) {
    if (typeof scheduledFor !== 'string' || !FORMATO_ISO_COM_FUSO.test(scheduledFor)) {
        throw new AppError('Data de agendamento inválida. Use ISO 8601 com fuso horário explícito (ex.: 2026-08-01T10:00:00-03:00).');
    }
}

module.exports = {
    validarCliente,
    resolverColumnId,
    montarMidiaItems,
    enfileirarContas,
    moverParaColunaFixa,
    removerMidiaDoDisco,
    validarFormatoData
};
