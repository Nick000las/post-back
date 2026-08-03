-- CreateTable
CREATE TABLE "card_comments" (
    "id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "text" TEXT,
    "attachment_path" VARCHAR(255),
    "attachment_original_name" VARCHAR(255),
    "attachment_mime_type" VARCHAR(100),
    "attachment_size" INTEGER,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "card_comments_post_id_created_at_idx" ON "card_comments"("post_id", "created_at");

-- AddForeignKey
ALTER TABLE "card_comments" ADD CONSTRAINT "fk_comment_post" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "card_comments" ADD CONSTRAINT "fk_comment_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
