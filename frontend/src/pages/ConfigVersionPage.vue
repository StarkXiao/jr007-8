<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppConfigStore, type ConfigBundle } from "@/stores/appConfig";
import ConfigPreview from "@/components/ConfigPreview.vue";

const route = useRoute();
const router = useRouter();
const store = useAppConfigStore();

const version = Number(route.params.version);
const bundle = ref<ConfigBundle | null>(null);
const note = ref<string | null>(null);
const status = ref("");
const publishedAt = ref<string | null>(null);
const tab = ref("categories");

onMounted(async () => {
  try {
    const detail = await store.getVersion(version);
    bundle.value = detail.bundle;
    note.value = detail.note;
    status.value = detail.status;
    publishedAt.value = detail.publishedAt;
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
});

async function rollback(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      `将把 v${version} 的内容重新发布为最新全量版本。填写回滚原因`,
      `一键回滚到 v${version}`,
      { inputValue: `回滚到 v${version}`, confirmButtonText: "确认回滚" },
    );
    const result = await store.rollbackTo(version, value);
    ElMessage.success(`已回滚，新版本号 v${result.version}`);
    router.push({ name: "app-config" });
  } catch (error) {
    if (error !== "cancel" && error instanceof Error) ElMessage.error(error.message);
  }
}

async function editFromHere(): Promise<void> {
  await store.createDraft(version);
  router.push({ name: "app-config", query: { tab: "draft" } });
}
</script>

<template>
  <div class="page page--wide">
    <div class="config-version-header">
      <div>
        <h1 class="page-title">配置版本 v{{ version }}</h1>
        <div class="muted">
          <el-tag size="small">{{ status }}</el-tag>
          发布于 {{ publishedAt ? new Date(publishedAt).toLocaleString("zh-CN") : "—" }} · {{ note || "无说明" }}
        </div>
      </div>
      <div style="display: flex; gap: 8px">
        <el-button @click="editFromHere">基于它创建草稿</el-button>
        <el-button type="warning" @click="rollback">一键回滚到这个版本</el-button>
        <el-button @click="router.push({ name: 'app-config' })">返回</el-button>
      </div>
    </div>

    <el-alert
      v-if="bundle"
      type="info"
      :closable="false"
      show-icon
      style="margin: 12px 0"
      title="这是不可变的历史快照"
      description="回滚不会修改或删除这一行，而是把它的内容作为最新全量版本重新发布，审计链始终完整。"
    />

    <el-tabs v-model="tab">
      <el-tab-pane label="分类" name="categories">
        <el-table v-if="bundle" :data="bundle.categories" size="small" border>
          <el-table-column prop="code" label="代码" width="180" />
          <el-table-column prop="name" label="名称" width="140" />
          <el-table-column label="属性数" width="90">
            <template #default="{ row }">{{ Object.keys(row.schema?.properties ?? {}).length }}</template>
          </el-table-column>
          <el-table-column label="必填" width="180">
            <template #default="{ row }">
              <el-tag v-for="field in row.schema?.required ?? []" :key="field" size="small" style="margin: 2px">
                {{ field }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="80">
            <template #default="{ row }">
              <el-tag :type="row.isActive ? 'success' : 'info'" size="small">
                {{ row.isActive ? "启用" : "停用" }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="业务阈值" name="thresholds">
        <el-descriptions v-if="bundle" :column="2" border size="small">
          <el-descriptions-item v-for="(value, key) in bundle.thresholds" :key="key" :label="String(key)">
            {{ value }}
          </el-descriptions-item>
        </el-descriptions>
      </el-tab-pane>
      <el-tab-pane label="预演这个版本" name="preview">
        <ConfigPreview :version="version" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.config-version-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}
</style>
