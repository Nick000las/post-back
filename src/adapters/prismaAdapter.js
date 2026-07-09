const { PrismaClient } = require('@prisma/client');
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

    static async listarContas() {
        return await prisma.accounts.findMany({
            select: CONTA_SELECT_SEGURO
        });
    }

    static async buscarContaPorId(id) {
        return await prisma.accounts.findUnique({
            where: { id: parseInt(id) }
        });
    }

    static async buscarContaPorIdInstagram(instagramUserId) {
        return await prisma.accounts.findUnique({
            where: { instagram_user_id: instagramUserId }
        });
    }

    static async criarConta(contaData) {
        return await prisma.accounts.create({
            data: contaData,
            select: CONTA_SELECT_SEGURO
        });
    }

    static async atualizarConta(id, atualizacoes) {
        return await prisma.accounts.update({
            where: { id: parseInt(id) },
            data: atualizacoes,
            select: CONTA_SELECT_SEGURO
        });
    }

    static async excluirConta(id) {
        return await prisma.accounts.delete({
            where: { id: parseInt(id) },
            select: CONTA_SELECT_SEGURO
        });
    }
}

module.exports = PrismaAdapter;
