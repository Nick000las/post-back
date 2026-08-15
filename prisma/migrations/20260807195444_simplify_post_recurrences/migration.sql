/*
  Warnings:

  - You are about to drop the column `end_date` on the `post_recurrences` table. All the data in the column will be lost.
  - You are about to drop the column `weekdays` on the `post_recurrences` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "post_recurrences" DROP COLUMN "end_date",
DROP COLUMN "weekdays";
