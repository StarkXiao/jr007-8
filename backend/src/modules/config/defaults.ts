import type { AttributeSchema } from "../categories/schemaValidator";
import { THRESHOLD_SPECS, type ConfigCategory, type ConfigPayload, type Thresholds } from "./types";

/**
 * 出厂默认配置：首次安装时写入 v1（active）。
 * 分类内容与历史种子数据一致，保证新库执行 seed 与执行 bootstrap 得到相同结果。
 */

function schema(definition: {
  required?: string[];
  properties: AttributeSchema["properties"];
}): AttributeSchema {
  return { type: "object", ...definition };
}

const DEFAULT_CATEGORIES: ConfigCategory[] = [
  {
    code: "bench",
    name: "长椅",
    icon: "bench",
    color: "#8B5E3C",
    description: "可以坐下来休息的地方，含靠背、遮荫、轮椅停靠等细节",
    sortOrder: 1,
    isActive: true,
    schema: schema({
      required: ["has_backrest", "condition"],
      properties: {
        has_backrest: { type: "boolean", label: "是否有靠背", help: "有靠背更适合长时间休息", ui: "switch" },
        count: { type: "integer", label: "可坐人数", minimum: 1, maximum: 50, unit: "人" },
        condition: {
          type: "string",
          label: "完好程度",
          ui: "select",
          enum: ["good", "fair", "poor"],
          enumLabels: { good: "完好", fair: "一般", poor: "破损" },
        },
        shade: {
          type: "string",
          label: "遮荫情况",
          ui: "select",
          enum: ["none", "partial", "full"],
          enumLabels: { none: "无遮荫", partial: "部分遮荫", full: "完全遮荫" },
        },
        wheelchair_space: { type: "boolean", label: "轮椅可停靠", ui: "switch" },
        material: {
          type: "string",
          label: "材质",
          ui: "select",
          enum: ["wood", "metal", "stone", "plastic", "mixed"],
          enumLabels: { wood: "木质", metal: "金属", stone: "石材", plastic: "塑料", mixed: "混合" },
        },
      },
    }),
  },
  {
    code: "drinking_water",
    name: "饮水处",
    icon: "water",
    color: "#2E86DE",
    description: "能接到水的地方，含是否免费、龙头高度、冬季是否关闭",
    sortOrder: 2,
    isActive: true,
    schema: schema({
      required: ["type", "free"],
      properties: {
        type: {
          type: "string",
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
        free: { type: "boolean", label: "是否免费", ui: "switch" },
        height: {
          type: "string",
          label: "龙头高度",
          ui: "select",
          enum: ["low", "standard", "high", "multi"],
          enumLabels: { low: "低（儿童/轮椅可用）", standard: "常规", high: "偏高", multi: "多种高度" },
        },
        temperature: {
          type: "string",
          label: "水温",
          ui: "select",
          enum: ["cold", "room", "warm"],
          enumLabels: { cold: "凉水", room: "常温", warm: "温水" },
        },
        open_hours: { type: "string", label: "开放时段", maxLength: 40, ui: "text" },
        closed_in_winter: { type: "boolean", label: "冬季会关闭", ui: "switch" },
      },
    }),
  },
  {
    code: "rain_shelter",
    name: "遮雨棚",
    icon: "shelter",
    color: "#16A085",
    description: "下雨时能躲一躲的地方，含可站人数、是否有座位",
    sortOrder: 3,
    isActive: true,
    schema: schema({
      required: ["capacity"],
      properties: {
        capacity: { type: "integer", label: "可容纳人数", minimum: 1, maximum: 200, unit: "人" },
        has_seats: { type: "boolean", label: "有座位", ui: "switch" },
        coverage: {
          type: "string",
          label: "覆盖范围",
          ui: "select",
          enum: ["small", "medium", "large"],
          enumLabels: { small: "仅够几人", medium: "可站十几人", large: "可容纳很多人" },
        },
        enclosed: { type: "boolean", label: "是否封闭", ui: "switch" },
        lighting: { type: "boolean", label: "夜间有照明", ui: "switch" },
      },
    }),
  },
  {
    code: "quiet_corner",
    name: "安静角落",
    icon: "quiet",
    color: "#8E44AD",
    description: "相对不吵、适合读书或打电话的地方，含安静时段规律",
    sortOrder: 4,
    isActive: true,
    schema: schema({
      required: ["noise_level"],
      properties: {
        noise_level: {
          type: "string",
          label: "安静程度",
          ui: "select",
          enum: ["very_quiet", "quiet", "moderate"],
          enumLabels: { very_quiet: "非常安静", quiet: "比较安静", moderate: "一般" },
        },
        best_time: {
          type: "string",
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
        has_seats: { type: "boolean", label: "有座位", ui: "switch" },
        crowd_level: {
          type: "string",
          label: "人流密度",
          ui: "select",
          enum: ["empty", "sparse", "moderate", "crowded"],
          enumLabels: { empty: "基本没人", sparse: "偶尔有人", moderate: "人不多不少", crowded: "人比较多" },
        },
        good_for: {
          type: "array",
          label: "适合做什么",
          ui: "checkbox",
          items: {
            type: "string",
            enum: ["reading", "rest", "phone_call", "work"],
            enumLabels: { reading: "读书", rest: "发呆休息", phone_call: "打电话", work: "办公" },
          },
        },
      },
    }),
  },
  {
    code: "night_light",
    name: "夜间照明",
    icon: "light",
    color: "#E1A100",
    description: "天黑以后这里亮不亮、走起来安不安全",
    sortOrder: 5,
    isActive: true,
    schema: schema({
      required: ["brightness"],
      properties: {
        brightness: {
          type: "string",
          label: "亮度",
          ui: "select",
          enum: ["dim", "moderate", "bright"],
          enumLabels: { dim: "偏暗", moderate: "够用", bright: "很亮" },
        },
        coverage: {
          type: "string",
          label: "覆盖范围",
          ui: "select",
          enum: ["patchy", "partial", "comprehensive"],
          enumLabels: { patchy: "断断续续", partial: "大部分有", comprehensive: "全程覆盖" },
        },
        light_type: {
          type: "string",
          label: "灯具类型",
          ui: "select",
          enum: ["led", "halogen", "solar", "unknown"],
          enumLabels: { led: "LED", halogen: "传统灯", solar: "太阳能灯", unknown: "说不清" },
        },
        all_night: { type: "boolean", label: "整夜亮着", ui: "switch" },
        safety_rating: { type: "integer", label: "夜间安全感", minimum: 1, maximum: 5, ui: "rating" },
        has_camera: { type: "boolean", label: "附近有监控", ui: "switch" },
      },
    }),
  },
];

function defaultThresholds(): Thresholds {
  return Object.fromEntries(THRESHOLD_SPECS.map((spec) => [spec.key, spec.default])) as Thresholds;
}

export function buildDefaultConfig(): ConfigPayload {
  return {
    categories: DEFAULT_CATEGORIES.map((category) => structuredClone(category)),
    thresholds: defaultThresholds(),
  };
}

export { DEFAULT_CATEGORIES };
