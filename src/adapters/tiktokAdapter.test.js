const tiktokAdapter = require('./tiktokAdapter.js');
const AppError = require('../errors/AppError.js');

const TOKEN = 'token-fake';
const ACCOUNT_ID = 'tiktok-123';
const VIDEO = { file_path: 'v.mp4', file_name: 'v.mp4', file_type: 'video/mp4' };

// Só os guard-rails: eles lançam antes de qualquer acesso a disco ou rede, então não precisam de
// mock nenhum. O caminho feliz (upload real) depende da API do TikTok e não é coberto aqui.
describe('TiktokAdapter.publicarContainer', () => {
    test('lança AppError se o id da conta estiver ausente', async () => {
        await expect(tiktokAdapter.publicarContainer({ media: [VIDEO] }, TOKEN, null)).rejects.toThrow(AppError);
    });

    test('rejeita carrossel em vez de publicar só o primeiro item em silêncio', async () => {
        const post = { media: [VIDEO, { ...VIDEO, file_path: 'v2.mp4' }] };

        await expect(tiktokAdapter.publicarContainer(post, TOKEN, ACCOUNT_ID))
            .rejects.toThrow('O TikTok não suporta carrossel nessa integração.');
    });

    test('rejeita post sem mídia', async () => {
        await expect(tiktokAdapter.publicarContainer({ media: [] }, TOKEN, ACCOUNT_ID)).rejects.toThrow(AppError);
    });

    test('rejeita mídia que não seja vídeo', async () => {
        const post = { media: [{ file_path: 'a.jpg', file_name: 'a.jpg', file_type: 'image/jpeg' }] };

        await expect(tiktokAdapter.publicarContainer(post, TOKEN, ACCOUNT_ID)).rejects.toThrow(AppError);
    });
});
