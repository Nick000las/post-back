-- CreateTable
CREATE TABLE "clients" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "platform" VARCHAR(50) NOT NULL,
    "platform_account_id" VARCHAR(100),
    "access_token" TEXT NOT NULL,
    "client_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_accounts" (
    "post_id" INTEGER NOT NULL,
    "account_id" INTEGER NOT NULL,
    "delivery_status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "api_post_id" VARCHAR(100),
    "error_message" TEXT,
    "job_id" VARCHAR(255),
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "post_accounts_pkey" PRIMARY KEY ("post_id","account_id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" SERIAL NOT NULL,
    "caption" TEXT,
    "file_path" VARCHAR(255) NOT NULL,
    "file_name" VARCHAR(255),
    "file_type" VARCHAR(100),
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "scheduled_for" TIMESTAMPTZ(6),
    "client_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_platform_account_id_key" ON "accounts"("platform_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "fk_client_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "fk_account_client" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "post_accounts" ADD CONSTRAINT "fk_batch_account" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "post_accounts" ADD CONSTRAINT "fk_batch_post" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "fk_post_client" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
