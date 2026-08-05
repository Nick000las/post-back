// Mesmos valores pedidos ao modelo no prompt de extração (aiLabService.js) — usado pra validar a
// resposta da IA antes de devolver pro frontend, já que o modelo pode divergir do que foi pedido.
// Sem CARROSSEL de propósito: single vs. carrossel é decidido pelo backend a partir da quantidade
// de arquivos que o usuário efetivamente arrastar (fato), não por um palpite da IA em cima de texto
// de PDF (que raramente especifica isso) — FEED cobre os dois casos até esse post virar publicável.
const FORMATOS_VALIDOS = ['FEED', 'STORY', 'REELS'];

module.exports = { FORMATOS_VALIDOS };
