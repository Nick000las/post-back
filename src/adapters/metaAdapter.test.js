const metaAdapter = require('./metaAdapter.js');
const AppError = require('../errors/AppError.js');

const TOKEN = 'token-fake';
const IG_ID = 'ig-123';
const PAGE_ID = 'page-123';

const imagem = (nome) => ({ file_path: `${nome}.jpg`, file_name: `${nome}.jpg`, file_type: 'image/jpeg' });
const video = (nome) => ({ file_path: `${nome}.mp4`, file_name: `${nome}.mp4`, file_type: 'video/mp4' });

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

// Extrai os bodies das chamadas POST feitas à Graph API, já parseados.
const bodiesEnviados = () => global.fetch.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => ({ url, body: JSON.parse(init.body) }));

describe('MetaAdapter — carrossel', () => {
    beforeEach(() => {
        process.env.BASE_URL = 'https://exemplo.test';
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete global.fetch;
    });

    describe('guard-rails', () => {
        test('Instagram e Facebook rejeitam post sem mídia', async () => {
            await expect(metaAdapter.publicarNoInstagram({ media: [] }, TOKEN, IG_ID)).rejects.toThrow(AppError);
            await expect(metaAdapter.publicarNoFacebook({ media: [] }, TOKEN, PAGE_ID)).rejects.toThrow(AppError);
            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('Instagram recusa carrossel acima do limite da API', async () => {
            const post = { caption: 'c', media: Array.from({ length: 11 }, (_, i) => imagem(`f${i}`)) };

            await expect(metaAdapter.publicarNoInstagram(post, TOKEN, IG_ID))
                .rejects.toThrow('Carrossel do Instagram aceita no máximo 10 itens.');
            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('Facebook recusa vídeo em carrossel antes de subir qualquer arquivo', async () => {
            const post = { caption: 'c', media: [imagem('a'), video('b')] };

            await expect(metaAdapter.publicarNoFacebook(post, TOKEN, PAGE_ID))
                .rejects.toThrow('Carrossel do Facebook não suporta vídeos nessa integração.');
            expect(global.fetch).not.toHaveBeenCalled();
        });
    });

    describe('Instagram', () => {
        // Cada filho responde com um id previsível; o pai é a última criação de container.
        const mockFluxoCarrossel = ({ atrasoPorItem = [] } = {}) => {
            let containerCriados = 0;
            global.fetch.mockImplementation(async (url, init) => {
                if (init?.method === 'POST' && url.endsWith('/media')) {
                    const body = JSON.parse(init.body);
                    if (body.media_type === 'CAROUSEL') return ok({ id: 'pai' });

                    const indice = containerCriados++;
                    // Simula respostas fora de ordem (o 1º item demora mais que o 2º).
                    if (atrasoPorItem[indice]) await new Promise(r => setTimeout(r, atrasoPorItem[indice]));
                    return ok({ id: `filho-${indice}` });
                }
                if (init?.method === 'POST' && url.endsWith('/media_publish')) return ok({ id: 'post-final' });
                return ok({ status_code: 'FINISHED' }); // polling do #aguardarContainerPronto
            });
        };

        test('cria um container por item, um container pai CAROUSEL e publica', async () => {
            mockFluxoCarrossel();
            const post = { caption: 'legenda', media: [imagem('a'), imagem('b')] };

            const resultado = await metaAdapter.publicarNoInstagram(post, TOKEN, IG_ID);

            const posts = bodiesEnviados();
            const filhos = posts.filter(p => p.body.image_url);
            const pai = posts.find(p => p.body.media_type === 'CAROUSEL');

            expect(filhos).toHaveLength(2);
            expect(pai.body.children).toEqual(['filho-0', 'filho-1']);
            expect(resultado).toEqual({ success: true, externalId: 'post-final' });
        });

        test('marca cada filho com is_carousel_item e não manda caption neles', async () => {
            mockFluxoCarrossel();
            const post = { caption: 'legenda', media: [imagem('a'), imagem('b')] };

            await metaAdapter.publicarNoInstagram(post, TOKEN, IG_ID);

            const filhos = bodiesEnviados().filter(p => p.body.image_url);
            filhos.forEach(filho => {
                expect(filho.body.is_carousel_item).toBe(true);
                expect(filho.body).not.toHaveProperty('caption');
            });
            // A legenda pertence só ao container pai.
            expect(bodiesEnviados().find(p => p.body.media_type === 'CAROUSEL').body.caption).toBe('legenda');
        });

        test('mantém a ordem dos itens mesmo quando as respostas voltam fora de ordem', async () => {
            // O 1º item demora 30ms e o 2º responde na hora: se a ordem viesse da conclusão das
            // chamadas (push dentro do map), children sairia invertido.
            mockFluxoCarrossel({ atrasoPorItem: [30, 0] });
            const post = { caption: 'c', media: [imagem('primeiro'), imagem('segundo')] };

            await metaAdapter.publicarNoInstagram(post, TOKEN, IG_ID);

            const pai = bodiesEnviados().find(p => p.body.media_type === 'CAROUSEL');
            expect(pai.body.children).toEqual(['filho-0', 'filho-1']);
        });

        test('vídeo dentro de carrossel usa media_type VIDEO, não REELS', async () => {
            mockFluxoCarrossel();
            const post = { caption: 'c', media: [video('a'), imagem('b')] };

            await metaAdapter.publicarNoInstagram(post, TOKEN, IG_ID);

            const filhoVideo = bodiesEnviados().find(p => p.body.video_url);
            expect(filhoVideo.body.media_type).toBe('VIDEO');
            expect(filhoVideo.body).not.toHaveProperty('share_to_feed');
        });
    });

    describe('Facebook', () => {
        test('sobe cada foto sem publicar e anexa todas num único post do feed', async () => {
            let fotos = 0;
            global.fetch.mockImplementation(async (url) => {
                if (url.endsWith('/photos')) return ok({ id: `foto-${fotos++}` });
                return ok({ id: 'post-carrossel' });
            });
            const post = { caption: 'legenda', media: [imagem('a'), imagem('b')] };

            const resultado = await metaAdapter.publicarNoFacebook(post, TOKEN, PAGE_ID);

            const uploads = bodiesEnviados().filter(p => p.url.endsWith('/photos'));
            expect(uploads).toHaveLength(2);
            // published: false é o que impede cada foto de virar um post separado na página.
            uploads.forEach(upload => expect(upload.body.published).toBe(false));

            const feed = bodiesEnviados().find(p => p.url.endsWith('/feed'));
            expect(feed.body.attached_media).toEqual([{ media_fbid: 'foto-0' }, { media_fbid: 'foto-1' }]);
            expect(feed.body.message).toBe('legenda');
            expect(resultado).toEqual({ success: true, externalId: 'post-carrossel' });
        });
    });
});
