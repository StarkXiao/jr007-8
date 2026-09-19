import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";

// 在线配置的生命周期：
//   读取 -> 建草稿 -> 保存（非法被拒）-> 预演 -> 全量发布 -> 分类立即变化
//   -> 灰度发布（白名单命中 / 普通用户不命中）-> 提升全量 -> 一键回滚
let app: Express;
let adminToken = "";
let userToken = "";
let adminUuid = "";
let userUuid = "";
let adminId = 0n;
let userId = 0n;

const suffix = Date.now().toString(36);
const adminEmail = `cfg-admin-${suffix}@example.com`;
const userEmail = `cfg-user-${suffix}@example.com`;
const password = "Str0ngPass1";

async function login(account: string): Promise<{ token: string; uuid: string }> {
  const response = await request(app).post("/api/v1/auth/login").send({ account, password }).expect(200);
  return { token: response.body.data.accessToken, uuid: response.body.data.user.uuid };
}

beforeAll(async () => {
  await initStorage();
  app = createApp();

  await request(app).post("/api/v1/auth/register").send({ email: adminEmail, password, nickname: "配置管理员" });
  await request(app).post("/api/v1/auth/register").send({ email: userEmail, password, nickname: "配置用户" });
  await prisma.user.update({ where: { email: adminEmail }, data: { role: "admin" } });

  const admin = await login(adminEmail);
  const user = await login(userEmail);
  adminToken = admin.token;
  adminUuid = admin.uuid;
  userToken = user.token;
  userUuid = user.uuid;

  const adminRow = await prisma.user.findUnique({ where: { uuid: adminUuid }, select: { id: true } });
  const userRow = await prisma.user.findUnique({ where: { uuid: userUuid }, select: { id: true } });
  adminId = adminRow?.id ?? 0n;
  userId = userRow?.id ?? 0n;
}, 60000);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [adminId, userId].filter((id) => id !== 0n) } } });
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("在线配置生命周期", () => {
  it("公开接口返回分类与生效版本头", async () => {
    const response = await request(app).get("/api/v1/categories").expect(200);
    expect(response.body.data.items.length).toBeGreaterThan(0);
    expect(response.headers["x-config-version"]).toBeDefined();
  });

  it("非管理员不能访问配置管理接口", async () => {
    await request(app).get("/api/v1/admin/config").set(auth(userToken)).expect(403);
  });

  it("管理员能看到当前状态（可能是种子引导的 v1，也可能已经被其他测试推进）", async () => {
    const response = await request(app).get("/api/v1/admin/config").set(auth(adminToken)).expect(200);
    expect(response.body.data.thresholdLabels).toBeTruthy();
  });

  it("草稿保存非法阈值会被拒绝", async () => {
    await request(app).post("/api/v1/admin/config/draft").set(auth(adminToken)).expect(201);
    const draft = await request(app).get("/api/v1/admin/config/draft").set(auth(adminToken)).expect(200);
    const bundle = draft.body.data.draft.bundle;
    bundle.thresholds.maxPageSize = 99999;

    await request(app)
      .put("/api/v1/admin/config/draft")
      .set(auth(adminToken))
      .send({ bundle })
      .expect(400);
  });

  it("保存合法草稿后校验接口通过", async () => {
    const draft = await request(app).get("/api/v1/admin/config/draft").set(auth(adminToken)).expect(200);
    const bundle = draft.body.data.draft.bundle;
    bundle.categories[0].description = "集成测试修改的分类描述";

    const saved = await request(app)
      .put("/api/v1/admin/config/draft")
      .set(auth(adminToken))
      .send({ bundle, note: "集成测试草稿" })
      .expect(200);
    expect(saved.body.data.version).toBeGreaterThan(0);

    const validation = await request(app)
      .post("/api/v1/admin/config/validate")
      .set(auth(adminToken))
      .send({ bundle })
      .expect(200);
    expect(validation.body.data.valid).toBe(true);
  });

  it("草稿预演不写库就能算出指定用户视角", async () => {
    const draft = await request(app).get("/api/v1/admin/config/draft").set(auth(adminToken)).expect(200);
    const preview = await request(app)
      .post("/api/v1/admin/config/preview")
      .set(auth(adminToken))
      .send({ bundle: draft.body.data.draft.bundle, role: "user", viewerUuid: userUuid })
      .expect(200);
    expect(preview.body.data.categories.length).toBeGreaterThan(0);
  });

  let fullVersion = 0;
  it("全量发布后公开接口立即看到改动", async () => {
    const before = await request(app).get("/api/v1/categories").expect(200);
    const target = before.body.data.items.find((item: { code: string }) => item.code === "bench");
    expect(target.description).not.toBe("集成测试修改的分类描述");

    const published = await request(app)
      .post("/api/v1/admin/config/publish")
      .set(auth(adminToken))
      .send({ mode: "full", note: "集成测试全量" })
      .expect(201);
    fullVersion = published.body.data.version;

    const after = await request(app).get("/api/v1/categories").expect(200);
    const changed = after.body.data.items.find((item: { code: string }) => item.code === "bench");
    expect(changed.description).toBe("集成测试修改的分类描述");
    expect(Number(after.headers["x-config-version"])).toBe(fullVersion);
  });

  let canaryVersion = 0;
  it("灰度：白名单用户命中，普通用户不命中", async () => {
    // 再造一个草稿：改阈值作为可观测差异
    await request(app).post("/api/v1/admin/config/draft").set(auth(adminToken)).expect(201);
    const draft = await request(app).get("/api/v1/admin/config/draft").set(auth(adminToken)).expect(200);
    const bundle = draft.body.data.draft.bundle;
    bundle.thresholds.commentMaxEdits = 7;

    await request(app)
      .put("/api/v1/admin/config/draft")
      .set(auth(adminToken))
      .send({ bundle, note: "集成测试灰度" })
      .expect(200);

    const published = await request(app)
      .post("/api/v1/admin/config/publish")
      .set(auth(adminToken))
      .send({ mode: "canary", canaryRule: { percent: 0, userUuids: [] }, note: "0% 灰度仅管理员" })
      .expect(201);
    canaryVersion = published.body.data.version;

    // 管理员始终命中
    const adminView = await request(app).get("/api/v1/meta").set(auth(adminToken)).expect(200);
    expect(Number(adminView.headers["x-config-version"])).toBe(canaryVersion);
    expect(adminView.headers["x-config-canary"]).toBe("1");

    // 普通用户不命中（0% 且不在白名单）
    const userView = await request(app).get("/api/v1/meta").set(auth(userToken)).expect(200);
    expect(Number(userView.headers["x-config-version"])).toBe(fullVersion);
    expect(userView.headers["x-config-canary"]).toBe("0");
  });

  it("白名单用户命中灰度", async () => {
    // 中止后用带白名单的规则重新灰度（中止后需要重新发一次，因为原行已归档）
    await request(app).post("/api/v1/admin/config/canary/stop").set(auth(adminToken)).expect(200);

    // 基于刚才的灰度版本内容重建草稿
    await request(app)
      .post("/api/v1/admin/config/draft")
      .set(auth(adminToken))
      .send({ baseVersion: canaryVersion })
      .expect(201);
    await request(app)
      .post("/api/v1/admin/config/publish")
      .set(auth(adminToken))
      .send({ mode: "canary", canaryRule: { percent: 0, userUuids: [userUuid] } })
      .expect(201);

    const userView = await request(app).get("/api/v1/meta").set(auth(userToken)).expect(200);
    expect(userView.headers["x-config-canary"]).toBe("1");
  });

  it("灰度提升为全量后普通用户也切换", async () => {
    await request(app).post("/api/v1/admin/config/canary/promote").set(auth(adminToken)).expect(200);
    const userView = await request(app).get("/api/v1/meta").set(auth(userToken)).expect(200);
    expect(userView.headers["x-config-canary"]).toBe("0");
    expect(userView.body.data.config.thresholds.commentMaxEdits).toBe(7);
  });

  it("一键回滚到任意历史版本，产生新版本号", async () => {
    const rolled = await request(app)
      .post("/api/v1/admin/config/publish")
      .set(auth(adminToken))
      .send({ mode: "full", fromVersion: fullVersion, note: `回滚到 v${fullVersion}` })
      .expect(201);
    expect(rolled.body.data.version).toBeGreaterThan(fullVersion);

    const view = await request(app).get("/api/v1/meta").set(auth(userToken)).expect(200);
    expect(view.body.data.config.thresholds.commentMaxEdits).not.toBe(7);
  });

  it("版本历史里所有版本都在（回滚不删除历史）", async () => {
    const versions = await request(app)
      .get("/api/v1/admin/config/versions?limit=100")
      .set(auth(adminToken))
      .expect(200);
    const numbers = versions.body.data.items
      .map((item: { version?: number }) => item.version)
      .filter((v: number | undefined): v is number => typeof v === "number");
    expect(numbers).toContain(fullVersion);
    expect(numbers).toContain(canaryVersion);
  });
});
