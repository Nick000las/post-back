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

    static async criarPost(caption, filePath, status, userId) {
        return await prisma.posts.create({
            data: {
                caption,
                file_path: filePath,
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
        return await prisma.post_accounts.create({
            data: {
                post_id: postId,
                account_id: accountId,
                delivery_status: status,
                api_post_id: apiPostId,
                error_message: errorMessage,
                processed_at: new Date()
            }
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
}

module.exports = PrismaAdapter;
