import type { AttributeSchema } from "../../modules/categories/schemaValidator";

/**
 * 在线配置的结构定义。
 * 一份配置（AppConfigVersion.payload）同时承载两类内容，
 * 打包发布、打包回滚，保证一次线上变更是可审查的整体：
 *   categories —— 分类与属性表单（精简 JSON Schema）
 *   thresholds —— 业务阈值（审核、评论、过期判定等）
 */

export interface ConfigCategory {
  code: string;
  name: string;
  icon: string;
  color: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  schema: AttributeSchema;
}

export type ThresholdUnit = "count" | "minutes" | "degrees" | "days" | "percent";

export interface ThresholdSpec {
  key: string;
  label: string;
  description: string;
  unit: ThresholdUnit;
  min: number;
  max: number;
  integer: boolean;
  /** 代码里的兜底默认值，也是首次安装时写入的初始配置 */
  default: number;
}

/** 业务阈值注册表：默认值、取值范围与展示文案的唯一来源 */
export const THRESHOLD_SPECS = [
  {
    key: "staleReportThreshold",
    label: "过期上报阈值",
    description: "同一地点累计多少条「信息过期」反馈后，进入待复核",
    unit: "count",
    min: 1,
    max: 20,
    integer: true,
    default: 3,
  },
  {
    key: "staleFreshnessFloor",
    label: "新鲜度过期线",
    description: "新鲜度低于该分数且长期无人确认时，视为疑似过期",
    unit: "count",
    min: 0,
    max: 100,
    integer: true,
    default: 30,
  },
  {
    key: "commentEditWindowMinutes",
    label: "评论可编辑时长",
    description: "评论发布后允许编辑的时间窗口，超时不可再改",
    unit: "minutes",
    min: 0,
    max: 1440,
    integer: true,
    default: 10,
  },
  {
    key: "commentMaxEdits",
    label: "评论最多编辑次数",
    description: "单条评论允许修改的次数，0 表示完全不可编辑",
    unit: "count",
    min: 0,
    max: 10,
    integer: true,
    default: 1,
  },
  {
    key: "confirmationCooldownDays",
    label: "信息确认冷却期",
    description: "同一用户对同一条目两次确认之间的最短间隔",
    unit: "days",
    min: 0,
    max: 365,
    integer: true,
    default: 30,
  },
  {
    key: "reportMergeWindowMinutes",
    label: "举报合并窗口",
    description: "该时长内对同一对象的多条举报合并为一个工单",
    unit: "minutes",
    min: 0,
    max: 2880,
    integer: true,
    default: 24 * 60,
  },
  {
    key: "reviewLockMinutes",
    label: "审核领取锁时长",
    description: "审核员领取任务后，锁定多久不处理会自动释放",
    unit: "minutes",
    min: 1,
    max: 480,
    integer: true,
    default: 30,
  },
  {
    key: "signedUrlTtlMinutes",
    label: "原图签名链接有效期",
    description: "查看私有原图时签名链接的存活时间，越短越安全",
    unit: "minutes",
    min: 1,
    max: 60,
    integer: true,
    default: 5,
  },
  {
    key: "maxBboxSpanDeg",
    label: "地图查询最大跨度",
    description: "一次性拉取地图数据允许的最大经纬度跨度，防止全表扫描",
    unit: "degrees",
    min: 0.1,
    max: 90,
    integer: false,
    default: 5,
  },
  {
    key: "duplicateRadiusMeters",
    label: "重复条目检测半径",
    description: "自动预检时，多近距离内的高度相似条目判为疑似重复",
    unit: "count",
    min: 10,
    max: 1000,
    integer: true,
    default: 100,
  },
  {
    key: "submitBurstLimit",
    label: "短时提交频率上限",
    description: "10 分钟内提交超过该数量会触发自动预检告警",
    unit: "count",
    min: 1,
    max: 50,
    integer: true,
    default: 5,
  },
] as const satisfies readonly ThresholdSpec[];

export type ThresholdKey = (typeof THRESHOLD_SPECS)[number]["key"];

export type Thresholds = Record<ThresholdKey, number>;

/**
 * 灰度命中规则。命不中或规则缺失时，用户读到 active 版本。
 * 多个条件之间是「或」：尾号取模、指定角色、UUID 白名单、稳定哈希比例，任一满足即命中。
 */
export interface RolloutRule {
  /** 用户数字 ID 对该值取模，余数落在 userModRemainders 中即命中；0 表示不启用 */
  userModBase?: number;
  userModRemainders?: number[];
  /** 命中灰度的角色 */
  roles?: string[];
  /** 命中灰度的用户 UUID 白名单 */
  userUuids?: string[];
  /** 0–100，按用户 UUID 的稳定哈希取模，保证同一个人每次结果一致 */
  percent?: number;
}

export interface ConfigPayload {
  categories: ConfigCategory[];
  thresholds: Thresholds;
}

/** 运行时解析后的配置视图：配置内容 + 它来自哪个版本 */
export interface ResolvedConfig {
  version: number;
  status: "active" | "canary";
  payload: ConfigPayload;
  categories: ConfigCategory[];
  thresholds: Thresholds;
}
