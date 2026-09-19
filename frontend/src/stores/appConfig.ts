import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api/client";
import type { AttributeSchema } from "@/api/types";

// 在线配置工作台的类型与 /api/v1/admin/config/* 一一对应。
// 配置包是整体版本化的：编辑器只改本地草稿副本，点"保存草稿"才落库。

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

export interface ConfigThresholds {
  maxBboxSpanDeg: number;
  defaultPageSize: number;
  maxPageSize: number;
  commentEditWindowMs: number;
  commentMaxEdits: number;
  confirmationCooldownMs: number;
  staleReportThreshold: number;
  reportMergeWindowMs: number;
  reviewLockMs: number;
  signedUrlTtlMs: number;
}

export interface ConfigBundle {
  formatVersion: number;
  categories: ConfigCategory[];
  thresholds: ConfigThresholds;
}

export interface CanaryRule {
  percent: number;
  userUuids: string[];
}

export interface ConfigVersionSummary {
  id?: string;
  version?: number;
  draftVersion?: number;
  status: "draft" | "canary" | "active" | "archived";
  canaryRule: CanaryRule | null;
  note: string | null;
  categoryCount: number;
  activeCategoryCount: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigOverview {
  active: { version: number; publishedAt: string | null; categoryCount: number } | null;
  canary: {
    version: number;
    canaryRule: CanaryRule;
    publishedAt: string | null;
    categoryCount: number;
  } | null;
  draft: { version: number; note: string | null; updatedAt: string; categoryCount: number } | null;
  thresholdLabels: Record<keyof ConfigThresholds, string>;
}

export const useAppConfigStore = defineStore("app-config", () => {
  const overview = ref<ConfigOverview | null>(null);
  const versions = ref<ConfigVersionSummary[]>([]);
  const draftBundle = ref<ConfigBundle | null>(null);
  const draftVersion = ref<number | null>(null);
  const dirty = ref(false);

  const canaryRule = computed(() => overview.value?.canary?.canaryRule ?? null);

  async function loadOverview(): Promise<void> {
    overview.value = await api.get<ConfigOverview>("/admin/config");
  }

  async function loadVersions(): Promise<void> {
    const result = await api.get<{ items: ConfigVersionSummary[] }>("/admin/config/versions", { limit: 100 });
    versions.value = result.items;
  }

  async function loadDraft(): Promise<void> {
    const result = await api.get<{ draft: (ConfigVersionSummary & { bundle: ConfigBundle }) | null }>(
      "/admin/config/draft",
    );
    if (result.draft) {
      draftBundle.value = result.draft.bundle;
      draftVersion.value = result.draft.version ?? result.draft.draftVersion ?? null;
    } else {
      draftBundle.value = null;
      draftVersion.value = null;
    }
    dirty.value = false;
  }

  /** 基于当前全量（或指定历史版本）创建/重置草稿 */
  async function createDraft(baseVersion?: number): Promise<void> {
    const result = await api.post<{ draft: ConfigVersionSummary & { bundle: ConfigBundle }; created: boolean }>(
      "/admin/config/draft",
      baseVersion ? { baseVersion } : {},
    );
    draftBundle.value = result.draft.bundle;
    draftVersion.value = result.draft.version ?? result.draft.draftVersion ?? null;
    dirty.value = false;
  }

  async function ensureDraftLoaded(): Promise<void> {
    if (!draftBundle.value) {
      await loadDraft();
      if (!draftBundle.value) await createDraft();
    }
  }

  async function saveDraft(note?: string): Promise<void> {
    if (!draftBundle.value) return;
    const result = await api.put<{ version: number; updatedAt: string }>("/admin/config/draft", {
      bundle: draftBundle.value,
      note: note ?? null,
    });
    draftVersion.value = result.version;
    dirty.value = false;
    await loadOverview();
  }

  async function discardDraft(): Promise<void> {
    await api.del("/admin/config/draft");
    draftBundle.value = null;
    draftVersion.value = null;
    dirty.value = false;
    await loadOverview();
  }

  /** 只校验不落库，编辑器实时反馈 */
  async function validate(bundle: ConfigBundle): Promise<{ valid: boolean; bundle: ConfigBundle }> {
    return api.post("/admin/config/validate", { bundle });
  }

  async function preview(payload: {
    version?: number;
    bundle?: ConfigBundle;
    viewerUuid?: string;
    bucketId?: string;
    role?: string;
  }) {
    return api.post<{
      effectiveVersion: number;
      canary: boolean;
      categories: Array<{ code: string; name: string; isActive: boolean; schemaVersion: number }>;
      thresholds: ConfigThresholds;
    }>("/admin/config/preview", payload);
  }

  async function publishFull(note?: string, fromVersion?: number): Promise<{ version: number }> {
    const result = await api.post<{ version: number; status: string }>("/admin/config/publish", {
      mode: "full",
      note,
      fromVersion,
    });
    dirty.value = false;
    await Promise.all([loadOverview(), loadVersions()]);
    return result;
  }

  async function publishCanary(rule: CanaryRule, note?: string): Promise<{ version: number }> {
    const result = await api.post<{ version: number; status: string }>("/admin/config/publish", {
      mode: "canary",
      canaryRule: rule,
      note,
    });
    dirty.value = false;
    await Promise.all([loadOverview(), loadVersions()]);
    return result;
  }

  async function promoteCanary(): Promise<void> {
    await api.post("/admin/config/canary/promote");
    await Promise.all([loadOverview(), loadVersions()]);
  }

  async function stopCanary(): Promise<void> {
    await api.post("/admin/config/canary/stop");
    await Promise.all([loadOverview(), loadVersions()]);
  }

  async function getVersion(version: number): Promise<ConfigVersionSummary & { bundle: ConfigBundle }> {
    const result = await api.get<{ version: ConfigVersionSummary & { bundle: ConfigBundle } }>(
      `/admin/config/versions/${version}`,
    );
    return result.version;
  }

  /** 一键回滚：把任意历史版本的内容重新全量发布为最新版本 */
  async function rollbackTo(version: number, note?: string): Promise<{ version: number }> {
    return publishFull(note ?? `回滚到 v${version}`, version);
  }

  function markDirty(): void {
    dirty.value = true;
  }

  return {
    overview,
    versions,
    draftBundle,
    draftVersion,
    dirty,
    canaryRule,
    loadOverview,
    loadVersions,
    loadDraft,
    createDraft,
    ensureDraftLoaded,
    saveDraft,
    discardDraft,
    validate,
    preview,
    publishFull,
    publishCanary,
    promoteCanary,
    stopCanary,
    getVersion,
    rollbackTo,
    markDirty,
  };
});
