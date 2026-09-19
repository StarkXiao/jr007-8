import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { AppError } from "../../utils/errors";
import { prisma } from "../../db/prisma";
import { AUDIT_ACTIONS } from "../../config/constants";
import { recordAudit } from "../../services/audit";
import {
  discardDraft,
  ensureDraft,
  getDraft,
  getVersion,
  listVersions,
  previewVersion,
  promoteCanary,
  publishVersion,
  saveDraft,
  stopCanary,
  validateCanaryRule,
} from "./service";
import { BUNDLE_FORMAT_VERSION, THRESHOLD_LABELS, assertValidBundle } from "./bundle";

export const adminConfigRouter = Router();

adminConfigRouter.use(requireAuth, requireRole("admin"));

const bundleBody = z
  .object({
    formatVersion: z.literal(BUNDLE_FORMAT_VERSION),
    categories: z.array(z.any()),
    thresholds: z.record(z.number()),
  })
  .passthrough();

const canaryRuleBody = z
  .object({
    percent: z.number().min(0).max(100),
    userUuids: z.array(z.string()).max(200).optional().default([]),
  })
  .default({ percent: 0, userUuids: [] });

function serializeVersion(version: Awaited<ReturnType<typeof getVersion>>) {
  return {
    id: version.id.toString(),
    version: version.version,
    status: version.status,
    canaryRule: version.canaryRule,
    note: version.note,
    categoryCount: version.categoryCount,
    activeCategoryCount: version.activeCategoryCount,
    publishedBy: version.publishedBy?.toString() ?? null,
    publishedAt: version.publishedAt,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    bundle: version.bundle,
  };
}

// 配置工作台首页：当前全量、灰度、草稿三个状态一览
adminConfigRouter.get(
  "/admin/config",
  asyncHandler(async (req, res) => {
    const [active, canary, draft] = await Promise.all([
      prisma.appConfigVersion.findFirst({ where: { status: "active" }, orderBy: { version: "desc" } }),
      prisma.appConfigVersion.findFirst({ where: { status: "canary" }, orderBy: { version: "desc" } }),
      getDraft(),
    ]);
    res.json(
      ok(req, {
        active: active
          ? { version: active.version, publishedAt: active.publishedAt, note: active.note }
          : null,
        canary: canary
          ? {
              version: canary.version,
              canaryRule: canary.canaryRule,
              publishedAt: canary.publishedAt,
              note: canary.note,
            }
          : null,        draft: draft
          ? { version: draft.version, note: draft.note, updatedAt: draft.updatedAt, categoryCount: draft.categoryCount }
          : null,
        thresholdLabels: THRESHOLD_LABELS,
      }),
    );
  }),
);

// 历史版本列表（回滚目标从这里选）
adminConfigRouter.get(
  "/admin/config/versions",
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }) }),
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    const versions = await listVersions(limit);
    res.json(
      ok(req, {
        items: versions.map((version) => ({
          id: version.id.toString(),
          version: version.status === "draft" ? undefined : version.version,
          draftVersion: version.status === "draft" ? version.version : undefined,
          status: version.status,
          canaryRule: version.canaryRule,
          note: version.note,
          categoryCount: version.categoryCount,
          activeCategoryCount: version.activeCategoryCount,
          publishedAt: version.publishedAt,
          createdAt: version.createdAt,
          updatedAt: version.updatedAt,
        })),
      }),
    );
  }),
);

adminConfigRouter.get(
  "/admin/config/versions/:version",
  validate({ params: z.object({ version: z.coerce.number().int() }) }),
  asyncHandler(async (req, res) => {
    const version = await getVersion(Number(req.params.version));
    res.json(ok(req, { version: serializeVersion(version) }));
  }),
);

adminConfigRouter.get(
  "/admin/config/draft",
  asyncHandler(async (req, res) => {
    const draft = await getDraft();
    res.json(ok(req, { draft: draft ? serializeVersion(draft) : null }));
  }),
);

// 创建（或基于指定历史版本创建）草稿
adminConfigRouter.post(
  "/admin/config/draft",
  validate({
    body: z.object({ baseVersion: z.number().int().positive().optional(), note: z.string().max(200).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const draft = await ensureDraft(req.user!.id, req.body.baseVersion);
    res.status(201).json(ok(req, { draft: serializeVersion(draft), created: draft.created }));
  }),
);

adminConfigRouter.put(
  "/admin/config/draft",
  validate({ body: z.object({ bundle: bundleBody, note: z.string().max(200).nullable().optional() }) }),
  asyncHandler(async (req, res) => {
    const draft = await saveDraft({ bundle: req.body.bundle, note: req.body.note, actorId: req.user!.id });
    res.json(ok(req, { version: draft.version, updatedAt: draft.updatedAt }));
  }),
);

adminConfigRouter.delete(
  "/admin/config/draft",
  asyncHandler(async (req, res) => {
    await discardDraft(req.user!.id);
    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.APP_CONFIG_DISCARD_DRAFT,
      req,
    });
    res.json(ok(req, { discarded: true }));
  }),
);

// 草稿预演（结构校验）：只校验不落库，前端编辑器实时调用
adminConfigRouter.post(
  "/admin/config/validate",
  validate({ body: z.object({ bundle: z.unknown() }) }),
  asyncHandler(async (req, res) => {
    // assertValidBundle 不合法时直接抛 400（错误信息里带具体字段），合法时回显归一化结果
    const normalized = assertValidBundle(req.body.bundle);
    res.json(ok(req, { valid: true, bundle: normalized }));
  }),
);

// 预演生效效果：指定版本或未保存的草稿内容 + 观看者身份 / 桶
adminConfigRouter.post(
  "/admin/config/preview",
  validate({
    body: z.object({
      version: z.number().int().optional(),
      bundle: z.unknown().optional(),
      viewerUuid: z.string().uuid().optional(),
      bucketId: z.string().max(64).optional(),
      role: z.enum(["visitor", "user", "moderator", "admin"]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    if (req.body.version === undefined && req.body.bundle === undefined) {
      throw AppError.badRequest("必须提供 version 或 bundle");
    }
    const result = await previewVersion(req.body);
    res.json(ok(req, result));
  }),
);

// 发布：全量 / 灰度；fromVersion 传历史版本号即一键回滚（重发）
adminConfigRouter.post(
  "/admin/config/publish",
  validate({
    body: z.object({
      mode: z.enum(["full", "canary"]),
      canaryRule: canaryRuleBody.optional(),
      note: z.string().max(200).optional(),
      fromVersion: z.number().int().positive().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const rule = req.body.mode === "canary" ? validateCanaryRule(req.body.canaryRule ?? { percent: 0 }) : undefined;
    const result = await publishVersion({
      mode: req.body.mode,
      canaryRule: rule,
      note: req.body.note,
      actorId: req.user!.id,
      fromVersion: req.body.fromVersion,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: result.status === "canary" ? AUDIT_ACTIONS.APP_CONFIG_CANARY : AUDIT_ACTIONS.APP_CONFIG_PUBLISH,
      targetType: "app_config",
      after: { version: result.version, mode: result.status, canaryRule: rule ?? null, fromVersion: req.body.fromVersion ?? null },
      reason: req.body.note,
      req,
    });

    res.status(201).json(ok(req, result));
  }),
);

// 灰度全量
adminConfigRouter.post(
  "/admin/config/canary/promote",
  asyncHandler(async (req, res) => {
    const result = await promoteCanary(req.user!.id);
    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.APP_CONFIG_CANARY_PROMOTE,
      targetType: "app_config",
      after: result,
      req,
    });
    res.json(ok(req, result));
  }),
);

// 中止灰度，回到全量版本
adminConfigRouter.post(
  "/admin/config/canary/stop",
  asyncHandler(async (req, res) => {
    await stopCanary(req.user!.id);
    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.APP_CONFIG_CANARY_STOP,
      targetType: "app_config",
      req,
    });
    res.json(ok(req, { stopped: true }));
  }),
);
