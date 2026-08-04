const FEED_STATUS_FILTERS = { TODOS: 'todos', FALHAS: 'falhas', PUBLICADOS: 'publicados' };

// Mapeia o filtro de UI do Feed Global pros status reais de posts.status. FALHAS inclui PARTIAL
// porque um post com pelo menos uma conta com erro também precisa aparecer pra troubleshooting/
// republicação — não só o que falhou por completo.
const FEED_STATUS_FILTER_MAP = {
    [FEED_STATUS_FILTERS.TODOS]: ['SCHEDULED', 'PROCESSING', 'PUBLISHED', 'PARTIAL', 'FAILED'],
    [FEED_STATUS_FILTERS.FALHAS]: ['FAILED', 'PARTIAL'],
    [FEED_STATUS_FILTERS.PUBLICADOS]: ['PUBLISHED']
};

const FEED_DATE_FILTERS = { HOJE: 'hoje', SETE_DIAS: '7dias', ESTE_MES: 'mes' };

// Mesmas strings usadas em accounts.platform / publishWorker.js — nenhuma outra constante disso
// existe hoje no projeto; centralizando aqui pra validar o query param `platform` do Feed do
// Cliente sem espalhar strings mágicas.
const PLATAFORMAS_VALIDAS = ['instagram', 'facebook', 'linkedin', 'tiktok'];

// Extensão futura (não implementada): filtro de formato (Feed/Story/Reels/Carrossel). Não existe
// coluna pra isso em posts hoje, e não há critério definido de origem do dado — fica de fora até
// esse produto ser decidido.

module.exports = { FEED_STATUS_FILTERS, FEED_STATUS_FILTER_MAP, FEED_DATE_FILTERS, PLATAFORMAS_VALIDAS };
