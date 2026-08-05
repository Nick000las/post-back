const { PDFParse } = require('pdf-parse');

// Mesmo espírito de thumbnailService.js: serviço fino de conversão de arquivo, sem estado.
// Ponto de entrada único usado por aiLabService pra extrair o texto do PDF antes de mandar pra IA.
class PdfService {
    static async extrairTexto (buffer) {
        const parser = new PDFParse({ data: buffer });
        try {
            const { text } = await parser.getText();
            return text;
        } finally {
            await parser.destroy();
        }
    }
}

module.exports = PdfService;
