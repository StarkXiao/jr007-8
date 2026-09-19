import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma";
import {
  discardDraft,
  ensureBootstrapConfig,
  getOrCreateDraft,
  invalidateConfigCache,
  previewConfig,
  publishDraft,
  resolveConfig,
  rollbackToVersion,
  revokeCanaryToDraft,
  updateCanaryRollout,
} from "../../src/modules/config/service";
import { buildDefaultConfig } from "../../src/modules/config/defaults";
import type { ConfigPayload, RolloutRule } from "../../src/modules/config/types";

// 在线配置完整生命周期：出厂引导 → 草稿 → 灰度（含命中判定）→ 转全量 → 回滚。
// 直接走 service 层，不经过 HTTP，重点验证状态机与解析逻辑。

const suffix = Date.now().toString(36);
let actorId = 0n;
let actorUuid = "";

function cloneDefault(): ConfigPayload {
  return structuredClone(buildDefaultConfig());
}

beforeAll(async () => {
  await ensureBootstrapConfig();

  // 用一个专属管理员账号承担所有操作，结束时清理
  const actor = await prisma.user.create({
    data: {
      email: `config-actor-${suffix}@example.com`,
      passwordHash: "x",
      nickname: `配置操作人${suffix.slice(-4)}`,
      role: "admin",
    },
    select: { id: true, uuid: true },
  });
  actorId = actor.id;
  actorUuid = actor.uuid;
}, 30000);

afterAll(async () => {
  // 恢复出厂 active，避免污染其它测试与本地库
  await prisma.appConfigVersion.deleteMany({});
  await prisma.appConfigVersion.create({
    data: {
      version: 1,
      status: "active",
      payload: cloneDefault() as never,
      publishedAt: new Date(),
      comment: "测试后恢复的出厂配置",
    },
  });
  await invalidateConfigCache();

  await prisma.user.deleteMany({ where: { id: actorId } });
  await prisma.$disconnect();
}, 30000);

describe("在线配置生命周期", () => {
  it("出厂引导后存在唯一 active，解析出默认阈值", async () => {
    await invalidateConfigCache();
    const config = await resolveConfig(undefined);
    expect(config.status).toBe("active");
    expect(config.thresholds.staleReportThreshold).toBe(3);
    expect(config.categories.length).toBeGreaterThan(0);
  });

  it("草稿不影响线上：保存草稿后系统解析仍是 active 旧值", async () => {
    await getOrCreateDraft(actorId);
    const { saveDraft } = await import("../../src/modules/config/service");

    const payload = cloneDefault();
    payload.thresholds.staleReportThreshold = 7;
    await saveDraft({ payload, actorId, comment: "草稿改阈值为 7" });

    // 游客 / 系统视角永远读 active
    const system = await resolveConfig(undefined);
    expect(system.thresholds.staleReportThreshold).toBe(3);
  });

  it("灰度发布：白名单用户读到 canary 新值，其他人读 active 旧值", async () => {
    const rollout: RolloutRule = { roles: ["admin"], userUuids: [actorUuid] };
    const published = await publishDraft({ mode: "canary", rollout, actorId, comment: "灰度：阈值 7" });
    expect(published.view.status).toBe("canary");

    const actor = { id: actorId, uuid: actorUuid, role: "admin" };
    const canaryConfig = await resolveConfig(actor);
    expect(canaryConfig.status).toBe("canary");
    expect(canaryConfig.thresholds.staleReportThreshold).toBe(7);

    // 一个不在白名单、非管理员的普通用户视角
    const outsider = { id: 999999n, uuid: "00000000-0000-0000-0000-000000000001", role: "user" };
    const activeConfig = await resolveConfig(outsider);
    expect(activeConfig.status).toBe("active");
    expect(activeConfig.thresholds.staleReportThreshold).toBe(3);
  });

  it("灰度扩缩量不产生新版本，立即改变命中范围", async () => {
    const before = await prisma.appConfigVersion.count({ where: { status: "canary" } });
    await updateCanaryRollout({ percent: 100 }, "扩到全量用户");
    const after = await prisma.appConfigVersion.count({ where: { status: "canary" } });
    expect(after).toBe(before);

    const outsider = { id: 999999n, uuid: "00000000-0000-0000-0000-000000000001", role: "user" };
    expect((await resolveConfig(outsider)).status).toBe("canary");
  });

  it("草稿预演返回命中说明", async () => {
    const result = await previewConfig({ id: actorId, uuid: actorUuid, role: "admin" });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain("命中");
  });

  it("撤回灰度：canary 回到草稿，线上恢复为 active", async () => {
    const draft = await revokeCanaryToDraft();
    expect(draft.status).toBe("draft");
    const outsider = { id: 999999n, uuid: "00000000-0000-0000-0000-000000000001", role: "user" };
    expect((await resolveConfig(outsider)).status).toBe("active");
  });

  it("全量发布：所有人读到新阈值，旧版本归档", async () => {
    const payload = cloneDefault();
    payload.thresholds.commentMaxEdits = 4;
    const { saveDraft } = await import("../../src/modules/config/service");
    await saveDraft({ payload, actorId, comment: "全量：评论可编辑 4 次" });

    const result = await publishDraft({ mode: "full", actorId, comment: "全量发布" });
    expect(result.view.status).toBe("active");

    await invalidateConfigCache();
    const anyone = await resolveConfig({ id: 999999n, uuid: "00000000-0000-0000-0000-000000000002", role: "user" });
    expect(anyone.thresholds.commentMaxEdits).toBe(4);

    const actives = await prisma.appConfigVersion.count({ where: { status: "active" } });
    expect(actives).toBe(1);
  });

  it("一键回滚：历史内容作为新 active 版本生效，版本号递增且不删历史", async () => {
    const historyBefore = await prisma.appConfigVersion.findMany({
      orderBy: { version: "asc" },
      select: { version: true, status: true },
    });
    const firstVersion = historyBefore[0]!.version;

    const rolledBack = await rollbackToVersion(firstVersion, actorId, "测试回滚");
    expect(rolledBack.status).toBe("active");
    expect(rolledBack.version).toBeGreaterThan(firstVersion);

    await invalidateConfigCache();
    const config = await resolveConfig(undefined);
    expect(config.thresholds.commentMaxEdits).toBe(1); // 出厂默认值
    expect(config.version).toBe(rolledBack.version);

    // 被回滚的那一版仍在档案里（archived），没有被物理删除
    const stillThere = await prisma.appConfigVersion.findUnique({ where: { version: firstVersion } });
    expect(stillThere).not.toBeNull();
  });

  it("丢弃草稿后解析不受影响", async () => {
    await getOrCreateDraft(actorId);
    await discardDraft();
    const config = await resolveConfig(undefined);
    expect(config.status).toBe("active");
  });
});
