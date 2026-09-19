import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { listCategories } from "./service";

export const categoriesRouter = Router();
export const adminCategoriesRouter = Router();

// 前端据此渲染动态属性表单。
// 走在线配置解析：命中灰度的用户拿到 canary 版本，其余人拿到 active 版本。
categoriesRouter.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const categories = await listCategories({ user: req.user });
    res.json(
      ok(req, {
        items: categories.map((category) => ({
          code: category.code,
          name: category.name,
          icon: category.icon,
          color: category.color,
          description: category.description,
          sortOrder: category.sortOrder,
          schemaVersion: category.schemaVersion,
          configStatus: category.configStatus,
          schema: category.schema,
        })),
      }),
    );
  }),
);

// 管理端：含停用分类
adminCategoriesRouter.get(
  "/admin/categories",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const categories = await listCategories({ includeInactive: true, user: req.user });
    res.json(
      ok(req, {
        items: categories.map((category) => ({
          id: category.id.toString(),
          code: category.code,
          name: category.name,
          icon: category.icon,
          color: category.color,
          description: category.description,
          sortOrder: category.sortOrder,
          isActive: category.isActive,
          schemaVersion: category.schemaVersion,
          configStatus: category.configStatus,
          schema: category.schema,
        })),
      }),
    );
  }),
);

// 分类的增删改与 Schema 发布已统一迁移到「在线配置」模块：
// 草稿 → 灰度 → 全量 / 回滚，见 /admin/config/*。
// 旧的 POST /admin/categories、PUT /admin/categories/:id/schema 已下线，
// 配置改动必须经过版本化流程，不能再绕过草稿直接生效。
