jest.mock('../adapters/prismaAdapter.js', () => ({
    buscarClientePorId: jest.fn(),
    criarPost: jest.fn(),
    atualizarStatusPost: jest.fn(),
    listarStatusContasDoPost: jest.fn(),
    registrarJobAgendado: jest.fn(),
    buscarPostComStatusContas: jest.fn(),
    buscarPostAgendadoComJobs: jest.fn(),
    excluirPostAgendado: jest.fn(),
    criarDraftComContas: jest.fn(),
    buscarDraftPorId: jest.fn(),
    listarContasDoDraft: jest.fn()
}));

jest.mock('../queues/publishQueue.js', () => ({
    publishQueue: { add: jest.fn(), getJob: jest.fn() }
}));

jest.mock('fs', () => ({
    existsSync: jest.fn().mockReturnValue(false),
    unlinkSync: jest.fn()
}));

const prismaAdapter = require('../adapters/prismaAdapter.js');
const { publishQueue } = require('../queues/publishQueue.js');
const postService = require('./postService.js');
const AppError = require('../errors/AppError.js');

const CLIENT_ID = 99;
const USER_ID = 7;

describe('PostService', () => {
    beforeEach(() => {
        prismaAdapter.buscarClientePorId.mockResolvedValue({ id: CLIENT_ID, user_id: USER_ID });
        publishQueue.add.mockResolvedValue({ id: 'job-1' });
    });
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
    });

    describe('gerenciarPostagemEmLote', () => {
        test('cria o post, marca PROCESSING e enfileira um job por conta (sem delay)', async () => {
            prismaAdapter.criarPost.mockResolvedValue({ id: 42 });

            const arquivo = { filename: 'foo.jpg', originalname: 'foo-original.jpg', mimetype: 'image/jpeg' };
            const accounts = [{ id: 1 }, { id: 2 }];

            const resultado = await postService.gerenciarPostagemEmLote(arquivo, 'legenda', accounts, CLIENT_ID, USER_ID);

            expect(prismaAdapter.buscarClientePorId).toHaveBeenCalledWith(CLIENT_ID, USER_ID);
            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(42, 'PROCESSING');
            expect(publishQueue.add).toHaveBeenCalledTimes(2);
            expect(publishQueue.add).toHaveBeenCalledWith('publicar-conta', { postId: 42, accountId: 1, clientId: CLIENT_ID }, {});
            expect(prismaAdapter.registrarJobAgendado).not.toHaveBeenCalled();
            expect(resultado).toEqual({ status: 'queued', postId: 42, totalContas: 2 });
        });

        test('lança AppError e não cria post quando o cliente não pertence ao usuário', async () => {
            prismaAdapter.buscarClientePorId.mockResolvedValue(null);

            await expect(
                postService.gerenciarPostagemEmLote({ filename: 'a', originalname: 'a', mimetype: 'image/jpeg' }, 'x', [{ id: 1 }], CLIENT_ID, USER_ID)
            ).rejects.toThrow(AppError);
            expect(prismaAdapter.criarPost).not.toHaveBeenCalled();
        });

        test('nunca inclui token/segredos no payload do job', async () => {
            prismaAdapter.criarPost.mockResolvedValue({ id: 1 });

            await postService.gerenciarPostagemEmLote(
                { filename: 'a.jpg', originalname: 'a.jpg', mimetype: 'image/jpeg' }, 'x', [{ id: 1 }], CLIENT_ID, USER_ID
            );

            const payload = publishQueue.add.mock.calls[0][1];
            expect(Object.keys(payload).sort()).toEqual(['accountId', 'clientId', 'postId']);
        });
    });

    describe('agendarPostagem', () => {
        const arquivo = { filename: 'foo.jpg', originalname: 'foo-original.jpg', mimetype: 'image/jpeg' };
        const accounts = [{ id: 1 }, { id: 2 }];

        test('valida a posse do cliente antes de qualquer coisa', async () => {
            prismaAdapter.buscarClientePorId.mockResolvedValue(null);

            await expect(
                postService.agendarPostagem(arquivo, 'c', accounts, '2999-01-01T10:00:00Z', CLIENT_ID, USER_ID)
            ).rejects.toThrow(AppError);
            expect(prismaAdapter.criarPost).not.toHaveBeenCalled();
            expect(publishQueue.add).not.toHaveBeenCalled();
        });

        test('rejeita data sem fuso horário explícito', async () => {
            await expect(
                postService.agendarPostagem(arquivo, 'c', accounts, '2999-01-01T10:00:00', CLIENT_ID, USER_ID)
            ).rejects.toThrow(AppError);
            expect(prismaAdapter.criarPost).not.toHaveBeenCalled();
        });

        test('rejeita string de data inválida', async () => {
            await expect(
                postService.agendarPostagem(arquivo, 'c', accounts, 'amanhã de manhã', CLIENT_ID, USER_ID)
            ).rejects.toThrow(AppError);
        });

        test('rejeita data no passado', async () => {
            await expect(
                postService.agendarPostagem(arquivo, 'c', accounts, '2020-01-01T00:00:00Z', CLIENT_ID, USER_ID)
            ).rejects.toThrow(AppError);
            expect(publishQueue.add).not.toHaveBeenCalled();
        });

        test('caminho feliz: grava SCHEDULED com clientId e delay, e registra job_id por conta', async () => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
            prismaAdapter.criarPost.mockResolvedValue({ id: 55 });
            publishQueue.add.mockResolvedValueOnce({ id: 'job-a' }).mockResolvedValueOnce({ id: 'job-b' });

            const scheduledFor = '2026-01-01T01:00:00Z'; // +1h
            const resultado = await postService.agendarPostagem(arquivo, 'c', accounts, scheduledFor, CLIENT_ID, USER_ID);

            expect(prismaAdapter.criarPost).toHaveBeenCalledWith(
                'c', 'foo.jpg', 'foo-original.jpg', 'image/jpeg', 'SCHEDULED', CLIENT_ID, new Date(scheduledFor)
            );
            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(55, 'SCHEDULED');
            expect(publishQueue.add).toHaveBeenCalledWith(
                'publicar-conta', { postId: 55, accountId: 1, clientId: CLIENT_ID }, { delay: 3600000 }
            );
            expect(prismaAdapter.registrarJobAgendado).toHaveBeenCalledWith(55, 1, 'job-a');
            expect(prismaAdapter.registrarJobAgendado).toHaveBeenCalledWith(55, 2, 'job-b');
            expect(resultado).toEqual({ status: 'scheduled', postId: 55, totalContas: 2 });

            jest.useRealTimers();
        });
    });

    describe('consultarStatusPost', () => {
        test('valida a posse do cliente', async () => {
            prismaAdapter.buscarClientePorId.mockResolvedValue(null);

            await expect(postService.consultarStatusPost(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(prismaAdapter.buscarPostComStatusContas).not.toHaveBeenCalled();
        });

        test('lança AppError quando o post não existe/não pertence ao cliente', async () => {
            prismaAdapter.buscarPostComStatusContas.mockResolvedValue(null);

            await expect(postService.consultarStatusPost(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
        });

        test('retorna { postId, status, accounts } e consulta scoped por clientId', async () => {
            prismaAdapter.buscarPostComStatusContas.mockResolvedValue({
                id: 5,
                status: 'PROCESSING',
                accounts: [{ accountId: 1, platform: 'instagram', delivery_status: 'PENDING', error_message: null }]
            });

            const resultado = await postService.consultarStatusPost(5, CLIENT_ID, USER_ID);

            expect(prismaAdapter.buscarPostComStatusContas).toHaveBeenCalledWith(5, CLIENT_ID);
            expect(resultado).toEqual({
                postId: 5,
                status: 'PROCESSING',
                accounts: [{ accountId: 1, platform: 'instagram', delivery_status: 'PENDING', error_message: null }]
            });
        });
    });

    describe('cancelarAgendamento', () => {
        test('lança AppError quando não há post agendado correspondente', async () => {
            prismaAdapter.buscarPostAgendadoComJobs.mockResolvedValue(null);

            await expect(postService.cancelarAgendamento(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(prismaAdapter.excluirPostAgendado).not.toHaveBeenCalled();
        });

        test('remove apenas os jobs em estado delayed, exclui o post e retorna sucesso', async () => {
            prismaAdapter.buscarPostAgendadoComJobs.mockResolvedValue({
                id: 8,
                file_path: 'foo.jpg',
                post_accounts: [{ job_id: 'job-a' }, { job_id: 'job-b' }, { job_id: null }]
            });
            prismaAdapter.excluirPostAgendado.mockResolvedValue({ id: 8, file_path: 'foo.jpg' });

            const jobDelayed = { getState: jest.fn().mockResolvedValue('delayed'), remove: jest.fn() };
            const jobAtivo = { getState: jest.fn().mockResolvedValue('active'), remove: jest.fn() };
            publishQueue.getJob.mockResolvedValueOnce(jobDelayed).mockResolvedValueOnce(jobAtivo);

            const resultado = await postService.cancelarAgendamento(8, CLIENT_ID, USER_ID);

            expect(jobDelayed.remove).toHaveBeenCalled();
            expect(jobAtivo.remove).not.toHaveBeenCalled();
            expect(publishQueue.getJob).toHaveBeenCalledTimes(2); // job_id null é ignorado
            expect(prismaAdapter.excluirPostAgendado).toHaveBeenCalledWith(8, CLIENT_ID);
            expect(resultado).toEqual({ message: 'Agendamento cancelado com sucesso', postId: 8 });
        });
    });

    describe('publicarDraft', () => {
        test('lança AppError se o draft não existe', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue(null);

            await expect(postService.publicarDraft(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(publishQueue.add).not.toHaveBeenCalled();
        });

        test('lança AppError se o draft não tem contas vinculadas', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({ id: 1 });
            prismaAdapter.listarContasDoDraft.mockResolvedValue([]);

            await expect(postService.publicarDraft(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(publishQueue.add).not.toHaveBeenCalled();
        });

        test('enfileira as contas vinculadas ao draft', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({
                id: 7, caption: 'c', file_path: 'f', file_name: 'n', file_type: 'image/jpeg'
            });
            prismaAdapter.listarContasDoDraft.mockResolvedValue([{ id: 3 }]);

            const resultado = await postService.publicarDraft(7, CLIENT_ID, USER_ID);

            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(7, 'PROCESSING');
            expect(publishQueue.add).toHaveBeenCalledWith('publicar-conta', { postId: 7, accountId: 3, clientId: CLIENT_ID }, {});
            expect(resultado).toEqual({ status: 'queued', postId: 7, totalContas: 1 });
        });
    });
});
