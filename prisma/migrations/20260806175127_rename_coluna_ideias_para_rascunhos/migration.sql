-- Renomeia a primeira coluna fixa do Kanban de "Ideias" para "Rascunhos" nos clients já existentes.
-- A página isolada de rascunhos foi removida do frontend e essa coluna passou a ser a porta de
-- entrada do funil (ver FIXED_COLUMNS_SEED em src/constants/kanban.js, que cobre clients novos).
--
-- Migration de dados apenas: nenhuma mudança de schema. O fixed_key continua 'IDEIAS' de propósito
-- (é o discriminador interno usado por buscarColunaIdeias e pelo índice uq_column_client_fixed_key)
-- — só o nome exibido muda. Ver o comentário no topo de src/constants/kanban.js.
UPDATE "columns" SET "name" = 'Rascunhos' WHERE "fixed_key" = 'IDEIAS';
