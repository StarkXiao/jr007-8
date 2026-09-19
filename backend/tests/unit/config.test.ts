import { describe, expect, it } from "vitest";
import {
  matchesRollout,
  stableBucket,
  validatePayload,
  validateRollout,
} from "../../src/modules/config/validate";
import { buildDefaultConfig } from "../../src/modules/config/defaults";

describe("在线配置 - 灰度命中规则", () => {
  const user = { id: 123n, uuid: "550e8400-e29b-41d4-a716-446655440000", role: "user" };

  it("空规则与游客都不命中", () => {
    expect(matchesRollout({}, user)).toBe(false);
    expect(matchesRollout(null, user)).toBe(false);
    expect(matchesRollout({ percent: 100 }, undefined)).toBe(false);
  });

  it("按角色命中", () => {
    expect(matchesRollout({ roles: ["moderator", "admin"] }, user)).toBe(false);
    expect(matchesRollout({ roles: ["user"] }, user)).toBe(true);
  });

  it("按 UUID 白名单命中", () => {
    expect(matchesRollout({ userUuids: [user.uuid] }, user)).toBe(true);
    expect(matchesRollout({ userUuids: ["00000000-0000-0000-0000-000000000000"] }, user)).toBe(false);
  });

  it("按数字 ID 取模命中，且余数正确", () => {
    // 123 % 10 = 3
    expect(matchesRollout({ userModBase: 10, userModRemainders: [3] }, user)).toBe(true);
    expect(matchesRollout({ userModBase: 10, userModRemainders: [0, 1, 2] }, user)).toBe(false);
  });

  it("稳定桶号在 0–99 且同一 UUID 每次一致", () => {
    const a = stableBucket(user.uuid);
    const b = stableBucket(user.uuid);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(99);
  });

  it("按稳定哈希比例命中：100% 全中、0% 全不命中", () => {
    expect(matchesRollout({ percent: 100 }, user)).toBe(true);
    expect(matchesRollout({ percent: 0 }, user)).toBe(false);
  });
});

describe("在线配置 - 灰度规则校验", () => {
  it("拒绝超范围的取模余数", () => {
    expect(() => validateRollout({ userModBase: 10, userModRemainders: [10] })).toThrow();
  });

  it("拒绝非法比例", () => {
    expect(() => validateRollout({ percent: 101 })).toThrow();
  });

  it("接受合法规则", () => {
    expect(validateRollout({ percent: 20, roles: ["admin"] })).toEqual({ percent: 20, roles: ["admin"] });
    expect(validateRollout(null)).toEqual({});
  });
});

describe("在线配置 - payload 校验", () => {
  it("出厂默认配置始终合法", () => {
    const clean = validatePayload(buildDefaultConfig());
    expect(clean.categories.length).toBeGreaterThan(0);
    expect(clean.thresholds.staleReportThreshold).toBe(3);
  });

  it("分类代码重复时报错", () => {
    const payload = buildDefaultConfig();
    payload.categories[1] = { ...payload.categories[0]! };
    expect(() => validatePayload(payload)).toThrow(/重复/);
  });

  it("非法颜色 / 非法 Schema 报错", () => {
    const payload = buildDefaultConfig();
    payload.categories[0]!.color = "red";
    expect(() => validatePayload(payload)).toThrow();
  });

  it("阈值越界报错，未知阈值键报错", () => {
    const payload = buildDefaultConfig();
    payload.thresholds.staleReportThreshold = 999;
    expect(() => validatePayload(payload)).toThrow(/范围/);

    const payload2 = buildDefaultConfig();
    (payload2.thresholds as Record<string, number>).unknownKey = 1;
    expect(() => validatePayload(payload2)).toThrow(/未注册/);
  });

  it("缺省阈值会被注册表默认值补全", () => {
    const partial = { categories: buildDefaultConfig().categories, thresholds: {} };
    const clean = validatePayload(partial);
    expect(clean.thresholds.reviewLockMinutes).toBe(30);
  });
});
