import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Prisma, type AppConfigStatus } from "@prisma/client";
import { prisma, toJsonValue } from "../../db/prisma";
import { redis } from "../../db/redis";
import { logger } from "../../utils/logger";
import { AppError } from "../../utils/errors";
import {
  assertValidBundle,
  cloneBundle,
  isConfigBundle,
  type CanaryRule,
  type ConfigBundle,
} from "./bundle";
import { createDefaultBundle } from "./defaults";
import type { AttributeSchema } from "../categories/schemaValidator";
import type { AuthUser } from "../../types/auth";

/**
 * 在线配置运行时：
 *
 *   版本表（事实来源，不可变快照）
 *        │ 启动加载 / 发布后失效
 *        ▼
 *   进程内缓存（active + canary + draft 元信息，带 TTL 兜底）
 *        │
 *        ▼
 *   请求上下文（AsyncLocalStorage）——按"用户桶 + 白名单 + 管理员"解析灰度
 *
 * Redis 只承担多实例之间的失效广播；Redis 挂了有 30 秒 TTL 兜底，
 * 数据库挂了有内置默认配置兜底。任何一环故障都不会让 API 起不来。
 */

interface CacheState {
  loadedAt: number;
  active: { version: number; bundle: ConfigBundle };
  canary: { id: bigint; version: number; bundle: ConfigBundle; rule: CanaryRule } | null;
  draft: { id: bigint; version: number; updatedAt: Date } | null;
}

const CACHE_TTL_MS = 30_000;
const INVALIDATION_CHANNEL = "psdm:appconfig:invalidate";
const INVALIDATION_PUBSUB_KEY = "psdm:appconfig:reload";

export const CONFIG_COOKIE = "psdm_cfg_bucket";
const COOKIE_MAX_AGE_MS = 180 * 24 * 3600 * 1000;

// ------------------------------------------------------------------ 缓存

let cache: CacheState | null = null;
let loading: Promise<CacheState> | null = null;

function fallbackState(): CacheState {
  return {
    loadedAt: Date.now(),
    active: { version: 0, bundle: createDefaultBundle() },
    canary: null,
    draft: null,
  };
}

async function loadFromDb(): Promise<CacheState> {
  const rows = await prisma.appConfigVersion.findMany({
    where: { status: { in: ["active", "canary", "draft"] } },
    orderBy: { version: "desc" },
  });

  const state = fallbackState();
  let activeFound = false;

  for (const row of rows) {
    if (!isConfigBundle(row.bundle)) {
      logger.error({ version: row.version, status: row.status }, "配置版本内容无法识别，已跳过");
      continue;
    }
    if (row.status === "active") {
      state.active = { version: row.version, bundle: row.bundle };
      activeFound = true;
    } else if (row.status === "canary") {
      state.canary = {
        id: row.id,
        version: row.version,
        bundle: row.bundle,
        rule: normalizeCanaryRule(row.canaryRule),
      };
    } else if (row.status === "draft" && !state.draft) {
      state.draft = { id: row.id, version: row.version, updatedAt: row.updatedAt };
    }
  }

  if (!activeFound) {
    logger.warn("版本表中没有 active 配置，使用内置默认配置兜底");
  }
  return state;
}

export async function refreshConfig(force = false): Promise<CacheState> {
  if (!force && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  // 并发请求共用同一次加载，避免缓存过期瞬间把数据库打穿
  if (!loading) {
    loading = loadFromDb()
      .then((state) => {
        cache = state;
        return state;
      })
      .catch((error) => {
        // 数据库故障时保留旧缓存；从未加载成功才用默认值
        logger.warn({ err: (error as Error).message }, "在线配置加载失败，沿用兜底配置");
        const state = cache ?? fallbackState();
        cache = { ...state, loadedAt: Date.now() };
        return cache;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** 发布 / 回滚后调用：失效本机缓存，并通知其他实例 */
export async function invalidateConfig(): Promise<void> {
  cache = null;
  await refreshConfig(true).catch(() => undefined);
  try {
    await redis.publish(INVALIDATION_CHANNEL, String(Date.now()));
    // pub/sub 不可靠（订阅连接断开会丢消息），再用一个带 TTL 的键兜底轮询
    await redis.set(INVALIDATION_PUBSUB_KEY, String(Date.now()), "EX", 60);
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "配置失效广播失败，其他实例将在 TTL 后自行刷新");
  }
}

let subscribed = false;
/** worker / server 启动时调用，监听其他实例的发布事件 */
export async function subscribeInvalidation(): Promise<void> {
  if (subscribed) return;
  subscribed = true;
  const sub = redis.duplicate();
  sub.on("error", (error) => logger.warn({ err: error.message }, "配置失效订阅异常"));
  await sub.subscribe(INVALIDATION_CHANNEL).catch(() => undefined);
  sub.on("message", (channel) => {
    if (channel === INVALIDATION_CHANNEL) {
      cache = null;
      refreshConfig(true).catch(() => undefined);
    }
  });
}

// ------------------------------------------------------------------ 请求上下文

export interface RequestConfigContext {
  /** 本次请求实际生效的配置包 */
  bundle: ConfigBundle;
  activeVersion: number;
  effectiveVersion: number;
  /** 生效来源：active=全量版本，canary=灰度版本，default=无任何已发布配置 */
  source: "active" | "canary" | "default";
  canary: boolean;
  viewer?: AuthUser;
  bucketId: string;
}

const requestStorage = new AsyncLocalStorage<RequestConfigContext>();

function stableBucketHash(bucketId: string): number {
  const digest = createHash("sha256").update(`psdm-canary:${bucketId}`).digest();
  // 取前 4 字节折成 0-9999 的桶，粒度 0.01%
  return digest.readUInt32BE(0) % 10_000;
}

export function isInCanary(rule: CanaryRule, viewer: AuthUser | undefined, bucketId: string): boolean {
  if (viewer && rule.userUuids.includes(viewer.uuid)) return true;
  // 管理员始终命中灰度：让发布者自己先看到效果，是灰度的最后一道人工校验
  if (viewer?.role === "admin") return true;
  if (rule.percent <= 0) return false;
  if (rule.percent >= 100) return true;
  return stableBucketHash(bucketId) < rule.percent * 100;
}

function normalizeCanaryRule(raw: unknown): CanaryRule {
  const candidate = (raw ?? {}) as Partial<CanaryRule>;
  const percent = typeof candidate.percent === "number" ? Math.min(100, Math.max(0, candidate.percent)) : 0;
  const userUuids = Array.isArray(candidate.userUuids)
    ? candidate.userUuids.filter((item): item is string => typeof item === "string")
    : [];
  return { percent, userUuids };
}

export function validateCanaryRule(raw: unknown): CanaryRule {
  const rule = normalizeCanaryRule(raw);
  if (rule.userUuids.length > 200) throw AppError.badRequest("灰度白名单最多 200 人");
  if (rule.userUuids.some((uuid) => !/^[0-9a-f-]{36}$/i.test(uuid))) {
    throw AppError.badRequest("灰度白名单必须是用户 UUID");
  }
  return rule;
}

export function runWithConfig<T>(context: RequestConfigContext, fn: () => T): T {
  return requestStorage.run(context, fn);
}

/** 当前请求的生效配置上下文；不在请求内（如 worker）时返回 null */
export function currentContext(): RequestConfigContext | null {
  return requestStorage.getStore() ?? null;
}

async function resolveBundle(
  viewer: AuthUser | undefined,
  bucketId: string,
): Promise<{ context: Omit<RequestConfigContext, "viewer" | "bucketId"> }> {
  const state = await refreshConfig();
  if (state.canary && isInCanary(state.canary.rule, viewer, bucketId)) {
    return {
      context: {
        bundle: state.canary.bundle,
        activeVersion: state.active.version,
        effectiveVersion: state.canary.version,
        source: "canary",
        canary: true,
      },
    };
  }
  return {
    context: {
      bundle: state.active.bundle,
      activeVersion: state.active.version,
      effectiveVersion: state.active.version,
      source: state.active.version === 0 ? "default" : "active",
      canary: false,
    },
  };
}

/**
 * 为请求构建配置上下文。鉴权中间件之后调用（viewer 已知）。
 * 匿名用户用持久化 cookie 作为桶 ID，保证同一浏览器灰度体验一致。
 */
export async function resolveRequestContext(
  viewer: AuthUser | undefined,
  bucketCookie: string | undefined,
): Promise<{ context: RequestConfigContext; setCookie: boolean; bucketId: string }> {
  let bucketId = viewer?.uuid ?? bucketCookie ?? "";
  let setCookie = false;

  if (!viewer) {
    if (!bucketId || !/^[0-9a-f-]{36}$/i.test(bucketId)) {
      bucketId = cryptoRandomUuid();
      setCookie = true;
    }
  }

  const { context } = await resolveBundle(viewer, bucketId);
  return {
    context: { ...context, viewer, bucketId },
    setCookie,
    bucketId,
  };
}

function cryptoRandomUuid(): string {
  // Node 20 自带全局 crypto.randomUUID
  return globalThis.crypto.randomUUID();
}

export function bucketCookieOptions() {
  return {
    httpOnly: false,
    sameSite: "lax" as const,
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/",
  };
}

// ------------------------------------------------------------------ 业务读取 API

/**
 * 生效中的配置包。请求处理链路里调用——带灰度视角；
 * worker 等请求外场景调用时返回全量版本（后台任务不应按用户桶随机行为）。
 */
export function activeBundle(): ConfigBundle {
  return currentContext()?.bundle ?? cache?.active.bundle ?? createDefaultBundle();
}

export function activeThresholds(): ConfigBundle["thresholds"] {
  return activeBundle().thresholds;
}

export function effectiveVersion(): number {
  return currentContext()?.effectiveVersion ?? cache?.active.version ?? 0;
}

// ------------------------------------------------------------------ 分类读取

export interface EffectiveCategory {
  code: string;
  name: string;
  icon: string;
  color: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  schemaVersion: number;
  schema: AttributeSchema;
}

export function listEffectiveCategories(includeInactive = false): EffectiveCategory[] {
  const bundle = activeBundle();
  const version = effectiveVersion();
  return cloneBundle(bundle)
    .categories.filter((category) => includeInactive || category.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
    .map((category) => ({ ...category, schemaVersion: version }));
}

export function getEffectiveCategory(code: string): EffectiveCategory | undefined {
  return listEffectiveCategories(true).find((category) => category.code === code);
}

export function requireEffectiveCategory(code: string): EffectiveCategory {
  const category = getEffectiveCategory(code);
  if (!category) throw AppError.badRequest(`分类不存在：${code}`);
  if (!category.isActive) throw AppError.badRequest(`分类已停用：${category.name}`);
  return category;
}

/**
 * 解析分类并返回数据库行 ID（spots.categoryId 外键需要）。
 * 正常情况下分类行在配置发布时已物化；只有"全新库、配置从未发布、
 * 请求直接跑在内置默认配置上"时才会走到惰性创建分支。
 */
export async function resolveCategoryRow(code: string): Promise<EffectiveCategory & { id: bigint }> {
  const category = requireEffectiveCategory(code);
  const existing = await prisma.category.findUnique({ where: { code } });
  if (existing) {
    return { ...category, id: existing.id };
  }

  const version = effectiveVersion() || 1;
  const created = await prisma.category.create({
    data: {
      code: category.code,
      name: category.name,
      icon: category.icon,
      color: category.color,
      description: category.description,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      schemas: {
        create: {
          version,
          schema: toJsonValue(category.schema),
          isCurrent: true,
        },
      },
    },
  });
  logger.warn({ code, version }, "分类行缺失，已按生效配置惰性创建");
  return { ...category, id: created.id };
}

/**
 * 审核路径专用：允许分类已停用（条目提交时仍启用，停用不应阻塞在途审核）。
 */
export async function resolveCategoryRowAllowInactive(
  code: string,
): Promise<EffectiveCategory & { id: bigint }> {
  const category = getEffectiveCategory(code);
  if (!category) throw AppError.badRequest(`分类不存在：${code}`);
  const existing = await prisma.category.findUnique({ where: { code } });
  if (existing) return { ...category, id: existing.id };

  const version = effectiveVersion() || 1;
  const created = await prisma.category.create({
    data: {
      code: category.code,
      name: category.name,
      icon: category.icon,
      color: category.color,
      description: category.description,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      schemas: { create: { version, schema: toJsonValue(category.schema), isCurrent: true } },
    },
  });
  return { ...category, id: created.id };
}

// ------------------------------------------------------------------ 版本写入（草稿 / 发布 / 灰度 / 回滚）

export interface VersionSummary {
  id: bigint;
  version: number;
  status: "draft" | "canary" | "active" | "archived";
  canaryRule: CanaryRule | null;
  note: string | null;
  createdBy: bigint | null;
  publishedBy: bigint | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  categoryCount: number;
  activeCategoryCount: number;
}

function summarize(row: {
  id: bigint;
  version: number;
  status: string;
  bundle: unknown;
  canaryRule: unknown;
  note: string | null;
  createdBy: bigint | null;
  publishedBy: bigint | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): VersionSummary {
  const bundle = isConfigBundle(row.bundle) ? row.bundle : null;
  return {
    id: row.id,
    version: row.version,
    status: row.status as VersionSummary["status"],
    canaryRule: row.status === "canary" ? normalizeCanaryRule(row.canaryRule) : null,
    note: row.note,
    createdBy: row.createdBy,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    categoryCount: bundle?.categories.length ?? 0,
    activeCategoryCount: bundle?.categories.filter((category) => category.isActive).length ?? 0,
  };
}

export async function listVersions(limit = 50): Promise<VersionSummary[]> {
  const rows = await prisma.appConfigVersion.findMany({
    orderBy: { version: "desc" },
    take: Math.min(limit, 200),
  });
  return rows.map(summarize);
}

export async function getVersion(version: number) {
  const row = await prisma.appConfigVersion.findUnique({ where: { version } });
  if (!row) throw AppError.notFound("配置版本不存在");
  return { ...summarize(row), bundle: row.bundle as unknown as ConfigBundle };
}

export async function getDraft() {
  const row = await prisma.appConfigVersion.findFirst({
    where: { status: "draft" },
    orderBy: { version: "desc" },
  });
  if (!row) return null;
  return { ...summarize(row), bundle: row.bundle as unknown as ConfigBundle };
}

type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function nextVersion(tx: PrismaTx): Promise<number> {
  const latest = await tx.appConfigVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
  return (latest?.version ?? 0) + 1;
}

/**
 * 发布前的数据完整性闸门：
 * 分类是条目的外键关联目标，新版本若删掉仍有条目（含未删除的历史条目）使用的分类，
 * 老条目会无法解释。要求先保留（可停用），等数据迁移后再删。
 */
async function assertNoOrphanedCategories(
  tx: PrismaTx,
  bundle: ConfigBundle,
): Promise<void> {
  const codes = bundle.categories.map((category) => category.code);
  const orphaned = await tx.category.findMany({
    where: {
      code: { notIn: codes },
      spots: { some: { deletedAt: null } },
    },
    select: { code: true, name: true, _count: { select: { spots: { where: { deletedAt: null } } } } },
  });
  if (orphaned.length > 0) {
    const detail = orphaned.map((row) => `${row.name}（${row.code}，${row._count.spots} 条）`).join("、");
    throw AppError.badRequest(
      `以下分类仍被条目使用，不能直接删除，请先在配置中保留并停用它们：${detail}`,
    );
  }
}

/** 取一份可编辑的草稿：没有就用当前全量配置初始化一个 */
export async function ensureDraft(actorId: bigint, baseVersion?: number) {
  const existing = await prisma.appConfigVersion.findFirst({
    where: { status: "draft" },
    orderBy: { version: "desc" },
  });

  let base: ConfigBundle;
  if (baseVersion !== undefined) {
    const row = await prisma.appConfigVersion.findUnique({ where: { version: baseVersion } });
    if (!row || !isConfigBundle(row.bundle)) throw AppError.notFound("基准配置版本不存在");
    base = row.bundle;
  } else if (existing) {
    return { ...summarize(existing), bundle: existing.bundle as unknown as ConfigBundle, created: false };
  } else {
    const state = await refreshConfig();
    base = state.active.bundle;
  }

  // 全局只保留一个草稿：基于历史版本重建时，直接把现有草稿内容重置为基准内容
  if (existing) {
    const updated = await prisma.appConfigVersion.update({
      where: { id: existing.id },
      data: { bundle: toJsonValue(cloneBundle(base)), createdBy: actorId },
    });
    await invalidateConfig();
    return { ...summarize(updated), bundle: updated.bundle as unknown as ConfigBundle, created: false };
  }

  const row = await prisma.$transaction(async (tx) => {
    const version = await nextVersion(tx);
    return tx.appConfigVersion.create({
      data: {
        version,
        status: "draft",
        bundle: toJsonValue(cloneBundle(base)),
        createdBy: actorId,
      },
    });
  });
  await invalidateConfig();
  return { ...summarize(row), bundle: row.bundle as unknown as ConfigBundle, created: true };
}

/**
 * 全新库引导：版本表为空时写入 v1 全量配置并物化分类表。
 * 由种子脚本调用；幂等。
 */
export async function bootstrapInitialConfig(actorId?: bigint): Promise<{ version: number; created: boolean }> {
  const latest = await prisma.appConfigVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
  if (latest) return { version: latest.version, created: false };

  const bundle = assertValidBundle(createDefaultBundle());
  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.appConfigVersion.create({
      data: {
        version: 1,
        status: "active",
        bundle: toJsonValue(bundle),
        note: "系统初始配置",
        createdBy: actorId,
        publishedBy: actorId,
        publishedAt: new Date(),
      },
    });
    await materializeCategories(tx, bundle, 1, actorId);
    return row.version;
  });
  await invalidateConfig();
  return { version: result, created: true };
}

export async function saveDraft(input: { bundle: unknown; note?: string | null; actorId: bigint }) {
  const bundle = assertValidBundle(input.bundle);
  const draft = await prisma.appConfigVersion.findFirst({
    where: { status: "draft" },
    orderBy: { version: "desc" },
  });
  if (!draft) throw AppError.conflict("VALIDATION_FAILED", "草稿不存在，请先创建草稿");

  const updated = await prisma.appConfigVersion.update({
    where: { id: draft.id },
    data: {
      bundle: toJsonValue(bundle),
      note: input.note === undefined ? undefined : input.note,
      createdBy: input.actorId,
    },
  });
  await invalidateConfig();
  return summarize(updated);
}

export async function discardDraft(actorId: bigint): Promise<void> {
  const draft = await prisma.appConfigVersion.findFirst({ where: { status: "draft" }, orderBy: { version: "desc" } });
  if (!draft) return;
  await prisma.appConfigVersion.update({ where: { id: draft.id }, data: { status: "archived", note: "草稿废弃" } });
  logger.info({ actorId: actorId.toString(), version: draft.version }, "配置草稿已废弃");
  await invalidateConfig();
}

/**
 * 全量发布时把分类物化到 categories / category_schemas 表。
 * 历史属性 Schema 行（category_schemas）只追加不改写，老条目永远能按旧版本解释。
 */
async function materializeCategories(
  tx: PrismaTx,
  bundle: ConfigBundle,
  configVersion: number,
  actorId?: bigint,
) {
  for (const category of bundle.categories) {
    const data = {
      code: category.code,
      name: category.name,
      icon: category.icon,
      color: category.color,
      description: category.description,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
    };

    const existing = await tx.category.findUnique({ where: { code: category.code } });
    let categoryId: bigint;
    if (existing) {
      categoryId = existing.id;
      await tx.category.update({ where: { id: existing.id }, data });
    } else {
      const created = await tx.category.create({ data });
      categoryId = created.id;
    }

    await ensureCategorySchema(tx, categoryId, category, configVersion, actorId, true);
  }
}

/**
 * 灰度物化：**只增不改**。
 * 关键隔离——灰度版本可能给分类改了名/颜色/停用状态，这些改动绝不能通过共享的
 * categories 表泄漏给非灰度用户。因此灰度只能：
 *   1) 为"全新分类"建行（否则灰度用户无法用新 categoryId 提交条目）；
 *   2) 追加该版本的属性 Schema 行（供修订记录引用）；
 * 已有分类行一律保持全量版本的内容不变。等灰度提升为全量时再做完整物化。
 */
async function materializeCanaryCategories(
  tx: PrismaTx,
  bundle: ConfigBundle,
  configVersion: number,
  actorId?: bigint,
) {
  for (const category of bundle.categories) {
    let categoryId: bigint | undefined;
    const existing = await tx.category.findUnique({ where: { code: category.code } });
    if (existing) {
      categoryId = existing.id;
    } else {
      // 全新分类：以非激活状态建行。普通用户的分类列表走配置过滤根本看不到它，
      // isActive=false 是防止任何绕过配置的直查路径把灰度分类泄露出去。
      const created = await tx.category.create({
        data: {
          code: category.code,
          name: category.name,
          icon: category.icon,
          color: category.color,
          description: category.description,
          sortOrder: category.sortOrder,
          isActive: false,
        },
      });
      categoryId = created.id;
    }
    await ensureCategorySchema(tx, categoryId, category, configVersion, actorId, false);
  }
}

async function ensureCategorySchema(
  tx: PrismaTx,
  categoryId: bigint,
  category: ConfigBundle["categories"][number],
  configVersion: number,
  actorId: bigint | undefined,
  isFull: boolean,
) {
  const versioned = await tx.categorySchema.findFirst({
    where: { categoryId, version: configVersion },
  });
  if (versioned) return;

  if (isFull) {
    // 只有全量发布才切换 isCurrent 指针；灰度版本绝不能顶掉"当前 Schema"
    await tx.categorySchema.updateMany({ where: { categoryId, isCurrent: true }, data: { isCurrent: false } });
  }
  await tx.categorySchema.create({
    data: {
      categoryId,
      version: configVersion,
      schema: toJsonValue(category.schema),
      isCurrent: isFull,
      createdBy: actorId,
    },
  });
}

export interface PublishResult {
  version: number;
  status: "active" | "canary";
  canary?: boolean;
}

/**
 * 发布配置。
 * - mode=full：新版本成为唯一 active，旧 active/canary 归档
 * - mode=canary：新版本成为 canary，当前 active 保持不变
 * fromVersion 缺省取草稿；传历史版本号即"一键回滚/重发任意版本"
 * （内容相同也会产生新版本号，保证审计链完整）
 */
export async function publishVersion(input: {
  mode: "full" | "canary";
  canaryRule?: CanaryRule;
  note?: string | null;
  actorId: bigint;
  fromVersion?: number;
}): Promise<PublishResult> {
  const result = await prisma.$transaction(async (tx) => {
    let sourceBundle: ConfigBundle;

    if (input.fromVersion !== undefined) {
      const row = await tx.appConfigVersion.findUnique({ where: { version: input.fromVersion } });
      if (!row || !isConfigBundle(row.bundle)) throw AppError.notFound("要发布的配置版本不存在");
      sourceBundle = row.bundle;
    } else {
      const draft = await tx.appConfigVersion.findFirst({
        where: { status: "draft" },
        orderBy: { version: "desc" },
      });
      if (!draft) throw AppError.conflict("VALIDATION_FAILED", "没有可发布的草稿");
      if (!isConfigBundle(draft.bundle)) throw AppError.badRequest("草稿内容损坏，无法发布");
      sourceBundle = draft.bundle;
    }
    // 发布前再过一次校验，防止绕过 API 直接写库的脏数据生效
    const bundle = assertValidBundle(sourceBundle);
    // 存量数据完整性：不能删掉仍被条目引用的分类
    await assertNoOrphanedCategories(tx, bundle);

    const version = await nextVersion(tx);

    if (input.mode === "full") {
      await tx.appConfigVersion.updateMany({
        where: { status: { in: ["active", "canary", "draft"] } },
        data: { status: "archived" },
      });
    } else {
      // 同一时刻只允许一个灰度版本，新灰度顶替旧灰度
      await tx.appConfigVersion.updateMany({
        where: { status: "canary" },
        data: { status: "archived" },
      });
      await tx.appConfigVersion.updateMany({ where: { status: "draft" }, data: { status: "archived" } });
    }

    const dbStatus: AppConfigStatus = input.mode === "full" ? "active" : "canary";
    const created = await tx.appConfigVersion.create({
      data: {
        version,
        status: dbStatus,
        bundle: toJsonValue(bundle),
        canaryRule:
          input.mode === "canary"
            ? toJsonValue(input.canaryRule ?? { percent: 0, userUuids: [] })
            : Prisma.JsonNull,
        note: input.note ?? null,
        createdBy: input.actorId,
        publishedBy: input.actorId,
        publishedAt: new Date(),
      },
    });

    if (input.mode === "full") {
      await materializeCategories(tx, bundle, version, input.actorId);
    } else {
      // 灰度物化只增不改，绝不让灰度的分类改名/停用泄漏给非灰度用户
      await materializeCanaryCategories(tx, bundle, version, input.actorId);
    }
    return { version: created.version, status: dbStatus };
  });

  await invalidateConfig();
  return { version: result.version, status: result.status === "active" ? "active" : "canary", canary: result.status === "canary" };
}

/**
 * 把当前灰度版本提升为全量（内容不变，状态流转，不新增版本号）。
 * 此刻才执行完整物化：灰度期间"只增不改"的分类行被更新为灰度内容，
 * isCurrent 指针切到该版本的属性 Schema。
 */
export async function promoteCanary(actorId: bigint): Promise<{ version: number }> {
  const state = await refreshConfig(true);
  if (!state.canary) throw AppError.conflict("VALIDATION_FAILED", "当前没有进行中的灰度");

  const { id, version, bundle } = state.canary;

  await prisma.$transaction(async (tx) => {
    await tx.appConfigVersion.updateMany({ where: { status: "active" }, data: { status: "archived" } });
    await tx.appConfigVersion.update({
      where: { id },
      data: { status: "active", canaryRule: Prisma.JsonNull, publishedBy: actorId, publishedAt: new Date() },
    });
    await materializeCategories(tx, bundle, version, actorId);
  });

  logger.info({ actorId: actorId.toString(), version }, "灰度配置已全量");
  await invalidateConfig();
  return { version };
}

/** 结束灰度：灰度行归档，所有请求回到当前 active */
export async function stopCanary(actorId: bigint): Promise<void> {
  const state = await refreshConfig(true);
  if (!state.canary) throw AppError.conflict("VALIDATION_FAILED", "当前没有进行中的灰度");
  await prisma.appConfigVersion.update({ where: { id: state.canary.id }, data: { status: "archived" } });
  logger.info({ actorId: actorId.toString(), version: state.canary.version }, "灰度已中止");
  await invalidateConfig();
}

/** 预演：不写库，只返回"某用户/某桶在某版本下会看到什么" */
export async function previewVersion(input: {
  version?: number;
  bundle?: unknown;
  viewerUuid?: string;
  bucketId?: string;
  role?: AuthUser["role"];
}): Promise<{
  effectiveVersion: number;
  canary: boolean;
  categories: Array<Pick<EffectiveCategory, "code" | "name" | "isActive" | "schemaVersion">>;
  thresholds: ConfigBundle["thresholds"];
}> {
  let bundle: ConfigBundle;
  let version: number;

  if (input.bundle !== undefined) {
    bundle = assertValidBundle(input.bundle);
    version = -1;
  } else {
    const row = await prisma.appConfigVersion.findUnique({ where: { version: input.version ?? -1 } });
    if (!row || !isConfigBundle(row.bundle)) throw AppError.notFound("配置版本不存在");
    bundle = row.bundle;
    version = row.version;
  }

  const viewer =
    input.viewerUuid || input.role
      ? ({ uuid: input.viewerUuid ?? "", role: input.role ?? "user" } as AuthUser)
      : undefined;
  const bucketId = input.bucketId ?? viewer?.uuid ?? "preview-anonymous";

  // 灰度版本按其规则判定；全量/草稿内容永远全量可见
  const canaryRow = version >= 0 ? await prisma.appConfigVersion.findUnique({ where: { version } }) : null;
  const canary =
    canaryRow?.status === "canary" ? isInCanary(normalizeCanaryRule(canaryRow.canaryRule), viewer, bucketId) : false;

  return {
    effectiveVersion: version,
    canary,
    categories: bundle.categories
      .filter((category) => category.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((category) => ({
        code: category.code,
        name: category.name,
        isActive: category.isActive,
        schemaVersion: version,
      })),
    thresholds: bundle.thresholds,
  };
}

// 热路径（如确认冷却期）避免 await：优先取当前请求上下文（含灰度），
// 请求外（worker）取全量缓存；首次 refreshConfig 完成前同步返回默认值。
export function cachedThresholds(): ConfigBundle["thresholds"] {
  return (
    currentContext()?.bundle.thresholds ??
    cache?.active.bundle.thresholds ??
    createDefaultBundle().thresholds
  );
}

export { CONFIG_COOKIE as CONFIG_BUCKET_COOKIE };
