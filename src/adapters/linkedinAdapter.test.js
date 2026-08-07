jest.mock('fs', () => ({
    readFileSync: jest.fn().mockReturnValue(Buffer.from('conteudo-fake'))
}));

const linkedinAdapter = require('./linkedinAdapter.js');
const AppError = require('../errors/AppError.js');

const TOKEN = 'token-fake';
const AUTHOR_URN = 'urn:li:person:abc';
const IMAGEM = { file_path: 'a.jpg', file_name: 'a.jpg', file_type: 'image/jpeg' };
const imagem = (nome) => ({ file_path: `${nome}.jpg`, file_name: `${nome}.jpg`, file_type: 'image/jpeg' });

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

describe('LinkedinAdapter.publicarContainer', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete global.fetch;
    });

    describe('guard-rails', () => {
        test('lança AppError se o URN for inválido ou ausente', async () => {
            const post = { media: [IMAGEM] };

            await expect(linkedinAdapter.publicarContainer(post, TOKEN, null)).rejects.toThrow(AppError);
            await expect(linkedinAdapter.publicarContainer(post, TOKEN, 'nao-eh-urn')).rejects.toThrow(AppError);
        });

        test('rejeita carrossel com vídeo em vez de publicar só o primeiro item em silêncio', async () => {
            const video = { file_path: 'v.mp4', file_name: 'v.mp4', file_type: 'video/mp4' };
            const post = { media: [IMAGEM, video] };

            await expect(linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN))
                .rejects.toThrow('O Linkedin não suporta carrossel com vídeo.');
            expect(global.fetch).not.toHaveBeenCalled();
        });
    });

    describe('carrossel de fotos', () => {
        // Cada chamada de registerUpload responde com um asset previsível; a chamada de upload
        // binário (PUT na uploadUrl devolvida) só precisa devolver ok; e a última chamada é o
        // ugcPosts em si.
        const mockFluxoCarrossel = () => {
            let registros = 0;
            global.fetch.mockImplementation(async (url, init) => {
                if (url.includes('registerUpload')) {
                    const indice = registros++;
                    return ok({
                        value: {
                            uploadMechanism: {
                                'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: `https://upload.test/${indice}` }
                            },
                            asset: `urn:li:digitalmediaAsset:asset-${indice}`
                        }
                    });
                }
                if (url.startsWith('https://upload.test/')) return { ok: true, status: 201 };
                return ok({ id: 'post-carrossel' });
            });
        };

        test('registra e sobe um asset por item, e publica um único post com todas as mídias', async () => {
            mockFluxoCarrossel();
            const post = { caption: 'legenda', media: [imagem('primeiro'), imagem('segundo')] };

            const resultado = await linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN);

            const chamadaUgc = global.fetch.mock.calls.find(([url]) => url === 'https://api.linkedin.com/v2/ugcPosts');
            const body = JSON.parse(chamadaUgc[1].body);
            const shareContent = body.specificContent['com.linkedin.ugc.ShareContent'];

            expect(shareContent.shareMediaCategory).toBe('IMAGE');
            expect(shareContent.media).toEqual([
                { status: 'READY', description: { text: 'primeiro.jpg' }, media: 'urn:li:digitalmediaAsset:asset-0', title: { text: 'primeiro.jpg' } },
                { status: 'READY', description: { text: 'segundo.jpg' }, media: 'urn:li:digitalmediaAsset:asset-1', title: { text: 'segundo.jpg' } }
            ]);
            expect(resultado).toEqual({ success: true, externalId: 'post-carrossel' });
        });

        test('lança AppError se o registro de algum asset falhar', async () => {
            global.fetch.mockResolvedValue({ ok: false, status: 400, text: async () => 'erro' });
            const post = { media: [imagem('a'), imagem('b')] };

            await expect(linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN)).rejects.toThrow(AppError);
        });
    });
});
