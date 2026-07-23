jest.mock('../adapters/prismaAdapter.js', () => ({
    criarPost: jest.fn(),
    atualizarStatusPost: jest.fn(),
    listarStatusContasDoPost: jest.fn(),
    criarDraftComContas: jest.fn(),
    buscarDraftPorId: jest.fn(),
    listarContasDoDraft: jest.fn()
}));

jest.mock('../queues/publishQueue.js', () => ({
    publishQueue: { add: jest.fn() }
}));

const prismaAdapter = require('../adapters/prismaAdapter.js');
const { publishQueue } = require('../queues/publishQueue.js');
const postService = require('./postService.js');
const AppError = require('../errors/AppError.js');

describe('PostService', () => {
    afterEach(() => jest.clearAllMocks());

    describe('finalizarStatusSeCompleto', () => {
        test('não fecha o status enquanto houver conta PENDING', async () => {
            prismaAdapter.listarStatusContasDoPost.mockResolvedValue([
                { delivery_status: 'SUCCESS' },
                { delivery_status: 'PENDING' }
            ]);

            await postService.finalizarStatusSeCompleto(1);

            expect(prismaAdapter.atualizarStatusPost).not.toHaveBeenCalled();
        });

        test('marca PUBLISHED quando todas as contas tiveram sucesso', async () => {
            prismaAdapter.listarStatusContasDoPost.mockResolvedValue([
                { delivery_status: 'SUCCESS' },
                { delivery_status: 'SUCCESS' }
            ]);

            await postService.finalizarStatusSeCompleto(1);

            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(1, 'PUBLISHED');
        });

        test('marca FAILED quando nenhuma conta teve sucesso', async () => {
            prismaAdapter.listarStatusContasDoPost.mockResolvedValue([
                { delivery_status: 'FAILED' },
                { delivery_status: 'FAILED' }
            ]);

            await postService.finalizarStatusSeCompleto(1);

            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(1, 'FAILED');
        });

        test('marca PARTIAL quando há mistura de sucesso e falha', async () => {
            prismaAdapter.listarStatusContasDoPost.mockResolvedValue([
                { delivery_status: 'SUCCESS' },
                { delivery_status: 'FAILED' }
            ]);

            await postService.finalizarStatusSeCompleto(1);

            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(1, 'PARTIAL');
        });

        test('trata array vazio como "sem contas" (0 sucessos) sem quebrar', async () => {
            prismaAdapter.listarStatusContasDoPost.mockResolvedValue([]);

            await postService.finalizarStatusSeCompleto(1);

            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(1, 'FAILED');
        });
    });

    describe('gerenciarPostagemEmLote', () => {
        test('cria o post, marca PROCESSING e enfileira um job por conta', async () => {
            prismaAdapter.criarPost.mockResolvedValue({ id: 42 });

            const arquivo = { filename: 'foo.jpg', originalname: 'foo-original.jpg', mimetype: 'image/jpeg' };
            const accounts = [{ id: 1 }, { id: 2 }];

            const resultado = await postService.gerenciarPostagemEmLote(arquivo, 'legenda', accounts, 99);

            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(42, 'PROCESSING');
            expect(publishQueue.add).toHaveBeenCalledTimes(2);
            expect(publishQueue.add).toHaveBeenCalledWith('publicar-conta', { postId: 42, accountId: 1, userId: 99 });
            expect(publishQueue.add).toHaveBeenCalledWith('publicar-conta', { postId: 42, accountId: 2, userId: 99 });
            expect(resultado).toEqual({ status: 'queued', postId: 42, totalContas: 2 });
        });

        test('nunca inclui token/segredos no payload do job', async () => {
            prismaAdapter.criarPost.mockResolvedValue({ id: 1 });

            await postService.gerenciarPostagemEmLote(
                { filename: 'a.jpg', originalname: 'a.jpg', mimetype: 'image/jpeg' }, 'x', [{ id: 1 }], 1
            );

            const payload = publishQueue.add.mock.calls[0][1];
            expect(Object.keys(payload).sort()).toEqual(['accountId', 'postId', 'userId']);
        });
    });

    describe('publicarDraft', () => {
        test('lança AppError se o draft não existe', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue(null);

            await expect(postService.publicarDraft(1, 1)).rejects.toThrow(AppError);
            expect(publishQueue.add).not.toHaveBeenCalled();
        });

        test('lança AppError se o draft não tem contas vinculadas', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({ id: 1 });
            prismaAdapter.listarContasDoDraft.mockResolvedValue([]);

            await expect(postService.publicarDraft(1, 1)).rejects.toThrow(AppError);
            expect(publishQueue.add).not.toHaveBeenCalled();
        });

        test('enfileira as contas vinculadas ao draft', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({
                id: 7, caption: 'c', file_path: 'f', file_name: 'n', file_type: 'image/jpeg'
            });
            prismaAdapter.listarContasDoDraft.mockResolvedValue([{ id: 3 }]);

            const resultado = await postService.publicarDraft(7, 5);

            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(7, 'PROCESSING');
            expect(publishQueue.add).toHaveBeenCalledWith('publicar-conta', { postId: 7, accountId: 3, userId: 5 });
            expect(resultado).toEqual({ status: 'queued', postId: 7, totalContas: 1 });
        });
    });
});
