import {
  getEffectiveCategory,
  listEffectiveCategories,
  resolveCategoryRow,
  resolveCategoryRowAllowInactive,
  type EffectiveCategory,
} from "../appconfig/service";

/**
 * 分类数据已全部迁移到在线配置（见 modules/appconfig）。
 * 这里保留兼容外观，spots / reviews 等模块仍可用 requireCategoryByCode 等名字，
 * 读到的永远是当前请求生效（含灰度）的配置。
 */
export type CategoryWithSchema = EffectiveCategory;

export function listCategories(options: { includeInactive?: boolean } = {}): Promise<EffectiveCategory[]> {
  return Promise.resolve(listEffectiveCategories(options.includeInactive));
}

export function getCategoryByCode(code: string): EffectiveCategory | undefined {
  return getEffectiveCategory(code);
}

/** 返回生效配置 + 数据库行 ID（外键写入需要）；行缺失时惰性物化 */
export function requireCategoryByCode(code: string): Promise<EffectiveCategory & { id: bigint }> {
  return resolveCategoryRow(code);
}

/**
 * 审核/改判路径使用：条目提交时分类还是启用的，之后被停用不应阻塞它通过审核。
 * 属性仍按当前生效 Schema 校验，只是不要求分类处于启用状态。
 */
export function requireCategoryForReview(code: string): Promise<EffectiveCategory & { id: bigint }> {
  return resolveCategoryRowAllowInactive(code);
}
