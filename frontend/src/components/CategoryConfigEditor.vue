<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { AttributeSchema, CategoryAttribute, ConfigCategoryPayload } from "@/api/types";

const props = defineProps<{
  modelValue: boolean;
  category: ConfigCategoryPayload | null;
  existingCodes: string[];
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "save", value: ConfigCategoryPayload): void;
}>();

const FIELD_TYPES = [
  { value: "boolean", label: "布尔（开关）" },
  { value: "integer", label: "整数" },
  { value: "number", label: "数字" },
  { value: "string", label: "文本" },
  { value: "array", label: "多选数组" },
] as const;

const UI_WIDGETS: Record<string, string[]> = {
  boolean: ["switch"],
  integer: ["number", "rating"],
  number: ["number"],
  string: ["text", "select", "textarea"],
  array: ["checkbox"],
};

interface FormState {
  code: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
  required: string[];
  attributes: Array<{
    key: string;
    type: CategoryAttribute["type"];
    label: string;
    help: string;
    ui: string;
    unit: string;
    minimum?: number;
    maximum?: number;
    maxLength?: number;
    enumValues: string;
    enumLabels: string;
    itemEnums: string;
  }>;
}

const form = reactive<FormState>({
  code: "",
  name: "",
  icon: "",
  color: "#333333",
  description: "",
  sortOrder: 0,
  isActive: true,
  required: [],
  attributes: [],
});

const isNew = computed(() => !props.category);
const codePattern = /^[a-z][a-z0-9_]{1,31}$/;
const colorPattern = /^#[0-9A-Fa-f]{6}$/;

watch(
  () => props.modelValue,
  (open) => {
    if (!open || !props.category) return;
    const c = props.category;
    form.code = c.code;
    form.name = c.name;
    form.icon = c.icon;
    form.color = c.color;
    form.description = c.description ?? "";
    form.sortOrder = c.sortOrder;
    form.isActive = c.isActive;
    form.required = [...(c.schema.required ?? [])];
    form.attributes = Object.entries(c.schema.properties).map(([key, p]) => ({
      key,
      type: p.type,
      label: p.label ?? "",
      help: p.help ?? "",
      ui: p.ui ?? "",
      unit: p.unit ?? "",
      minimum: p.minimum,
      maximum: p.maximum,
      maxLength: p.maxLength,
      enumValues: (p.enum ?? []).join(", "),
      enumLabels: Object.entries(p.enumLabels ?? {}).map(([k, v]) => `${k}:${v}`).join(", "),
      itemEnums: (p.items?.enum ?? []).join(", "),
    }));
  },
);

watch(
  () => props.modelValue,
  (open) => {
    if (open && !props.category) {
      form.code = "";
      form.name = "";
      form.icon = "pin";
      form.color = "#336699";
      form.description = "";
      form.sortOrder = (props.existingCodes.length + 1) * 10;
      form.isActive = true;
      form.required = [];
      form.attributes = [];
    }
  },
);

function addAttribute() {
  form.attributes.push({
    key: "",
    type: "string",
    label: "",
    help: "",
    ui: "text",
    unit: "",
    enumValues: "",
    enumLabels: "",
    itemEnums: "",
  });
}

function removeAttribute(index: number) {
  const [removed] = form.attributes.splice(index, 1);
  form.required = form.required.filter((key) => key !== removed?.key);
}

function parseEnumList(text: string): string[] {
  return text
    .split(/[,,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnumLabels(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of text.split(/[,,\n]/)) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(":");
    if (index > 0) result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return result;
}

function buildSchema(): AttributeSchema {
  const properties: AttributeSchema["properties"] = {};
  for (const attr of form.attributes) {
    const key = attr.key.trim();
    if (!key) continue;
    const property: CategoryAttribute = { type: attr.type };
    if (attr.label) property.label = attr.label;
    if (attr.help) property.help = attr.help;
    if (attr.ui) property.ui = attr.ui;
    if (attr.unit) property.unit = attr.unit;
    if (attr.type === "integer" || attr.type === "number") {
      if (attr.minimum !== undefined && attr.minimum !== null && !Number.isNaN(attr.minimum)) property.minimum = attr.minimum;
      if (attr.maximum !== undefined && attr.maximum !== null && !Number.isNaN(attr.maximum)) property.maximum = attr.maximum;
    }
    if (attr.type === "string") {
      const values = parseEnumList(attr.enumValues);
      if (values.length) {
        property.enum = values;
        const labels = parseEnumLabels(attr.enumLabels);
        if (Object.keys(labels).length) property.enumLabels = labels;
      }
      if (attr.maxLength) property.maxLength = attr.maxLength;
    }
    if (attr.type === "array") {
      const values = parseEnumList(attr.itemEnums);
      property.items = { type: "string", ...(values.length ? { enum: values } : {}) };
    }
    properties[key] = property;
  }
  return { type: "object", required: form.required.filter((key) => Boolean(properties[key])), properties };
}

function confirm() {
  if (!codePattern.test(form.code)) {
    return;
  }
  if (!form.name.trim()) return;
  if (!colorPattern.test(form.color)) return;
  const keys = form.attributes.map((a) => a.key.trim()).filter(Boolean);
  if (new Set(keys).size !== keys.length) return;

  emit("save", {
    code: form.code,
    name: form.name.trim(),
    icon: form.icon.trim() || "pin",
    color: form.color,
    description: form.description.trim() || null,
    sortOrder: form.sortOrder,
    isActive: form.isActive,
    schema: buildSchema(),
  });
  emit("update:modelValue", false);
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="isNew ? '新建分类' : `编辑分类：${category?.name ?? ''}`"
    width="860px"
    top="6vh"
    @update:model-value="(value: boolean) => emit('update:modelValue', value)"
  >
    <el-form label-width="110px" class="category-editor">
      <el-row :gutter="12">
        <el-col :span="8">
          <el-form-item label="分类代码" required>
            <el-input v-model="form.code" :disabled="!isNew" placeholder="如 drinking_water" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="名称" required>
            <el-input v-model="form.name" maxlength="16" show-word-limit />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="颜色">
            <el-color-picker v-model="form.color" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="12">
        <el-col :span="8">
          <el-form-item label="图标标识">
            <el-input v-model="form.icon" placeholder="bench / water / pin" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="排序">
            <el-input-number v-model="form.sortOrder" :min="0" :max="999" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="启用">
            <el-switch v-model="form.isActive" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-form-item label="描述">
        <el-input v-model="form.description" maxlength="200" show-word-limit />
      </el-form-item>

      <el-divider content-position="left">属性表单（{{ form.attributes.length }} 项）</el-divider>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="属性 key 一经发布被历史条目引用，改名等于新增字段；请在上线前确定 key"
        style="margin-bottom: 10px"
      />

      <el-table :data="form.attributes" size="small" border>
        <el-table-column label="字段 key" width="170">
          <template #default="{ row }">
            <el-input v-model="row.key" size="small" placeholder="snake_case" />
          </template>
        </el-table-column>
        <el-table-column label="名称" width="140">
          <template #default="{ row }">
            <el-input v-model="row.label" size="small" placeholder="展示名" />
          </template>
        </el-table-column>
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-select v-model="row.type" size="small" @change="(value: string) => (row.ui = UI_WIDGETS[value]?.[0] ?? '')">
              <el-option v-for="t in FIELD_TYPES" :key="t.value" :label="t.label" :value="t.value" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="必填" width="60" align="center">
          <template #default="{ row }">
            <el-checkbox :model-value="form.required.includes(row.key)" :disabled="!row.key" @change="(checked: boolean) => {
              form.required = checked ? [...form.required, row.key] : form.required.filter((k) => k !== row.key)
            }" />
          </template>
        </el-table-column>
        <el-table-column label="约束 / 选项" min-width="260">
          <template #default="{ row }">
            <div v-if="row.type === 'integer' || row.type === 'number'" class="constraint-row">
              <el-input-number v-model="row.minimum" size="small" placeholder="最小" controls-position="right" style="width: 100px" />
              <span>~</span>
              <el-input-number v-model="row.maximum" size="small" placeholder="最大" controls-position="right" style="width: 100px" />
              <el-input v-model="row.unit" size="small" placeholder="单位" style="width: 90px" />
            </div>
            <div v-else-if="row.type === 'string'" class="constraint-row constraint-row--wrap">
              <el-input v-model="row.enumValues" size="small" placeholder="枚举值，逗号分隔：good, fair, poor" />
              <el-input v-model="row.enumLabels" size="small" placeholder="标签，形如 good:完好, fair:一般" />
              <el-input-number v-model="row.maxLength" size="small" placeholder="最大长度" controls-position="right" style="width: 120px" />
            </div>
            <div v-else-if="row.type === 'array'" class="constraint-row">
              <el-input v-model="row.itemEnums" size="small" placeholder="可选值，逗号分隔：reading, rest" />
            </div>
            <el-input v-else-if="row.type === 'boolean'" v-model="row.help" size="small" placeholder="帮助文案（可选）" />
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="" width="64">
          <template #default="{ $index }">
            <el-button size="small" type="danger" link @click="removeAttribute($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-button size="small" style="margin-top: 10px" @click="addAttribute">+ 添加属性</el-button>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="confirm">确定</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.constraint-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.constraint-row--wrap {
  flex-wrap: wrap;
}

.constraint-row :deep(.el-input) {
  flex: 1;
  min-width: 120px;
}
</style>
