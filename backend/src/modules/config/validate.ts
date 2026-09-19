import { AppError } from "../../utils/errors";
import { assertValidSchema } from "../categories/schemaValidator";
import { THRESHOLD_SPECS, type ConfigPayload, type RolloutRule, type Thresholds } from "./types";

const CATEGORY_CODE_RE = /^[a-z][a-z0-9_]{1,31}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function fail(message: string, details?: unknown): never {
  throw AppError.badRequest(message, details);
}

/** 校验一个分类定义；属性 Schema 复用已有的严格校验器 */
function validateCategory(input: unknown, index: number): void {
  if (!input || typeof input !== "object") fail(`第 ${index + 1} 个分类格式不正确`);
  const category = input as Record<string, unknown>;
  const where = `第 ${index + 1} 个分类（${String(category.code ?? "?")}）`;

  if (typeof category.code !== "string" || !CATEGORY_CODE_RE.test(category.code)) {
    fail(`${where} 的代码不合法：只能是小写字母开头、含小写字母/数字/下划线，2–32 位`);
  }
  if (typeof category.name !== "string" || category.name.trim().length < 1 || category.name.length > 16) {
    fail(`${where} 的名称需为 1–16 个字符`);
  }
  if (typeof category.icon !== "string" || category.icon.length < 1 || category.icon.length > 64) {
    fail(`${where} 的图标标识不合法`);
  }
  if (typeof category.color !== "string" || !COLOR_RE.test(category.color)) {
    fail(`${where} 的颜色需为 #RRGGBB 格式`);
  }
  if (category.description !== null && category.description !== undefined) {
    if (typeof category.description !== "string" || category.description.length > 200) {
      fail(`${where} 的描述需为不超过 200 字的文本或 null`);
    }
  }
  if (typeof category.sortOrder !== "number" || !Number.isInteger(category.sortOrder) || category.sortOrder < 0 || category.sortOrder > 999) {
    fail(`${where} 的排序值需为 0–999 的整数`);
  }
  if (typeof category.isActive !== "boolean") fail(`${where} 缺少 isActive 开关`);
  // 非法 Schema 会直接抛出带具体字段的错误
  assertValidSchema(category.schema);
}

/** 校验阈值：键必须在注册表内，数值必须落在允许区间，整数键不得给小数 */
function validateThresholds(input: unknown): Thresholds {
  if (!input || typeof input !== "object") fail("业务阈值必须是一个对象");
  const raw = input as Record<string, unknown>;
  const result = {} as Record<string, number>;

  for (const spec of THRESHOLD_SPECS) {
    const value = raw[spec.key] ?? spec.default;
    if (typeof value !== "number" || Number.isNaN(value)) {
      fail(`阈值「${spec.label}」必须是数字`);
    }
    if (spec.integer && !Number.isInteger(value)) {
      fail(`阈值「${spec.label}」必须是整数`);
    }
    if (value < spec.min || value > spec.max) {
      fail(`阈值「${spec.label}」超出允许范围：${spec.min} ~ ${spec.max}（当前 ${value}）`);
    }
    result[spec.key] = value;
  }

  const unknown = Object.keys(raw).filter((key) => !THRESHOLD_SPECS.some((spec) => spec.key === key));
  if (unknown.length > 0) fail(`存在未注册的阈值键：${unknown.join("、")}`);

  return result as Thresholds;
}

/** 校验整份配置草稿，并返回带默认值补全、可直接入库的干净副本 */
export function validatePayload(input: unknown): ConfigPayload {
  if (!input || typeof input !== "object") fail("配置内容必须是 { categories, thresholds } 结构");
  const { categories, thresholds } = input as Record<string, unknown>;
  if (!Array.isArray(categories) || categories.length === 0) {
    fail("至少要保留一个分类；全部下架请改为把各分类 isActive 置为 false");
  }
  if (categories.length > 50) fail("分类数量不能超过 50 个");

  categories.forEach(validateCategory);

  const codes = categories.map((category) => (category as { code: string }).code);
  if (new Set(codes).size !== codes.length) fail("分类代码存在重复，请先去重");

  const cleanThresholds = validateThresholds(thresholds);

  return {
    categories: (categories as ConfigPayload["categories"]).map((category) => ({
      ...category,
      description: category.description ?? null,
    })),
    thresholds: cleanThresholds,
  };
}

/** 灰度规则校验。允许空规则（等于不命中任何人）。 */
export function validateRollout(input: unknown): RolloutRule {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object") fail("灰度规则必须是对象");
  const rule = input as Record<string, unknown>;
  const clean: RolloutRule = {};

  if (rule.userModBase !== undefined) {
    if (typeof rule.userModBase !== "number" || !Number.isInteger(rule.userModBase) || rule.userModBase < 2 || rule.userModBase > 10000) {
      fail("灰度尾号取模的基数需为 2–10000 的整数");
    }
    clean.userModBase = rule.userModBase;
  }

  if (rule.userModRemainders !== undefined) {
    if (!Array.isArray(rule.userModRemainders) || rule.userModRemainders.some((n) => typeof n !== "number" || n < 0)) {
      fail("灰度命中余数需为非负整数数组");
    }
    clean.userModRemainders = rule.userModRemainders as number[];
  }

  if (clean.userModRemainders?.length && clean.userModBase !== undefined) {
    const outOfRange = clean.userModRemainders.filter((n) => n >= (clean.userModBase as number));
    if (outOfRange.length) fail(`灰度余数 ${outOfRange.join("、")} 超出取模基数范围`);
  }

  if (rule.roles !== undefined) {
    if (!Array.isArray(rule.roles) || rule.roles.some((role) => typeof role !== "string")) {
      fail("灰度角色需为字符串数组");
    }
    const allowed = new Set(["visitor", "user", "moderator", "admin"]);
    const bad = (rule.roles as string[]).filter((role) => !allowed.has(role));
    if (bad.length) fail(`灰度角色不合法：${bad.join("、")}`);
    clean.roles = rule.roles as string[];
  }

  if (rule.userUuids !== undefined) {
    if (!Array.isArray(rule.userUuids) || rule.userUuids.some((id) => typeof id !== "string")) {
      fail("灰度白名单需为 UUID 字符串数组");
    }
    clean.userUuids = rule.userUuids as string[];
  }

  if (rule.percent !== undefined) {
    if (typeof rule.percent !== "number" || Number.isNaN(rule.percent) || rule.percent < 0 || rule.percent > 100) {
      fail("灰度比例需为 0–100 的数字");
    }
    clean.percent = rule.percent;
  }

  return clean;
}

/**
 * 判断用户是否命中灰度。
 * 入参是登录用户的最小视图；游客（无 id）永远不命中——
 * 灰度要能定位到具体的人，才能在出问题时解释和回滚。
 */
export function matchesRollout(
  rule: RolloutRule | null | undefined,
  user: { id: bigint; uuid: string; role: string } | undefined,
): boolean {
  if (!rule || !user) return false;

  if (rule.roles?.length && rule.roles.includes(user.role)) return true;

  if (rule.userUuids?.length && rule.userUuids.includes(user.uuid)) return true;

  if (rule.userModBase && rule.userModRemainders?.length) {
    const remainder = Number(user.id % BigInt(rule.userModBase));
    if (rule.userModRemainders.includes(remainder)) return true;
  }

  if (rule.percent !== undefined && rule.percent > 0) {
    if (stableBucket(user.uuid) < rule.percent) return true;
  }

  return false;
}

/**
 * 由 UUID 派生稳定的 0–99 桶号：同一个用户每次结果一致，灰度名单不会随刷新乱跳。
 * 用 FNV-1a，32 位，够用且零依赖。
 */
export function stableBucket(uuid: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < uuid.length; i += 1) {
    hash ^= uuid.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}
