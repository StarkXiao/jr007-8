import { AppError } from "../../utils/errors";
import { assertValidSchema, type AttributeSchema } from "../categories/schemaValidator";

/**
 * 在线配置包：分类、属性表单与业务阈值的唯一事实来源。
 * 整体版本化——任何一项改动都会产生一个新的完整快照，
 * 这样灰度与回滚不需要按字段拼接，直接切换整包即可。
 */
export const BUNDLE_FORMAT_VERSION = 1;

export interface ConfigCategory {
  code: string;
  name: string;
  icon: string;
  color: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  schema: AttributeSchema;
}

export interface ConfigThresholds {
  /** 地图一次性查询的最大经纬度跨度 */
  maxBboxSpanDeg: number;
  defaultPageSize: number;
  maxPageSize: number;
  /** 评论发布后允许编辑的窗口（毫秒） */
  commentEditWindowMs: number;
  commentMaxEdits: number;
  /** 同一用户对同一条目的确认冷却期（毫秒） */
  confirmationCooldownMs: number;
  /** 过期上报达到该数量后条目进入待复核 */
  staleReportThreshold: number;
  /** 举报自动合并窗口（毫秒） */
  reportMergeWindowMs: number;
  /** 审核任务领取锁时长（毫秒） */
  reviewLockMs: number;
  /** 原图签名 URL 有效期（毫秒） */
  signedUrlTtlMs: number;
}

export interface ConfigBundle {
  formatVersion: number;
  categories: ConfigCategory[];
  thresholds: ConfigThresholds;
}

export interface CanaryRule {
  /** 命中灰度的用户桶百分比，0-100，按用户 UUID 确定性哈希 */
  percent: number;
  /** 显式命中的用户 UUID（内测账号 / 管理员预演） */
  userUuids: string[];
}

// 阈值的安全边界：在线配置允许调参，但不能把系统调成 DoS 或逻辑失效。
// 例如 maxPageSize 给到 10000 会让一次列表查询拖垮数据库。
const THRESHOLD_BOUNDS: Record<keyof ConfigThresholds, { min: number; max: number; integer?: boolean; label: string }> = {
  maxBboxSpanDeg: { min: 0.1, max: 90, label: "地图查询最大跨度（度）" },
  defaultPageSize: { min: 1, max: 200, integer: true, label: "默认分页大小" },
  maxPageSize: { min: 1, max: 500, integer: true, label: "最大分页大小" },
  commentEditWindowMs: { min: 0, max: 24 * 3600 * 1000, label: "评论编辑窗口（毫秒）" },
  commentMaxEdits: { min: 0, max: 20, integer: true, label: "评论可编辑次数" },
  confirmationCooldownMs: { min: 0, max: 365 * 24 * 3600 * 1000, label: "确认冷却期（毫秒）" },
  staleReportThreshold: { min: 1, max: 100, integer: true, label: "过期上报阈值" },
  reportMergeWindowMs: { min: 0, max: 30 * 24 * 3600 * 1000, label: "举报合并窗口（毫秒）" },
  reviewLockMs: { min: 60 * 1000, max: 24 * 3600 * 1000, label: "审核锁时长（毫秒）" },
  signedUrlTtlMs: { min: 30 * 1000, max: 60 * 60 * 1000, label: "签名 URL 有效期（毫秒）" },
};

export const THRESHOLD_LABELS: Record<keyof ConfigThresholds, string> = Object.fromEntries(
  Object.entries(THRESHOLD_BOUNDS).map(([key, meta]) => [key, meta.label]),
) as Record<keyof ConfigThresholds, string>;

const CATEGORY_CODE_RE = /^[a-z][a-z0-9_]{1,31}$/;

function fail(message: string): never {
  throw AppError.badRequest(message);
}

/**
 * 严格校验候选配置包。管理员保存草稿 / 发布 / 预演前都走这里，
 * 不让结构损坏的配置进入版本表。
 */
export function assertValidBundle(input: unknown): ConfigBundle {
  if (!input || typeof input !== "object") fail("配置包必须是对象");
  const candidate = input as Partial<ConfigBundle>;

  if (candidate.formatVersion !== BUNDLE_FORMAT_VERSION) {
    fail(`不支持的配置包格式版本：${String(candidate.formatVersion)}`);
  }

  if (!Array.isArray(candidate.categories)) fail("categories 必须是数组");
  if (candidate.categories.length === 0) fail("至少要保留一个分类");

  const seenCodes = new Set<string>();
  for (const raw of candidate.categories) {
    const category = raw as ConfigCategory;
    if (!category || typeof category !== "object") fail("存在不合法的分类定义");
    if (!CATEGORY_CODE_RE.test(category.code ?? "")) {
      fail(`分类代码不合法（小写字母开头，仅含小写字母/数字/下划线）：${String(category.code)}`);
    }
    if (seenCodes.has(category.code)) fail(`分类代码重复：${category.code}`);
    seenCodes.add(category.code);

    if (!category.name || category.name.length > 32) fail(`分类 ${category.code} 的名称必填且不超过 32 字`);
    if (!category.icon || category.icon.length > 64) fail(`分类 ${category.code} 的图标标识不合法`);
    if (!/^#[0-9A-Fa-f]{6}$/.test(category.color ?? "")) fail(`分类 ${category.code} 的颜色需为 #RRGGBB`);
    if (category.description != null && typeof category.description !== "string") {
      fail(`分类 ${category.code} 的描述必须是文本或 null`);
    }
    if (!Number.isInteger(category.sortOrder) || category.sortOrder < 0 || category.sortOrder > 9999) {
      fail(`分类 ${category.code} 的排序值需为 0-9999 的整数`);
    }
    if (typeof category.isActive !== "boolean") fail(`分类 ${category.code} 的 isActive 必须是布尔值`);
    // 复用既有的严格属性 Schema 校验，错误信息直接透传
    assertValidSchema(category.schema);
  }

  const rawThresholds = candidate.thresholds as Partial<ConfigThresholds> | undefined;
  if (!rawThresholds || typeof rawThresholds !== "object") fail("thresholds 必须是对象");

  for (const key of Object.keys(THRESHOLD_BOUNDS) as Array<keyof ConfigThresholds>) {
    const value = rawThresholds[key];
    const bound = THRESHOLD_BOUNDS[key];
    if (typeof value !== "number" || Number.isNaN(value)) fail(`${bound.label}必须是数字`);
    if (bound.integer && !Number.isInteger(value)) fail(`${bound.label}必须是整数`);
    if (value < bound.min || value > bound.max) {
      fail(`${bound.label}超出允许范围（${bound.min} ~ ${bound.max}）`);
    }
  }

  if (rawThresholds.maxPageSize! < rawThresholds.defaultPageSize!) {
    fail("最大分页大小不能小于默认分页大小");
  }

  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    categories: candidate.categories.map((category) => ({
      code: category.code,
      name: category.name,
      icon: category.icon,
      color: category.color,
      description: category.description ?? null,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      schema: category.schema,
    })),
    thresholds: rawThresholds as ConfigThresholds,
  };
}

export function isConfigBundle(value: unknown): value is ConfigBundle {
  if (!value || typeof value !== "object") return false;
  return (value as ConfigBundle).formatVersion === BUNDLE_FORMAT_VERSION;
}

/** 深拷贝配置包，避免调用方误改缓存里的共享对象 */
export function cloneBundle(bundle: ConfigBundle): ConfigBundle {
  return JSON.parse(JSON.stringify(bundle)) as ConfigBundle;
}
