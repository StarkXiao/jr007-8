<script setup lang="ts">
import { computed, ref } from "vue";
import type { CategoryAttribute } from "@/api/types";
import type { ConfigBundle, ConfigCategory } from "@/stores/appConfig";

// 分类与属性表单的结构化编辑器。
// 刻意不做成"贴 JSON 文本框"：配置一旦支持在线改，
// 就必须让不看文档的人也能安全地改，JSON 文本框只会把拼写错误直接送进生产。
const props = defineProps<{ bundle: ConfigBundle }>();
const emit = defineEmits<{ (event: "change"): void }>();

const activeCategory = ref<string>();

const categories = computed({
  get: () => props.bundle.categories,
  set: (value: ConfigCategory[]) => {
    props.bundle.categories = value;
    emit("change");
  },
});

const ATTR_TYPES: Array<{ value: CategoryAttribute["type"]; label: string }> = [
  { value: "boolean", label: "布尔（开关）" },
  { value: "integer", label: "整数" },
  { value: "number", label: "数字" },
  { value: "string", label: "文本" },
  { value: "array", label: "多选数组" },
];

function updateCategory(index: number, patch: Partial<ConfigCategory>): void {
  categories.value = categories.value.map((category, i) => (i === index ? { ...category, ...patch } : category));
}

function addCategory(): void {
  const code = `category_${Date.now().toString(36)}`;
  categories.value = [
    ...categories.value,
    {
      code,
      name: "新分类",
      icon: "pin",
      color: "#666666",
      description: null,
      sortOrder: categories.value.length + 1,
      isActive: true,
      schema: { type: "object", required: [], properties: {} },
    },
  ];
  emit("change");
}

function removeCategory(index: number): void {
  categories.value = categories.value.filter((_, i) => i !== index);
  emit("change");
}

function addAttribute(category: ConfigCategory): void {
  let key = "new_field";
  let suffix = 1;
  while (category.schema.properties[key]) {
    key = `new_field_${suffix}`;
    suffix += 1;
  }
  category.schema.properties[key] = { type: "string", label: "新属性" };
  emit("change");
}

function renameAttribute(category: ConfigCategory, oldKey: string, newKey: string): void {
  const key = newKey.trim();
  if (!key || key === oldKey || category.schema.properties[key]) return;
  const properties = Object.entries(category.schema.properties).reduce<Record<string, CategoryAttribute>>(
    (acc, [k, value]) => {
      acc[k === oldKey ? key : k] = value;
      return acc;
    },
    {},
  );
  category.schema.properties = properties;
  category.schema.required = (category.schema.required ?? []).map((field) => (field === oldKey ? key : field));
  emit("change");
}

function removeAttribute(category: ConfigCategory, key: string): void {
  delete category.schema.properties[key];
  category.schema.required = (category.schema.required ?? []).filter((field) => field !== key);
  emit("change");
}

function toggleRequired(category: ConfigCategory, key: string, required: boolean): void {
  const set = new Set(category.schema.required ?? []);
  if (required) set.add(key);
  else set.delete(key);
  category.schema.required = [...set];
  emit("change");
}

function isRequired(category: ConfigCategory, key: string): boolean {
  return (category.schema.required ?? []).includes(key);
}

function updateAttribute(category: ConfigCategory, key: string, patch: Partial<CategoryAttribute>): void {
  category.schema.properties[key] = { ...category.schema.properties[key], ...patch };
  emit("change");
}

function parseEnumText(property: CategoryAttribute): string {
  return (property.enum ?? []).join("\n");
}

function onEnumBlur(category: ConfigCategory, key: string, text: string): void {
  const property = category.schema.properties[key];
  const values = text
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
  property.enum = values.length > 0 ? values : undefined;
  // 清掉已经不存在的标签映射，避免残留
  if (property.enumLabels) {
    property.enumLabels = Object.fromEntries(Object.entries(property.enumLabels).filter(([k]) => values.includes(k)));
  }
  emit("change");
}

function enumLabelText(property: CategoryAttribute): string {
  return Object.entries(property.enumLabels ?? {})
    .map(([value, label]) => `${value}:${label}`)
    .join("\n");
}

function onEnumLabelsBlur(category: ConfigCategory, key: string, text: string): void {
  const property = category.schema.properties[key];
  const labels: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf(":");
    if (index > 0) labels[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  property.enumLabels = Object.keys(labels).length > 0 ? labels : undefined;
  emit("change");
}

function arrayEnumText(property: CategoryAttribute): string {
  return (property.items?.enum ?? []).join("\n");
}

function onArrayEnumBlur(category: ConfigCategory, key: string, text: string): void {
  const property = category.schema.properties[key];
  const values = text
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
  property.items = { type: "string", ...(property.items ?? {}), enum: values.length > 0 ? values : undefined };
  emit("change");
}
</script>

<template>
  <div class="config-categories">
    <el-alert
      type="warning"
      :closable="false"
      show-icon
      style="margin-bottom: 12px"
      title="改动只保存在草稿里，发布后才会生效"
      description="删除必填属性前请确认：已发布的历史条目仍按旧版本解释，新提交会立即按新版本校验。分类代码创建后不要随意修改（它是条目关联键）。"
    />

    <el-collapse v-model="activeCategory" accordion>
      <el-collapse-item v-for="(category, index) in categories" :key="category.code" :name="category.code">
        <template #title>
          <span class="config-categories__title">
            <el-tag :color="category.color" effect="dark" size="small" disable-transitions>
              {{ category.name }}
            </el-tag>
            <span class="muted">{{ category.code }}</span>
            <el-tag :type="category.isActive ? 'success' : 'info'" size="small">
              {{ category.isActive ? "启用" : "停用" }}
            </el-tag>
            <span class="muted">{{ Object.keys(category.schema.properties).length }} 个属性</span>
          </span>
        </template>

        <div class="config-categories__body">
          <el-row :gutter="12">
            <el-col :xs="24" :sm="8">
              <el-form-item label="名称">
                <el-input :model-value="category.name" @update:model-value="(v: string) => updateCategory(index, { name: v })" />
              </el-form-item>
            </el-col>
            <el-col :xs="24" :sm="8">
              <el-form-item label="代码（关联键）">
                <el-input :model-value="category.code" @update:model-value="(v: string) => updateCategory(index, { code: v.trim() })" />
              </el-form-item>
            </el-col>
            <el-col :xs="12" :sm="4">
              <el-form-item label="图标">
                <el-input :model-value="category.icon" @update:model-value="(v: string) => updateCategory(index, { icon: v })" />
              </el-form-item>
            </el-col>
            <el-col :xs="12" :sm="4">
              <el-form-item label="颜色">
                <el-color-picker :model-value="category.color" @update:model-value="(v: string) => updateCategory(index, { color: v })" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-row :gutter="12">
            <el-col :xs="24" :sm="16">
              <el-form-item label="描述">
                <el-input :model-value="category.description ?? ''" @update:model-value="(v: string) => updateCategory(index, { description: v || null })" />
              </el-form-item>
            </el-col>
            <el-col :xs="12" :sm="4">
              <el-form-item label="排序">
                <el-input-number :model-value="category.sortOrder" :min="0" :max="9999" @update:model-value="(v: number) => updateCategory(index, { sortOrder: v })" />
              </el-form-item>
            </el-col>
            <el-col :xs="12" :sm="4">
              <el-form-item label="启用">
                <el-switch :model-value="category.isActive" @update:model-value="(v: boolean) => updateCategory(index, { isActive: v })" />
              </el-form-item>
            </el-col>
          </el-row>

          <el-divider content-position="left">属性表单</el-divider>

          <el-table :data="Object.entries(category.schema.properties)" size="small" border>
            <el-table-column label="字段键" width="170">
              <template #default="{ row }">
                <el-input
                  :model-value="row[0]"
                  size="small"
                  @change="(v: string) => renameAttribute(category, row[0], v)"
                />
              </template>
            </el-table-column>
            <el-table-column label="显示名" width="150">
              <template #default="{ row }">
                <el-input
                  :model-value="row[1].label"
                  size="small"
                  @update:model-value="(v: string) => updateAttribute(category, row[0], { label: v })"
                />
              </template>
            </el-table-column>
            <el-table-column label="类型" width="150">
              <template #default="{ row }">
                <el-select
                  :model-value="row[1].type"
                  size="small"
                  @update:model-value="(v: CategoryAttribute['type']) => updateAttribute(category, row[0], { type: v })"
                >
                  <el-option v-for="option in ATTR_TYPES" :key="option.value" :label="option.label" :value="option.value" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="必填" width="70" align="center">
              <template #default="{ row }">
                <el-checkbox
                  :model-value="isRequired(category, row[0])"
                  @update:model-value="(v: boolean) => toggleRequired(category, row[0], v)"
                />
              </template>
            </el-table-column>
            <el-table-column label="约束 / 枚举">
              <template #default="{ row }">
                <div class="config-categories__constraints">
                  <template v-if="row[1].type === 'integer' || row[1].type === 'number'">
                    <el-input-number
                      :model-value="row[1].minimum"
                      size="small"
                      placeholder="最小值"
                      controls-position="right"
                      style="width: 120px"
                      @update:model-value="(v?: number) => updateAttribute(category, row[0], { minimum: v })"
                    />
                    <el-input-number
                      :model-value="row[1].maximum"
                      size="small"
                      placeholder="最大值"
                      controls-position="right"
                      style="width: 120px"
                      @update:model-value="(v?: number) => updateAttribute(category, row[0], { maximum: v })"
                    />
                  </template>
                  <template v-else-if="row[1].type === 'string'">
                    <el-input
                      :model-value="parseEnumText(row[1])"
                      size="small"
                      type="textarea"
                      :rows="2"
                      placeholder="枚举值，每行一个（留空=自由文本）"
                      style="width: 260px"
                      @blur="(e: FocusEvent) => onEnumBlur(category, row[0], (e.target as HTMLTextAreaElement).value)"
                    />
                    <el-input
                      :model-value="enumLabelText(row[1])"
                      size="small"
                      type="textarea"
                      :rows="2"
                      placeholder="标签 value:中文，每行一个"
                      style="width: 260px"
                      @blur="(e: FocusEvent) => onEnumLabelsBlur(category, row[0], (e.target as HTMLTextAreaElement).value)"
                    />
                  </template>
                  <template v-else-if="row[1].type === 'array'">
                    <el-input
                      :model-value="arrayEnumText(row[1])"
                      size="small"
                      type="textarea"
                      :rows="2"
                      placeholder="可选项，每行一个"
                      style="width: 260px"
                      @blur="(e: FocusEvent) => onArrayEnumBlur(category, row[0], (e.target as HTMLTextAreaElement).value)"
                    />
                  </template>
                  <span v-else class="muted">—</span>
                  <el-input
                    :model-value="row[1].help"
                    size="small"
                    placeholder="帮助提示"
                    style="width: 200px"
                    @update:model-value="(v: string) => updateAttribute(category, row[0], { help: v })"
                  />
                </div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" align="center">
              <template #default="{ row }">
                <el-button size="small" type="danger" link @click="removeAttribute(category, row[0])">删除</el-button>
              </template>
            </el-table-column>
          </el-table>

          <div style="margin-top: 8px">
            <el-button size="small" @click="addAttribute(category)">+ 添加属性</el-button>
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>

    <div style="margin-top: 12px; display: flex; gap: 10px">
      <el-button @click="addCategory">+ 添加分类</el-button>
      <el-button
        v-for="(category, index) in categories"
        :key="`remove-${category.code}`"
        type="danger"
        plain
        size="small"
        @click="removeCategory(index)"
      >
        删除「{{ category.name }}」
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.config-categories__title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.config-categories__body {
  padding: 0 12px 12px;
}

.config-categories__constraints {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: flex-start;
}
</style>
