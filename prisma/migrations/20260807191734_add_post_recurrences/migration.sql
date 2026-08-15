-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "recurrence_id" INTEGER;

-- CreateTable
CREATE TABLE "post_recurrences" (
    "id" SERIAL NOT NULL,
    "client_id" INTEGER NOT NULL,
    "weekdays" INTEGER[],
    "end_date" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_recurrences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "post_recurrences_client_id_idx" ON "post_recurrences"("client_id");

-- AddForeignKey
ALTER TABLE "post_recurrences" ADD CONSTRAINT "fk_recurrence_client" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "fk_post_recurrence" FOREIGN KEY ("recurrence_id") REFERENCES "post_recurrences"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
