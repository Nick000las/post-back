const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const FORMATO_CRIPTOGRAFADO = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;

function carregarChave() {
    const chaveHex = process.env.ACCOUNTS_ENCRYPTION_KEY;
    if (!chaveHex || chaveHex.length !== 64) {
        throw new Error('ACCOUNTS_ENCRYPTION_KEY ausente ou inválida: defina uma chave hex de 64 caracteres (32 bytes). Gere uma com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    }
    return Buffer.from(chaveHex, 'hex');
}

const CHAVE = carregarChave();

function encrypt(texto) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, CHAVE, iv);
    const cifrado = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${cifrado.toString('hex')}`;
}

function decrypt(payload) {
    const [ivHex, authTagHex, cifradoHex] = payload.split(':');
    const decipher = crypto.createDecipheriv(ALGORITHM, CHAVE, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decifrado = Buffer.concat([decipher.update(Buffer.from(cifradoHex, 'hex')), decipher.final()]);
    return decifrado.toString('utf8');
}

function isEncrypted(valor) {
    return typeof valor === 'string' && FORMATO_CRIPTOGRAFADO.test(valor);
}

module.exports = { encrypt, decrypt, isEncrypted };
