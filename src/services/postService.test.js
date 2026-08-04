jest.mock('../adapters/prismaAdapter.js', () => ({
    buscarClientePorId: jest.fn(),
    criarPost: jest.fn(),
    atualizarStatusPost: jest.fn(),
    atualizarScheduledFor: jest.fn(),
    listarStatusContasDoPost: jest.fn(),
    registrarJobAgendado: jest.fn(),
    buscarPostComStatusContas: jest.fn(),
    vincularPostConta: jest.fn(),
    buscarPostAgendadoComJobs: jest.fn(),
    reverterAgendamentoParaDraft: jest.fn(),
    excluirPostDefinitivo: jest.fn(),
    criarDraftComContas: jest.fn(),
    buscarDraftPorId: jest.fn(),
    atualizarMidiaDraft: jest.fn(),
    removerMidiaDraft: jest.fn(),
    buscarPostPorId: jest.fn(),
    listarContasDoDraft: jest.fn(),
    // Kanban: buscarColunaIdeias é chamado por baixo dos panos (via kanbanService.resolverColunaIdeias)
    // sempre que um post é criado sem columnId explícito — ou seja, em todo teste de criação de post.
    buscarColunaIdeias: jest.fn(),
    // Salto automático de coluna (SCHEDULED -> Agendado, status final -> Finalizado): chamado por
    // #moverParaColunaFixa em todo teste de #enfileirarContas/finalizarStatusSeCompleto.
    buscarColunaPorFixedKey: jest.fn(),
    moverPostDeColuna: jest.fn(),
    listarFeedGlobal: jest.fn(),
    listarFeedCliente: jest.fn()
}));

jest.mock('../queues/publishQueue.js', () => ({
    publishQueue: { add: jest.fn(), getJob: jest.fn() }
}));

jest.mock('./thumbnailService.js', () => ({
    gerar: jest.fn()
}));

jest.mock('fs', () => ({
    existsSync: jest.fn().mockReturnValue(false),
    unlinkSync: jest.fn()
}));

const prismaAdapter = require('../adapters/prismaAdapter.js');
const { publishQueue } = require('../queues/publishQueue.js');
const thumbnailService = require('./thumbnailService.js');
const postService = require('./postService.js');
const AppError = require('../errors/AppError.js');

const CLIENT_ID = 99;
const USER_ID = 7;
const IDEIAS_COLUMN_ID = 1001;

describe('PostService', () => {
    beforeEach(() => {
        prismaAdapter.buscarClientePorId.mockResolvedValue({ id: CLIENT_ID, user_id: USER_ID });
        prismaAdapter.buscarColunaIdeias.mockResolvedValue({ id: IDEIAS_COLUMN_ID });
        prismaAdapter.buscarPostPorId.mockResolvedValue({ id: 1, client_id: CLIENT_ID });
        prismaAdapter.buscarColunaPorFixedKey.mockResolvedValue({ id: 2002 });
        thumbnailService.gerar.mockResolvedValue(null);
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

            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(1, 'PUBLISHED', { published_at: expect.any(Date) });
        });

        test('marca FAILED quando nenhuma conta teve sucesso', async () => {
            prismaAdapter.listarStatusContasDoPost.mockResolvedValue([
                { delivery_status: 'FAILED' }
            ]);

            await postService.finalizarStatusSeCompleto(1);

            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(1, 'FAILED', { published_at: expect.any(Date) });
        });

        test('marca PARTIAL quando há mistura de sucesso e falha', async () => {
            prismaAdapter.listarStatusContasDoPost.mockResolvedValue([
                { delivery_status: 'SUCCESS' },
                { delivery_status: 'FAILED' }
            ]);

            await postService.finalizarStatusSeCompleto(1);

            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(1, 'PARTIAL', { published_at: expect.any(Date) });
        });

        test('move o post pra coluna fixa "Finalizado" ao fechar o status', async () => {
            prismaAdapter.listarStatusContasDoPost.mockResolvedValue([{ delivery_status: 'SUCCESS' }]);
            prismaAdapter.buscarPostPorId.mockResolvedValue({ id: 1, client_id: CLIENT_ID });

            await postService.finalizarStatusSeCompleto(1);

            expect(prismaAdapter.buscarColunaPorFixedKey).toHaveBeenCalledWith(CLIENT_ID, 'FINALIZADO');
            expect(prismaAdapter.moverPostDeColuna).toHaveBeenCalledWith(1, CLIENT_ID, 2002);
        });

        test('não quebra o fechamento de status se o post não for encontrado (inconsistência de dados)', async () => {
            prismaAdapter.listarStatusContasDoPost.mockResolvedValue([{ delivery_status: 'SUCCESS' }]);
            prismaAdapter.buscarPostPorId.mockResolvedValue(null);

            await expect(postService.finalizarStatusSeCompleto(1)).resolves.not.toThrow();
            expect(prismaAdapter.moverPostDeColuna).not.toHaveBeenCalled();
        });
    });

    describe('gerenciarPostagemEmLote', () => {
        test('cria o post, marca PROCESSING e enfileira um job por conta (sem delay)', async () => {
            prismaAdapter.criarPost.mockResolvedValue({ id: 42 });

            const arquivo = { filename: 'foo.jpg', originalname: 'foo-original.jpg', mimetype: 'image/jpeg' };
            const accounts = [{ id: 1 }, { id: 2 }];

            const resultado = await postService.gerenciarPostagemEmLote(arquivo, 'legenda', accounts, CLIENT_ID, USER_ID);

            expect(prismaAdapter.buscarClientePorId).toHaveBeenCalledWith(CLIENT_ID, USER_ID);
            // scheduledFor precisa ser null aqui, não o columnId — já foi um bug real (columnId caindo
            // na posição de scheduledFor por falta desse null).
            expect(prismaAdapter.criarPost).toHaveBeenCalledWith(
                'legenda', 'foo.jpg', 'foo-original.jpg', 'image/jpeg', 'DRAFT', CLIENT_ID, null, IDEIAS_COLUMN_ID, null
            );
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
                'c', 'foo.jpg', 'foo-original.jpg', 'image/jpeg', 'SCHEDULED', CLIENT_ID, new Date(scheduledFor), IDEIAS_COLUMN_ID, null
            );
            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(55, 'SCHEDULED');
            expect(publishQueue.add).toHaveBeenCalledWith(
                'publicar-conta', { postId: 55, accountId: 1, clientId: CLIENT_ID }, { delay: 3600000 }
            );
            expect(prismaAdapter.registrarJobAgendado).toHaveBeenCalledWith(55, 1, 'job-a');
            expect(prismaAdapter.registrarJobAgendado).toHaveBeenCalledWith(55, 2, 'job-b');
            expect(resultado).toEqual({ status: 'scheduled', postId: 55, totalContas: 2 });

            // Salto automático de coluna: SCHEDULED move o post pra coluna fixa "Agendado".
            expect(prismaAdapter.buscarColunaPorFixedKey).toHaveBeenCalledWith(CLIENT_ID, 'AGENDADO');
            expect(prismaAdapter.moverPostDeColuna).toHaveBeenCalledWith(55, CLIENT_ID, 2002);

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
        // Mudança de semântica: cancelar NÃO exclui mais o post — reverte pra DRAFT. Estes testes
        // documentam o contrato esperado; os TODOs de postService.cancelarAgendamento ainda precisam
        // ser implementados pra eles passarem (esqueleto, não lógica pronta).
        test('lança AppError quando não há post agendado correspondente', async () => {
            prismaAdapter.buscarPostAgendadoComJobs.mockResolvedValue(null);

            await expect(postService.cancelarAgendamento(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(prismaAdapter.reverterAgendamentoParaDraft).not.toHaveBeenCalled();
        });

        test('remove apenas os jobs em estado delayed, reverte o post pra DRAFT e move pra Ideias', async () => {
            prismaAdapter.buscarPostAgendadoComJobs.mockResolvedValue({
                id: 8,
                file_path: 'foo.jpg',
                post_accounts: [{ job_id: 'job-a' }, { job_id: 'job-b' }, { job_id: null }]
            });
            prismaAdapter.reverterAgendamentoParaDraft.mockResolvedValue({ id: 8, status: 'DRAFT' });

            const jobDelayed = { getState: jest.fn().mockResolvedValue('delayed'), remove: jest.fn() };
            const jobAtivo = { getState: jest.fn().mockResolvedValue('active'), remove: jest.fn() };
            publishQueue.getJob.mockResolvedValueOnce(jobDelayed).mockResolvedValueOnce(jobAtivo);

            const resultado = await postService.cancelarAgendamento(8, CLIENT_ID, USER_ID);

            expect(jobDelayed.remove).toHaveBeenCalled();
            expect(jobAtivo.remove).not.toHaveBeenCalled();
            expect(publishQueue.getJob).toHaveBeenCalledTimes(2); // job_id null é ignorado
            expect(prismaAdapter.reverterAgendamentoParaDraft).toHaveBeenCalledWith(8, CLIENT_ID);
            expect(prismaAdapter.buscarColunaPorFixedKey).toHaveBeenCalledWith(CLIENT_ID, 'IDEIAS');
            expect(prismaAdapter.moverPostDeColuna).toHaveBeenCalledWith(8, CLIENT_ID, 2002);
            expect(resultado).toEqual({ message: 'Agendamento cancelado. O post voltou a ser um rascunho.', postId: 8 });
        });
    });

    describe('alterarDataAgendamento', () => {
        test('lança AppError se a nova data não tiver fuso horário explícito', async () => {
            await expect(
                postService.alterarDataAgendamento(1, CLIENT_ID, USER_ID, '2999-01-01T10:00:00')
            ).rejects.toThrow(AppError);
            expect(prismaAdapter.buscarPostAgendadoComJobs).not.toHaveBeenCalled();
        });

        test('lança AppError se a nova data estiver no passado', async () => {
            await expect(
                postService.alterarDataAgendamento(1, CLIENT_ID, USER_ID, '2020-01-01T00:00:00Z')
            ).rejects.toThrow(AppError);
        });

        test('lança AppError quando não há post agendado correspondente', async () => {
            prismaAdapter.buscarPostAgendadoComJobs.mockResolvedValue(null);

            await expect(
                postService.alterarDataAgendamento(1, CLIENT_ID, USER_ID, '2999-01-01T10:00:00Z')
            ).rejects.toThrow(AppError);
            expect(prismaAdapter.atualizarScheduledFor).not.toHaveBeenCalled();
        });

        test('reagenda os jobs existentes (changeDelay) e grava a nova data', async () => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
            prismaAdapter.buscarPostAgendadoComJobs.mockResolvedValue({
                id: 8,
                file_path: 'foo.jpg',
                post_accounts: [{ job_id: 'job-a' }]
            });
            const job = { getState: jest.fn().mockResolvedValue('delayed'), changeDelay: jest.fn() };
            publishQueue.getJob.mockResolvedValueOnce(job);

            const scheduledFor = '2026-01-01T02:00:00Z'; // +2h
            const resultado = await postService.alterarDataAgendamento(8, CLIENT_ID, USER_ID, scheduledFor);

            expect(job.changeDelay).toHaveBeenCalledWith(7200000);
            expect(prismaAdapter.atualizarScheduledFor).toHaveBeenCalledWith(8, new Date(scheduledFor));
            expect(resultado).toEqual({ message: 'Data de agendamento atualizada com sucesso', postId: 8, scheduled_for: new Date(scheduledFor) });

            jest.useRealTimers();
        });
    });

    describe('excluirPost', () => {
        test('lança AppError se o post não existe/não pertence ao cliente', async () => {
            prismaAdapter.buscarPostAgendadoComJobs.mockResolvedValue(null);
            prismaAdapter.excluirPostDefinitivo.mockResolvedValue(null);

            await expect(postService.excluirPost(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
        });

        test('remove jobs pendentes (se houver) e exclui o post definitivamente', async () => {
            prismaAdapter.buscarPostAgendadoComJobs.mockResolvedValue({
                id: 8,
                file_path: 'foo.jpg',
                post_accounts: [{ job_id: 'job-a' }]
            });
            const jobDelayed = { getState: jest.fn().mockResolvedValue('delayed'), remove: jest.fn() };
            publishQueue.getJob.mockResolvedValueOnce(jobDelayed);
            prismaAdapter.excluirPostDefinitivo.mockResolvedValue({ id: 8, file_path: 'foo.jpg' });

            const resultado = await postService.excluirPost(8, CLIENT_ID, USER_ID);

            expect(jobDelayed.remove).toHaveBeenCalled();
            expect(prismaAdapter.excluirPostDefinitivo).toHaveBeenCalledWith(8, CLIENT_ID);
            expect(resultado).toEqual({ message: 'Post excluído com sucesso', postId: 8 });
        });

        test('exclui normalmente um post que não estava agendado (sem jobs pra remover)', async () => {
            prismaAdapter.buscarPostAgendadoComJobs.mockResolvedValue(null);
            prismaAdapter.excluirPostDefinitivo.mockResolvedValue({ id: 3, file_path: 'bar.jpg' });

            const resultado = await postService.excluirPost(3, CLIENT_ID, USER_ID);

            expect(publishQueue.getJob).not.toHaveBeenCalled();
            expect(resultado).toEqual({ message: 'Post excluído com sucesso', postId: 3 });
        });
    });

    describe('publicarDraft', () => {
        test('lança AppError se o draft não existe', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue(null);

            await expect(postService.publicarDraft(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(publishQueue.add).not.toHaveBeenCalled();
        });

        test('lança AppError se o draft não tem mídia', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({ id: 1, file_path: null });

            await expect(postService.publicarDraft(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(prismaAdapter.listarContasDoDraft).not.toHaveBeenCalled();
            expect(publishQueue.add).not.toHaveBeenCalled();
        });

        test('lança AppError se o draft não tem contas vinculadas', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({ id: 1, file_path: 'f' });
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

    describe('agendarDraft', () => {
        test('rejeita data sem fuso horário explícito', async () => {
            await expect(
                postService.agendarDraft(1, CLIENT_ID, USER_ID, '2999-01-01T10:00:00')
            ).rejects.toThrow(AppError);
            expect(prismaAdapter.buscarDraftPorId).not.toHaveBeenCalled();
        });

        test('rejeita data no passado', async () => {
            await expect(
                postService.agendarDraft(1, CLIENT_ID, USER_ID, '2020-01-01T00:00:00Z')
            ).rejects.toThrow(AppError);
            expect(publishQueue.add).not.toHaveBeenCalled();
        });

        test('lança AppError se o draft não existe', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue(null);

            await expect(
                postService.agendarDraft(1, CLIENT_ID, USER_ID, '2999-01-01T10:00:00Z')
            ).rejects.toThrow(AppError);
            expect(publishQueue.add).not.toHaveBeenCalled();
        });

        test('lança AppError se o draft não tem mídia', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({ id: 1, file_path: null });

            await expect(
                postService.agendarDraft(1, CLIENT_ID, USER_ID, '2999-01-01T10:00:00Z')
            ).rejects.toThrow(AppError);
            expect(prismaAdapter.listarContasDoDraft).not.toHaveBeenCalled();
        });

        test('lança AppError se o draft não tem contas vinculadas', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({ id: 1, file_path: 'f' });
            prismaAdapter.listarContasDoDraft.mockResolvedValue([]);

            await expect(
                postService.agendarDraft(1, CLIENT_ID, USER_ID, '2999-01-01T10:00:00Z')
            ).rejects.toThrow(AppError);
            expect(prismaAdapter.atualizarScheduledFor).not.toHaveBeenCalled();
        });

        test('caminho feliz: grava scheduled_for, marca SCHEDULED e move pra coluna Agendado', async () => {
            jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
            prismaAdapter.buscarDraftPorId.mockResolvedValue({
                id: 9, caption: 'c', file_path: 'f', file_name: 'n', file_type: 'image/jpeg'
            });
            prismaAdapter.listarContasDoDraft.mockResolvedValue([{ id: 1 }]);
            publishQueue.add.mockResolvedValueOnce({ id: 'job-a' });

            const scheduledFor = '2026-01-01T01:00:00Z'; // +1h
            const resultado = await postService.agendarDraft(9, CLIENT_ID, USER_ID, scheduledFor);

            expect(prismaAdapter.atualizarScheduledFor).toHaveBeenCalledWith(9, new Date(scheduledFor));
            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(9, 'SCHEDULED');
            expect(publishQueue.add).toHaveBeenCalledWith(
                'publicar-conta', { postId: 9, accountId: 1, clientId: CLIENT_ID }, { delay: 3600000 }
            );
            expect(prismaAdapter.registrarJobAgendado).toHaveBeenCalledWith(9, 1, 'job-a');
            expect(prismaAdapter.buscarColunaPorFixedKey).toHaveBeenCalledWith(CLIENT_ID, 'AGENDADO');
            expect(prismaAdapter.moverPostDeColuna).toHaveBeenCalledWith(9, CLIENT_ID, 2002);
            expect(resultado).toEqual({ status: 'scheduled', postId: 9, totalContas: 1 });

            jest.useRealTimers();
        });
    });

    describe('atualizarMidiaDraft', () => {
        const arquivo = { filename: 'novo.jpg', originalname: 'novo-original.jpg', mimetype: 'image/jpeg' };

        test('lança AppError se o draft não existe', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue(null);

            await expect(
                postService.atualizarMidiaDraft(1, CLIENT_ID, USER_ID, arquivo)
            ).rejects.toThrow(AppError);
            expect(thumbnailService.gerar).not.toHaveBeenCalled();
            expect(prismaAdapter.atualizarMidiaDraft).not.toHaveBeenCalled();
        });

        test('lança AppError se o adapter não encontra o draft na hora de atualizar (corrida de status)', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({ id: 1, file_path: 'antigo.jpg', thumbnail_path: 'antigo-thumb.jpg' });
            thumbnailService.gerar.mockResolvedValue('novo-thumb.jpg');
            prismaAdapter.atualizarMidiaDraft.mockResolvedValue(null);

            await expect(
                postService.atualizarMidiaDraft(1, CLIENT_ID, USER_ID, arquivo)
            ).rejects.toThrow(AppError);
        });

        test('gera thumbnail, atualiza o draft e repassa os dados corretos pro adapter', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({ id: 5, file_path: 'antigo.jpg', thumbnail_path: 'antigo-thumb.jpg' });
            thumbnailService.gerar.mockResolvedValue('novo-thumb.jpg');
            prismaAdapter.atualizarMidiaDraft.mockResolvedValue({ id: 5, file_path: 'novo.jpg' });

            const resultado = await postService.atualizarMidiaDraft(5, CLIENT_ID, USER_ID, arquivo);

            expect(thumbnailService.gerar).toHaveBeenCalledWith(arquivo);
            expect(prismaAdapter.atualizarMidiaDraft).toHaveBeenCalledWith(5, CLIENT_ID, {
                filePath: 'novo.jpg', fileName: 'novo-original.jpg', fileType: 'image/jpeg', thumbnailPath: 'novo-thumb.jpg'
            });
            expect(resultado).toEqual({ id: 5, file_path: 'novo.jpg' });
        });
    });

    describe('removerMidiaDraft', () => {
        test('lança AppError se o draft não existe', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue(null);

            await expect(postService.removerMidiaDraft(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(prismaAdapter.removerMidiaDraft).not.toHaveBeenCalled();
        });

        test('lança AppError se o adapter não encontra o draft na hora de remover (corrida de status)', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({ id: 1, file_path: 'antigo.jpg' });
            prismaAdapter.removerMidiaDraft.mockResolvedValue(null);

            await expect(postService.removerMidiaDraft(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
        });

        test('remove a mídia e retorna o draft atualizado', async () => {
            prismaAdapter.buscarDraftPorId.mockResolvedValue({ id: 5, file_path: 'antigo.jpg', thumbnail_path: 'antigo-thumb.jpg' });
            prismaAdapter.removerMidiaDraft.mockResolvedValue({ id: 5, file_path: null, thumbnail_path: null });

            const resultado = await postService.removerMidiaDraft(5, CLIENT_ID, USER_ID);

            expect(prismaAdapter.removerMidiaDraft).toHaveBeenCalledWith(5, CLIENT_ID);
            expect(resultado).toEqual({ id: 5, file_path: null, thumbnail_path: null });
        });
    });

    describe('listarFeedGlobal', () => {
        beforeEach(() => {
            prismaAdapter.listarFeedGlobal.mockResolvedValue({ posts: [], total: 0 });
        });

        test('escopa a busca pelo userId autenticado, sem exigir clientId', async () => {
            await postService.listarFeedGlobal(USER_ID, { status: 'todos' }, 1, 10);

            expect(prismaAdapter.listarFeedGlobal).toHaveBeenCalledWith(expect.objectContaining({
                userId: USER_ID,
                clientId: undefined,
                statusList: ['SCHEDULED', 'PROCESSING', 'PUBLISHED', 'PARTIAL', 'FAILED']
            }));
        });

        test('mapeia o filtro "falhas" para FAILED e PARTIAL', async () => {
            await postService.listarFeedGlobal(USER_ID, { status: 'falhas' }, 1, 10);

            expect(prismaAdapter.listarFeedGlobal).toHaveBeenCalledWith(expect.objectContaining({
                statusList: ['FAILED', 'PARTIAL']
            }));
        });

        test('valida a posse do cliente quando clientId é informado (isolar um client)', async () => {
            await postService.listarFeedGlobal(USER_ID, { status: 'todos', clientId: CLIENT_ID }, 1, 10);

            expect(prismaAdapter.buscarClientePorId).toHaveBeenCalledWith(CLIENT_ID, USER_ID);
        });

        test('lança AppError se o clientId informado não pertence ao usuário', async () => {
            prismaAdapter.buscarClientePorId.mockResolvedValue(null);

            await expect(
                postService.listarFeedGlobal(USER_ID, { status: 'todos', clientId: CLIENT_ID }, 1, 10)
            ).rejects.toThrow(AppError);
        });

        test('retorna a paginação calculada a partir do total', async () => {
            prismaAdapter.listarFeedGlobal.mockResolvedValue({ posts: [{ id: 1 }], total: 25 });

            const resultado = await postService.listarFeedGlobal(USER_ID, { status: 'todos' }, 2, 10);

            expect(resultado).toEqual({
                feed: [{ id: 1 }],
                pagination: { page: 2, limit: 10, total: 25, totalPages: 3 }
            });
        });
    });

    describe('listarFeedCliente', () => {
        beforeEach(() => {
            prismaAdapter.listarFeedCliente.mockResolvedValue({ posts: [], total: 0 });
        });

        test('exige clientId válido (posse do usuário) antes de listar', async () => {
            await postService.listarFeedCliente(USER_ID, { clientId: CLIENT_ID }, 1, 10);

            expect(prismaAdapter.buscarClientePorId).toHaveBeenCalledWith(CLIENT_ID, USER_ID);
            expect(prismaAdapter.listarFeedCliente).toHaveBeenCalledWith(expect.objectContaining({ clientId: CLIENT_ID }));
        });

        test('lança AppError se o cliente não pertence ao usuário', async () => {
            prismaAdapter.buscarClientePorId.mockResolvedValue(null);

            await expect(
                postService.listarFeedCliente(USER_ID, { clientId: CLIENT_ID }, 1, 10)
            ).rejects.toThrow(AppError);
            expect(prismaAdapter.listarFeedCliente).not.toHaveBeenCalled();
        });

        test('repassa o filtro de platform pro adapter', async () => {
            await postService.listarFeedCliente(USER_ID, { clientId: CLIENT_ID, platform: 'instagram' }, 1, 10);

            expect(prismaAdapter.listarFeedCliente).toHaveBeenCalledWith(expect.objectContaining({ platform: 'instagram' }));
        });

        test('resolve o intervalo de mês/ano só quando os dois vierem', async () => {
            await postService.listarFeedCliente(USER_ID, { clientId: CLIENT_ID, month: 8, year: 2026 }, 1, 10);

            const chamada = prismaAdapter.listarFeedCliente.mock.calls[0][0];
            expect(chamada.intervalo).toEqual({
                from: new Date(2026, 7, 1, 0, 0, 0, 0),
                to: new Date(2026, 7, 31, 23, 59, 59, 999)
            });
        });

        test('filtra o ano inteiro quando só year vier (dropdown "Todos os meses")', async () => {
            await postService.listarFeedCliente(USER_ID, { clientId: CLIENT_ID, year: 2025 }, 1, 10);

            const chamada = prismaAdapter.listarFeedCliente.mock.calls[0][0];
            expect(chamada.intervalo).toEqual({
                from: new Date(2025, 0, 1, 0, 0, 0, 0),
                to: new Date(2025, 11, 31, 23, 59, 59, 999)
            });
        });

        test('não filtra por data se só month vier, sem year', async () => {
            await postService.listarFeedCliente(USER_ID, { clientId: CLIENT_ID, month: 8 }, 1, 10);

            expect(prismaAdapter.listarFeedCliente).toHaveBeenCalledWith(expect.objectContaining({ intervalo: undefined }));
        });
    });

    describe('republicarPost', () => {
        test('lança AppError se o cliente não pertence ao usuário', async () => {
            prismaAdapter.buscarClientePorId.mockResolvedValue(null);

            await expect(postService.republicarPost(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(prismaAdapter.buscarPostComStatusContas).not.toHaveBeenCalled();
        });

        test('lança AppError se o post não é encontrado', async () => {
            prismaAdapter.buscarPostComStatusContas.mockResolvedValue(null);

            await expect(postService.republicarPost(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
        });

        test('lança AppError se não há contas com falha', async () => {
            prismaAdapter.buscarPostComStatusContas.mockResolvedValue({
                id: 1,
                status: 'PUBLISHED',
                accounts: [{ accountId: 2, platform: 'instagram', delivery_status: 'SUCCESS', error_message: null }]
            });

            await expect(postService.republicarPost(1, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(prismaAdapter.vincularPostConta).not.toHaveBeenCalled();
        });

        test('reseta só as contas com falha pra PENDING e reenfileira só elas', async () => {
            prismaAdapter.buscarPostComStatusContas.mockResolvedValue({
                id: 1,
                status: 'PARTIAL',
                accounts: [
                    { accountId: 2, platform: 'instagram', delivery_status: 'FAILED', error_message: 'Token expirado' },
                    { accountId: 3, platform: 'facebook', delivery_status: 'SUCCESS', error_message: null }
                ]
            });

            const resultado = await postService.republicarPost(1, CLIENT_ID, USER_ID);

            expect(prismaAdapter.vincularPostConta).toHaveBeenCalledTimes(1);
            expect(prismaAdapter.vincularPostConta).toHaveBeenCalledWith(1, 2, 'PENDING', null, null);
            expect(publishQueue.add).toHaveBeenCalledTimes(1);
            expect(publishQueue.add).toHaveBeenCalledWith('publicar-conta', { postId: 1, accountId: 2, clientId: CLIENT_ID }, {});
            expect(prismaAdapter.atualizarStatusPost).toHaveBeenCalledWith(1, 'PROCESSING');
            expect(resultado).toEqual({ status: 'queued', postId: 1, totalContas: 1 });
        });
    });
});
