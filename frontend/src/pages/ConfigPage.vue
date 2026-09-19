<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppConfigStore, type CanaryRule, type ConfigVersionSummary } from "@/stores/appConfig";
import ConfigCategoryEditor from "@/components/ConfigCategoryEditor.vue";
import ConfigThresholdEditor from "@/components/ConfigThresholdEditor.vue";
import ConfigPreview from "@/components/ConfigPreview.vue";

const store = useAppConfigStore();
const router = useRouter();

const tab = ref("overview");
const editorTab = ref("categories");
const loading = ref(false);
const note = ref("");

const draftBundle = computed(() => store.draftBundle);
const draftOverview = computed(() => store.overview?.draft ?? null);

onMounted(async () => {
  loading.value = true;
  try {
    await store.loadOverview();
    await store.loadVersions();
    if (router.currentRoute.value.query.tab === "draft") {
      await openDraft();
    }
  } finally {
    loading.value = false;
  }
});

async function openDraft(): Promise<void> {
  loading.value = true;
  try {
    await store.ensureDraftLoaded();
    note.value = "";
    tab.value = "draft";
  } finally {
    loading.value = false;
  }
}

async function editVersion(version: ConfigVersionSummary): Promise<void> {
  loading.value = true;
  try {
    // 基于该历史版本重建草稿（内容相同于"以历史为起点继续改"）
    await store.createDraft(version.version);
    tab.value = "draft";
    ElMessage.success(`已基于 v${version.version} 创建草稿`);
  } finally {
    loading.value = false;
  }
}

async function saveDraft(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt("本次修改说明（可选，会留在版本记录里）", "保存草稿", {
      inputValue: note.value,
      inputType: "textarea",
      confirmButtonText: "保存",
      cancelButtonText: "取消",
    }).catch(() => ({ value: undefined }));
    if (value === undefined) return;
    note.value = value;
    await store.saveDraft(value || undefined);
    ElMessage.success("草稿已保存");
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function publishFull(): Promise<void> {
  try {
    await store.saveDraft(note.value || undefined);
    await ElMessageBox.confirm(
      "全量发布后所有用户立即使用新配置。旧版本会归档，可随时一键回滚。确认发布？",
      "全量发布",
      { type: "warning", confirmButtonText: "确认全量发布" },
    );
    const result = await store.publishFull(note.value || undefined);
    ElMessage.success(`已全量发布 v${result.version}`);
    tab.value = "overview";
  } catch (error) {
    if (error !== "cancel" && error instanceof Error) ElMessage.error(error.message);
  }
}

const canaryDialog = ref(false);
const canaryForm = ref<CanaryRule>({ percent: 10, userUuids: [] });
const canaryUuidsText = ref("");

function openCanaryDialog(): void {
  const current = store.overview?.canary?.canaryRule;
  canaryForm.value = current ? { ...current } : { percent: 10, userUuids: [] };
  canaryUuidsText.value = canaryForm.value.userUuids.join("\n");
  canaryDialog.value = true;
}

async function confirmCanary(): Promise<void> {
  try {
    canaryForm.value.userUuids = canaryUuidsText.value
      .split(/[\s,，]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    await store.saveDraft(note.value || undefined);
    const result = await store.publishCanary(canaryForm.value, note.value || undefined);
    canaryDialog.value = false;
    ElMessage.success(`灰度 v${result.version} 已开始（${canaryForm.value.percent}% 用户 + 白名单）`);
    tab.value = "overview";
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function promoteCanary(): Promise<void> {
  try {
    await ElMessageBox.confirm("将当前灰度版本提升为全量？所有用户将立即切换。", "灰度全量", {
      type: "warning",
    });
    await store.promoteCanary();
    ElMessage.success("灰度已提升为全量");
  } catch (error) {
    if (error !== "cancel" && error instanceof Error) ElMessage.error(error.message);
  }
}

async function stopCanary(): Promise<void> {
  try {
    await ElMessageBox.confirm("中止灰度后，所有用户立即回到当前全量版本。", "中止灰度", { type: "warning" });
    await store.stopCanary();
    ElMessage.success("灰度已中止");
  } catch (error) {
    if (error !== "cancel" && error instanceof Error) ElMessage.error(error.message);
  }
}

async function rollback(version: ConfigVersionSummary): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      `将把 v${version.version} 的内容重新发布为最新全量版本。填写回滚原因（会记入审计）`,
      `一键回滚到 v${version.version}`,
      { inputValue: `回滚到 v${version.version}`, confirmButtonText: "确认回滚" },
    );
    const result = await store.rollbackTo(version.version!, value);
    ElMessage.success(`已回滚，新版本号 v${result.version}`);
    tab.value = "overview";
  } catch (error) {
    if (error !== "cancel" && error instanceof Error) ElMessage.error(error.message);
  }
}

async function viewVersion(version: ConfigVersionSummary): Promise<void> {
  if (!version.version) return;
  router.push({ name: "config-version", params: { version: String(version.version) } });
}

function statusTag(status: ConfigVersionSummary["status"]): { type: "success" | "warning" | "info" | "primary"; text: string } {
  switch (status) {
    case "active":
      return { type: "success", text: "全量生效" };
    case "canary":
      return { type: "warning", text: "灰度中" };
    case "draft":
      return { type: "primary", text: "草稿" };
    default:
      return { type: "info", text: "历史归档" };
  }
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}
</script>

<template>
  <div class="page page--wide" v-loading="loading">
    <div class="config-header">
      <h1 class="page-title">在线配置</h1>
      <el-button @click="router.push({ name: 'admin' })">返回管理后台</el-button>
    </div>

    <el-tabs v-model="tab">
      <!-- 概览 -->
      <el-tab-pane label="发布状态" name="overview">
        <el-row :gutter="12">
          <el-col :xs="24" :md="8">
            <el-card shadow="never" class="config-state-card">
              <template #header>当前全量版本</template>
              <template v-if="store.overview?.active">
                <div class="config-state-card__version">v{{ store.overview.active.version }}</div>
                <div class="muted">发布于 {{ formatTime(store.overview.active.publishedAt) }}</div>
                <div class="muted">{{ store.overview.active.categoryCount }} 个分类</div>
              </template>
              <el-empty v-else description="尚未发布过配置（系统正使用内置默认值）" :image-size="60" />
            </el-card>
          </el-col>
          <el-col :xs="24" :md="8">
            <el-card shadow="never" class="config-state-card">
              <template #header>
                <span>灰度版本 <el-tag v-if="store.overview?.canary" type="warning" size="small">进行中</el-tag></span>
              </template>
              <template v-if="store.overview?.canary">
                <div class="config-state-card__version">v{{ store.overview.canary.version }}</div>
                <div class="muted">{{ store.overview.canary.canaryRule.percent }}% 用户桶 + {{ store.overview.canary.canaryRule.userUuids.length }} 个白名单</div>
                <div class="muted">管理员始终命中灰度</div>
                <div style="margin-top: 10px; display: flex; gap: 8px">
                  <el-button size="small" type="success" @click="promoteCanary">提升为全量</el-button>
                  <el-button size="small" type="danger" plain @click="stopCanary">中止灰度</el-button>
                </div>
              </template>
              <el-empty v-else description="没有进行中的灰度" :image-size="60" />
            </el-card>
          </el-col>
          <el-col :xs="24" :md="8">
            <el-card shadow="never" class="config-state-card">
              <template #header>
                <span>草稿 <el-tag v-if="store.dirty" type="danger" size="small">有未保存改动</el-tag></template>
              </template>
              <template v-if="draftOverview">
                <div class="config-state-card__version">v{{ draftOverview?.version }}</div>
                <div class="muted">更新于 {{ formatTime(draftOverview?.updatedAt ?? null) }}</div>
                <div class="muted" style="margin-bottom: 10px">{{ draftOverview?.note || "无说明" }}</div>
                <el-button size="small" type="primary" @click="openDraft">继续编辑</el-button>
              </template>
              <el-empty v-else description="没有草稿" :image-size="60">
                <el-button size="small" type="primary" @click="openDraft">从全量版本创建草稿</el-button>
              </el-empty>
            </el-card>
          </el-col>
        </el-row>

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center">
              <span>版本历史（回滚到任意版本）</span>
              <el-button size="small" @click="store.loadVersions(); store.loadOverview()">刷新</el-button>
            </div>
          </template>
          <el-table :data="store.versions" size="small">
            <el-table-column label="版本" width="90">
              <template #default="{ row }">
                <span v-if="row.version">v{{ row.version }}</span>
                <span v-else class="muted">草稿 #{{ row.draftVersion }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag :type="statusTag(row.status).type" size="small">{{ statusTag(row.status).text }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="灰度规则" width="180">
              <template #default="{ row }">
                <span v-if="row.canaryRule" class="muted">
                  {{ row.canaryRule.percent }}% + {{ row.canaryRule.userUuids.length }} 人白名单
                </span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column prop="note" label="说明" min-width="160" />
            <el-table-column label="分类" width="90">
              <template #default="{ row }">{{ row.activeCategoryCount }}/{{ row.categoryCount }}</template>
            </el-table-column>
            <el-table-column label="发布时间" width="170">
              <template #default="{ row }">{{ formatTime(row.publishedAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="230" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.version" size="small" link @click="viewVersion(row)">查看</el-button>
                <el-button v-if="row.status === 'archived' || row.status === 'active' || row.status === 'canary'" size="small" link @click="editVersion(row)">
                  基于它改
                </el-button>
                <el-button
                  v-if="row.status !== 'draft'"
                  size="small"
                  type="warning"
                  link
                  @click="rollback(row)"
                >
                  一键回滚
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- 草稿编辑 -->
      <el-tab-pane label="草稿编辑" name="draft" :disabled="!draftBundle">
        <template v-if="draftBundle">
          <el-alert
            :type="store.dirty ? 'warning' : 'success'"
            :closable="false"
            show-icon
            style="margin-bottom: 12px"
            :title="store.dirty ? '草稿有未保存的改动' : '草稿已保存'"
            :description="`草稿版本 v${store.draftVersion} · 修改不会影响线上，保存草稿或发布后才落库`"
          />

          <div style="display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap">
            <el-input v-model="note" placeholder="本次修改说明" style="width: 300px" />
            <el-button @click="saveDraft">保存草稿</el-button>
            <el-button type="primary" @click="publishFull">全量发布</el-button>
            <el-button type="warning" @click="openCanaryDialog">灰度发布</el-button>
            <el-button type="danger" plain @click="store.discardDraft().then(() => { tab = 'overview'; ElMessage.info('草稿已废弃') })">
              废弃草稿
            </el-button>
          </div>

          <el-tabs v-model="editorTab">
            <el-tab-pane label="分类与属性表单" name="categories">
              <ConfigCategoryEditor :bundle="draftBundle" @change="store.markDirty()" />
            </el-tab-pane>
            <el-tab-pane label="业务阈值" name="thresholds">
              <ConfigThresholdEditor
                :bundle="draftBundle"
                :labels="store.overview?.thresholdLabels"
                @change="store.markDirty()"
              />
            </el-tab-pane>
            <el-tab-pane label="草稿预演" name="preview">
              <ConfigPreview :bundle="draftBundle" />
            </el-tab-pane>
          </el-tabs>
        </template>
      </el-tab-pane>
    </el-tabs>

    <!-- 灰度规则对话框 -->
    <el-dialog v-model="canaryDialog" title="灰度发布规则" width="520px">
      <el-form label-width="120px">
        <el-form-item label="灰度用户比例">
          <el-slider v-model="canaryForm.percent" :min="0" :max="100" :step="1" show-input />
          <div class="muted" style="font-size: 12px">按用户 UUID 确定性哈希分桶；0 = 仅白名单与管理员可见，100 = 全员</div>
        </el-form-item>
        <el-form-item label="白名单 UUID">
          <el-input
            v-model="canaryUuidsText"
            type="textarea"
            :rows="5"
            placeholder="每行一个用户 UUID，最多 200 个（内测账号、业务负责人）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="canaryDialog = false">取消</el-button>
        <el-button type="warning" @click="confirmCanary">开始灰度</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.config-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.config-state-card {
  min-height: 200px;
}

.config-state-card__version {
  font-size: 26px;
  font-weight: 600;
  margin-bottom: 6px;
}
</style>
