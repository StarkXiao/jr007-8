-- 在线配置：分类 / 属性表单 / 业务阈值统一版本化
--
-- 每一行是一个不可变的完整配置包。draft 可反复修改；canary 按用户桶灰度；
-- active 全局唯一；archived 为只读历史。回滚 = 用历史版本内容发一个新版本，
-- 因此历史行永远不会被删除或覆盖。

DO $$ BEGIN
  CREATE TYPE "AppConfigStatus" AS ENUM ('draft', 'canary', 'active', 'archived');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE "app_config_versions" (
    "id" BIGSERIAL NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "AppConfigStatus" NOT NULL DEFAULT 'draft',
    "bundle" JSONB NOT NULL,
    "canary_rule" JSONB,
    "note" VARCHAR(200),
    "created_by" BIGINT,
    "published_by" BIGINT,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "app_config_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "app_config_versions_version_key" ON "app_config_versions"("version");
CREATE INDEX "idx_app_config_status" ON "app_config_versions"("status");

ALTER TABLE "app_config_versions"
  ADD CONSTRAINT "app_config_versions_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "app_config_versions"
  ADD CONSTRAINT "app_config_versions_published_by_fkey"
  FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE SET NULL;
