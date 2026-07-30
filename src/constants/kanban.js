const FIXED_COLUMN_KEYS = { IDEIAS: 'IDEIAS', AGENDADO: 'AGENDADO', FINALIZADO: 'FINALIZADO' };

const FIXED_COLUMNS_SEED = [
    { name: 'Ideias', fixed_key: FIXED_COLUMN_KEYS.IDEIAS, order: 1000 },
    { name: 'Agendado', fixed_key: FIXED_COLUMN_KEYS.AGENDADO, order: 2000 },
    { name: 'Finalizado', fixed_key: FIXED_COLUMN_KEYS.FINALIZADO, order: 3000 }
];

// Fonte única pras 3 colunas fixas: usado por prismaAdapter.criarClient (seed inicial na criação do
// client), kanbanService (validação de is_fixed/fixed_key) e pelo backfill da migration
// 20260729174226_add_columns_and_post_column_id (esse já rodou, então não precisa mudar retroativamente
// se estas constantes mudarem no futuro — só afeta clients criados a partir de agora).

module.exports = { FIXED_COLUMN_KEYS, FIXED_COLUMNS_SEED };
