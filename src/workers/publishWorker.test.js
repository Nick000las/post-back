jest.mock('bullmq', () => {
    class UnrecoverableError extends Error {}
    return {
        Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
        UnrecoverableError
    };
});

jest.mock('../config/redisConfig.js', () => ({}));

jest.mock('../queues/publishQueue.js', () => ({
    PUBLISH_QUEUE_NAME: 'publish'
}));

jest.mock('../adapters/prismaAdapter.js', () => ({
    buscarPostPorId: jest.fn(),
    buscarContaPorId: jest.fn(),
    vincularPostConta: jest.fn(),
    atualizarStatusPost: jest.fn()
}));

jest.mock('../adapters/metaAdapter.js', () => ({
    publicarNoInstagram: jest.fn(),
    publicarNoFacebook: jest.fn()
}));

jest.mock('../adapters/tiktokAdapter.js', () => ({
    publicarContainer: jest.fn()
}));

jest.mock('../adapters/linkedinAdapter.js', () => ({
    publicarContainer: jest.fn()
}));

jest.mock('../services/postService.js', () => ({
    finalizarStatusSeCompleto: jest.fn()
}));

jest.mock('../utils/cryptoUtil.js', () => ({
    decrypt: jest.fn(token => `decrypted:${token}`)
}));

const { UnrecoverableError: FakeUnrecoverableError } = require('bullmq');
const prismaAdapter = require('../adapters/prismaAdapter.js');
const metaAdapter = require('../adapters/metaAdapter.js');
const tiktokAdapter = require('../adapters/tiktokAdapter.js');
const linkedinAdapter = require('../adapters/linkedinAdapter.js');
const postService = require('../services/postService.js');
const AppError = require('../errors/AppError.js');
const { processarJob } = require('./publishWorker.js');

function criarJobFake (data, overrides = {}) {
    return {
        data,
        attemptsMade: 0,
        opts: { attempts: 3 },
        ...overrides
    };
}

describe('publishWorker.processarJob', () => {
    afterEach(() => jest.clearAllMocks());

    test('lança UnrecoverableError se o post não existe (não tenta adapter nenhum)', async () => {
        prismaAdapter.buscarPostPorId.mockResolvedValue(null);
        prismaAdapter.buscarContaPorId.mockResolvedValue({ id: 1 });

        const job = criarJobFake({ postId: 1, accountId: 1, clientId: 1 });

        await expect(processarJob(job)).rejects.toThrow(FakeUnrecoverableError);
        expect(metaAdapter.publicarNoInstagram).not.toHaveBeenCalled();
    });

    test('lança UnrecoverableError se a conta não existe', async () => {
        prismaAdapter.buscarPostPorId.mockResolvedValue({ id: 1 });
        prismaAdapter.buscarContaPorId.mockResolvedValue(null);

        const job = criarJobFake({ postId: 1, accountId: 1, clientId: 1 });

        await expect(processarJob(job)).rejects.toThrow(FakeUnrecoverableError);
    });

    test('busca a conta já filtrando pelo clientId do job (não vaza conta de outro cliente)', async () => {
        prismaAdapter.buscarPostPorId.mockResolvedValue({ id: 1, status: 'PROCESSING' });
        prismaAdapter.buscarContaPorId.mockResolvedValue({ id: 2, platform: 'instagram', access_token: 'x' });
        metaAdapter.publicarNoInstagram.mockResolvedValue({ success: true, externalId: 'e' });

        const job = criarJobFake({ postId: 1, accountId: 2, clientId: 77 });
        await processarJob(job);

        expect(prismaAdapter.buscarContaPorId).toHaveBeenCalledWith(2, 77);
    });

    test('post SCHEDULED: transiciona pra PROCESSING antes de publicar', async () => {
        prismaAdapter.buscarPostPorId.mockResolvedValue({ id: 1, status: 'SCHEDULED', file_path: 'a', file_type: 'image/jpeg' });
        prismaAdapter.buscarContaPorId.mockResolvedValue({ id: 2, platform: 'instagram', platform_account_id: 'ig', access_token: 'tok' });
        metaAdapter.publicarNoInstagram.mockResolvedValue({ success: true, externalId: 'e' });

        const job = criarJobFake({ postId: 1, accountId: 2, clientId: 1 });
        await processarJob(job);

        expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(1, 'PROCESSING');
    });

    test('post já PROCESSING (publicação imediata): não reescreve o status', async () => {
        prismaAdapter.buscarPostPorId.mockResolvedValue({ id: 1, status: 'PROCESSING', file_path: 'a', file_type: 'image/jpeg' });
        prismaAdapter.buscarContaPorId.mockResolvedValue({ id: 2, platform: 'instagram', platform_account_id: 'ig', access_token: 'tok' });
        metaAdapter.publicarNoInstagram.mockResolvedValue({ success: true, externalId: 'e' });

        const job = criarJobFake({ postId: 1, accountId: 2, clientId: 1 });
        await processarJob(job);

        expect(prismaAdapter.atualizarStatusPost).not.toHaveBeenCalled();
    });

    test('publica no instagram com sucesso, descriptografa o token e finaliza o status do post', async () => {
        const post = { id: 1, status: 'PROCESSING', caption: 'x', file_path: 'a.jpg', file_type: 'image/jpeg' };
        const conta = { id: 2, platform: 'instagram', platform_account_id: 'ig-123', access_token: 'enc-token' };

        prismaAdapter.buscarPostPorId.mockResolvedValue(post);
        prismaAdapter.buscarContaPorId.mockResolvedValue(conta);
        metaAdapter.publicarNoInstagram.mockResolvedValue({ success: true, externalId: 'ext-1' });

        const job = criarJobFake({ postId: 1, accountId: 2, clientId: 9 });
        await processarJob(job);

        expect(metaAdapter.publicarNoInstagram).toHaveBeenCalledWith(post, 'decrypted:enc-token', 'ig-123');
        expect(prismaAdapter.vincularPostConta).toHaveBeenCalledWith(1, 2, 'SUCCESS', 'ext-1', null);
        expect(postService.finalizarStatusSeCompleto).toHaveBeenCalledWith(1);
    });

    test.each([
        ['facebook', 'publicarNoFacebook', () => metaAdapter],
        ['tiktok', 'publicarContainer', () => tiktokAdapter],
        ['linkedin', 'publicarContainer', () => linkedinAdapter]
    ])('dispatch por plataforma: %s usa o adapter correto', async (platform, metodo, getAdapter) => {
        const adapter = getAdapter();
        const post = { id: 1, status: 'PROCESSING', file_path: 'a', file_type: 'image/jpeg' };
        const conta = { id: 2, platform, platform_account_id: 'dest-1', access_token: 'tok' };

        prismaAdapter.buscarPostPorId.mockResolvedValue(post);
        prismaAdapter.buscarContaPorId.mockResolvedValue(conta);
        adapter[metodo].mockResolvedValue({ success: true, externalId: 'ext' });

        const job = criarJobFake({ postId: 1, accountId: 2, clientId: 1 });
        await processarJob(job);

        expect(adapter[metodo]).toHaveBeenCalledWith(post, 'decrypted:tok', 'dest-1');
    });

    test('plataforma não suportada: falha imediata (UnrecoverableError), sem retry', async () => {
        const post = { id: 1, status: 'PROCESSING', file_path: 'a', file_type: 'image/jpeg' };
        const conta = { id: 2, platform: 'myspace', platform_account_id: 'x', access_token: 'tok' };

        prismaAdapter.buscarPostPorId.mockResolvedValue(post);
        prismaAdapter.buscarContaPorId.mockResolvedValue(conta);

        const job = criarJobFake({ postId: 1, accountId: 2, clientId: 1 });

        await expect(processarJob(job)).rejects.toThrow(FakeUnrecoverableError);
        expect(prismaAdapter.vincularPostConta).toHaveBeenCalledWith(1, 2, 'FAILED', null, expect.stringContaining('myspace'));
        expect(postService.finalizarStatusSeCompleto).toHaveBeenCalledWith(1);
    });

    test('erro de negócio do adapter (AppError): fecha o resultado imediatamente, não espera retry', async () => {
        const post = { id: 1, status: 'PROCESSING', file_path: 'a', file_type: 'image/jpeg' };
        const conta = { id: 2, platform: 'linkedin', platform_account_id: 'urn:li:x', access_token: 'tok' };

        prismaAdapter.buscarPostPorId.mockResolvedValue(post);
        prismaAdapter.buscarContaPorId.mockResolvedValue(conta);
        linkedinAdapter.publicarContainer.mockRejectedValue(new AppError('URN inválido'));

        const job = criarJobFake({ postId: 1, accountId: 2, clientId: 1 });

        await expect(processarJob(job)).rejects.toThrow(FakeUnrecoverableError);
        expect(prismaAdapter.vincularPostConta).toHaveBeenCalledWith(1, 2, 'FAILED', null, 'URN inválido');
        expect(postService.finalizarStatusSeCompleto).toHaveBeenCalledTimes(1);
    });

    test('erro transiente ANTES da última tentativa: não grava FAILED nem finaliza, só relança', async () => {
        const post = { id: 1, status: 'PROCESSING', file_path: 'a', file_type: 'image/jpeg' };
        const conta = { id: 2, platform: 'tiktok', platform_account_id: 'x', access_token: 'tok' };

        prismaAdapter.buscarPostPorId.mockResolvedValue(post);
        prismaAdapter.buscarContaPorId.mockResolvedValue(conta);
        const erroTransiente = new Error('ETIMEDOUT');
        tiktokAdapter.publicarContainer.mockRejectedValue(erroTransiente);

        const job = criarJobFake({ postId: 1, accountId: 2, clientId: 1 }, { attemptsMade: 0, opts: { attempts: 3 } });

        await expect(processarJob(job)).rejects.toBe(erroTransiente);
        expect(prismaAdapter.vincularPostConta).not.toHaveBeenCalled();
        expect(postService.finalizarStatusSeCompleto).not.toHaveBeenCalled();
    });

    test('erro transiente NA última tentativa: grava FAILED e finaliza antes de relançar', async () => {
        const post = { id: 1, status: 'PROCESSING', file_path: 'a', file_type: 'image/jpeg' };
        const conta = { id: 2, platform: 'tiktok', platform_account_id: 'x', access_token: 'tok' };

        prismaAdapter.buscarPostPorId.mockResolvedValue(post);
        prismaAdapter.buscarContaPorId.mockResolvedValue(conta);
        const erroTransiente = new Error('ETIMEDOUT');
        tiktokAdapter.publicarContainer.mockRejectedValue(erroTransiente);

        const job = criarJobFake({ postId: 1, accountId: 2, clientId: 1 }, { attemptsMade: 2, opts: { attempts: 3 } });

        await expect(processarJob(job)).rejects.toBe(erroTransiente);
        expect(prismaAdapter.vincularPostConta).toHaveBeenCalledWith(1, 2, 'FAILED', null, expect.any(String));
        expect(postService.finalizarStatusSeCompleto).toHaveBeenCalledWith(1);
    });
});
