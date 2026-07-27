const { PrismaClient } = require('@prisma/client');
const cryptoUtil = require('../utils/cryptoUtil.js');
const prisma = new PrismaClient();

const CONTA_SELECT_SEGURO = {
    id: true,
    name: true,
    platform: true,
    platform_account_id: true,
    created_at: true
};

// accounts e posts pertencem a um client (não mais direto a um user) — todo método que antes
// filtrava por user_id agora filtra por client_id. postService/userService validam a posse do
// client (buscarClientePorId) antes de repassar clientId pra cá.

class PrismaAdapter {
    static async buscarClientePorId(clientId, userId) {
        return await prisma.clients.findFirst({
            where: { id: parseInt(clientId), user_id: userId }
        });
    }

    static async criarClient(name, userId) {
        return await prisma.clients.create({
            data: { name, user_id: userId }
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

    static async criarPost(caption, filePath, fileName, fileType, status, clientId, scheduledFor = null) {
        return await prisma.posts.create({
            data: {
                caption,
                file_path: filePath,
                file_name: fileName,
                file_type: fileType,
                status,
                client_id: parseInt(clientId),
                scheduled_for: scheduledFor
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

    // contaData precisa trazer client_id (não mais user_id) — quem monta esse objeto é o caller.
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

    static async criarDraftComContas(caption, fileName, filePath, fileType, clientId, accountIds) {
        return await prisma.$transaction(async (tx) => {
            const draft = await tx.posts.create({
                data: {
                    caption,
                    file_path: filePath,
                    file_name: fileName,
                    file_type: fileType,
                    status: 'DRAFT',
                    client_id: parseInt(clientId)
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
            select: { id: true, caption: true, file_path: true, file_name: true, file_type: true, status: true, created_at: true, updated_at: true }
        });
    }

    static async buscarPostPorId(postId) {
        return await prisma.posts.findUnique({
            where: { id: postId }
        });
    }

    // Usado pelo endpoint GET /posts/:id/status — busca o post filtrando por client_id (pra não
    // vazar status de post de outro cliente) + post_accounts com delivery_status/error_message.
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

    static async excluirPostAgendado(postId, clientId) {
        const post = await prisma.posts.findFirst({
            where: { id: parseInt(postId), client_id: parseInt(clientId), status: 'SCHEDULED' },
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
                id: true, caption: true, file_path: true, file_name: true, file_type: true, status: true, created_at: true, updated_at: true,
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
            select: { id: true, caption: true, file_path: true, file_name: true, file_type: true, status: true, created_at: true, updated_at: true }
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
            select: { id: true, caption: true, file_path: true, file_name: true, file_type: true, status: true, created_at: true, updated_at: true
            }
        });
    }

    static async listarDrafts(clientId) {
        const drafts = await prisma.posts.findMany({
            where: { client_id: parseInt(clientId), status: 'DRAFT' },
            orderBy: { updated_at: 'desc' },
            select: {
                id: true, caption: true, file_path: true, file_name: true, file_type: true, status: true, created_at: true, updated_at: true,
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
                    id: true, caption: true, file_path: true, file_name: true, file_type: true, status: true, created_at: true, updated_at: true,
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
