<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useConfigStore } from "@/stores/config";
import CategoryConfigEditor from "@/components/CategoryConfigEditor.vue";
import type { ConfigCategoryPayload, ConfigVersionView, RolloutRule } from "@/api/types";

const config = useConfigStore();
const busy = ref(false);

const tab = ref("draft");
const editorVisible = ref(false);
const editingCategory = ref<ConfigCategoryPayload | null>(null);

const UNIT_LABEL: Record<string, string> = {
  count: "个",
  minutes: "分钟",
  degrees: "度",
  days: "天",
  percent: "%",
};

const payload = computed(() => config.draftPayload);
const thresholds = computed(() => payload.value?.thresholds ?? {});
const categories = computed(() => payload.value?.categories ?? []);

// 灰度规则表单
const rollout = computed({
  get: () => config.draftRollout,
  set: (value: RolloutRule) => {
    config.draftRollout = value;
  },
});

const modRuleText = ref("");

function syncModText() {
  const rule = rollout.value;
  modRuleText.value = rule.userModBase ? `${rule.userModBase} | ${(rule.userModRemainders ?? []).join(",")}` : "";
}

function applyModText() {
  const text = modRuleText.value.trim();
  if (!text) {
    delete rollout.value.userModBase;
    delete rollout.value.userModRemainders;
    return;
  }
  const [baseRaw, remRaw] = text.split("|").map((part) => part?.trim() ?? "");
  const base = Number(baseRaw);
  const remainders = (remRaw ?? "")
    .split(/[,,\s]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item));
  if (!Number.isInteger(base) || base < 2) {
    ElMessage.warning("取模基数需为 ≥2 的整数，格式：10 | 0,1");
    return;
  }
  rollout.value.userModBase = base;
  rollout.value.userModRemainders = remainders;
}

const whitelistText = ref("");
function syncWhitelist() {
  whitelistText.value = (rollout.value.userUuids ?? []).join("\n");
}
function applyWhitelist() {
  const uuids = whitelistText.value
    .split(/[\s,,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  rollout.value.userUuids = uuids.length ? uuids : undefined;
}

// ---------------------------------------------------------------- 分类编辑

function openCreate() {
  editingCategory.value = null;
  editorVisible.value = true;
}

function openEdit(category: ConfigCategoryPayload) {
  editingCategory.value = category;
  editorVisible.value = true;
}

function onSaveCategory(value: ConfigCategoryPayload) {
  if (!payload.value) return;
  const index = payload.value.categories.findIndex((item) => item.code === value.code);
  if (index >= 0) {
    payload.value.categories[index] = value;
  } else {
    if (payload.value.categories.some((item) => item.code === value.code)) {
      ElMessage.error("分类代码已存在");
      return;
    }
    payload.value.categories.push(value);
  }
  ElMessage.success(index >= 0 ? "已更新分类（记得保存草稿）" : "已加入分类（记得保存草稿）");
}

async function removeCategory(code: string) {
  if (!payload.value) return;
  await ElMessageBox.confirm(
    "移除后，使用该分类的历史条目不会被删除，但新提交不能再选它。确定从配置中移除？",
    "移除分类",
    { type: "warning" },
  );
  payload.value.categories = payload.value.categories.filter((item) => item.code !== code);
}

// ---------------------------------------------------------------- 预演

const previewIdentity = reactive({ userId: "", userUuid: "", role: "user" });
const previewResult = ref<Awaited<ReturnType<typeof config.preview>> | null>(null);

async function runPreview() {
  try {
    busy.value = true;
    // 先把文本框里的取模/白名单规则同步进 rollout，预演的就是编辑器当前内容
    applyModText();
    applyWhitelist();
    previewResult.value = await config.preview({
      userId: previewIdentity.userId || undefined,
      userUuid: previewIdentity.userUuid || undefined,
      role: previewIdentity.role || undefined,
    });
  } finally {
    busy.value = false;
  }
}

// ---------------------------------------------------------------- 动作

async function withBusy(action: () => Promise<void>): Promise<void> {
  try {
    busy.value = true;
    await action();
    await config.loadVersions();
    syncModText();
    syncWhitelist();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    busy.value = false;
  }
}

async function startEditing() {
  await withBusy(async () => {
    await config.ensureDraft();
    syncModText();
    syncWhitelist();
    ElMessage.success(`已基于 v${config.draft?.version ?? ""} 准备草稿`);
  });
}

async function saveDraft() {
  await withBusy(async () => {
    applyModText();
    applyWhitelist();
    await config.saveDraft();
    ElMessage.success("草稿已保存（线上无任何变化）");
  });
}

async function discardDraft() {
  await ElMessageBox.confirm("丢弃后草稿内容不保留，确定？", "丢弃草稿", { type: "warning" });
  await withBusy(async () => {
    await config.discardDraft();
    ElMessage.success("草稿已丢弃");
  });
}

async function publishCanary() {
  await ElMessageBox.confirm(
    "草稿将以灰度方式生效：只有命中规则的用户看到新版本，其余用户仍用全量版本。继续？",
    "灰度发布",
  );
  await withBusy(async () => {
    applyModText();
    applyWhitelist();
    const view = await config.publishCanary();
    ElMessage.success(`v${view.version} 已开始灰度`);
    tab.value = "versions";
  });
}

async function publishFull() {
  await ElMessageBox.confirm(
    "全量发布后所有用户立即使用新版本，旧版本归档（可随时回滚）。确定继续？",
    "全量发布",
    { type: "warning" },
  );
  await withBusy(async () => {
    const view = await config.publishFull();
    ElMessage.success(`v${view.version} 已全量生效`);
    tab.value = "versions";
  });
}

async function promoteCanary() {
  await ElMessageBox.confirm("把当前灰度版本提升为全量？未命中灰度的用户也会立即切换。", "灰度转全量", {
    type: "warning",
  });
  await withBusy(async () => {
    const view = await config.promoteCanaryToFull(`灰度 v${config.canary?.version ?? ""} 验证通过，转全量`);
    ElMessage.success(`v${view.version} 已全量生效`);
  });
}

async function revokeCanary() {
  await withBusy(async () => {
    await config.revokeCanary();
    ElMessage.success("灰度已撤回为草稿，线上仍为全量版本");
    tab.value = "draft";
  });
}

async function rollback(version: ConfigVersionView) {
  const { value } = await ElMessageBox.prompt(`将用 v${version.version} 的内容发布为新的全量版本，备注（可选）`, "一键回滚", {
    inputValue: `紧急回滚到 v${version.version}`,
  });
  await withBusy(async () => {
    const view = await config.rollback(version.version, value || undefined);
    ElMessage.success(`已回滚：v${version.version} 的内容已作为 v${view.version} 全量生效`);
  });
}

function viewPayload(version: ConfigVersionView) {
  void ElMessageBox.alert(
    `<pre style="max-height:60vh;overflow:auto;font-size:12px">${escapeHtml(
      JSON.stringify(version.payload, null, 2),
    )}</pre>`,
    `v${version.version} 配置内容`,
    { dangerouslyUseHTMLString: true, customClass: "config-json-dialog" },
  );
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] as string);
}

function statusTagType(status: string): "info" | "warning" | "success" | "primary" {
  if (status === "active") return "success";
  if (status === "canary") return "warning";
  if (status === "draft") return "primary";
  return "info";
}

function statusLabel(status: string): string {
  return { draft: "草稿", canary: "灰度中", active: "全量", archived: "已归档" }[status] ?? status;
}

onMounted(async () => {
  try {
    busy.value = true;
    await Promise.all([config.loadSpecs(), config.loadVersions()]);
    syncModText();
    syncWhitelist();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    busy.value = false;
  }
});
</script>

<template>
  <div class="page page--wide" v-loading="busy">
    <div class="config-header">
      <h1 class="page-title">在线配置</h1>
      <div class="config-header__states">
        <el-tag :type="statusTagType('active')" size="small">
          全量 v{{ config.active?.version ?? "-" }}
        </el-tag>
        <el-tag :type="statusTagType('canary')" size="small" effect="plain">
          灰度 v{{ config.canary?.version ?? "-" }}
        </el-tag>
        <el-tag :type="statusTagType('draft')" size="small" effect="plain">
          草稿 v{{ config.draft?.version ?? "-" }}
        </el-tag>
      </div>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="所有改动先存草稿，线上不受影响；可以先灰度给一部分人，验证没问题再全量。任何历史版本都能一键回滚。"
      style="margin-bottom: 14px"
    />

    <!-- 灰度进行中的横幅 -->
    <el-alert
      v-if="config.canary"
      type="warning"
      :closable="false"
      show-icon
      :title="`v${config.canary.version} 正在灰度中`"
      style="margin-bottom: 14px"
    >
      <template #default>
        <div class="canary-banner">
          <span>{{ config.canary.comment ?? "按灰度规则对部分用户生效" }}</span>
          <span class="canary-banner__actions">
            <el-button size="small" type="success" @click="promoteCanary">转全量</el-button>
            <el-button size="small" @click="revokeCanary">撤回为草稿</el-button>
          </span>
        </div>
      </template>
    </el-alert>

    <el-tabs v-model="tab">
      <!-- ====================================================== 草稿编辑 -->
      <el-tab-pane name="draft">
        <template #label>草稿与预演</template>

        <div v-if="!config.draft" class="draft-empty">
          <el-empty description="当前没有草稿">
            <el-button type="primary" @click="startEditing">基于全量 v{{ config.active?.version }} 创建草稿</el-button>
          </el-empty>
        </div>

        <template v-else>
          <el-card shadow="never" style="margin-bottom: 14px">
            <template #header>发布说明</template>
            <el-input
              v-model="config.draftComment"
              placeholder="这次改了什么、为什么改（会进入审计日志）"
              maxlength="200"
              show-word-limit
            />
          </el-card>

          <el-card shadow="never" style="margin-bottom: 14px">
            <template #header>
              <div class="card-header-row">
                <span>业务阈值（{{ config.specs.length }} 项）</span>
                <el-button size="small" text @click="config.loadSpecs()">刷新默认值</el-button>
              </div>
            </template>
            <el-row :gutter="16">
              <el-col v-for="spec in config.specs" :key="spec.key" :xs="24" :sm="12" :md="8">
                <div class="threshold-item">
                  <div class="threshold-item__head">
                    <span>{{ spec.label }}</span>
                    <el-button size="small" link @click="thresholds[spec.key] = spec.default">重置</el-button>
                  </div>
                  <div class="threshold-item__control">
                    <el-input-number
                      v-model="thresholds[spec.key]"
                      :min="spec.min"
                      :max="spec.max"
                      :step="spec.integer ? 1 : 0.5"
                      :precision="spec.integer ? 0 : 2"
                      size="small"
                      controls-position="right"
                    />
                    <span class="muted">{{ UNIT_LABEL[spec.unit] }}</span>
                  </div>
                  <p class="threshold-item__help">
                    {{ spec.description }}
                    <span v-if="thresholds[spec.key] !== spec.default" class="threshold-item__changed">
                      默认 {{ spec.default }}
                    </span>
                  </p>
                </div>
              </el-col>
            </el-row>
          </el-card>

          <el-card shadow="never" style="margin-bottom: 14px">
            <template #header>
              <div class="card-header-row">
                <span>分类与属性表单（{{ categories.length }}）</span>
                <el-button size="small" type="primary" @click="openCreate">+ 新建分类</el-button>
              </div>
            </template>
            <el-table :data="categories" size="small">
              <el-table-column label="颜色" width="70">
                <template #default="{ row }">
                  <span class="color-dot" :style="{ background: row.color }" />
                </template>
              </el-table-column>
              <el-table-column prop="name" label="名称" width="120" />
              <el-table-column prop="code" label="代码" width="170" />
              <el-table-column label="属性数" width="80">
                <template #default="{ row }">{{ Object.keys(row.schema?.properties ?? {}).length }}</template>
              </el-table-column>
              <el-table-column label="必填" width="70">
                <template #default="{ row }">{{ (row.schema?.required ?? []).length }}</template>
              </el-table-column>
              <el-table-column prop="sortOrder" label="排序" width="70" />
              <el-table-column label="状态" width="80">
                <template #default="{ row }">
                  <el-tag :type="row.isActive ? 'success' : 'info'" size="small">
                    {{ row.isActive ? "启用" : "停用" }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" min-width="150">
                <template #default="{ row }">
                  <el-button size="small" @click="openEdit(row)">编辑</el-button>
                  <el-button size="small" type="danger" link @click="removeCategory(row.code)">移除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-card>

          <el-card shadow="never" style="margin-bottom: 14px">
            <template #header>灰度规则（保存草稿后可预演；不填规则灰度不会命中任何人）</template>
            <el-form label-width="180px">
              <el-form-item label="稳定哈希比例">
                <el-slider v-model="rollout.percent" :min="0" :max="100" show-input style="max-width: 520px" />
                <p class="muted form-help">同一用户每次结果一致（UUID 哈希），灰度名单不会随刷新乱跳</p>
              </el-form-item>
              <el-form-item label="命中角色">
                <el-checkbox-group v-model="rollout.roles">
                  <el-checkbox value="user">普通用户</el-checkbox>
                  <el-checkbox value="moderator">审核员</el-checkbox>
                  <el-checkbox value="admin">管理员</el-checkbox>
                </el-checkbox-group>
              </el-form-item>
              <el-form-item label="用户 ID 尾号取模">
                <el-input
                  v-model="modRuleText"
                  placeholder="格式：10 | 0,1（ID 对 10 取模余数为 0 或 1 的用户）"
                  style="max-width: 520px"
                  @blur="applyModText"
                />
              </el-form-item>
              <el-form-item label="UUID 白名单">
                <el-input
                  v-model="whitelistText"
                  type="textarea"
                  :rows="2"
                  placeholder="每行一个 UUID"
                  style="max-width: 520px"
                  @blur="applyWhitelist"
                />
              </el-form-item>
            </el-form>
          </el-card>

          <!-- 预演 -->
          <el-card shadow="never" style="margin-bottom: 14px">
            <template #header>草稿预演：模拟某个用户会看到哪一版</template>
            <div class="preview-row">
              <el-input v-model="previewIdentity.userId" placeholder="用户数字 ID（取模规则需要）" style="width: 200px" />
              <el-input v-model="previewIdentity.userUuid" placeholder="用户 UUID（比例/白名单需要）" style="width: 340px" />
              <el-select v-model="previewIdentity.role" style="width: 140px">
                <el-option label="普通用户" value="user" />
                <el-option label="审核员" value="moderator" />
                <el-option label="管理员" value="admin" />
                <el-option label="游客" value="visitor" />
              </el-select>
              <el-button type="primary" plain @click="runPreview">预演</el-button>
            </div>
            <el-alert
              v-if="previewResult"
              :type="previewResult.matched ? 'success' : 'info'"
              :closable="false"
              show-icon
              style="margin-top: 10px"
              :title="previewResult.reason"
              :description="`全量 v${previewResult.activeVersion ?? '-'} / 待发布 v${previewResult.previewVersion ?? '-'}，命中用户将看到 ${previewResult.matched ? '待发布版本' : '全量版本'}（${previewResult.payload?.categories.length ?? 0} 个分类、阈值 ${Object.keys(previewResult.payload?.thresholds ?? {}).length} 项）`"
            />
          </el-card>

          <div class="action-bar">
            <el-button @click="discardDraft">丢弃草稿</el-button>
            <el-button @click="saveDraft">保存草稿</el-button>
            <el-button type="warning" plain @click="publishCanary">灰度发布</el-button>
            <el-button type="danger" @click="publishFull">全量发布</el-button>
          </div>
        </template>
      </el-tab-pane>

      <!-- ====================================================== 历史版本 -->
      <el-tab-pane name="versions">
        <template #label>版本与回滚</template>
        <el-table :data="config.versions" size="small" style="width: 100%">
          <el-table-column prop="version" label="版本" width="80">
            <template #default="{ row }">v{{ row.version }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="comment" label="说明" min-width="220" show-overflow-tooltip />
          <el-table-column label="发布人" width="120">
            <template #default="{ row }">{{ row.publisher?.nickname ?? row.creator?.nickname ?? "-" }}</template>
          </el-table-column>
          <el-table-column label="发布时间" width="180">
            <template #default="{ row }">
              {{ row.publishedAt ? new Date(row.publishedAt).toLocaleString("zh-CN") : "-" }}
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200">
            <template #default="{ row }">
              <el-button size="small" @click="viewPayload(row)">查看内容</el-button>
              <el-button
                size="small"
                type="warning"
                plain
                :disabled="row.status === 'active'"
                @click="rollback(row)"
              >
                回滚到此版
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <CategoryConfigEditor
      v-model="editorVisible"
      :category="editingCategory"
      :existing-codes="categories.map((c) => c.code)"
      @save="onSaveCategory"
    />
  </div>
</template>

<style scoped>
.config-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}

.config-header__states {
  display: flex;
  gap: 8px;
}

.card-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.canary-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.threshold-item {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.threshold-item__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  margin-bottom: 6px;
}

.threshold-item__control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.threshold-item__help {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--color-text-soft, #909399);
}

.threshold-item__changed {
  margin-left: 6px;
  color: var(--el-color-warning);
}

.color-dot {
  display: inline-block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.1);
}

.preview-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.form-help {
  margin: 2px 0 0;
  font-size: 12px;
}

.action-bar {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  position: sticky;
  bottom: 0;
  background: var(--el-bg-color);
  padding: 12px 0;
  border-top: 1px solid var(--el-border-color-lighter);
}

.draft-empty {
  padding: 40px 0;
}
</style>
