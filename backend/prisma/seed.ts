import bcrypt from "bcryptjs";
import { env } from "../src/config/env";
import { prisma, toJsonValue } from "../src/db/prisma";
import { randomPassword } from "../src/utils/crypto";
import { fuzzCoordinates } from "../src/services/geo";
import { bootstrapInitialConfig } from "../src/modules/appconfig/service";

// 分类与属性 Schema 的定义已经全部进入在线配置（见 src/modules/appconfig/defaults.ts）。
// 种子脚本只负责引导出 v1 全量配置并物化分类表，不再在代码里另存一份副本。

interface SpotSeed {
  categoryCode: string;
  title: string;
  description: string;
  attributes: Record<string, unknown>;
  lat: number;
  lng: number;
  addressText: string;
  status: "published" | "pending";
  fuzzRadiusM: number;
}

// 开发用演示数据：覆盖五个分类，坐标在上海几个公开的公共空间附近
const SPOTS: SpotSeed[] = [
  {
    categoryCode: "bench",
    title: "梧桐树下带靠背的长椅",
    description: "傍晚有树荫，旁边就是步道，坐着很舒服。周末上午人会多一点。",
    attributes: { has_backrest: true, count: 3, condition: "good", shade: "full", wheelchair_space: true, material: "mixed" },
    lat: 31.2318,
    lng: 121.4732,
    addressText: "上海市黄浦区人民大道附近",
    status: "published",
    fuzzRadiusM: 50,
  },
  {
    categoryCode: "drinking_water",
    title: "公园入口的直饮水龙头",
    description: "两个龙头，一个高一个低，低的那个推轮椅也能够到。冬天会关掉。",
    attributes: { type: "direct", free: true, height: "multi", temperature: "cold", open_hours: "6:00–21:00", closed_in_winter: true },
    lat: 31.2285,
    lng: 121.4698,
    addressText: "上海市黄浦区武胜路附近",
    status: "published",
    fuzzRadiusM: 30,
  },
  {
    categoryCode: "rain_shelter",
    title: "地铁口旁的遮雨棚",
    description: "下雨天等车能躲一下，能站十几个人，靠墙有一排窄座位。",
    attributes: { capacity: 15, has_seats: true, coverage: "medium", enclosed: false, lighting: true },
    lat: 31.2362,
    lng: 121.4805,
    addressText: "上海市黄浦区南京东路附近",
    status: "published",
    fuzzRadiusM: 50,
  },
  {
    categoryCode: "quiet_corner",
    title: "图书馆外侧的台阶角落",
    description: "工作日下午几乎没人，打过好几次电话都没被吵到。晚上七点后会有人来拍照。",
    attributes: {
      noise_level: "very_quiet",
      best_time: "afternoon",
      has_seats: false,
      crowd_level: "empty",
      good_for: ["phone_call", "reading"],
    },
    lat: 31.2241,
    lng: 121.4756,
    addressText: "上海市黄浦区淮海中路附近",
    status: "published",
    fuzzRadiusM: 50,
  },
  {
    categoryCode: "night_light",
    title: "沿河步道的夜间照明",
    description: "灯是 LED 的，整夜都亮。中间有一小段大约三十米比较暗，晚上走靠外侧更好。",
    attributes: { brightness: "moderate", coverage: "partial", light_type: "led", all_night: true, safety_rating: 4, has_camera: true },
    lat: 31.2401,
    lng: 121.4905,
    addressText: "上海市虹口区北苏州路附近",
    status: "published",
    fuzzRadiusM: 100,
  },
  {
    categoryCode: "bench",
    title: "小区门口的石凳（待审核示例）",
    description: "这条用于演示审核流程，登录审核员账号后可以在审核台看到它。",
    attributes: { has_backrest: false, count: 2, condition: "fair", shade: "partial" },
    lat: 31.2198,
    lng: 121.4651,
    addressText: "上海市黄浦区制造局路附近",
    status: "pending",
    fuzzRadiusM: 50,
  },
];

async function main(): Promise<void> {
  console.log("开始写入种子数据…\n");

  // 先建管理员账号，配置引导需要 createdBy 记录操作人
  const accounts = [
    { email: "admin@example.com", nickname: "管理员", role: "admin" as const },
    { email: "moderator@example.com", nickname: "审核员小周", role: "moderator" as const },
    { email: "user@example.com", nickname: "阿吉", role: "user" as const },
  ];

  const credentials: Array<{ role: string; email: string; password: string }> = [];
  const userIdByEmail = new Map<string, bigint>();

  for (const account of accounts) {
    const password = randomPassword(16);
    const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

    const user = await prisma.user.upsert({
      where: { email: account.email },
      create: {
        email: account.email,
        nickname: account.nickname,
        passwordHash,
        role: account.role,
        status: "active",
        creditScore: 100,
        settings: { create: {} },
      },
      update: {
        nickname: account.nickname,
        role: account.role,
        passwordHash,
        status: "active",
      },
    });

    userIdByEmail.set(account.email, user.id);
    credentials.push({ role: account.role, email: account.email, password });
  }

  // 在线配置引导：写入 v1 全量配置（分类 + 属性表单 + 业务阈值）并物化分类表。
  // 已有配置版本时保持不动——管理员在线发布的配置不能被重新跑种子覆盖。
  const adminId = userIdByEmail.get("admin@example.com")!;
  const configBootstrap = await bootstrapInitialConfig(adminId);
  console.log(
    configBootstrap.created
      ? "已引导在线配置 v1（分类 / 属性表单 / 业务阈值）"
      : `在线配置已存在（v${configBootstrap.version}），跳过引导`,
  );

  const categoryRows = await prisma.category.findMany({ select: { id: true, code: true } });
  const categoryIdByCode = new Map(categoryRows.map((row) => [row.code, row.id]));

  const ownerId = userIdByEmail.get("user@example.com")!;
  const moderatorId = userIdByEmail.get("moderator@example.com")!;
  let created = 0;

  for (const spot of SPOTS) {
    const categoryId = categoryIdByCode.get(spot.categoryCode);
    if (!categoryId) continue;

    const uuid = await prisma.spot
      .findFirst({ where: { title: spot.title }, select: { uuid: true } })
      .then((existing) => existing?.uuid);

    if (uuid) continue;

    const publicPoint = fuzzCoordinates(
      { lat: spot.lat, lng: spot.lng },
      spot.fuzzRadiusM,
      `${spot.title}-seed`,
    );

    const record = await prisma.spot.create({
      data: {
        ownerId,
        categoryId,
        status: spot.status,
        title: spot.title,
        description: spot.description,
        attributes: toJsonValue(spot.attributes),
        exactLat: spot.lat,
        exactLng: spot.lng,
        publicLat: spot.status === "published" ? publicPoint.lat : null,
        publicLng: spot.status === "published" ? publicPoint.lng : null,
        fuzzEnabled: true,
        fuzzRadiusM: spot.fuzzRadiusM,
        addressText: spot.addressText,
        freshnessScore: spot.status === "published" ? 60 : 0,
        confirmCount: spot.status === "published" ? 1 : 0,
        publishedAt: spot.status === "published" ? new Date() : null,
      },
    });

    const revision = await prisma.spotRevision.create({
      data: {
        spotId: record.id,
        revisionNo: 1,
        editorId: ownerId,
        schemaVersion: configBootstrap.version,
        snapshot: toJsonValue({
          title: spot.title,
          description: spot.description,
          attributes: spot.attributes,
          categoryCode: spot.categoryCode,
          categorySchemaVersion: configBootstrap.version,
          lat: spot.lat,
          lng: spot.lng,
          fuzzEnabled: true,
          fuzzRadiusM: spot.fuzzRadiusM,
          addressText: spot.addressText,
          media: [],
        }),
      },
    });

    await prisma.spot.update({
      where: { id: record.id },
      data: { currentRevisionId: revision.id },
    });

    // 待审核的示例条目同时建一条审核工单，让审核台开箱就有内容
    if (spot.status === "pending") {
      await prisma.reviewTask.create({
        data: {
          spotId: record.id,
          revisionId: revision.id,
          status: "pending",
          priority: 0,
          slaDueAt: new Date(Date.now() + env.REVIEW_SLA_HOURS * 3600000),
          autoCheck: toJsonValue({ passed: true, issues: [], meta: { seeded: true } }),
        },
      });
    } else {
      await prisma.reviewTask.create({
        data: {
          spotId: record.id,
          revisionId: revision.id,
          status: "approved",
          decidedBy: moderatorId,
          decidedAt: new Date(),
          decisionReason: "种子数据，直接发布",
          slaDueAt: new Date(),
        },
      });
    }

    created += 1;
  }

  console.log(`已写入 ${created} 条演示条目（其余为已存在，跳过）`);

  const total = await prisma.spot.count();

  console.log("\n================ 种子账号（密码仅本次输出，请立即保存） ================");
  for (const item of credentials) {
    console.log(`  ${item.role.padEnd(10)} ${item.email.padEnd(26)} ${item.password}`);
  }
  console.log("======================================================================");
  console.log(`\n当前库中条目总数：${total}`);
  console.log("启动方式：npm run dev（API）与 npm run dev:worker（异步任务）\n");
}

main()
  .catch((error) => {
    console.error("种子数据写入失败：", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
