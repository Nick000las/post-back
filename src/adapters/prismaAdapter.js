const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

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
        return await prisma.accounts.findMany();
    }
}

module.exports = PrismaAdapter;
