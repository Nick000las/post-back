-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "column_id" INTEGER;

-- CreateTable
CREATE TABLE "columns" (
    "id" SERIAL NOT NULL,
    "client_id" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "order" INTEGER NOT NULL,
    "is_fixed" BOOLEAN NOT NULL DEFAULT false,
    "fixed_key" VARCHAR(20),
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "columns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "columns_client_id_order_idx" ON "columns"("client_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "uq_column_client_fixed_key" ON "columns"("client_id", "fixed_key");

-- CreateIndex
CREATE INDEX "posts_client_id_column_id_idx" ON "posts"("client_id", "column_id");

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "fk_post_column" FOREIGN KEY ("column_id") REFERENCES "columns"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "columns" ADD CONSTRAINT "fk_column_client" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Backfill: cria as 3 colunas fixas pra clients existentes e aponta posts.column_id pra "Ideias" de cada client.
-- Mantém os mesmos valores de FIXED_COLUMNS_SEED (src/constants/columns.js) — se aquele arquivo mudar
-- nome/order/fixed_key no futuro, este backfill histórico não precisa ser alterado (já rodou uma vez).
INSERT INTO "columns" ("client_id", "name", "order", "is_fixed", "fixed_key")
SELECT "id", 'Ideias', 1000, true, 'IDEIAS' FROM "clients"
UNION ALL
SELECT "id", 'Agendado', 2000, true, 'AGENDADO' FROM "clients"
UNION ALL
SELECT "id", 'Finalizado', 3000, true, 'FINALIZADO' FROM "clients";

UPDATE "posts" p
SET "column_id" = c."id"
FROM "columns" c
WHERE p."client_id" = c."client_id"
  AND c."fixed_key" = 'IDEIAS'
  AND p."column_id" IS NULL;
