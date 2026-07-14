const { PrismaClient } = require('@prisma/client');
const cryptoUtil = require('../utils/cryptoUtil.js');
const prisma = new PrismaClient();

const CONTA_SELECT_SEGURO = {
    id: true,
    name: true,
    platform: true,
    instagram_user_id: true,
    created_at: true
};

class PrismaAdapter {
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

    static async criarPost(caption, filePath, fileName, fileType, status, userId) {
        return await prisma.posts.create({
            data: {
                caption,
                file_path: filePath,
                file_name: fileName,
                file_type: fileType,
                status,
                user_id: userId
            }
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

    static async listarContas(userId) {
        return await prisma.accounts.findMany({
            where: { user_id: userId },
            select: CONTA_SELECT_SEGURO
        });
    }

    static async buscarContaPorId(id, userId) {
        return await prisma.accounts.findFirst({
            where: { id: parseInt(id), user_id: userId }
        });
    }

    static async buscarContaPorIdInstagram(instagramUserId) {
        return await prisma.accounts.findUnique({
            where: { instagram_user_id: instagramUserId }
        });
    }

    static async criarConta(contaData) {
        const dadosCriptografados = { ...contaData, access_token: cryptoUtil.encrypt(contaData.access_token) };
        return await prisma.accounts.create({
            data: dadosCriptografados,
            select: CONTA_SELECT_SEGURO
        });
    }

    static async atualizarConta(id, userId, atualizacoes) {
        const dados = atualizacoes.access_token
            ? { ...atualizacoes, access_token: cryptoUtil.encrypt(atualizacoes.access_token) }
            : atualizacoes;

        const resultado = await prisma.accounts.updateMany({
            where: { id: parseInt(id), user_id: userId },
            data: dados
        });
        if (resultado.count === 0) return null;

        return await prisma.accounts.findUnique({
            where: { id: parseInt(id) },
            select: CONTA_SELECT_SEGURO
        });
    }

    static async excluirConta(id, userId) {
        const conta = await prisma.accounts.findFirst({
            where: { id: parseInt(id), user_id: userId },
            select: CONTA_SELECT_SEGURO
        });
        if (!conta) return null;

        await prisma.accounts.delete({ where: { id: parseInt(id) } });
        return conta;
    }

    static async criarDraftComContas(caption, fileName, filePath, fileType, userId, accountIds) {
        return await prisma.$transaction(async (tx) => {
            const draft = await tx.posts.create({
                data: {
                    caption,
                    file_path: filePath,
                    file_name: fileName,
                    file_type: fileType,
                    status: 'DRAFT',
                    user_id: userId
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

    static async buscarDraftPorId(draftId, userId) {
        return await prisma.posts.findFirst({
            where: { id: parseInt(draftId), user_id: userId, status: 'DRAFT' },
            select: { id: true, caption: true, file_path: true, file_name: true, file_type: true, status: true, created_at: true, updated_at: true }
        });
    }

    static async buscarDraftComContas(draftId, userId) {
        const draft = await prisma.posts.findFirst({
            where: { id: parseInt(draftId), user_id: userId, status: 'DRAFT' },
            select: {
                id: true, caption: true, file_path: true, file_name: true, file_type: true, status: true, created_at: true, updated_at: true,
                post_accounts: { select: { accounts: { select: CONTA_SELECT_SEGURO } } }
            }
        });
        if (!draft) return null;

        const { post_accounts, ...draftSemVinculos } = draft;
        return { ...draftSemVinculos, accounts: post_accounts.map(vinculo => vinculo.accounts) };
    }

    static async listarContasDoDraft(draftId, userId) {
        const vinculos = await prisma.post_accounts.findMany({
            where: { post_id: parseInt(draftId), accounts: { user_id: userId } },
            select: { account_id: true }
        });
        return vinculos.map(vinculo => ({ id: vinculo.account_id }));
    }

    static async excluirDraft(draftId, userId) {
        const draft = await prisma.posts.findFirst({
            where: { id: parseInt(draftId), user_id: userId, status: 'DRAFT' },
            select: { id: true, caption: true, file_path: true, file_name: true, file_type: true, status: true, created_at: true, updated_at: true }
        });
        if (!draft) return null;

        await prisma.posts.delete({ where: { id: draft.id } });
        return draft;
    }

    static async atualizarDraft(draftId, caption, userId) {
        const resultado = await prisma.posts.updateMany({
            where: { id: parseInt(draftId), user_id: userId, status: 'DRAFT' },
            data: { caption, updated_at: new Date() }
        });
        if (resultado.count === 0) return null;

        return await prisma.posts.findUnique({
            where: { id: parseInt(draftId) },
            select: { id: true, caption: true, file_path: true, file_name: true, file_type: true, status: true, created_at: true, updated_at: true
            }
        });
    }

    static async listarDrafts(userId) {
        const drafts = await prisma.posts.findMany({
            where: { user_id: userId, status: 'DRAFT' },
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
        const where = { status: { in: ['PUBLISHED', 'PARTIAL'] } };
        const skip = (page - 1) * limit;

        const [posts, total] = await Promise.all([
            prisma.posts.findMany({
                where,
                orderBy: { updated_at: 'desc' },
                skip,
                take: limit,
                select: {
                    id: true, caption: true, file_path: true, file_name: true, file_type: true, status: true, created_at: true, updated_at: true,
                    users: { select: { id: true, name: true } },
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
            posts: posts.map(({ post_accounts, users, ...post }) => ({
                ...post,
                author: users,
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
