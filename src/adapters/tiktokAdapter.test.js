jest.mock('fs', () => ({
    statSync: jest.fn(),
    readFileSync: jest.fn()
}));

const fs = require('fs');
const tiktokAdapter = require('./tiktokAdapter.js');
const AppError = require('../errors/AppError.js');

const TOKEN = 'token-fake';
const ACCOUNT_ID = 'tiktok-123';
const VIDEO = { file_path: 'v.mp4', file_name: 'v.mp4', file_type: 'video/mp4' };
const imagem = (nome) => ({ file_path: `${nome}.jpg`, file_name: `${nome}.jpg`, file_type: 'image/jpeg' });

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

// Simula um arquivo de `tamanho` bytes no disco: statSync usado por #calcularPlanoDeChunks,
// readFileSync usado por #enviarArquivoBinario (fatiado por chunk via Buffer.subarray).
function mockArquivoDeTamanho (tamanho) {
    fs.statSync.mockReturnValue({ size: tamanho });
    fs.readFileSync.mockReturnValue(Buffer.alloc(tamanho));
}

// Mocka o fluxo completo de vídeo: POST no TIKTOK_INIT_URL devolve upload_url/publish_id: cada PUT
// subsequente na upload_url é registrado em `chamadasPut` (pra inspecionar Content-Range por
// chunk) e responde conforme `respostaPut` (default: sempre ok).
function mockFluxoVideo ({ respostaPut = () => ({ ok: true, status: 201 }) } = {}) {
    const chamadasPut = [];
    global.fetch.mockImplementation(async (url, init) => {
        if (url.includes('/post/publish/video/init/')) {
            return ok({ data: { upload_url: 'https://upload.test/video', publish_id: 'publish-video-1' } });
        }
        chamadasPut.push(init);
        return respostaPut(chamadasPut.length - 1);
    });
    return chamadasPut;
}

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

    // Caminho principal do TikTok (vídeo único) — sem cobertura nenhuma antes disto. #enviarArquivoBinario
    // fatia o Buffer.alloc(tamanho) do mock por índice de chunk; o conteúdo é zeros, só o TAMANHO de cada
    // fatia (e o Content-Range enviado) importa pra essas asserções.
    describe('vídeo único', () => {
        test('vídeo pequeno (cabe num chunk só): manda 1 chunk cobrindo o arquivo inteiro', async () => {
            mockArquivoDeTamanho(5 * 1024 * 1024); // 5MB, bem abaixo do teto de 64MB de um chunk só
            const chamadasPut = mockFluxoVideo();
            const post = { caption: 'legenda', media: [VIDEO] };

            const resultado = await tiktokAdapter.publicarContainer(post, TOKEN, ACCOUNT_ID);

            const chamadaInit = global.fetch.mock.calls.find(([url]) => url.includes('/video/init/'));
            const bodyInit = JSON.parse(chamadaInit[1].body);
            expect(bodyInit.source_info).toEqual({
                source: 'FILE_UPLOAD',
                video_size: 5 * 1024 * 1024,
                chunk_size: 5 * 1024 * 1024,
                total_chunk_count: 1
            });

            expect(chamadasPut).toHaveLength(1);
            expect(chamadasPut[0].headers['Content-Range']).toBe(`bytes 0-${5 * 1024 * 1024 - 1}/${5 * 1024 * 1024}`);
            expect(chamadasPut[0].body).toHaveLength(5 * 1024 * 1024);
            expect(resultado).toEqual({ success: true, externalId: 'publish-video-1' });
        });

        test('vídeo grande (acima do teto de um chunk só): divide em N chunks de 10MB, último com o resto', async () => {
            const TAMANHO = 75 * 1024 * 1024; // não divisível por 10MB de propósito — força um último chunk parcial
            mockArquivoDeTamanho(TAMANHO);
            const chamadasPut = mockFluxoVideo();
            const post = { caption: 'legenda', media: [VIDEO] };

            const resultado = await tiktokAdapter.publicarContainer(post, TOKEN, ACCOUNT_ID);

            const chamadaInit = global.fetch.mock.calls.find(([url]) => url.includes('/video/init/'));
            const bodyInit = JSON.parse(chamadaInit[1].body);
            expect(bodyInit.source_info).toEqual({
                source: 'FILE_UPLOAD',
                video_size: TAMANHO,
                chunk_size: 10 * 1024 * 1024,
                total_chunk_count: 8 // ceil(75/10)
            });

            expect(chamadasPut).toHaveLength(8);
            // 7 primeiros chunks cheios de 10MB
            for (let i = 0; i < 7; i++) {
                const inicio = i * 10 * 1024 * 1024;
                const fim = inicio + 10 * 1024 * 1024;
                expect(chamadasPut[i].headers['Content-Range']).toBe(`bytes ${inicio}-${fim - 1}/${TAMANHO}`);
                expect(chamadasPut[i].body).toHaveLength(10 * 1024 * 1024);
            }
            // último chunk (índice 7) carrega só o resto: 75MB - 70MB = 5MB
            const inicioUltimo = 7 * 10 * 1024 * 1024;
            expect(chamadasPut[7].headers['Content-Range']).toBe(`bytes ${inicioUltimo}-${TAMANHO - 1}/${TAMANHO}`);
            expect(chamadasPut[7].body).toHaveLength(5 * 1024 * 1024);

            expect(resultado).toEqual({ success: true, externalId: 'publish-video-1' });
        });

        test('pára no primeiro chunk que falhar, sem tentar enviar os demais', async () => {
            // 65MB acima do teto de 64MB de um chunk só -> divide em ceil(65/10) = 7 chunks de 10MB
            mockArquivoDeTamanho(65 * 1024 * 1024);
            mockFluxoVideo({
                respostaPut: (indiceChamada) => (indiceChamada === 1 ? { ok: false, status: 500 } : { ok: true, status: 201 })
            });
            const post = { media: [VIDEO] };

            await expect(tiktokAdapter.publicarContainer(post, TOKEN, ACCOUNT_ID))
                .rejects.toThrow('Falha ao enviar os dados do vídeo para o TikTok (chunk 2/7).');

            // 1 chamada de init + 2 PUTs (o 2º falhou, os 5 restantes nunca deveriam ter sido tentados)
            expect(global.fetch).toHaveBeenCalledTimes(3);
        });

        test('lança AppError se o init do upload de vídeo for recusado pela API', async () => {
            mockArquivoDeTamanho(1024);
            global.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'token inválido' } }) });
            const post = { media: [VIDEO] };

            await expect(tiktokAdapter.publicarContainer(post, TOKEN, ACCOUNT_ID)).rejects.toThrow(AppError);
        });
    });
});
