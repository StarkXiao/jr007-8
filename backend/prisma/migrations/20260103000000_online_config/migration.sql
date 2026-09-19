-- 在线配置：分类、属性表单与业务阈值的版本化配置
-- 支持草稿（draft）、灰度（canary）、全量（active）三态与历史版本归档（archived）

-- CreateEnum
CREATE TYPE "AppConfigStatus" AS ENUM ('draft', 'canary', 'active', 'archived');

-- CreateTable
CREATE TABLE "app_config_versions" (
    "id" BIGSERIAL NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "AppConfigStatus" NOT NULL,
    "payload" JSONB NOT NULL,
    "rollout" JSONB,
    "comment" VARCHAR(200),
    "created_by" BIGINT,
    "published_by" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "app_config_versions_pkey" PRIMARY KEY ("id")
);

-- 同一时刻：至多一个 draft、一个 canary、一个 active（archived 不限）
CREATE UNIQUE INDEX "idx_app_config_version_no" ON "app_config_versions"("version");
CREATE UNIQUE INDEX "idx_app_config_single_draft" ON "app_config_versions"((1)) WHERE "status" = 'draft';
CREATE UNIQUE INDEX "idx_app_config_single_canary" ON "app_config_versions"((1)) WHERE "status" = 'canary';
CREATE UNIQUE INDEX "idx_app_config_single_active" ON "app_config_versions"((1)) WHERE "status" = 'active';
CREATE INDEX "idx_app_config_status" ON "app_config_versions"("status");

-- AddForeignKey
ALTER TABLE "app_config_versions"
  ADD CONSTRAINT "app_config_versions_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "app_config_versions"
  ADD CONSTRAINT "app_config_versions_published_by_fkey"
  FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
