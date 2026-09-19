import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { listEffectiveCategories } from "../appconfig/service";

export const categoriesRouter = Router();
export const adminCategoriesRouter = Router();

// 分类与属性表单全部来自在线配置：
// 普通请求按调用者的灰度视角返回，管理端返回当前全量版本（含停用分类）。
// 配置改动通过 /admin/config/* 走版本化发布，不再存在绕过版本管理的直写入口。
categoriesRouter.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const categories = listEffectiveCategories();
    res.json(
      ok(req, {
        // 灰度命中时返回灰度版本号，响应头 X-Config-Version 同样可查
        configVersion: categories[0]?.schemaVersion ?? req.config?.activeVersion ?? 0,
        canary: req.config?.canary ?? false,
        items: categories.map((category) => ({
          code: category.code,
          name: category.name,
          icon: category.icon,
          color: category.color,
          description: category.description,
          sortOrder: category.sortOrder,
          schemaVersion: category.schemaVersion,
          schema: category.schema,
        })),
      }),
    );
  }),
);

adminCategoriesRouter.get(
  "/admin/categories",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const categories = listEffectiveCategories(true);
    res.json(
      ok(req, {
        items: categories.map((category) => ({
          code: category.code,
          name: category.name,
          icon: category.icon,
          color: category.color,
          description: category.description,
          sortOrder: category.sortOrder,
          isActive: category.isActive,
          schemaVersion: category.schemaVersion,
          schema: category.schema,
        })),
      }),
    );
  }),
);
