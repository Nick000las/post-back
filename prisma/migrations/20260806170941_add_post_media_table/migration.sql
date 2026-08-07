-- Move a mídia de posts (colunas escalares file_path/file_name/file_type/thumbnail_path) para uma
-- tabela filha própria, post_media, com ordem — pra suportar carrossel (N mídias por post).
-- Todo post passa a guardar mídia aqui, inclusive o de arquivo único ("carrossel de 1 item").
--
-- ORDEM IMPORTA: o backfill precisa rodar ANTES do DROP COLUMN, senão os dados existentes somem.
-- Escrita à mão por isso (prisma migrate dev geraria só CREATE + DROP, sem o INSERT no meio).

-- CreateTable
CREATE TABLE "post_media" (
    "id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "file_path" VARCHAR(255) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_type" VARCHAR(100) NOT NULL,
    "thumbnail_path" VARCHAR(255),
    "order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "post_media_post_id_order_idx" ON "post_media"("post_id", "order");

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "fk_media_post" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Backfill: cada post que tem mídia hoje vira exatamente 1 linha em post_media (order = 0).
-- Posts sem file_path (drafts sem mídia, importados do Lab de IA) simplesmente não geram linha —
-- 0 linhas em post_media é um estado válido. file_name/file_type usam COALESCE porque eram
-- nullable em posts mas são NOT NULL aqui (na prática sempre vieram juntos com file_path).
INSERT INTO "post_media" ("post_id", "file_path", "file_name", "file_type", "thumbnail_path", "order")
SELECT "id", "file_path", COALESCE("file_name", "file_path"), COALESCE("file_type", 'application/octet-stream'), "thumbnail_path", 0
FROM "posts"
WHERE "file_path" IS NOT NULL;

-- AlterTable
ALTER TABLE "posts" DROP COLUMN "file_path",
DROP COLUMN "file_name",
DROP COLUMN "file_type",
DROP COLUMN "thumbnail_path";
