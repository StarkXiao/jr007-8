import { describe, expect, it } from "vitest";
import { assertValidBundle, BUNDLE_FORMAT_VERSION, type ConfigBundle } from "../../src/modules/appconfig/bundle";
import { createDefaultBundle } from "../../src/modules/appconfig/defaults";
import { isInCanary } from "../../src/modules/appconfig/service";
import type { AuthUser } from "../../src/types/auth";

function validBundle(): ConfigBundle {
  return createDefaultBundle();
}

describe("配置包结构校验", () => {
  it("内置默认配置合法", () => {
    expect(() => assertValidBundle(validBundle())).not.toThrow();
  });

  it("拒绝空分类列表", () => {
    const bundle = validBundle();
    bundle.categories = [];
    expect(() => assertValidBundle(bundle)).toThrow(/至少/);
  });

  it("拒绝重复分类代码", () => {
    const bundle = validBundle();
    bundle.categories[1]!.code = bundle.categories[0]!.code;
    expect(() => assertValidBundle(bundle)).toThrow(/重复/);
  });

  it("拒绝非法颜色", () => {
    const bundle = validBundle();
    bundle.categories[0]!.color = "red";
    expect(() => assertValidBundle(bundle)).toThrow(/#RRGGBB/);
  });

  it("分类代码必须是小写下划线格式", () => {
    const bundle = validBundle();
    bundle.categories[0]!.code = "Bad-Code";
    expect(() => assertValidBundle(bundle)).toThrow();
  });

  it("属性 Schema 复用严格校验：未知类型被拦", () => {
    const bundle = validBundle();
    (bundle.categories[0]!.schema.properties as Record<string, unknown>).weird = { type: "date" };
    expect(() => assertValidBundle(bundle)).toThrow();
  });

  it("必填字段没有对应属性定义时拒绝", () => {
    const bundle = validBundle();
    bundle.categories[0]!.schema.required = ["missing_field"];
    expect(() => assertValidBundle(bundle)).toThrow(/必填字段/);
  });

  it("阈值越界被拒绝", () => {
    const bundle = validBundle();
    bundle.thresholds.maxPageSize = 10000;
    expect(() => assertValidBundle(bundle)).toThrow(/最大分页大小/);
  });

  it("默认分页大于最大分页时拒绝", () => {
    const bundle = validBundle();
    bundle.thresholds.defaultPageSize = 200;
    bundle.thresholds.maxPageSize = 50;
    expect(() => assertValidBundle(bundle)).toThrow(/不能小于/);
  });

  it("非整数的整数阈值被拒绝", () => {
    const bundle = validBundle();
    bundle.thresholds.staleReportThreshold = 2.5;
    expect(() => assertValidBundle(bundle)).toThrow(/整数/);
  });

  it("格式版本不符被拒绝", () => {
    const bundle = validBundle() as unknown as Record<string, unknown>;
    bundle.formatVersion = 999;
    expect(() => assertValidBundle(bundle)).toThrow(/格式版本/);
  });
});

describe("灰度分桶", () => {
  const admin = { uuid: "11111111-1111-1111-1111-111111111111", role: "admin" } as AuthUser;
  const whitelisted = { uuid: "22222222-2222-2222-2222-222222222222", role: "user" } as AuthUser;

  it("管理员始终命中灰度", () => {
    expect(isInCanary({ percent: 0, userUuids: [] }, admin, "anything")).toBe(true);
  });

  it("白名单用户命中，即使比例为 0", () => {
    expect(isInCanary({ percent: 0, userUuids: [whitelisted.uuid] }, whitelisted, "x")).toBe(true);
  });

  it("0% 时普通用户不命中，100% 时全部命中", () => {
    const user = { uuid: "33333333-3333-3333-3333-333333333333", role: "user" } as AuthUser;
    expect(isInCanary({ percent: 0, userUuids: [] }, user, user.uuid)).toBe(false);
    expect(isInCanary({ percent: 100, userUuids: [] }, user, user.uuid)).toBe(true);
  });

  it("同一桶 ID 的判定是确定性的（不会刷新就变）", () => {
    const rule = { percent: 30, userUuids: [] };
    const first = isInCanary(rule, undefined, "stable-anonymous-bucket");
    for (let i = 0; i < 20; i += 1) {
      expect(isInCanary(rule, undefined, "stable-anonymous-bucket")).toBe(first);
    }
  });

  it("约 10% 比例下分布在合理区间", () => {
    let hits = 0;
    for (let i = 0; i < 5000; i += 1) {
      if (isInCanary({ percent: 10, userUuids: [] }, undefined, `bucket-${i}`)) hits += 1;
    }
    // 期望值 500，放宽到 350-650，避免偶发
    expect(hits).toBeGreaterThan(350);
    expect(hits).toBeLessThan(650);
  });
});
