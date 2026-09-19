<script setup lang="ts">
import { computed } from "vue";
import type { ConfigBundle, ConfigThresholds } from "@/stores/appConfig";

const props = defineProps<{
  bundle: ConfigBundle;
  labels?: Record<keyof ConfigThresholds, string>;
}>();
const emit = defineEmits<{ (event: "change"): void }>();

const thresholds = computed(() => props.bundle.thresholds);

// 时间类阈值以毫秒存储，编辑时按人类习惯的分钟/小时/天呈现
const TIME_FIELDS: Array<{ key: keyof ConfigThresholds; unit: number; unitLabel: string; label: string }> = [
  { key: "commentEditWindowMs", unit: 60 * 1000, unitLabel: "分钟", label: "评论可编辑窗口" },
  { key: "confirmationCooldownMs", unit: 24 * 3600 * 1000, unitLabel: "天", label: "确认冷却期" },
  { key: "reportMergeWindowMs", unit: 3600 * 1000, unitLabel: "小时", label: "举报合并窗口" },
  { key: "reviewLockMs", unit: 60 * 1000, unitLabel: "分钟", label: "审核领取锁时长" },
  { key: "signedUrlTtlMs", unit: 60 * 1000, unitLabel: "分钟", label: "原图签名 URL 有效期" },
];

function labelOf(key: keyof ConfigThresholds): string {
  return props.labels?.[key] ?? key;
}

const NUMBER_FIELDS: Array<{ key: keyof ConfigThresholds; label: string; unit?: string }> = [
  { key: "maxBboxSpanDeg", label: "地图查询最大跨度", unit: "度" },
  { key: "defaultPageSize", label: "默认分页大小", unit: "条" },
  { key: "maxPageSize", label: "最大分页大小", unit: "条" },
  { key: "commentMaxEdits", label: "评论可编辑次数", unit: "次" },
  { key: "staleReportThreshold", label: "过期上报阈值", unit: "次" },
];

function displayValue(key: keyof ConfigThresholds, unit: number): number {
  return thresholds.value[key] / unit;
}

function setThreshold(key: keyof ConfigThresholds, value: number | undefined): void {
  if (value === undefined || Number.isNaN(value)) return;
  props.bundle.thresholds[key] = value;
  emit("change");
}

function setTimeThreshold(key: keyof ConfigThresholds, value: number | undefined, unit: number): void {
  if (value === undefined || Number.isNaN(value)) return;
  props.bundle.thresholds[key] = Math.round(value * unit);
  emit("change");
}
</script>

<template>
  <el-alert
    type="info"
    :closable="false"
    show-icon
    style="margin-bottom: 12px"
    title="阈值在发布后立即对新请求生效"
    description="服务端有强制安全边界，超出范围的取值在保存草稿时就会被拒绝。正在处理中的请求/工单不受影响。"
  />

  <el-row :gutter="20">
    <el-col :xs="24" :sm="12">
      <el-card shadow="never" header="数量与范围">
        <el-form-item v-for="field in NUMBER_FIELDS" :key="field.key" :label="labels?.[field.key] ?? field.label">
          <el-input-number
            :model-value="thresholds[field.key]"
            :min="0"
            @update:model-value="(v?: number) => setThreshold(field.key, v)"
          />
          <span class="muted" style="margin-left: 8px">{{ field.unit }}</span>
        </el-form-item>
      </el-card>
    </el-col>
    <el-col :xs="24" :sm="12">
      <el-card shadow="never" header="时间窗口">
        <el-form-item v-for="field in TIME_FIELDS" :key="field.key" :label="field.label">
          <el-input-number
            :model-value="displayValue(field.key, field.unit)"
            :min="0"
            @update:model-value="(v?: number) => setTimeThreshold(field.key, v, field.unit)"
          />
          <span class="muted" style="margin-left: 8px">{{ field.unitLabel }}</span>
          <span class="config-thresholds__raw muted">= {{ thresholds[field.key].toLocaleString() }} ms</span>
        </el-form-item>
      </el-card>
    </el-col>
  </el-row>
</template>

<style scoped>
.config-thresholds__raw {
  margin-left: 8px;
  font-size: 12px;
}
</style>
