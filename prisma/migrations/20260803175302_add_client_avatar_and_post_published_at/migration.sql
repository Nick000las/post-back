-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "avatar_path" VARCHAR(255);

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "published_at" TIMESTAMPTZ(6);
