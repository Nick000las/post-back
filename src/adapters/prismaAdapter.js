const { PrismaClient } = require('@prisma/client');
const cryptoUtil = require('../utils/cryptoUtil.js');
const { FIXED_COLUMN_KEYS, FIXED_COLUMNS_SEED, DIAS_VISIVEIS_COLUNA_FINALIZADO } = require('../constants/kanban.js');
const prisma = new PrismaClient();

const CONTA_SELECT_SEGURO = {
    id: true,
    name: true,
    platform: true,
    platform_account_id: true,
    created_at: true
};

// Campos base de post reaproveitados em todo select de leitura (drafts, feed, quadro kanban etc.) —
// única fonte de verdade pra não esquecer um campo novo (ex.: thumbnail_path) em algum dos vários
// pontos que selecionam post.
const POST_SELECT_BASE = {
    id: true,
    caption: true,
    file_path: true,
    file_name: true,
    file_type: true,
    thumbnail_path: true,
    status: true,
    created_at: true,
    updated_at: true
};

// Campos base de comentário reaproveitados em toda leitura de chat — já inclui o nome do autor
// (users.name) achatado via select, pra frontend não precisar de uma segunda chamada.
const COMMENT_SELECT_BASE = {
    id: true,
    post_id: true,
    text: true,
    attachment_path: true,
    attachment_original_name: true,
    attachment_mime_type: true,
    attachment_size: true,
    created_at: true,
    users: { select: { id: true, name: true } }
};


class PrismaAdapter {
    static async buscarClientePorId(clientId, userId) {
        return await prisma.clients.findFirst({
            where: { id: parseInt(clientId), user_id: userId }
        });
    }

    static async criarClient(name, userId) {
        return await prisma.$transaction(async (tx) => {
            const client = await tx.clients.create({
                data: { name, user_id: userId }
            });

            await tx.columns.createMany({
                data: FIXED_COLUMNS_SEED.map(coluna => ({
                    ...coluna,
                    is_fixed: true,
                    client_id: client.id
                }))
            });

            return client;
        });
    }

    static async listarClients(userId) {
        return await prisma.clients.findMany({
            where: { user_id: userId },
            orderBy: { created_at: 'desc' }
        });
    }

    static async atualizarClient(id, userId, name) {
        const resultado = await prisma.clients.updateMany({
            where: { id: parseInt(id), user_id: userId },
            data: { name }
        });
        if (resultado.count === 0) return null;

        return await prisma.clients.findUnique({ where: { id: parseInt(id) } });
    }

    static async excluirClient(id, userId) {
        const client = await prisma.clients.findFirst({
            where: { id: parseInt(id), user_id: userId }
        });
        if (!client) return null;

        await prisma.clients.delete({ where: { id: client.id } });
        return client;
    }

    // ---- Kanban: colunas ----

    static async listarColunas(clientId) {
        return await prisma.columns.findMany({
            where: { client_id: parseInt(clientId) },
            orderBy: { order: 'asc' }
        });
    }

    static async buscarColunaPorId(id, clientId) {
        return await prisma.columns.findFirst({
            where: { id: parseInt(id), client_id: parseInt(clientId) }
        });
    }

    // Ponto de resolução reutilizável do "gancho de IA": toda criação de post que não vier com
    // column_id explícito cai aqui (via kanbanService.resolverColunaIdeias).
    static async buscarColunaIdeias(clientId) {
        return await prisma.columns.findFirst({
            where: { client_id: parseInt(clientId), fixed_key: FIXED_COLUMN_KEYS.IDEIAS },
            select: { id: true }
        });
    }

    // Genérico: busca qualquer uma das 3 colunas fixas (Ideias/Agendado/Finalizado) do client. Usado
    // pelo salto automático de coluna quando um post muda de status (ver postService#moverParaColunaFixa).
    static async buscarColunaPorFixedKey(clientId, fixedKey) {
        return await prisma.columns.findFirst({
            where: { client_id: parseInt(clientId), fixed_key: fixedKey },
            select: { id: true }
        });
    }

    static async criarColunaDinamica(clientId, name) {
        const [maiorOrderDinamica, colunaIdeias] = await Promise.all([
            prisma.columns.aggregate({
                where: { client_id: parseInt(clientId), is_fixed: false },
                _max: { order: true }
            }),
            prisma.columns.findFirst({
                where: { client_id: parseInt(clientId), fixed_key: FIXED_COLUMN_KEYS.IDEIAS },
                select: { order: true }
            })
        ]);

        const order = (maiorOrderDinamica._max.order ?? colunaIdeias.order) + 1;

        return await prisma.columns.create({
            data: { name, client_id: parseInt(clientId), order, is_fixed: false }
        });
    }

    static async renomearColuna(id, clientId, name) {
        const resultado = await prisma.columns.updateMany({
            where: { id: parseInt(id), client_id: parseInt(clientId), is_fixed: false },
            data: { name }
        });
        if (resultado.count === 0) return null;

        return await prisma.columns.findUnique({ where: { id: parseInt(id) } });
    }

    static async excluirColunaDinamica(id, clientId) {
        return await prisma.$transaction(async (tx) => {
            const coluna = await tx.columns.findFirst({
                where: { id: parseInt(id), client_id: parseInt(clientId), is_fixed: false },
                select: { id: true, name: true }
            });
            if (!coluna) return null;

            const colunaIdeias = await tx.columns.findFirst({
                where: { client_id: parseInt(clientId), fixed_key: FIXED_COLUMN_KEYS.IDEIAS },
                select: { id: true }
            });
            if (!colunaIdeias) throw new Error(`Client ${clientId} sem coluna Ideias — inconsistência de dados`);

            const { count: postsMovidos } = await tx.posts.updateMany({
                where: { client_id: parseInt(clientId), column_id: parseInt(id) },
                data: { column_id: colunaIdeias.id }
            });

            await tx.columns.delete({ where: { id: coluna.id } });
            return { ...coluna, postsMovidos };
        });
    }


    static async moverPostDeColuna(postId, clientId, columnId) {
        const resultado = await prisma.posts.updateMany({
            where: { id: parseInt(postId), client_id: parseInt(clientId) },
            data: { column_id: parseInt(columnId), updated_at: new Date() }
        });
        if (resultado.count === 0) return null;

        return await prisma.posts.findUnique({ where: { id: parseInt(postId) } });
    }

    static async buscarQuadro(clientId) {
        const columns = await prisma.columns.findMany({
            where: { client_id: parseInt(clientId) },
            orderBy: { order: 'asc' },
            select: {
                id: true, name: true, order: true, is_fixed: true, fixed_key: true,
                posts: {
                    select: {
                        ...POST_SELECT_BASE,
                        scheduled_for: true,
                        post_accounts: { select: { accounts: { select: CONTA_SELECT_SEGURO } } }
                    }
                }
            }
        });

        // Corte de retenção só da coluna Finalizado (ver DIAS_VISIVEIS_COLUNA_FINALIZADO) — usa
        // updated_at como proxy de "quando finalizou": nada mais toca esse campo depois que o post
        // entra em Finalizado (edição de legenda só existe pra DRAFT, e mover manualmente pra dentro
        // dessa coluna já é bloqueado em kanbanService.moverPost).
        const dataLimiteFinalizado = new Date();
        dataLimiteFinalizado.setDate(dataLimiteFinalizado.getDate() - DIAS_VISIVEIS_COLUNA_FINALIZADO);

        return columns.map(({ posts, ...column }) => {
            const postsVisiveis = column.fixed_key === FIXED_COLUMN_KEYS.FINALIZADO
                ? posts.filter(post => post.updated_at >= dataLimiteFinalizado)
                : posts;

            return {
                ...column,
                posts: postsVisiveis.map(({ post_accounts, ...post }) => ({
                    ...post,
                    accounts: post_accounts.map(vinculo => vinculo.accounts)
                }))
            };
        });
    }

    static async buscarUsuarioPorEmail(email) {
        return await prisma.users.findUnique({
            where: { email }
        });
    }

    static async buscarUsuarioPorId(id) {
        return await prisma.users.findUnique({
            where: { id }
        });
    }

    static async criarUsuario(name, email, passwordHash) {
        return await prisma.users.create({
            data: { name, email, password_hash: passwordHash }
        });
    }


    static async criarPost(caption, filePath, fileName, fileType, status, clientId, scheduledFor = null, columnId = null, thumbnailPath = null) {
        return await prisma.posts.create({
            data: {
                caption,
                file_path: filePath,
                file_name: fileName,
                file_type: fileType,
                status,
                client_id: parseInt(clientId),
                scheduled_for: scheduledFor,
                column_id: columnId,
                thumbnail_path: thumbnailPath
            }
        });
    }

    static async registrarJobAgendado(postId, accountId, jobId) {
        return await prisma.post_accounts.upsert({
            where: { post_id_account_id: { post_id: postId, account_id: accountId } },
            create: { post_id: postId, account_id: accountId, delivery_status: 'PENDING', job_id: jobId },
            update: { job_id: jobId }
        });
    }

    static async atualizarStatusPost(postId, status) {
        return await prisma.posts.update({
            where: { id: postId },
            data: { status, updated_at: new Date() }
        });
    }

    static async atualizarScheduledFor(postId, scheduledFor) {
        return await prisma.posts.update({
            where: { id: parseInt(postId) },
            data: { scheduled_for: scheduledFor, updated_at: new Date() }
        });
    }

    static async vincularPostConta(postId, accountId, status, apiPostId, errorMessage) {
        const dados = {
            delivery_status: status,
            api_post_id: apiPostId,
            error_message: errorMessage,
            processed_at: new Date()
        };

        return await prisma.post_accounts.upsert({
            where: { post_id_account_id: { post_id: postId, account_id: accountId } },
            create: { post_id: postId, account_id: accountId, ...dados },
            update: dados
        });
    }

    static async listarContas(clientId) {
        return await prisma.accounts.findMany({
            where: { client_id: parseInt(clientId) },
            select: CONTA_SELECT_SEGURO
        });
    }

    static async buscarContaPorId(id, clientId) {
        return await prisma.accounts.findFirst({
            where: { id: parseInt(id), client_id: parseInt(clientId) }
        });
    }

    static async buscarContaPorPlatformAccountId(platformAccountId) {
        return await prisma.accounts.findUnique({
            where: { platform_account_id: platformAccountId }
        });
    }

    static async criarConta(contaData) {
        const dadosCriptografados = { ...contaData, access_token: cryptoUtil.encrypt(contaData.access_token) };
        return await prisma.accounts.create({
            data: dadosCriptografados,
            select: CONTA_SELECT_SEGURO
        });
    }

    static async atualizarConta(id, clientId, atualizacoes) {
        const dados = atualizacoes.access_token
            ? { ...atualizacoes, access_token: cryptoUtil.encrypt(atualizacoes.access_token) }
            : atualizacoes;

        const resultado = await prisma.accounts.updateMany({
            where: { id: parseInt(id), client_id: parseInt(clientId) },
            data: dados
        });
        if (resultado.count === 0) return null;

        return await prisma.accounts.findUnique({
            where: { id: parseInt(id) },
            select: CONTA_SELECT_SEGURO
        });
    }

    static async excluirConta(id, clientId) {
        const conta = await prisma.accounts.findFirst({
            where: { id: parseInt(id), client_id: parseInt(clientId) },
            select: CONTA_SELECT_SEGURO
        });
        if (!conta) return null;

        await prisma.accounts.delete({ where: { id: parseInt(id) } });
        return conta;
    }

    static async criarDraftComContas(caption, fileName, filePath, fileType, clientId, accountIds, columnId = null, thumbnailPath = null) {
        return await prisma.$transaction(async (tx) => {
            const draft = await tx.posts.create({
                data: {
                    caption,
                    file_path: filePath,
                    file_name: fileName,
                    file_type: fileType,
                    status: 'DRAFT',
                    client_id: parseInt(clientId),
                    column_id: columnId,
                    thumbnail_path: thumbnailPath
                }
            });

            await tx.post_accounts.createMany({
                data: accountIds.map(accountId => ({
                    post_id: draft.id,
                    account_id: accountId,
                    delivery_status: 'PENDING'
                }))
            });

            return draft;
        });
    }

    static async buscarDraftPorId(draftId, clientId) {
        return await prisma.posts.findFirst({
            where: { id: parseInt(draftId), client_id: parseInt(clientId), status: 'DRAFT' },
            select: POST_SELECT_BASE
        });
    }

    static async buscarPostPorId(postId) {
        return await prisma.posts.findUnique({
            where: { id: postId }
        });
    }

   
    static async buscarPostPorIdEClient(postId, clientId) {
        return await prisma.posts.findFirst({ 
            where: { id: parseInt(postId), client_id: parseInt(clientId) },
            select: { id: true }
        });
    }

    static async listarComentarios(postId) {
        return await prisma.card_comments.findMany({
            where: { post_id: parseInt(postId) },
            orderBy: { created_at: 'asc' },
            select: COMMENT_SELECT_BASE
        });
    }


    static async criarComentario(postId, userId, text, dadosAnexo) {
        return await prisma.card_comments.create({
            data: {
                post_id: parseInt(postId),
                user_id: userId,
                text,
                attachment_path: dadosAnexo?.path ?? null,
                attachment_original_name: dadosAnexo?.originalName ?? null,
                attachment_mime_type: dadosAnexo?.mimeType ?? null,
                attachment_size: dadosAnexo?.size ?? null
            },
            select: COMMENT_SELECT_BASE
        });
    }

    static async buscarPostComStatusContas(postId, clientId) {
        const post = await prisma.posts.findFirst({
            where: { id: parseInt(postId), client_id: parseInt(clientId) },
            select: {
                id: true,
                status: true,
                post_accounts: {
                    select: {
                        delivery_status: true,
                        error_message: true,
                        accounts: { select: { id: true, platform: true } }
                    }
                }
            }
        });
        if (!post) return null;

        const { post_accounts, ...rest } = post;
        return {
            ...rest,
            accounts: post_accounts.map(vinculo => ({
                accountId: vinculo.accounts.id,
                platform: vinculo.accounts.platform,
                delivery_status: vinculo.delivery_status,
                error_message: vinculo.error_message
            }))
        };
    }

    static async buscarPostAgendadoComJobs(postId, clientId) {
        return await prisma.posts.findFirst({
            where: { id: parseInt(postId), client_id: parseInt(clientId), status: 'SCHEDULED' },
            select: {
                id: true,
                file_path: true,
                post_accounts: { select: { job_id: true } }
            }
        });
    }

    // Cancelar agendamento não apaga mais o post — reverte pra DRAFT (arte/legenda preservadas), pra
    // a agência poder reagendar depois sem refazer o upload. Retorna null se não achar um SCHEDULED
    // com esse id+client (mesma regra de posse de sempre).
    static async reverterAgendamentoParaDraft(postId, clientId) {
        const resultado = await prisma.posts.updateMany({
            where: { id: parseInt(postId), client_id: parseInt(clientId), status: 'SCHEDULED' },
            data: { status: 'DRAFT', scheduled_for: null, updated_at: new Date() }
        });
        if (resultado.count === 0) return null;
        return prisma.posts.findUnique({ where: { id: parseInt(postId) }, select: POST_SELECT_BASE });
    }

    // Exclusão definitiva de post em QUALQUER status (ao contrário de excluirDraft, que só aceita
    // DRAFT) — usada pelo botão de lixeira do popup do Kanban. card_comments tem onDelete: Cascade no
    // schema, então os comentários somem junto automaticamente, sem precisar apagar nada à parte aqui.
    static async excluirPostDefinitivo(postId, clientId) {
        const post = await prisma.posts.findFirst({
            where: { id: parseInt(postId), client_id: parseInt(clientId) },
            select: { id: true, file_path: true }
        });
        if (!post) return null;

        await prisma.posts.delete({ where: { id: post.id } });
        return post;
    }

    static async listarStatusContasDoPost(postId) {
        return await prisma.post_accounts.findMany({
            where: { post_id: postId },
            select: { delivery_status: true }
        });
    }

    static async buscarDraftComContas(draftId, clientId) {
        const draft = await prisma.posts.findFirst({
            where: { id: parseInt(draftId), client_id: parseInt(clientId), status: 'DRAFT' },
            select: {
                ...POST_SELECT_BASE,
                post_accounts: { select: { accounts: { select: CONTA_SELECT_SEGURO } } }
            }
        });
        if (!draft) return null;

        const { post_accounts, ...draftSemVinculos } = draft;
        return { ...draftSemVinculos, accounts: post_accounts.map(vinculo => vinculo.accounts) };
    }

    static async listarContasDoDraft(draftId, clientId) {
        const vinculos = await prisma.post_accounts.findMany({
            where: { post_id: parseInt(draftId), accounts: { client_id: parseInt(clientId) } },
            select: { account_id: true }
        });
        return vinculos.map(vinculo => ({ id: vinculo.account_id }));
    }

    static async excluirDraft(draftId, clientId) {
        const draft = await prisma.posts.findFirst({
            where: { id: parseInt(draftId), client_id: parseInt(clientId), status: 'DRAFT' },
            select: POST_SELECT_BASE
        });
        if (!draft) return null;

        await prisma.posts.delete({ where: { id: draft.id } });
        return draft;
    }

    static async atualizarDraft(draftId, caption, clientId) {
        const resultado = await prisma.posts.updateMany({
            where: { id: parseInt(draftId), client_id: parseInt(clientId), status: 'DRAFT' },
            data: { caption, updated_at: new Date() }
        });
        if (resultado.count === 0) return null;

        return await prisma.posts.findUnique({
            where: { id: parseInt(draftId) },
            select: POST_SELECT_BASE
        });
    }

    // Substitui a mídia de um draft existente (edição no popup do Kanban). dadosMidia já vem pronto do
    // service: { filePath, fileName, fileType, thumbnailPath }. Mesmo padrão de atualizarDraft
    // (updateMany + count check + findUnique) — só aceita se o post ainda for DRAFT.
    static async atualizarMidiaDraft(draftId, clientId, dadosMidia) {
        const resultado = await prisma.posts.updateMany({
            where: { id: parseInt(draftId), client_id: parseInt(clientId), status: 'DRAFT' },
            data: {
                file_path: dadosMidia.filePath,
                file_name: dadosMidia.fileName,
                file_type: dadosMidia.fileType,
                thumbnail_path: dadosMidia.thumbnailPath,
                updated_at: new Date()
            }
        });
        if(resultado.count === 0) return null;
        return await prisma.posts.findUnique({
            where: { id: parseInt(draftId) },
            select: POST_SELECT_BASE
        });
    }

    // Limpa a mídia de um draft (botão de lixeira) — post fica com file_path/file_name/file_type/
    // thumbnail_path todos null, permanecendo DRAFT normalmente (só sem mídia até o usuário anexar
    // outra). Mesmo padrão updateMany + count check + findUnique.
    static async removerMidiaDraft(draftId, clientId) {
        const resultado = await prisma.posts.updateMany({
            where: { id: parseInt(draftId), client_id: parseInt(clientId), status: 'DRAFT' },
            data: {
                file_path: null,
                file_name: null,
                file_type: null,
                thumbnail_path: null,
                updated_at: new Date()
            }
        });
        if(resultado.count === 0) return null;
        return await prisma.posts.findUnique({
            where: { id: parseInt(draftId) },
            select: POST_SELECT_BASE
        });
    }

    static async listarDrafts(clientId) {
        const drafts = await prisma.posts.findMany({
            where: { client_id: parseInt(clientId), status: 'DRAFT' },
            orderBy: { updated_at: 'desc' },
            select: {
                ...POST_SELECT_BASE,
                post_accounts: { select: { accounts: { select: CONTA_SELECT_SEGURO } } }
            }
        });

        return drafts.map(({ post_accounts, ...draft }) => ({
            ...draft,
            accounts: post_accounts.map(vinculo => vinculo.accounts)
        }));
    }

    static async listarFeed(page, limit) {
        const where = { status: { in: ['SCHEDULED', 'PUBLISHED', 'PARTIAL', 'PROCESSING', 'FAILED'] } };
        const skip = (page - 1) * limit;

        const [posts, total] = await Promise.all([
            prisma.posts.findMany({
                where,
                orderBy: { updated_at: 'desc' },
                skip,
                take: limit,
                select: {
                    ...POST_SELECT_BASE,
                    clients: { select: { id: true, name: true } },
                    post_accounts: {
                        select: {
                            delivery_status: true,
                            error_message: true,
                            accounts: { select: CONTA_SELECT_SEGURO }
                        }
                    }
                }
            }),
            prisma.posts.count({ where })
        ]);

        return {
            posts: posts.map(({ post_accounts, clients, ...post }) => ({
                ...post,
                author: clients,
                accounts: post_accounts.map(vinculo => ({
                    ...vinculo.accounts,
                    delivery_status: vinculo.delivery_status,
                    error_message: vinculo.error_message
                }))
            })),
            total
        };
    }
}

module.exports = PrismaAdapter;
