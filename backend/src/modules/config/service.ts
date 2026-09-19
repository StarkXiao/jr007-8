import { Prisma, type AppConfigVersion, type PrismaClient } from "@prisma/client";
import { prisma, toJsonValue } from "../../db/prisma";
import { redis } from "../../db/redis";
import { logger } from "../../utils/logger";
import { AppError } from "../../utils/errors";
import { buildDefaultConfig } from "./defaults";
import { matchesRollout, stableBucket } from "./validate";
import type {
  ConfigPayload,
  ResolvedConfig,
  RolloutRule,
  ThresholdKey,
} from "./types";
import { THRESHOLD_SPECS } from "./types";
import type { AppConfigStatus } from "@prisma/client";

// ------------------------------------------------------------------ 缓存
//
// 每个请求都查版本表太浪费，但配置又必须在发布后很快生效。
// 采用「进程内短 TTL（30s 兜底）+ Redis 发布订阅主动失效」：
// 任何进程写了配置就 publish，所有 API/worker 进程立刻丢缓存重读。

const CACHE_TTL_MS = 30_000;
const INVALIDATE_CHANNEL = "psdm:config:invalidate";

type VersionRow = AppConfigVersion;

interface Snapshot {
  active: VersionRow | null;
  canary: VersionRow | null;
  draft: VersionRow | null;
  fetchedAt: number;
}

let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
let subscriber: ReturnType<typeof redis.duplicate> | null = null;
let subscribed = false;

async function fetchSnapshot(): Promise<Snapshot> {
  const [active, canary, draft] = await Promise.all([
    prisma.appConfigVersion.findFirst({ where: { status: "active" }, orderBy: { version: "desc" } }),
    prisma.appConfigVersion.findFirst({ where: { status: "canary" }, orderBy: { version: "desc" } }),
    prisma.appConfigVersion.findFirst({ where: { status: "draft" }, orderBy: { version: "desc" } }),
  ]);
  return { active, canary, draft, fetchedAt: Date.now() };
}

async function getSnapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;

  // 同一时刻并发的请求只查一次库
  inflight ??= fetchSnapshot()
    .then((snapshot) => {
      cache = snapshot;
      return snapshot;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 本进程立刻丢缓存，并通知其它进程（API 多实例 / worker）一起丢 */
export async function invalidateConfigCache(): Promise<void> {
  cache = null;
  try {
    await redis.publish(INVALIDATE_CHANNEL, String(Date.now()));
  } catch (error) {
    // Redis 不可用时靠 30s TTL 兜底收敛，不能因为通知失败让发布动作失败
    logger.warn({ err: (error as Error).message }, "配置失效通知未发出，等待 TTL 兜底");
  }
}

/** 懒订阅一次失效消息；worker 与 API 启动时都可以调 */
export function initConfigInvalidationSubscriber(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    subscriber = redis.duplicate();
    subscriber.on("error", (error: Error) => {
      logger.warn({ err: error.message }, "配置失效订阅连接异常");
    });
    void subscriber.subscribe(INVALIDATE_CHANNEL).catch((error) => {
      logger.warn({ err: (error as Error).message }, "配置失效订阅失败");
    });
    subscriber.on("message", (channel) => {
      if (channel === INVALIDATE_CHANNEL) cache = null;
    });
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "配置失效订阅初始化失败");
  }
}

// ------------------------------------------------------------------ 首次安装

let bootstrapped = false;

/**
 * 库里一个版本都没有时（全新部署），用出厂默认配置写入 v1=active。
 * 用 advisory lock + 状态复查，避免多进程同时启动各写一份。
 */
export async function ensureBootstrapConfig(): Promise<void> {
  if (bootstrapped) return;
  const any = await prisma.appConfigVersion.findFirst({ select: { id: true } });
  if (any) {
    bootstrapped = true;
    return;
  }

  await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ lock: boolean }>>`SELECT pg_try_advisory_xact_lock(917253) AS lock`;
    if (!row.lock) return;
    const again = await tx.appConfigVersion.findFirst({ select: { id: true } });
    if (again) return;

    await tx.appConfigVersion.create({
      data: {
        version: 1,
        status: "active",
        payload: toJsonValue(buildDefaultConfig()),
        publishedAt: new Date(),
        comment: "出厂默认配置",
      },
    });
    logger.info("在线配置为空，已写入出厂默认配置 v1");
  });

  bootstrapped = true;
  cache = null;
}

// ------------------------------------------------------------------ 解析

function asPayload(row: VersionRow): ConfigPayload {
  return row.payload as unknown as ConfigPayload;
}

function fallbackConfig(): ResolvedConfig {
  const fallback = buildDefaultConfig();
  return { version: 0, status: "active", payload: fallback, categories: fallback.categories, thresholds: fallback.thresholds };
}

/**
 * 按当前用户解析线上配置：命中灰度规则读 canary，否则读 active；
 * 游客与系统任务（无用户）永远读 active。
 */
export async function resolveConfig(
  user?: { id: bigint; uuid: string; role: string },
  forceCanary = false,
): Promise<ResolvedConfig> {
  await ensureBootstrapConfig();
  const snapshot = await getSnapshot();

  if (snapshot.canary) {
    const rule = (snapshot.canary.rollout ?? null) as RolloutRule | null;
    if (forceCanary || matchesRollout(rule, user)) {
      const payload = asPayload(snapshot.canary);
      return { version: snapshot.canary.version, status: "canary", payload, categories: payload.categories, thresholds: payload.thresholds };
    }
  }

  if (!snapshot.active) return fallbackConfig();

  const payload = asPayload(snapshot.active);
  return { version: snapshot.active.version, status: "active", payload, categories: payload.categories, thresholds: payload.thresholds };
}

/** 系统/定时任务视角：只有 active，没有灰度 */
export async function resolveSystemConfig(): Promise<ResolvedConfig> {
  return resolveConfig(undefined);
}

export async function getThresholds(user?: { id: bigint; uuid: string; role: string }): Promise<ResolvedConfig["thresholds"]> {
  return (await resolveConfig(user)).thresholds;
}

/** 单个阈值的便捷读取，缺键时退回注册表默认值，保证坏数据不炸业务 */
export async function getThreshold(key: ThresholdKey, user?: { id: bigint; uuid: string; role: string }): Promise<number> {
  const thresholds = await getThresholds(user);
  const value = thresholds[key];
  if (typeof value === "number") return value;
  return THRESHOLD_SPECS.find((spec) => spec.key === key)?.default ?? 0;
}

// ------------------------------------------------------------------ 分类物化
//
// spots.categoryId 是外键，所以分类不能只存在 JSON 里。
// 发布时把配置里的分类同步到 categories 表：
//   全量发布 —— 增删改全部对齐（移除的分类置 isActive=false，历史条目外键不断）
//   灰度发布 —— 只补建缺失分类（置 isActive=false），绝不动现有行，
//               保证未命中灰度的用户看到的世界完全不变。

type TransactionClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

async function materializeCategories(tx: TransactionClient, payload: ConfigPayload, options: { mode: "canary" | "full"; configVersion: number }): Promise<void> {
  const existing = await tx.category.findMany();
  const byCode = new Map(existing.map((category) => [category.code, category]));

  for (const item of payload.categories) {
    const current = byCode.get(item.code);
    const schemaData = toJsonValue(item.schema);

    if (!current) {
      // 新分类：灰度阶段先以「停用」落库供外键使用，全量发布时才对所有人可见
      await tx.category.create({
        data: {
          code: item.code,
          name: item.name,
          icon: item.icon,
          color: item.color,
          description: item.description,
          sortOrder: item.sortOrder,
          isActive: options.mode === "full" ? item.isActive : false,
          schemas: {
            create: { version: options.configVersion, schema: schemaData, isCurrent: options.mode === "full" },
          },
        },
      });
      continue;
    }

    if (options.mode === "full") {
      await tx.category.update({
        where: { id: current.id },
        data: {
          name: item.name,
          icon: item.icon,
          color: item.color,
          description: item.description,
          sortOrder: item.sortOrder,
          isActive: item.isActive,
        },
      });
    }

    // 灰度阶段也为已存在分类补一份 canary schema（非 current），供管理端与排查使用；
    // 全量阶段则切换 current 指针。
    if (options.mode === "full") {
      // 无论该版本的 schema 行是否已存在（灰度转全量时它已存在），
      // 都要先把其它行的 current 摘掉，保证同一分类永远只有一个 current
      await tx.categorySchema.updateMany({
        where: { categoryId: current.id, isCurrent: true, version: { not: options.configVersion } },
        data: { isCurrent: false },
      });
    }

    const schemaRow = await tx.categorySchema.findUnique({
      where: { categoryId_version: { categoryId: current.id, version: options.configVersion } },
    });
    if (schemaRow) {
      await tx.categorySchema.update({
        where: { id: schemaRow.id },
        data: { schema: schemaData, isCurrent: options.mode === "full" ? true : schemaRow.isCurrent },
      });
    } else {
      await tx.categorySchema.create({
        data: {
          categoryId: current.id,
          version: options.configVersion,
          schema: schemaData,
          isCurrent: options.mode === "full",
        },
      });
    }
  }

  if (options.mode === "full") {
    const configCodes = payload.categories.map((category) => category.code);
    await tx.category.updateMany({
      where: { code: { notIn: configCodes }, isActive: true },
      data: { isActive: false },
    });
  }
}

// ------------------------------------------------------------------ 版本生命周期

export interface AdminVersionView {
  id: string;
  version: number;
  status: AppConfigVersion["status"];
  payload: ConfigPayload;
  rollout: RolloutRule | null;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  creator: { nickname: string } | null;
  publisher: { nickname: string } | null;
}

const versionInclude = {
  creator: { select: { nickname: true } },
  publisher: { select: { nickname: true } },
} as const;

function toVersionView(
  row: AppConfigVersion & { creator?: { nickname: string } | null; publisher?: { nickname: string } | null },
): AdminVersionView {
  return {
    id: row.id.toString(),
    version: row.version,
    status: row.status,
    payload: row.payload as unknown as ConfigPayload,
    rollout: (row.rollout as RolloutRule | null) ?? null,
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    creator: row.creator ? { nickname: row.creator.nickname } : null,
    publisher: row.publisher ? { nickname: row.publisher.nickname } : null,
  };
}

async function listAllVersions(): Promise<AdminVersionView[]> {
  const rows = await prisma.appConfigVersion.findMany({ orderBy: { version: "desc" }, include: versionInclude });
  return rows.map(toVersionView);
}

/** 读取当前草稿；不存在时以当前生效版本的内容自动建一个草稿，编辑从「现状」起步 */
export async function getOrCreateDraft(actorId: bigint): Promise<{ view: AdminVersionView; created: boolean }> {
  await ensureBootstrapConfig();
  const snapshot = await getSnapshot();
  if (snapshot.draft) {
    const row = await prisma.appConfigVersion.findUniqueOrThrow({
      where: { id: snapshot.draft.id },
      include: versionInclude,
    });
    return { view: toVersionView(row), created: false };
  }

  const base = snapshot.active ?? snapshot.canary;
  const latest = await prisma.appConfigVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
  const row = await prisma.appConfigVersion.create({
    data: {
      version: (latest?.version ?? 0) + 1,
      status: "draft",
      payload: base ? toJsonValue(base.payload) : toJsonValue(buildDefaultConfig()),
      // 草稿尚未配置自己的灰度规则，rollout 留空（DbNull），发布时再写入
      rollout: Prisma.DbNull,
      createdBy: actorId,
      comment: base ? `基于 v${base.version} 创建的草稿` : "草稿",
    },
    include: versionInclude,
  });
  await invalidateConfigCache();
  return { view: toVersionView(row), created: true };
}

/** 更新草稿内容/灰度规则/备注（仅 draft 状态可改） */
export async function saveDraft(input: {
  payload: ConfigPayload;
  rollout?: RolloutRule | null;
  comment?: string | null;
  actorId: bigint;
}): Promise<AdminVersionView> {
  const draft = await prisma.appConfigVersion.findFirst({ where: { status: "draft" } });
  if (!draft) throw AppError.notFound("草稿不存在，请先创建");

  const row = await prisma.appConfigVersion.update({
    where: { id: draft.id },
    data: {
      payload: toJsonValue(input.payload),
      ...(input.rollout !== undefined
        ? { rollout: input.rollout === null ? Prisma.DbNull : toJsonValue(input.rollout) }
        : {}),
      // 只在显式传入（含空串）时覆盖；发布动作若不带说明，保留草稿原备注
      ...(input.comment !== undefined && input.comment !== null ? { comment: input.comment } : {}),
      createdBy: input.actorId,
    },
    include: versionInclude,
  });
  await invalidateConfigCache();
  return toVersionView(row);
}

/** 丢弃草稿（物理删除；它从未生效，不产生任何线上影响） */
export async function discardDraft(): Promise<void> {
  const draft = await prisma.appConfigVersion.findFirst({ where: { status: "draft" } });
  if (draft) {
    await prisma.appConfigVersion.delete({ where: { id: draft.id } });
    await invalidateConfigCache();
  }
}

/**
 * 发布草稿。
 * canary：草稿转为 canary；已有 canary 归档。active 原封不动。
 * full：草稿转为 active；旧 active 与当前 canary 全部归档。
 * 版本号在草稿创建时已占用，发布只切换状态。
 *
 * 特殊情况：没有草稿、但存在进行中的 canary 时，full 发布会把 canary 直接提升为全量
 *（灰度验证通过后的常规动作），不强制要求管理员先手动把它退回草稿。
 */
export async function publishDraft(input: {
  mode: "canary" | "full";
  rollout?: RolloutRule | null;
  comment?: string | null;
  actorId: bigint;
}): Promise<{ view: AdminVersionView; materialized: number }> {
  const existingDraft = await prisma.appConfigVersion.findFirst({ where: { status: "draft" } });
  const existingCanary = await prisma.appConfigVersion.findFirst({ where: { status: "canary" } });

  // 灰度转全量：直接把 canary 行切到 active
  if (input.mode === "full" && !existingDraft && existingCanary) {
    const payload = existingCanary.payload as unknown as ConfigPayload;
    const result = await prisma.$transaction(async (tx) => {
      await tx.appConfigVersion.updateMany({ where: { status: "active" }, data: { status: "archived" } });
      const row = await tx.appConfigVersion.update({
        where: { id: existingCanary.id },
        data: {
          status: "active",
          rollout: Prisma.DbNull,
          comment: input.comment ?? existingCanary.comment,
          publishedBy: input.actorId,
          publishedAt: new Date(),
        },
        include: versionInclude,
      });
      await materializeCategories(tx, payload, { mode: "full", configVersion: row.version });
      return { view: toVersionView(row), materialized: payload.categories.length };
    });
    await invalidateConfigCache();
    return result;
  }

  const draft = existingDraft;
  if (!draft) throw AppError.notFound("草稿不存在，请先创建");
  if (input.mode === "canary" && !input.rollout) {
    throw AppError.badRequest("灰度发布必须给出命中规则（哪怕只对管理员生效）");
  }
  const payload = draft.payload as unknown as ConfigPayload;

  const result = await prisma.$transaction(async (tx) => {
    if (input.mode === "full") {
      await tx.appConfigVersion.updateMany({
        where: { status: { in: ["active", "canary"] } },
        data: { status: "archived" },
      });
    } else {
      await tx.appConfigVersion.updateMany({ where: { status: "canary" }, data: { status: "archived" } });
    }

    const row = await tx.appConfigVersion.update({
      where: { id: draft.id },
      data: {
        status: (input.mode === "full" ? "active" : "canary") as AppConfigStatus,
        rollout: input.mode === "canary" ? toJsonValue(input.rollout ?? {}) : Prisma.DbNull,
        comment: input.comment ?? draft.comment,
        publishedBy: input.actorId,
        publishedAt: new Date(),
      },
      include: versionInclude,
    });

    await materializeCategories(tx, payload, { mode: input.mode, configVersion: row.version });
    return { view: toVersionView(row), materialized: payload.categories.length };
  });

  await invalidateConfigCache();
  return result;
}

/** 灰度中调整命中规则（扩量/缩量），不产生新版本 */
export async function updateCanaryRollout(rollout: RolloutRule, comment?: string | null): Promise<AdminVersionView> {
  const canary = await prisma.appConfigVersion.findFirst({ where: { status: "canary" } });
  if (!canary) throw AppError.notFound("当前没有进行中的灰度");

  const row = await prisma.appConfigVersion.update({
    where: { id: canary.id },
    data: { rollout: toJsonValue(rollout), ...(comment !== undefined ? { comment } : {}) },
    include: versionInclude,
  });
  await invalidateConfigCache();
  return toVersionView(row);
}

/** 结束灰度：canary 退回为草稿继续改（不影响线上 active） */
export async function revokeCanaryToDraft(): Promise<AdminVersionView> {
  const canary = await prisma.appConfigVersion.findFirst({ where: { status: "canary" } });
  if (!canary) throw AppError.notFound("当前没有进行中的灰度");
  // 若已有草稿先归档（不删除，保留操作痕迹）
  await prisma.appConfigVersion.updateMany({ where: { status: "draft" }, data: { status: "archived" } });
  const row = await prisma.appConfigVersion.update({
    where: { id: canary.id },
    data: { status: "draft", publishedAt: null, publishedBy: null, rollout: Prisma.DbNull },
    include: versionInclude,
  });
  await invalidateConfigCache();
  return toVersionView(row);
}

/**
 * 一键回滚到任意历史版本：
 * 用该版本的内容新建一个 active 版本（旧 active/canary/草稿全部归档）。
 * 历史本身永远 append-only——回滚不是「把指针拨回去」，
 * 而是「把老内容作为新版本重新发布」，审计链不断。
 */
export async function rollbackToVersion(versionNo: number, actorId: bigint, comment?: string | null): Promise<AdminVersionView> {
  const target = await prisma.appConfigVersion.findUnique({ where: { version: versionNo } });
  if (!target) throw AppError.notFound(`配置版本 v${versionNo} 不存在`);
  const payload = target.payload as unknown as ConfigPayload;

  const view = await prisma.$transaction(async (tx) => {
    const latest = await tx.appConfigVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    await tx.appConfigVersion.updateMany({
      where: { status: { in: ["active", "canary", "draft"] } },
      data: { status: "archived" },
    });

    const row = await tx.appConfigVersion.create({
      data: {
        version: (latest?.version ?? 0) + 1,
        status: "active",
        payload: toJsonValue(payload),
        rollout: Prisma.DbNull,
        comment: comment ?? `回滚到 v${versionNo} 的内容`,
        createdBy: actorId,
        publishedBy: actorId,
        publishedAt: new Date(),
      },
      include: versionInclude,
    });

    await materializeCategories(tx, payload, { mode: "full", configVersion: row.version });
    return toVersionView(row);
  });

  await invalidateConfigCache();
  return view;
}

export async function getVersionsForAdmin(): Promise<{
  versions: AdminVersionView[];
  active: AdminVersionView | null;
  canary: AdminVersionView | null;
  draft: AdminVersionView | null;
}> {
  await ensureBootstrapConfig();
  const versions = await listAllVersions();
  return {
    versions,
    active: versions.find((item) => item.status === "active") ?? null,
    canary: versions.find((item) => item.status === "canary") ?? null,
    draft: versions.find((item) => item.status === "draft") ?? null,
  };
}

// ------------------------------------------------------------------ 草稿预演

/**
 * 草稿预演：给定一个模拟用户，返回该用户在「灰度规则下」会看到哪一版、为什么。
 * 可传入未落库的 rollout（编辑器里还没保存的规则）当场试算；预演不写任何数据。
 */
export async function previewConfig(
  identity: { id?: bigint; uuid?: string; role?: string },
  override?: { rollout?: RolloutRule | null },
): Promise<{
  matched: boolean;
  reason: string;
  payload: ConfigPayload | null;
  activeVersion: number | null;
  previewVersion: number | null;
}> {
  await ensureBootstrapConfig();
  const snapshot = await getSnapshot();
  const previewRow = snapshot.draft ?? snapshot.canary;
  const activeVersion = snapshot.active?.version ?? null;

  // 显式传入的规则优先（预演编辑器里未保存的改动），否则用已存草稿/灰度的规则
  const rule: RolloutRule = override?.rollout !== undefined
    ? (override.rollout ?? {})
    : (((previewRow?.rollout ?? null) as RolloutRule | null) ?? {});

  if (!identity.id || !identity.uuid || !identity.role) {
    return {
      matched: false,
      reason: "游客 / 未指定用户：只会看到当前全量版本",
      payload: snapshot.active ? asPayload(snapshot.active) : null,
      activeVersion,
      previewVersion: previewRow?.version ?? null,
    };
  }

  const user = { id: identity.id, uuid: identity.uuid, role: identity.role };
  const matched = matchesRollout(rule, user);
  const bucket = stableBucket(user.uuid);

  const reasons: string[] = [];
  if (rule.roles?.includes(user.role)) reasons.push(`角色 ${user.role}`);
  if (rule.userUuids?.includes(user.uuid)) reasons.push("UUID 白名单");
  if (rule.userModBase && rule.userModRemainders?.length) {
    const remainder = Number(user.id % BigInt(rule.userModBase));
    if (rule.userModRemainders.includes(remainder)) reasons.push(`ID 取模（${remainder} mod ${rule.userModBase}）`);
  }
  if (typeof rule.percent === "number" && rule.percent > 0 && bucket < rule.percent) {
    reasons.push(`灰度比例 ${rule.percent}%（桶号 ${bucket}）`);
  }

  const reason = matched
    ? `命中灰度：${reasons.join("、")}`
    : `未命中任何灰度规则（稳定桶号 ${bucket}），将看到全量版本 v${activeVersion ?? "-"}`;

  return {
    matched,
    reason,
    payload: matched && previewRow ? asPayload(previewRow) : snapshot.active ? asPayload(snapshot.active) : null,
    activeVersion,
    previewVersion: previewRow?.version ?? null,
  };
}
