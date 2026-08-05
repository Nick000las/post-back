-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "format" VARCHAR(20),
ADD COLUMN     "suggested_date" TIMESTAMPTZ(6);
