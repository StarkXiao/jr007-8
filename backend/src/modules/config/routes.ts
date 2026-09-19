import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { AUDIT_ACTIONS } from "../../config/constants";
import { recordAudit } from "../../services/audit";
import { validatePayload, validateRollout } from "./validate";
import {
  discardDraft,
  getOrCreateDraft,
  getVersionsForAdmin,
  previewConfig,
  publishDraft,
  rollbackToVersion,
  revokeCanaryToDraft,
  saveDraft,
  updateCanaryRollout,
} from "./service";
import { THRESHOLD_SPECS } from "./types";

export const adminConfigRouter = Router();

// 所有路由都是管理员操作；配置改动影响全站，不开放给审核员
adminConfigRouter.use(requireAuth, requireRole("admin"));

const rolloutSchema = z.object({
  userModBase: z.number().int().min(2).max(10000).optional(),
  userModRemainders: z.array(z.number().int().min(0)).optional(),
  roles: z.array(z.string()).optional(),
  userUuids: z.array(z.string().uuid()).optional(),
  percent: z.number().min(0).max(100).optional(),
});

const payloadSchema = z.object({
  categories: z.array(z.any()).min(1),
  thresholds: z.record(z.string(), z.number()),
});

// 阈值注册表：前端编辑表单按它渲染（标签、单位、范围、默认值）
adminConfigRouter.get(
  "/admin/config/threshold-specs",
  asyncHandler(async (req, res) => {
    res.json(ok(req, { items: THRESHOLD_SPECS }));
  }),
);

// 版本档案 + 当前 draft/canary/active 指针
adminConfigRouter.get(
  "/admin/config/versions",
  asyncHandler(async (req, res) => {
    res.json(ok(req, await getVersionsForAdmin()));
  }),
);

// 取草稿；不存在时以当前生效内容自动创建
adminConfigRouter.post(
  "/admin/config/draft",
  asyncHandler(async (req, res) => {
    const result = await getOrCreateDraft(req.user!.id);
    res.status(201).json(ok(req, result));
  }),
);

// 保存草稿（不触碰线上）。严格校验在 service 里完成，给出具体中文错误
adminConfigRouter.put(
  "/admin/config/draft",
  validate({
    body: z.object({
      payload: payloadSchema,
      rollout: rolloutSchema.nullable().optional(),
      comment: z.string().max(200).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const payload = validatePayload(req.body.payload);
    const rollout = req.body.rollout === undefined ? undefined : validateRollout(req.body.rollout);
    const view = await saveDraft({
      payload,
      rollout: rollout ?? null,
      comment: req.body.comment ?? null,
      actorId: req.user!.id,
    });
    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.CONFIG_DRAFT_SAVE,
      targetType: "app_config",
      targetId: BigInt(view.id),
      reason: view.comment ?? undefined,
      after: { version: view.version },
      req,
    });
    res.json(ok(req, { view }));
  }),
);

adminConfigRouter.delete(
  "/admin/config/draft",
  asyncHandler(async (req, res) => {
    await discardDraft();
    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.CONFIG_DRAFT_DISCARD,
      targetType: "app_config",
      reason: "丢弃草稿",
      req,
    });
    res.json(ok(req, { discarded: true }));
  }),
);

// 草稿预演：传入模拟用户（可带编辑器里未保存的灰度规则），返回命中哪版及原因，无任何写入
adminConfigRouter.post(
  "/admin/config/preview",
  validate({
    body: z.object({
      userId: z.coerce.bigint().optional(),
      userUuid: z.string().uuid().optional(),
      role: z.enum(["visitor", "user", "moderator", "admin"]).optional(),
      rollout: rolloutSchema.nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await previewConfig(
      { id: req.body.userId, uuid: req.body.userUuid, role: req.body.role },
      { rollout: req.body.rollout === undefined ? undefined : validateRollout(req.body.rollout) },
    );
    res.json(ok(req, result));
  }),
);

// 灰度发布：草稿 → canary，必须给出灰度规则（规则可以是「只给管理员」）
adminConfigRouter.post(
  "/admin/config/publish-canary",
  validate({
    body: z.object({
      payload: payloadSchema.optional(),
      rollout: rolloutSchema,
      comment: z.string().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const rollout = validateRollout(req.body.rollout);

    if (req.body.payload) {
      // 带内容的发布：先严格校验并落草稿，再切状态
      const payload = validatePayload(req.body.payload);
      await saveDraft({ payload, rollout, comment: req.body.comment ?? null, actorId: req.user!.id });
    } else {
      // 只发规则：确保有草稿（以当前生效内容为底），仅把规则写进去
      const draft = await getOrCreateDraft(req.user!.id);
      if (!draft.created) {
        await saveDraft({ payload: draft.view.payload, rollout, comment: req.body.comment ?? draft.view.comment, actorId: req.user!.id });
      }
    }

    const result = await publishDraft({
      mode: "canary",
      rollout,
      comment: req.body.comment,
      actorId: req.user!.id,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.CONFIG_PUBLISH_CANARY,
      targetType: "app_config",
      targetId: BigInt(result.view.id),
      reason: result.view.comment ?? undefined,
      after: { version: result.view.version, rollout: result.view.rollout },
      req,
    });
    res.json(ok(req, result));
  }),
);

// 灰度扩/缩量：只改规则，不产生新版本
adminConfigRouter.put(
  "/admin/config/canary/rollout",
  validate({ body: z.object({ rollout: rolloutSchema, comment: z.string().max(200).nullable().optional() }) }),
  asyncHandler(async (req, res) => {
    const view = await updateCanaryRollout(validateRollout(req.body.rollout), req.body.comment ?? null);
    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.CONFIG_CANARY_UPDATE,
      targetType: "app_config",
      targetId: BigInt(view.id),
      after: { version: view.version, rollout: view.rollout },
      req,
    });
    res.json(ok(req, { view }));
  }),
);

// 结束灰度：canary 退回草稿
adminConfigRouter.post(
  "/admin/config/canary/revoke",
  asyncHandler(async (req, res) => {
    const view = await revokeCanaryToDraft();
    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.CONFIG_CANARY_REVOKE,
      targetType: "app_config",
      targetId: BigInt(view.id),
      reason: "灰度撤回为草稿",
      after: { version: view.version },
      req,
    });
    res.json(ok(req, { view }));
  }),
);

// 全量发布：草稿 → active，旧版本全部归档，分类物化对齐
adminConfigRouter.post(
  "/admin/config/publish-full",
  validate({
    body: z.object({ payload: payloadSchema.optional(), comment: z.string().max(200).optional() }),
  }),
  asyncHandler(async (req, res) => {
    if (req.body.payload) {
      const payload = validatePayload(req.body.payload);
      await saveDraft({ payload, comment: req.body.comment ?? null, actorId: req.user!.id });
    }
    // 不带内容时：已有草稿 → 发布草稿；无草稿但有 canary → 直接提升 canary。
    // 两种情况都由 service 处理，路由不主动创建草稿。

    const result = await publishDraft({ mode: "full", comment: req.body.comment, actorId: req.user!.id });

    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.CONFIG_PUBLISH_FULL,
      targetType: "app_config",
      targetId: BigInt(result.view.id),
      reason: result.view.comment ?? undefined,
      after: { version: result.view.version, categories: result.materialized },
      req,
    });
    res.json(ok(req, result));
  }),
);

// 一键回滚：把任意历史版本的内容重新发布为新的 active
adminConfigRouter.post(
  "/admin/config/rollback/:version",
  validate({
    params: z.object({ version: z.coerce.number().int().positive() }),
    body: z.object({ comment: z.string().max(200).optional() }).optional(),
  }),
  asyncHandler(async (req, res) => {
    const versionNo = Number(req.params.version);
    const view = await rollbackToVersion(versionNo, req.user!.id, req.body?.comment);
    await recordAudit({
      actorId: req.user!.id,
      action: AUDIT_ACTIONS.CONFIG_ROLLBACK,
      targetType: "app_config",
      targetId: BigInt(view.id),
      reason: view.comment ?? `回滚到 v${versionNo}`,
      after: { newVersion: view.version, rolledBackFrom: versionNo },
      req,
    });
    res.json(ok(req, { view }));
  }),
);
