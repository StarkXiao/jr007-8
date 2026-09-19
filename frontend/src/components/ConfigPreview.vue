<script setup lang="ts">
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { useAppConfigStore, type ConfigBundle } from "@/stores/appConfig";

// 草稿预演：给定"观看者身份 / 分桶 ID"，算出他实际会看到的分类与阈值，
// 全程不写库、不发布。灰度版本还会按灰度规则判定该用户是否命中。
const props = defineProps<{ bundle?: ConfigBundle; version?: number }>();

const store = useAppConfigStore();
const viewerUuid = ref("");
const bucketId = ref("");
const role = ref<"" | "visitor" | "user" | "moderator" | "admin">("");
const result = ref<Awaited<ReturnType<typeof store.preview>> | null>(null);
const loading = ref(false);

async function run(): Promise<void> {
  loading.value = true;
  try {
    result.value = await store.preview({
      version: props.version,
      bundle: props.bundle,
      viewerUuid: viewerUuid.value || undefined,
      bucketId: bucketId.value || undefined,
      role: role.value || undefined,
    });
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

function formatThresholds(thresholds: Record<string, number>): string {
  return JSON.stringify(thresholds, null, 2);
}
</script>

<template>
  <el-card shadow="never" header="预演：这个配置在指定用户视角下长什么样">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 12px"
      title="预演不会保存或发布任何内容"
      description="管理员和灰度白名单用户始终命中灰度；其他用户按 UUID/分桶的哈希百分位判定。匿名用户用浏览器分桶 cookie。"
    />

    <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px">
      <el-input v-model="viewerUuid" placeholder="观看者 UUID（白名单/用户桶）" style="width: 320px" />
      <el-input v-model="bucketId" placeholder="匿名分桶 ID（留空随机）" style="width: 220px" />
      <el-select v-model="role" placeholder="角色" clearable style="width: 140px">
        <el-option label="游客" value="visitor" />
        <el-option label="普通用户" value="user" />
        <el-option label="审核员" value="moderator" />
        <el-option label="管理员" value="admin" />
      </el-select>
      <el-button type="primary" :loading="loading" @click="run">开始预演</el-button>
    </div>

    <template v-if="result">
      <el-descriptions :column="3" border size="small" style="margin-bottom: 12px">
        <el-descriptions-item label="生效版本">v{{ result.effectiveVersion }}</el-descriptions-item>
        <el-descriptions-item label="是否命中灰度">
          <el-tag :type="result.canary ? 'warning' : 'success'" size="small">
            {{ result.canary ? "灰度" : "全量" }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="可见分类数">{{ result.categories.length }}</el-descriptions-item>
      </el-descriptions>

      <el-table :data="result.categories" size="small" border style="margin-bottom: 12px">
        <el-table-column prop="code" label="代码" width="180" />
        <el-table-column prop="name" label="名称" width="160" />
        <el-table-column prop="schemaVersion" label="Schema 版本" width="120" />
        <el-table-column label="状态">
          <template #default="{ row }">
            <el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? "启用" : "停用" }}</el-tag>
          </template>
        </el-table-column>
      </el-table>

      <el-input :model-value="formatThresholds(result.thresholds)" type="textarea" :rows="10" readonly />
    </template>
  </el-card>
</template>
