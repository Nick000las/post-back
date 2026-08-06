// ATENÇÃO ao descasamento proposital da primeira coluna: o `name` exibido é "Rascunhos", mas o
// `fixed_key` continua 'IDEIAS'. O fixed_key é um discriminador interno — está gravado em
// columns.fixed_key de todos os clients existentes, no índice uq_column_client_fixed_key e no
// backfill da migration 20260729174226. Renomeá-lo exigiria migration de dados acoplada ao deploy
// do código (se a migration rodasse antes, buscarColunaIdeias não acharia nada e TODA criação de
// post quebraria). O usuário nunca vê o fixed_key, então o custo de mantê-lo é só cosmético: os
// símbolos internos (FIXED_COLUMN_KEYS.IDEIAS, resolverColunaIdeias, buscarColunaIdeias) seguem
// dizendo "Ideias" enquanto a UI diz "Rascunhos". NÃO "conserte" isso sem migration.
const FIXED_COLUMN_KEYS = { IDEIAS: 'IDEIAS', AGENDADO: 'AGENDADO', FINALIZADO: 'FINALIZADO' };

const FIXED_COLUMNS_SEED = [
    { name: 'Rascunhos', fixed_key: FIXED_COLUMN_KEYS.IDEIAS, order: 1000 },
    { name: 'Agendado', fixed_key: FIXED_COLUMN_KEYS.AGENDADO, order: 2000 },
    { name: 'Finalizado', fixed_key: FIXED_COLUMN_KEYS.FINALIZADO, order: 3000 }
];

// A coluna Finalizado só mostra cards concluídos (PUBLISHED/PARTIAL/FAILED) nos últimos N dias, pra
// não acumular indefinidamente e poluir a aba Workflow — histórico completo continua disponível no
// Feed (GET /feed), que não tem esse corte. Ver prismaAdapter.buscarQuadro.
const DIAS_VISIVEIS_COLUNA_FINALIZADO = 15;

// Fonte única pras 3 colunas fixas: usado por prismaAdapter.criarClient (seed inicial na criação do
// client), kanbanService (validação de is_fixed/fixed_key) e pelo backfill da migration
// 20260729174226_add_columns_and_post_column_id (esse já rodou, então não precisa mudar retroativamente
// se estas constantes mudarem no futuro — só afeta clients criados a partir de agora).

module.exports = { FIXED_COLUMN_KEYS, FIXED_COLUMNS_SEED, DIAS_VISIVEIS_COLUNA_FINALIZADO };
