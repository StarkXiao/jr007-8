import { BUNDLE_FORMAT_VERSION, type ConfigBundle, type ConfigThresholds } from "./bundle";

/**
 * 内置默认配置。两种用途：
 * 1. 版本表里还没有任何 active 配置（全新库 / 数据库故障）时的兜底，
 *    保证读路径永远拿得到合法配置；
 * 2. 管理员编辑草稿时的初始内容。
 */
export const DEFAULT_THRESHOLDS: ConfigThresholds = {
  maxBboxSpanDeg: 5,
  defaultPageSize: 20,
  maxPageSize: 100,
  commentEditWindowMs: 10 * 60 * 1000,
  commentMaxEdits: 1,
  confirmationCooldownMs: 30 * 24 * 60 * 60 * 1000,
  staleReportThreshold: 3,
  reportMergeWindowMs: 24 * 60 * 60 * 1000,
  reviewLockMs: 30 * 60 * 1000,
  signedUrlTtlMs: 5 * 60 * 1000,
};

export const DEFAULT_CATEGORIES = [
  {
    code: "bench",
    name: "长椅",
    icon: "bench",
    color: "#8B5E3C",
    description: "可以坐下来休息的地方，含靠背、遮荫、轮椅停靠等细节",
    sortOrder: 1,
    isActive: true,
    schema: {
      type: "object" as const,
      required: ["has_backrest", "condition"],
      properties: {
        has_backrest: {
          type: "boolean" as const,
          label: "是否有靠背",
          help: "有靠背更适合长时间休息",
          ui: "switch",
        },
        count: { type: "integer" as const, label: "可坐人数", minimum: 1, maximum: 50, unit: "人" },
        condition: {
          type: "string" as const,
          label: "完好程度",
          ui: "select",
          enum: ["good", "fair", "poor"],
          enumLabels: { good: "完好", fair: "一般", poor: "破损" },
        },
        shade: {
          type: "string" as const,
          label: "遮荫情况",
          ui: "select",
          enum: ["none", "partial", "full"],
          enumLabels: { none: "无遮荫", partial: "部分遮荫", full: "完全遮荫" },
        },
        wheelchair_space: { type: "boolean" as const, label: "轮椅可停靠", ui: "switch" },
        material: {
          type: "string" as const,
          label: "材质",
          ui: "select",
          enum: ["wood", "metal", "stone", "plastic", "mixed"],
          enumLabels: {
            wood: "木质",
            metal: "金属",
            stone: "石材",
            plastic: "塑料",
            mixed: "混合",
          },
        },
      },
    },
  },
  {
    code: "drinking_water",
    name: "饮水处",
    icon: "water",
    color: "#2E86DE",
    description: "能接到水的地方，含是否免费、龙头高度、冬季是否关闭",
    sortOrder: 2,
    isActive: true,
    schema: {
      type: "object" as const,
      required: ["type", "free"],
      properties: {
        type: {
          type: "string" as const,
          label: "供水类型",
          ui: "select",
          enum: ["direct", "fountain", "station", "shop"],
          enumLabels: {
            direct: "直饮水龙头",
            fountain: "喷泉式饮水台",
            station: "供水站",
            shop: "附近商店代售",
          },
        },
        free: { type: "boolean" as const, label: "是否免费", ui: "switch" },
        height: {
          type: "string" as const,
          label: "龙头高度",
          ui: "select",
          enum: ["low", "standard", "high", "multi"],
          enumLabels: { low: "低（儿童/轮椅可用）", standard: "常规", high: "偏高", multi: "多种高度" },
        },
        temperature: {
          type: "string" as const,
          label: "水温",
          ui: "select",
          enum: ["cold", "room", "warm"],
          enumLabels: { cold: "凉水", room: "常温", warm: "温水" },
        },
        open_hours: { type: "string" as const, label: "开放时段", maxLength: 40, ui: "text" },
        closed_in_winter: { type: "boolean" as const, label: "冬季会关闭", ui: "switch" },
      },
    },
  },
  {
    code: "rain_shelter",
    name: "遮雨棚",
    icon: "shelter",
    color: "#16A085",
    description: "下雨时能躲一躲的地方，含可站人数、是否有座位",
    sortOrder: 3,
    isActive: true,
    schema: {
      type: "object" as const,
      required: ["capacity"],
      properties: {
        capacity: { type: "integer" as const, label: "可容纳人数", minimum: 1, maximum: 200, unit: "人" },
        has_seats: { type: "boolean" as const, label: "有座位", ui: "switch" },
        coverage: {
          type: "string" as const,
          label: "覆盖范围",
          ui: "select",
          enum: ["small", "medium", "large"],
          enumLabels: { small: "仅够几人", medium: "可站十几人", large: "可容纳很多人" },
        },
        enclosed: { type: "boolean" as const, label: "是否封闭", ui: "switch" },
        lighting: { type: "boolean" as const, label: "夜间有照明", ui: "switch" },
      },
    },
  },
  {
    code: "quiet_corner",
    name: "安静角落",
    icon: "quiet",
    color: "#8E44AD",
    description: "相对不吵、适合读书或打电话的地方，含安静时段规律",
    sortOrder: 4,
    isActive: true,
    schema: {
      type: "object" as const,
      required: ["noise_level"],
      properties: {
        noise_level: {
          type: "string" as const,
          label: "安静程度",
          ui: "select",
          enum: ["very_quiet", "quiet", "moderate"],
          enumLabels: { very_quiet: "非常安静", quiet: "比较安静", moderate: "一般" },
        },
        best_time: {
          type: "string" as const,
          label: "最安静的时段",
          ui: "select",
          enum: ["morning", "noon", "afternoon", "evening", "night", "all_day"],
          enumLabels: {
            morning: "清晨",
            noon: "中午",
            afternoon: "下午",
            evening: "傍晚",
            night: "夜间",
            all_day: "全天都安静",
          },
        },
        has_seats: { type: "boolean" as const, label: "有座位", ui: "switch" },
        crowd_level: {
          type: "string" as const,
          label: "人流密度",
          ui: "select",
          enum: ["empty", "sparse", "moderate", "crowded"],
          enumLabels: { empty: "基本没人", sparse: "偶尔有人", moderate: "人不多不少", crowded: "人比较多" },
        },
        good_for: {
          type: "array" as const,
          label: "适合做什么",
          ui: "checkbox",
          items: {
            type: "string",
            enum: ["reading", "rest", "phone_call", "work"],
            enumLabels: {
              reading: "读书",
              rest: "发呆休息",
              phone_call: "打电话",
              work: "办公",
            },
          },
        },
      },
    },
  },
  {
    code: "night_light",
    name: "夜间照明",
    icon: "light",
    color: "#E1A100",
    description: "天黑以后这里亮不亮、走起来安不安全",
    sortOrder: 5,
    isActive: true,
    schema: {
      type: "object" as const,
      required: ["brightness"],
      properties: {
        brightness: {
          type: "string" as const,
          label: "亮度",
          ui: "select",
          enum: ["dim", "moderate", "bright"],
          enumLabels: { dim: "偏暗", moderate: "够用", bright: "很亮" },
        },
        coverage: {
          type: "string" as const,
          label: "覆盖范围",
          ui: "select",
          enum: ["patchy", "partial", "comprehensive"],
          enumLabels: { patchy: "断断续续", partial: "大部分有", comprehensive: "全程覆盖" },
        },
        light_type: {
          type: "string" as const,
          label: "灯具类型",
          ui: "select",
          enum: ["led", "halogen", "solar", "unknown"],
          enumLabels: { led: "LED", halogen: "传统灯", solar: "太阳能灯", unknown: "说不清" },
        },
        all_night: { type: "boolean" as const, label: "整夜亮着", ui: "switch" },
        safety_rating: { type: "integer" as const, label: "夜间安全感", minimum: 1, maximum: 5, ui: "rating" },
        has_camera: { type: "boolean" as const, label: "附近有监控", ui: "switch" },
      },
    },
  },
];

export function createDefaultBundle(): ConfigBundle {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    // 深拷贝，默认表在模块加载后不应被任何调用方修改
    categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)),
    thresholds: { ...DEFAULT_THRESHOLDS },
  };
}
