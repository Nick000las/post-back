jest.mock('../adapters/prismaAdapter.js', () => ({
    buscarClientePorId: jest.fn(),
    listarColunas: jest.fn(),
    buscarColunaPorId: jest.fn(),
    buscarColunaIdeias: jest.fn(),
    criarColunaDinamica: jest.fn(),
    renomearColuna: jest.fn(),
    excluirColunaDinamica: jest.fn(),
    moverPostDeColuna: jest.fn(),
    buscarQuadro: jest.fn()
}));

const prismaAdapter = require('../adapters/prismaAdapter.js');
const kanbanService = require('./kanbanService.js');
const AppError = require('../errors/AppError.js');

const CLIENT_ID = 99;
const USER_ID = 7;

describe('KanbanService', () => {
    beforeEach(() => {
        prismaAdapter.buscarClientePorId.mockResolvedValue({ id: CLIENT_ID, user_id: USER_ID });
    });
    afterEach(() => jest.clearAllMocks());

    describe('listarQuadro', () => {
        test('valida a posse do cliente', async () => {
            prismaAdapter.buscarClientePorId.mockResolvedValue(null);

            await expect(kanbanService.listarQuadro(CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(prismaAdapter.buscarQuadro).not.toHaveBeenCalled();
        });

        test('retorna { columns } com o resultado do adapter', async () => {
            const columns = [{ id: 1, name: 'Rascunhos', posts: [] }];
            prismaAdapter.buscarQuadro.mockResolvedValue(columns);

            const resultado = await kanbanService.listarQuadro(CLIENT_ID, USER_ID);

            expect(prismaAdapter.buscarQuadro).toHaveBeenCalledWith(CLIENT_ID);
            expect(resultado).toEqual({ columns });
        });
    });

    describe('criarColuna', () => {
        test('lança AppError com nome vazio ou só espaços', async () => {
            await expect(kanbanService.criarColuna(CLIENT_ID, USER_ID, '')).rejects.toThrow(AppError);
            await expect(kanbanService.criarColuna(CLIENT_ID, USER_ID, '   ')).rejects.toThrow(AppError);
            expect(prismaAdapter.criarColunaDinamica).not.toHaveBeenCalled();
        });

        test('cria a coluna com o nome já sem espaços nas pontas', async () => {
            prismaAdapter.criarColunaDinamica.mockResolvedValue({ id: 5, name: 'Em Design' });

            await kanbanService.criarColuna(CLIENT_ID, USER_ID, '  Em Design  ');

            expect(prismaAdapter.criarColunaDinamica).toHaveBeenCalledWith(CLIENT_ID, 'Em Design');
        });
    });

    describe('renomearColuna', () => {
        test('lança AppError se a coluna não existe', async () => {
            prismaAdapter.buscarColunaPorId.mockResolvedValue(null);

            await expect(kanbanService.renomearColuna(1, CLIENT_ID, USER_ID, 'Novo nome')).rejects.toThrow(AppError);
            expect(prismaAdapter.renomearColuna).not.toHaveBeenCalled();
        });

        test('lança AppError ao tentar renomear coluna fixa', async () => {
            prismaAdapter.buscarColunaPorId.mockResolvedValue({ id: 1, is_fixed: true });

            await expect(kanbanService.renomearColuna(1, CLIENT_ID, USER_ID, 'Novo nome')).rejects.toThrow(AppError);
            expect(prismaAdapter.renomearColuna).not.toHaveBeenCalled();
        });

        test('renomeia coluna dinâmica', async () => {
            prismaAdapter.buscarColunaPorId.mockResolvedValue({ id: 1, is_fixed: false });
            prismaAdapter.renomearColuna.mockResolvedValue({ id: 1, name: 'Novo nome' });

            const resultado = await kanbanService.renomearColuna(1, CLIENT_ID, USER_ID, 'Novo nome');

            expect(prismaAdapter.renomearColuna).toHaveBeenCalledWith(1, CLIENT_ID, 'Novo nome');
            expect(resultado).toEqual({ id: 1, name: 'Novo nome' });
        });
    });

    describe('excluirColuna', () => {
        test('lança AppError se a coluna não existe', async () => {
            prismaAdapter.buscarColunaPorId.mockResolvedValue(null);

            await expect(kanbanService.excluirColuna(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(prismaAdapter.excluirColunaDinamica).not.toHaveBeenCalled();
        });

        test('lança AppError ao tentar excluir coluna fixa', async () => {
            prismaAdapter.buscarColunaPorId.mockResolvedValue({ id: 1, is_fixed: true });

            await expect(kanbanService.excluirColuna(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(prismaAdapter.excluirColunaDinamica).not.toHaveBeenCalled();
        });

        test('exclui coluna dinâmica', async () => {
            prismaAdapter.buscarColunaPorId.mockResolvedValue({ id: 1, is_fixed: false });
            prismaAdapter.excluirColunaDinamica.mockResolvedValue({ id: 1, name: 'Em Design', postsMovidos: 3 });

            const resultado = await kanbanService.excluirColuna(1, CLIENT_ID, USER_ID);

            expect(prismaAdapter.excluirColunaDinamica).toHaveBeenCalledWith(1, CLIENT_ID);
            expect(resultado).toEqual({ id: 1, name: 'Em Design', postsMovidos: 3 });
        });
    });

    describe('moverPost', () => {
        test('lança AppError se a coluna de destino não existe', async () => {
            prismaAdapter.buscarColunaPorId.mockResolvedValue(null);

            await expect(kanbanService.moverPost(1, CLIENT_ID, USER_ID, 999)).rejects.toThrow(AppError);
            expect(prismaAdapter.moverPostDeColuna).not.toHaveBeenCalled();
        });

        test.each(['AGENDADO', 'FINALIZADO'])(
            'bloqueia mover manualmente para a coluna fixa %s',
            async (fixedKey) => {
                prismaAdapter.buscarColunaPorId.mockResolvedValue({ id: 2, fixed_key: fixedKey, is_fixed: true });

                await expect(kanbanService.moverPost(1, CLIENT_ID, USER_ID, 2)).rejects.toThrow(AppError);
                expect(prismaAdapter.moverPostDeColuna).not.toHaveBeenCalled();
            }
        );

        test('lança AppError se o post não existe/não pertence ao cliente', async () => {
            prismaAdapter.buscarColunaPorId.mockResolvedValue({ id: 3, fixed_key: null, is_fixed: false });
            prismaAdapter.moverPostDeColuna.mockResolvedValue(null);

            await expect(kanbanService.moverPost(1, CLIENT_ID, USER_ID, 3)).rejects.toThrow(AppError);
        });

        test('move o post para uma coluna dinâmica ou para Rascunhos', async () => {
            prismaAdapter.buscarColunaPorId.mockResolvedValue({ id: 3, fixed_key: null, is_fixed: false });
            prismaAdapter.moverPostDeColuna.mockResolvedValue({ id: 1, column_id: 3 });

            const resultado = await kanbanService.moverPost(1, CLIENT_ID, USER_ID, 3);

            expect(prismaAdapter.moverPostDeColuna).toHaveBeenCalledWith(1, CLIENT_ID, 3);
            expect(resultado).toEqual({ id: 1, column_id: 3 });
        });
    });

    describe('resolverColunaIdeias', () => {
        test('lança erro se o client não tiver coluna Rascunhos (inconsistência de dados)', async () => {
            prismaAdapter.buscarColunaIdeias.mockResolvedValue(null);

            await expect(kanbanService.resolverColunaIdeias(CLIENT_ID)).rejects.toThrow(AppError);
        });

        test('retorna o id da coluna Rascunhos do client', async () => {
            prismaAdapter.buscarColunaIdeias.mockResolvedValue({ id: 1001 });

            const id = await kanbanService.resolverColunaIdeias(CLIENT_ID);

            expect(id).toBe(1001);
        });
    });
});
