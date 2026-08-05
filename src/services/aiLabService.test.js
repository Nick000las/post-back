jest.mock('../adapters/prismaAdapter.js', () => ({
    buscarClientePorId: jest.fn(),
    criarPostsEmLotePorIA: jest.fn()
}));

jest.mock('../adapters/groqAdapter.js', () => ({
    chatCompletion: jest.fn()
}));

jest.mock('./pdfService.js', () => ({
    extrairTexto: jest.fn()
}));

jest.mock('./kanbanService.js', () => ({
    resolverColunaIdeias: jest.fn()
}));

const prismaAdapter = require('../adapters/prismaAdapter.js');
const groqAdapter = require('../adapters/groqAdapter.js');
const pdfService = require('./pdfService.js');
const kanbanService = require('./kanbanService.js');
const aiLabService = require('./aiLabService.js');
const AppError = require('../errors/AppError.js');

const CLIENT_ID = 99;
const USER_ID = 7;
const IDEIAS_COLUMN_ID = 1001;
const arquivo = { buffer: Buffer.from('pdf falso') };

describe('AiLabService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prismaAdapter.buscarClientePorId.mockResolvedValue({ id: CLIENT_ID, user_id: USER_ID });
        pdfService.extrairTexto.mockResolvedValue('texto extraído do pdf');
        kanbanService.resolverColunaIdeias.mockResolvedValue(IDEIAS_COLUMN_ID);
    });

    describe('extrairPostsDoPdf', () => {
        test('lança AppError se o cliente não pertence ao usuário', async () => {
            prismaAdapter.buscarClientePorId.mockResolvedValue(null);

            await expect(aiLabService.extrairPostsDoPdf(arquivo, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(pdfService.extrairTexto).not.toHaveBeenCalled();
        });

        test('extrai o texto do pdf e repassa pra Groq', async () => {
            groqAdapter.chatCompletion.mockResolvedValue(JSON.stringify({ posts: [] }));

            await aiLabService.extrairPostsDoPdf(arquivo, CLIENT_ID, USER_ID);

            expect(pdfService.extrairTexto).toHaveBeenCalledWith(arquivo.buffer);
            expect(groqAdapter.chatCompletion).toHaveBeenCalledTimes(1);
        });

        test('retorna a lista de posts extraída da resposta da IA', async () => {
            const posts = [{ caption: 'Post 1', format: 'FEED', suggestedDate: '2026-08-03' }];
            groqAdapter.chatCompletion.mockResolvedValue(JSON.stringify({ posts }));

            const resultado = await aiLabService.extrairPostsDoPdf(arquivo, CLIENT_ID, USER_ID);

            expect(resultado).toEqual(posts);
        });

        test('lança AppError se a resposta da IA não for um JSON válido', async () => {
            groqAdapter.chatCompletion.mockResolvedValue('isso não é JSON');

            await expect(aiLabService.extrairPostsDoPdf(arquivo, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
        });

        test('lança AppError se a resposta não tiver o array "posts"', async () => {
            groqAdapter.chatCompletion.mockResolvedValue(JSON.stringify({}));

            await expect(aiLabService.extrairPostsDoPdf(arquivo, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
        });

        test('retorna array vazio se a IA legitimamente não encontrou posts no PDF', async () => {
            groqAdapter.chatCompletion.mockResolvedValue(JSON.stringify({ posts: [] }));

            const resultado = await aiLabService.extrairPostsDoPdf(arquivo, CLIENT_ID, USER_ID);

            expect(resultado).toEqual([]);
        });

        test('descarta itens sem legenda (post sem conteúdo útil)', async () => {
            groqAdapter.chatCompletion.mockResolvedValue(JSON.stringify({
                posts: [
                    { caption: '', format: 'FEED', suggestedDate: '2026-08-03' },
                    { format: 'FEED', suggestedDate: '2026-08-03' },
                    { caption: 'Post válido', format: 'FEED', suggestedDate: '2026-08-03' }
                ]
            }));

            const resultado = await aiLabService.extrairPostsDoPdf(arquivo, CLIENT_ID, USER_ID);

            expect(resultado).toEqual([{ caption: 'Post válido', format: 'FEED', suggestedDate: '2026-08-03' }]);
        });

        test('normaliza format inválido/fora do enum pra null, sem descartar o post', async () => {
            groqAdapter.chatCompletion.mockResolvedValue(JSON.stringify({
                posts: [{ caption: 'Post 1', format: 'VIDEO', suggestedDate: '2026-08-03' }]
            }));

            const resultado = await aiLabService.extrairPostsDoPdf(arquivo, CLIENT_ID, USER_ID);

            expect(resultado).toEqual([{ caption: 'Post 1', format: null, suggestedDate: '2026-08-03' }]);
        });

        test('aceita format em minúsculo/com espaços e normaliza pro enum', async () => {
            groqAdapter.chatCompletion.mockResolvedValue(JSON.stringify({
                posts: [{ caption: 'Post 1', format: ' feed ', suggestedDate: '2026-08-03' }]
            }));

            const resultado = await aiLabService.extrairPostsDoPdf(arquivo, CLIENT_ID, USER_ID);

            expect(resultado[0].format).toBe('FEED');
        });

        test('normaliza data fora do padrão ISO ou inexistente (ex.: 30/02) pra null', async () => {
            groqAdapter.chatCompletion.mockResolvedValue(JSON.stringify({
                posts: [
                    { caption: 'Post 1', format: 'FEED', suggestedDate: '03/08/2026' },
                    { caption: 'Post 2', format: 'FEED', suggestedDate: '2026-02-30' },
                    { caption: 'Post 3', format: 'FEED', suggestedDate: null }
                ]
            }));

            const resultado = await aiLabService.extrairPostsDoPdf(arquivo, CLIENT_ID, USER_ID);

            expect(resultado.every(post => post.suggestedDate === null)).toBe(true);
        });
    });

    describe('importarPostsExtraidos', () => {
        const posts = [{ caption: 'Post 1', format: 'FEED', suggestedDate: '2026-08-03' }];

        test('lança AppError se o cliente não pertence ao usuário', async () => {
            prismaAdapter.buscarClientePorId.mockResolvedValue(null);

            await expect(aiLabService.importarPostsExtraidos(posts, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
            expect(prismaAdapter.criarPostsEmLotePorIA).not.toHaveBeenCalled();
        });

        test('lança AppError se a lista não for um array', async () => {
            await expect(aiLabService.importarPostsExtraidos(null, CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
        });

        test('lança AppError se a lista estiver vazia', async () => {
            await expect(aiLabService.importarPostsExtraidos([], CLIENT_ID, USER_ID)).rejects.toThrow(AppError);
        });

        test('resolve a coluna Ideias e cria os posts em lote nela', async () => {
            prismaAdapter.criarPostsEmLotePorIA.mockResolvedValue(posts.map((post, i) => ({ id: i + 1, ...post })));

            const resultado = await aiLabService.importarPostsExtraidos(posts, CLIENT_ID, USER_ID);

            expect(kanbanService.resolverColunaIdeias).toHaveBeenCalledWith(CLIENT_ID);
            expect(prismaAdapter.criarPostsEmLotePorIA).toHaveBeenCalledWith(CLIENT_ID, IDEIAS_COLUMN_ID, posts);
            expect(resultado.message).toBe('1 posts importados com sucesso');
            expect(resultado.criados).toHaveLength(1);
        });
    });
});
