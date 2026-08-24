const fs = require('fs');

jest.mock('fs', () => ({
    readFileSync: jest.fn().mockReturnValue(Buffer.from('conteudo-fake')),
    // Usado só pelo guard de tamanho de vídeo; o padrão é um arquivo pequeno, e os testes que
    // exercitam o limite sobrescrevem o retorno.
    statSync: jest.fn().mockReturnValue({ size: 1024 })
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
        // Redefinido a cada teste: restoreAllMocks não desfaz mockReturnValue de mock de módulo,
        // então sem isto o tamanho grande de um teste vazaria pros seguintes.
        fs.statSync.mockReturnValue({ size: 1024 });
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

    // Caminho de post.media.length === 0 — sem cobertura nenhuma antes disto.
    describe('texto sem mídia', () => {
        test('publica post de texto puro (shareMediaCategory NONE, sem campo media)', async () => {
            global.fetch.mockImplementation(async (url) => {
                if (url === 'https://api.linkedin.com/v2/ugcPosts') return ok({ id: 'post-texto' });
                throw new Error(`chamada inesperada nesse teste: ${url}`);
            });
            const post = { caption: 'só texto', media: [] };

            const resultado = await linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN);

            const [url, init] = global.fetch.mock.calls[0];
            const shareContent = JSON.parse(init.body).specificContent['com.linkedin.ugc.ShareContent'];
            expect(url).toBe('https://api.linkedin.com/v2/ugcPosts');
            expect(shareContent.shareMediaCategory).toBe('NONE');
            expect(shareContent).not.toHaveProperty('media');
            expect(resultado).toEqual({ success: true, externalId: 'post-texto' });
        });

        test('lança AppError se a API recusar o post de texto', async () => {
            global.fetch.mockResolvedValue({ ok: false, status: 400, text: async () => 'erro texto' });
            const post = { caption: 'x', media: [] };

            await expect(linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN)).rejects.toThrow(AppError);
        });
    });

    // Caminho de post.media.length === 1 (#publicarComMedia) — sem cobertura nenhuma antes disto,
    // apesar de ser o uso mais comum da integração (1 imagem OU 1 vídeo, não carrossel).
    describe('mídia única', () => {
        const VIDEO_UNICO = { file_path: 'v.mp4', file_name: 'v.mp4', file_type: 'video/mp4' };

        // Vídeo único faz uma chamada a mais que imagem: GET de status do asset (#aguardarAssetPronto)
        // antes do POST em ugcPosts — respondida aqui já como 'AVAILABLE' pra não esperar o polling
        // de verdade (o mesmo padrão que metaAdapter.test.js usa pro polling de container do Instagram).
        const mockFluxoMidiaUnica = () => {
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('registerUpload')) {
                    return ok({
                        value: {
                            uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: 'https://upload.test/asset' } },
                            asset: 'urn:li:digitalmediaAsset:asset-unico'
                        }
                    });
                }
                if (url === 'https://upload.test/asset') return { ok: true, status: 201 };
                if (url === 'https://api.linkedin.com/v2/assets/asset-unico') return ok({ recipes: [{ status: 'AVAILABLE' }] });
                return ok({ id: 'post-midia-unica' });
            });
        };

        test('imagem única: registra recipe de imagem e publica com shareMediaCategory IMAGE', async () => {
            mockFluxoMidiaUnica();
            const post = { caption: 'legenda', media: [imagem('foto')] };

            const resultado = await linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN);

            const chamadaRegistro = global.fetch.mock.calls.find(([url]) => url.includes('registerUpload'));
            expect(JSON.parse(chamadaRegistro[1].body).registerUploadRequest.recipes)
                .toEqual(['urn:li:digitalmediaRecipe:feedshare-image']);

            const chamadaUgc = global.fetch.mock.calls.find(([url]) => url === 'https://api.linkedin.com/v2/ugcPosts');
            const shareContent = JSON.parse(chamadaUgc[1].body).specificContent['com.linkedin.ugc.ShareContent'];
            expect(shareContent.shareMediaCategory).toBe('IMAGE');
            expect(shareContent.media).toEqual([
                { status: 'READY', description: { text: 'foto.jpg' }, media: 'urn:li:digitalmediaAsset:asset-unico', title: { text: 'foto.jpg' } }
            ]);
            expect(resultado).toEqual({ success: true, externalId: 'post-midia-unica' });
        });

        test('vídeo único: registra recipe de vídeo e publica com shareMediaCategory VIDEO', async () => {
            mockFluxoMidiaUnica();
            const post = { caption: 'legenda', media: [VIDEO_UNICO] };

            const resultado = await linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN);

            const chamadaRegistro = global.fetch.mock.calls.find(([url]) => url.includes('registerUpload'));
            expect(JSON.parse(chamadaRegistro[1].body).registerUploadRequest.recipes)
                .toEqual(['urn:li:digitalmediaRecipe:feedshare-video']);

            const chamadaUgc = global.fetch.mock.calls.find(([url]) => url === 'https://api.linkedin.com/v2/ugcPosts');
            expect(JSON.parse(chamadaUgc[1].body).specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory).toBe('VIDEO');
            expect(resultado).toEqual({ success: true, externalId: 'post-midia-unica' });
        });

        test('lança AppError se o registro do asset falhar', async () => {
            global.fetch.mockResolvedValue({ ok: false, status: 400, text: async () => 'erro registro' });
            const post = { media: [imagem('a')] };

            await expect(linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN)).rejects.toThrow(AppError);
        });

        // O asset devolve o `resultadoStatus` na consulta de status; tudo antes disso é caminho feliz.
        const mockFluxoComStatus = (resultadoStatus) => {
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('registerUpload')) {
                    return ok({
                        value: {
                            uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: 'https://upload.test/asset' } },
                            asset: 'urn:li:digitalmediaAsset:asset-falho'
                        }
                    });
                }
                if (url === 'https://upload.test/asset') return { ok: true, status: 201 };
                if (url === 'https://api.linkedin.com/v2/assets/asset-falho') return ok(resultadoStatus);
                return ok({ id: 'post-que-nao-deveria-existir' });
            });
        };

        const naoPublicou = () => !global.fetch.mock.calls.some(([url]) => url === 'https://api.linkedin.com/v2/ugcPosts');

        // Os status de falha REAIS da Assets API. Não existe status 'ERROR' — era esse o valor que
        // o adapter (e o teste antigo) esperavam, o que deixava CLIENT_ERROR/SERVER_ERROR passarem
        // como se o vídeo estivesse pronto e publicava um post apontando pra um asset quebrado.
        test.each(['CLIENT_ERROR', 'SERVER_ERROR', 'INCOMPLETE'])(
            'vídeo: lança AppError e nunca cria o post se o asset falhar no processamento (status %s)',
            async (status) => {
                mockFluxoComStatus({ recipes: [{ status }], status: 'ALLOWED' });
                const post = { media: [VIDEO_UNICO] };

                await expect(linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN))
                    .rejects.toThrow('O Linkedin falhou ao processar o vídeo enviado.');
                expect(naoPublicou()).toBe(true);
            }
        );

        // O recipe pode estar pronto e ainda assim o asset não poder ser servido.
        test('vídeo: lança AppError se o asset estiver BLOCKED mesmo com o recipe AVAILABLE', async () => {
            mockFluxoComStatus({ recipes: [{ status: 'AVAILABLE' }], status: 'BLOCKED' });
            const post = { media: [VIDEO_UNICO] };

            await expect(linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN))
                .rejects.toThrow('O Linkedin bloqueou o vídeo enviado.');
            expect(naoPublicou()).toBe(true);
        });

        // WAITING_UPLOAD não é sucesso: é o estado de quem ainda não terminou de subir. A regra antiga
        // ("qualquer coisa que não seja PROCESSING está pronto") publicaria já na primeira consulta.
        test('vídeo: continua aguardando em WAITING_UPLOAD e só publica quando vira AVAILABLE', async () => {
            jest.useFakeTimers();
            let consultas = 0;
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('registerUpload')) {
                    return ok({
                        value: {
                            uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: 'https://upload.test/asset' } },
                            asset: 'urn:li:digitalmediaAsset:asset-lento'
                        }
                    });
                }
                if (url === 'https://upload.test/asset') return { ok: true, status: 201 };
                if (url === 'https://api.linkedin.com/v2/assets/asset-lento') {
                    const status = consultas++ === 0 ? 'WAITING_UPLOAD' : 'AVAILABLE';
                    return ok({ recipes: [{ status }], status: 'ALLOWED' });
                }
                return ok({ id: 'post-apos-espera' });
            });

            const promessa = linkedinAdapter.publicarContainer({ caption: 'x', media: [VIDEO_UNICO] }, TOKEN, AUTHOR_URN);

            // Drena as microtasks sem mexer no relógio: chega até a 1ª consulta de status e para no
            // setTimeout do polling. Conferir `consultas` aqui é o que garante que a asserção
            // seguinte é sobre o estado "já consultou e decidiu esperar", não sobre "ainda nem começou".
            await jest.advanceTimersByTimeAsync(0);
            expect(consultas).toBe(1);
            expect(naoPublicou()).toBe(true);

            await jest.advanceTimersByTimeAsync(5000);
            await expect(promessa).resolves.toEqual({ success: true, externalId: 'post-apos-espera' });
            expect(consultas).toBe(2);

            jest.useRealTimers();
        });

        // O multer aceita até 300MB (uploadConfig.js) e não há validação de tamanho no caminho até o
        // adapter, então a faixa acima do limite do Linkedin chega aqui de verdade.
        describe('limite de 200MB por upload único', () => {
            const MB = 1024 * 1024;

            test('vídeo acima de 200MB: lança AppError sem registrar asset (nenhuma chamada de rede)', async () => {
                fs.statSync.mockReturnValue({ size: 201 * MB });
                const post = { media: [VIDEO_UNICO] };

                await expect(linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN))
                    .rejects.toThrow('O Linkedin não aceita vídeo acima de 200MB. Envie um arquivo menor.');
                // Registrar antes de validar deixaria um asset órfão no Linkedin a cada tentativa.
                expect(global.fetch).not.toHaveBeenCalled();
            });

            test('vídeo dentro do limite: publica normalmente', async () => {
                fs.statSync.mockReturnValue({ size: 199 * MB });
                mockFluxoMidiaUnica();

                const resultado = await linkedinAdapter.publicarContainer({ caption: 'x', media: [VIDEO_UNICO] }, TOKEN, AUTHOR_URN);

                expect(resultado).toEqual({ success: true, externalId: 'post-midia-unica' });
            });

            test('imagem grande não é barrada: o limite é do fluxo de vídeo', async () => {
                fs.statSync.mockReturnValue({ size: 250 * MB });
                mockFluxoMidiaUnica();

                const resultado = await linkedinAdapter.publicarContainer({ caption: 'x', media: [imagem('foto')] }, TOKEN, AUTHOR_URN);

                expect(resultado).toEqual({ success: true, externalId: 'post-midia-unica' });
            });
        });

        test('imagem: não faz polling de status (só vídeo precisa esperar)', async () => {
            mockFluxoMidiaUnica();
            const post = { media: [imagem('foto')] };

            await linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN);

            expect(global.fetch.mock.calls.some(([url]) => url.startsWith('https://api.linkedin.com/v2/assets/'))).toBe(false);
        });

        test('lança AppError se o upload binário do arquivo falhar', async () => {
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('registerUpload')) {
                    return ok({
                        value: {
                            uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: 'https://upload.test/asset' } },
                            asset: 'urn:li:digitalmediaAsset:asset-x'
                        }
                    });
                }
                return { ok: false, status: 500 };
            });
            const post = { media: [imagem('a')] };

            await expect(linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN)).rejects.toThrow(AppError);
        });

        test('lança AppError se a API recusar o post com mídia (asset já registrado e enviado)', async () => {
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('registerUpload')) {
                    return ok({
                        value: {
                            uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: 'https://upload.test/asset' } },
                            asset: 'urn:li:digitalmediaAsset:asset-x'
                        }
                    });
                }
                if (url === 'https://upload.test/asset') return { ok: true, status: 201 };
                return { ok: false, status: 400, text: async () => 'erro ugc' };
            });
            const post = { media: [imagem('a')] };

            await expect(linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN)).rejects.toThrow(AppError);
        });
    });
});
