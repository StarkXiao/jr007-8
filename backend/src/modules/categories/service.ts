import { prisma } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { isAttributeSchema, type AttributeSchema } from "./schemaValidator";
import { resolveConfig } from "../config/service";

export interface CategoryWithSchema {
  id: bigint;
  code: string;
  name: string;
  icon: string;
  color: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  schema: AttributeSchema;
  schemaVersion: number;
}

/**
 * 分类与属性 Schema 的读取全部来自在线配置（支持灰度）。
 * categories 物化表仅用于外键关联，这里按 code 补上它的数字 id。
 */
export async function listCategories(
  options: { includeInactive?: boolean; user?: { id: bigint; uuid: string; role: string } } = {},
): Promise<Array<CategoryWithSchema & { configStatus: "active" | "canary" }>> {
  const config = await resolveConfig(options.user);
  const codes = config.categories.map((category) => category.code);
  const materialized = codes.length
    ? await prisma.category.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })
    : [];
  const idByCode = new Map(materialized.map((row) => [row.code, row.id]));

  return config.categories
    .filter((category) => options.includeInactive || category.isActive)
    .map((category) => {
      if (!isAttributeSchema(category.schema)) {
        throw new AppError(500, "INTERNAL_ERROR", `分类 ${category.code} 的属性 Schema 不合法`);
      }
      return {
        // 灰度中新分类可能尚未物化（只在发布时物化），用 0 占位；调用方只在需要外键时才用 id
        id: idByCode.get(category.code) ?? 0n,
        code: category.code,
        name: category.name,
        icon: category.icon,
        color: category.color,
        description: category.description,
        sortOrder: category.sortOrder,
        isActive: category.isActive,
        schema: category.schema,
        schemaVersion: config.version,
        configStatus: config.status,
      };
    });
}

export async function getCategoryByCode(
  code: string,
  user?: { id: bigint; uuid: string; role: string },
): Promise<(CategoryWithSchema & { configStatus: "active" | "canary" }) | undefined> {
  const categories = await listCategories({ includeInactive: true, user });
  return categories.find((category) => category.code === code);
}

export async function requireCategoryByCode(
  code: string,
  user?: { id: bigint; uuid: string; role: string },
): Promise<CategoryWithSchema & { configStatus: "active" | "canary" }> {
  const category = await getCategoryByCode(code, user);
  if (!category) throw AppError.badRequest(`分类不存在：${code}`);
  if (!category.isActive) throw AppError.badRequest(`分类已停用：${category.name}`);
  return category;
}

/**
 * 取分类在物化表里的真实数字 id（spots.categoryId 外键需要）。
 * 灰度里新增的分类在发布时已以「停用」补建到物化表，所以这里一定查得到；
 * 查不到属于数据不一致，直接 500 而不是静默写入 0。
 */
export async function requireMaterializedCategoryId(code: string): Promise<bigint> {
  const row = await prisma.category.findUnique({ where: { code }, select: { id: true } });
  if (!row) throw new AppError(500, "INTERNAL_ERROR", `分类 ${code} 尚未物化，无法关联条目`);
  return row.id;
}
