const tiktokAdapter = require('./tiktokAdapter.js');
const AppError = require('../errors/AppError.js');

const TOKEN = 'token-fake';
const ACCOUNT_ID = 'tiktok-123';
const VIDEO = { file_path: 'v.mp4', file_name: 'v.mp4', file_type: 'video/mp4' };
const imagem = (nome) => ({ file_path: `${nome}.jpg`, file_name: `${nome}.jpg`, file_type: 'image/jpeg' });

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

describe('TiktokAdapter.publicarContainer', () => {
    beforeEach(() => {
        process.env.BASE_URL = 'https://exemplo.test';
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete global.fetch;
    });

    // Guard-rails: lançam antes de qualquer chamada de rede.
    describe('guard-rails', () => {
        test('lança AppError se o id da conta estiver ausente', async () => {
            await expect(tiktokAdapter.publicarContainer({ media: [VIDEO] }, TOKEN, null)).rejects.toThrow(AppError);
            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('rejeita post sem mídia', async () => {
            await expect(tiktokAdapter.publicarContainer({ media: [] }, TOKEN, ACCOUNT_ID)).rejects.toThrow(AppError);
            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('rejeita mídia única que não seja vídeo', async () => {
            const post = { media: [imagem('a')] };

            await expect(tiktokAdapter.publicarContainer(post, TOKEN, ACCOUNT_ID)).rejects.toThrow(AppError);
            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('rejeita carrossel com vídeo em vez de publicar só o primeiro item em silêncio', async () => {
            const post = { media: [VIDEO, { ...VIDEO, file_path: 'v2.mp4' }] };

            await expect(tiktokAdapter.publicarContainer(post, TOKEN, ACCOUNT_ID))
                .rejects.toThrow('O TikTok não suporta carrossel com vídeo.');
            expect(global.fetch).not.toHaveBeenCalled();
        });
    });

    describe('carrossel de fotos', () => {
        test('inicializa um post PHOTO com as URLs públicas na ordem de post.media', async () => {
            global.fetch.mockResolvedValue(ok({ data: { publish_id: 'publish-123' } }));
            const post = { caption: 'legenda', media: [imagem('primeiro'), imagem('segundo')] };

            const resultado = await tiktokAdapter.publicarContainer(post, TOKEN, ACCOUNT_ID);

            const [url, init] = global.fetch.mock.calls[0];
            const body = JSON.parse(init.body);

            expect(url).toBe('https://open.tiktokapis.com/v2/post/publish/content/init/');
            expect(body.media_type).toBe('PHOTO');
            expect(body.post_info.title).toBe('legenda');
            expect(body.source_info.photo_images).toEqual([
                'https://exemplo.test/uploads/primeiro.jpg',
                'https://exemplo.test/uploads/segundo.jpg'
            ]);
            expect(resultado).toEqual({ success: true, externalId: 'publish-123' });
        });

        test('lança AppError se a API do TikTok recusar o carrossel', async () => {
            global.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'falhou' } }) });
            const post = { media: [imagem('a'), imagem('b')] };

            await expect(tiktokAdapter.publicarContainer(post, TOKEN, ACCOUNT_ID)).rejects.toThrow(AppError);
        });
    });
});
