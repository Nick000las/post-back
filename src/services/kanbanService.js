const prismaAdapter = require('../adapters/prismaAdapter.js');
const AppError = require('../errors/AppError.js');
const { FIXED_COLUMN_KEYS } = require('../constants/kanban.js');

class KanbanService {

    // Confere que o client pertence ao usuário autenticado (agência) — idêntico ao #validarCliente de
    // postService/userService.
    static async #validarCliente (clientId, userId) {
        const cliente = await prismaAdapter.buscarClientePorId(clientId, userId);
        if (!cliente) throw new AppError('Cliente não encontrado');
        return cliente;
    }

    // Usado pelo endpoint combinado GET /kanban (colunas já com os posts aninhados).
    static async listarQuadro (clientId, userId) {
        await this.#validarCliente(clientId, userId);
        const columns = await prismaAdapter.buscarQuadro(clientId);
        return { columns };
    }

    // Listagem "leve" das colunas, sem os posts — não é consumida pelo frontend hoje (que usa
    // listarQuadro), mantida por completude da API.
    static async listarColunas (clientId, userId) {
        await this.#validarCliente(clientId, userId);
        return prismaAdapter.listarColunas(clientId);
    }

    static async criarColuna (clientId, userId, name) {
        await this.#validarCliente(clientId, userId);
        if (!name || !name.trim()) throw new AppError('Nome não pode ser vazio');

        return prismaAdapter.criarColunaDinamica(clientId, name.trim());
    }

    static async renomearColuna (id, clientId, userId, name) {
        await this.#validarCliente(clientId, userId);
        if (!name || !name.trim()) throw new AppError('Nome não pode ser vazio');

        const coluna = await prismaAdapter.buscarColunaPorId(id, clientId);
        if (!coluna) throw new AppError('Coluna não encontrada');
        if (coluna.is_fixed) throw new AppError('Não é possível renomear uma coluna fixa');

        return prismaAdapter.renomearColuna(id, clientId, name.trim());
    }

    static async excluirColuna (id, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const coluna = await prismaAdapter.buscarColunaPorId(id, clientId);
        if (!coluna) throw new AppError('Coluna não encontrada');
        if (coluna.is_fixed) throw new AppError('Não é possível excluir uma coluna fixa');

        // excluirColunaDinamica já reatribui os posts da coluna excluída pra Ideias antes de apagar.
        return prismaAdapter.excluirColunaDinamica(id, clientId);
    }

    static async moverPost (postId, clientId, userId, columnId) {
        await this.#validarCliente(clientId, userId);

        const coluna = await prismaAdapter.buscarColunaPorId(columnId, clientId);
        if (!coluna) throw new AppError('Coluna não encontrada');

        // Regra de segurança obrigatória aqui — não é só UX do frontend: as colunas finais representam
        // estados que só o motor de publicação pode atribuir, nunca um drag-and-drop manual.
        if (coluna.fixed_key === FIXED_COLUMN_KEYS.AGENDADO || coluna.fixed_key === FIXED_COLUMN_KEYS.FINALIZADO) {
            throw new AppError('Não é possível mover um post manualmente para esta coluna');
        }

        const post = await prismaAdapter.moverPostDeColuna(postId, clientId, columnId);
        if (!post) throw new AppError('Post não encontrado');
        return post;
    }

    // Gancho de IA: ponto de resolução reutilizável da coluna "Ideias" de um client — chamado por
    // postService#resolverColumnId sempre que um post é criado sem column_id explícito.
    static async resolverColunaIdeias (clientId) {
        const coluna = await prismaAdapter.buscarColunaIdeias(clientId);
        if (!coluna) throw new AppError('Coluna Ideias não encontrada para este cliente');
        return coluna.id;
    }
}

module.exports = KanbanService;
