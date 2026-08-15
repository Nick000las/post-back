const AppError = require('../errors/AppError.js');
const fs = require('fs');

// Utilitários compartilhados pelos controllers que recebem multipart (postController,
// storyController). Extraído de postController quando o fluxo de Stories passou a precisar do
// mesmo parsing/limpeza — sem mudança de comportamento.

// As contas chegam como string JSON no corpo multipart (não dá pra mandar array estruturado junto
// de arquivo sem serializar).
function parseAccounts (rawAccounts) {
    let accounts;
    try {
        accounts = JSON.parse(rawAccounts);
    } catch {
        throw new AppError('Lista de contas inválida');
    }

    if (!Array.isArray(accounts) || accounts.length === 0) throw new AppError('Nenhuma conta selecionada');
    if (!accounts.every(account => Number.isInteger(account?.id))) throw new AppError('Cada conta deve ter um id numérico');

    return accounts;
}

// O multer já gravou os arquivos em disco antes do handler rodar — se a requisição falhar depois
// disso, eles viram lixo órfão em .uploads. Aceita undefined (rota sem arquivo é caso válido) e
// um único arquivo (req.file de .single) além do array de .array.
function limparArquivosEnviados (arquivos = []) {
    const lista = Array.isArray(arquivos) ? arquivos : [arquivos];
    lista.forEach(arquivo => {
        if (arquivo && fs.existsSync(arquivo.path)) fs.unlinkSync(arquivo.path);
    });
}

module.exports = { parseAccounts, limparArquivosEnviados };
