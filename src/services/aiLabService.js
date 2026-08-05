const prismaAdapter = require('../adapters/prismaAdapter.js');
const groqAdapter = require('../adapters/groqAdapter.js');
const pdfService = require('./pdfService.js');
const kanbanService = require('./kanbanService.js');
const AppError = require('../errors/AppError.js');
const { FORMATOS_VALIDOS } = require('../constants/aiLab.js');

const FORMATO_DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

class AiLabService {

    // Confere que o client pertence ao usuário autenticado — idêntico ao #validarCliente de
    // postService/kanbanService.
    static async #validarCliente (clientId, userId) {
        const cliente = await prismaAdapter.buscarClientePorId(clientId, userId);
        if (!cliente) throw new AppError('Cliente não encontrado');
        return cliente;
    }

    // Só aceita "YYYY-MM-DD" (o formato pedido no prompt) e confere que a data é real. new Date()
    // sozinho não basta aqui: "2026-02-30" não vira Invalid Date, o JS "rola" silenciosamente pra
    // 1º de março — por isso o round-trip via toISOString (sempre em UTC, evitando o post-dating de
    // fuso horário local) precisa bater exatamente com o valor original.
    static #validarDataSugerida (valor) {
        if (typeof valor !== 'string' || !FORMATO_DATA_ISO.test(valor)) return null;

        const data = new Date(`${valor}T00:00:00Z`);
        if (Number.isNaN(data.getTime())) return null;

        return data.toISOString().slice(0, 10) === valor ? valor : null;
    }

    // Normaliza um item bruto vindo da IA pro shape esperado — o modelo pode devolver tipos
    // errados, formato fora do enum pedido, ou datas fora do padrão ISO. Retorna null (item
    // descartado) quando não sobra nem legenda, já que um card sem nenhum texto não serve pra nada
    // na tela de revisão.
    static #normalizarPostExtraido (postBruto) {
        if (!postBruto || typeof postBruto !== 'object') return null;

        const caption = typeof postBruto.caption === 'string' && postBruto.caption.trim()
            ? postBruto.caption.trim()
            : null;
        if (!caption) return null;

        const formatoNormalizado = typeof postBruto.format === 'string' ? postBruto.format.trim().toUpperCase() : null;
        const format = FORMATOS_VALIDOS.includes(formatoNormalizado) ? formatoNormalizado : null;

        return { caption, format, suggestedDate: this.#validarDataSugerida(postBruto.suggestedDate) };
    }

    // Faz o parsing "burro" (JSON.parse) só aqui, isolado, pra poder transformar tanto um JSON
    // inválido quanto um shape inesperado (sem array "posts") num erro claro pro usuário — em vez
    // de deixar a exceção nativa (SyntaxError, TypeError) vazar como erro 500 genérico. Itens
    // individuais malformados não derrubam a extração inteira: são descartados e logados.
    static #parseRespostaDaIA (respostaBruta) {
        let parsed;
        try {
            parsed = JSON.parse(respostaBruta);
        } catch (erro) {
            console.error('Resposta da IA não é um JSON válido', { erro: erro.message, respostaBruta });
            throw new AppError('A IA retornou uma resposta em formato inesperado. Tente novamente.');
        }

        if (!Array.isArray(parsed?.posts)) {
            console.error('Resposta da IA sem o array "posts" esperado', { parsed });
            throw new AppError('A IA retornou uma resposta em formato inesperado. Tente novamente.');
        }

        const posts = parsed.posts.map(post => this.#normalizarPostExtraido(post)).filter(post => post !== null);
        if (posts.length < parsed.posts.length) {
            console.warn('Alguns posts extraídos pela IA foram descartados por não terem legenda', {
                total: parsed.posts.length,
                validos: posts.length
            });
        }

        return posts;
    }

    // Extração: NÃO persiste nada — é só preview pra tela de revisão (scroll vertical) do
    // frontend. A importação de fato só acontece em importarPostsExtraidos, depois do usuário
    // revisar/editar a lista.
    static async extrairPostsDoPdf (arquivo, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        const texto = await pdfService.extrairTexto(arquivo.buffer);

        const prompt = `Você é um especialista em estruturação de dados. Sua tarefa é analisar o texto bruto extraído de um cronograma de redes sociais em PDF (que pode conter ruídos de tabelas, instruções burocráticas da agência e múltiplos blocos) e extrair os dados das postagens, retornando EXCLUSIVAMENTE um JSON válido.

            REGRAS DE EXTRAÇÃO:
            1. FOCO NO CONTEÚDO: Ignore parágrafos introdutórios, regras de aprovação de clientes, cabeçalhos genéricos e rodapés. Busque os blocos repetitivos que indicam uma postagem (geralmente compostos por Data, Formato e o Texto em si).
            2. TRATAMENTO DA DATA ("suggestedDate"): O texto pode ter datas curtas (ex: "03/08"). Identifique o mês principal do cronograma no topo do documento. Como estamos em ${new Date().getFullYear()}, assuma o ano atual caso não esteja explícito. Formate a data final ESTRITAMENTE no padrão ISO "YYYY-MM-DD" (ex: "${new Date().getFullYear()}-08-03"). Se não encontrar um dia exato, retorne null neste campo.
            3. TRATAMENTO DO FORMATO ("format"): Identifique onde diz se é Feed, Story, Reels, Carrossel, Vídeo, etc. Padronize a saída APENAS para os valores: "FEED", "STORY" ou "REELS" (tudo em maiúsculo) — NÃO existe "CARROSSEL" como valor válido: tanto uma imagem única quanto um carrossel de imagens contam como "FEED" (a distinção entre os dois é decidida depois, pela quantidade de arquivos anexados, não por você). Vídeo vertical curto = "REELS"; vídeo comum de feed = "FEED". Se não for possível identificar, assuma "FEED".
            4. TRATAMENTO DA LEGENDA ("caption"): Extraia o texto completo do post, incluindo emojis e as hashtags finais. Preserve as quebras de linha estruturais usando "\\n". NÃO inclua os metadados de formato ou data dentro do texto da legenda.

            FORMATO DE SAÍDA:
            Retorne ABSOLUTAMENTE APENAS um objeto JSON com uma chave "posts" contendo o array de postagens. Não inclua blocos de código markdown (como \`\`\`json), não inclua saudações, não explique seu raciocínio. O texto retornado deve ser injetado diretamente em um JSON.parse().

            Exemplo da estrutura esperada:
            {
              "posts": [
                {
                    "caption": "Seu carro pode valer mais do que você imagina.\\n\\nVenha para a loja.\\n#seminovos",
                    "format": "FEED",
                    "suggestedDate": "2026-08-03"
                }
              ]
            }

            TEXTO DO PDF A SER ANALISADO:
            ${texto}`;

        const respostaBruta = await groqAdapter.chatCompletion(prompt);

        return this.#parseRespostaDaIA(respostaBruta);
    }

    // Importação: recebe a lista já revisada/editada pelo usuário no frontend e persiste em lote
    // como cards DRAFT vazios (sem mídia, sem contas) na coluna Ideias do client.
    static async importarPostsExtraidos (posts, clientId, userId) {
        await this.#validarCliente(clientId, userId);

        if (!Array.isArray(posts) || posts.length === 0) {
            throw new AppError('Nenhum post para importar');
        }

        const columnId = await kanbanService.resolverColunaIdeias(clientId);
        const criados = await prismaAdapter.criarPostsEmLotePorIA(clientId, columnId, posts);

        return { message: `${criados.length} posts importados com sucesso`, criados };
    }
}

module.exports = AiLabService;
