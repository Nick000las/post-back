const linkedinAdapter = require('./linkedinAdapter.js');
const AppError = require('../errors/AppError.js');

const TOKEN = 'token-fake';
const AUTHOR_URN = 'urn:li:person:abc';
const IMAGEM = { file_path: 'a.jpg', file_name: 'a.jpg', file_type: 'image/jpeg' };

// Só os guard-rails: eles lançam antes de qualquer acesso a disco ou rede, então não precisam de
// mock nenhum. O caminho feliz (upload real) depende da API do Linkedin e não é coberto aqui.
describe('LinkedinAdapter.publicarContainer', () => {
    test('lança AppError se o URN for inválido ou ausente', async () => {
        const post = { media: [IMAGEM] };

        await expect(linkedinAdapter.publicarContainer(post, TOKEN, null)).rejects.toThrow(AppError);
        await expect(linkedinAdapter.publicarContainer(post, TOKEN, 'nao-eh-urn')).rejects.toThrow(AppError);
    });

    test('rejeita carrossel em vez de publicar só o primeiro item em silêncio', async () => {
        const post = { media: [IMAGEM, { ...IMAGEM, file_path: 'b.jpg' }] };

        await expect(linkedinAdapter.publicarContainer(post, TOKEN, AUTHOR_URN))
            .rejects.toThrow('O Linkedin não suporta carrossel nessa integração.');
    });
});
