import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "@/api/client";
import type {
  ConfigPayload,
  ConfigPreviewResult,
  ConfigVersionView,
  ConfigVersionsResponse,
  RolloutRule,
  ThresholdSpec,
} from "@/api/types";

// 在线配置中心：草稿编辑 → 预演 → 灰度 → 全量 / 回滚，全部走版本化 API。
export const useConfigStore = defineStore("online-config", () => {
  const specs = ref<ThresholdSpec[]>([]);
  const versions = ref<ConfigVersionView[]>([]);
  const active = ref<ConfigVersionView | null>(null);
  const canary = ref<ConfigVersionView | null>(null);
  const draft = ref<ConfigVersionView | null>(null);

  // 草稿工作副本：编辑期间只改本地副本，点「保存草稿」才提交
  const draftPayload = ref<ConfigPayload | null>(null);
  const draftRollout = ref<RolloutRule>({});
  const draftComment = ref("");

  async function loadSpecs(): Promise<void> {
    const result = await api.get<{ items: ThresholdSpec[] }>("/admin/config/threshold-specs");
    specs.value = result.items;
  }

  async function loadVersions(): Promise<void> {
    const result = await api.get<ConfigVersionsResponse>("/admin/config/versions");
    versions.value = result.versions;
    active.value = result.active;
    canary.value = result.canary;
    draft.value = result.draft;

    // 打开页面时若已有草稿，工作副本以草稿为准；否则以全量内容起步（保存时才真正建草稿）
    const base = result.draft ?? result.active;
    if (base) {
      draftPayload.value = structuredClone(base.payload);
      draftRollout.value = base.rollout ? structuredClone(base.rollout) : {};
      draftComment.value = base.comment ?? "";
    }
  }

  /** 确保服务端存在草稿行（基于当前生效内容创建），并载入工作副本 */
  async function ensureDraft(): Promise<void> {
    const result = await api.post<{ view: ConfigVersionView; created: boolean }>("/admin/config/draft");
    draftPayload.value = structuredClone(result.view.payload);
    draftRollout.value = result.view.rollout ? structuredClone(result.view.rollout) : {};
    draftComment.value = result.view.comment ?? "";
    await loadVersions();
  }

  async function saveDraft(): Promise<void> {
    const result = await api.put<{ view: ConfigVersionView }>("/admin/config/draft", {
      payload: draftPayload.value,
      rollout: draftRollout.value,
      comment: draftComment.value || null,
    });
    draft.value = result.view;
    await loadVersions();
  }

  async function discardDraft(): Promise<void> {
    await api.del("/admin/config/draft");
    await loadVersions();
  }

  async function publishCanary(): Promise<ConfigVersionView> {
    const result = await api.post<{ view: ConfigVersionView }>("/admin/config/publish-canary", {
      payload: draftPayload.value!,
      rollout: draftRollout.value,
      comment: draftComment.value || undefined,
    });
    await loadVersions();
    return result.view;
  }

  async function updateCanaryRollout(rollout: RolloutRule): Promise<void> {
    await api.put("/admin/config/canary/rollout", { rollout });
    await loadVersions();
  }

  async function revokeCanary(): Promise<void> {
    await api.post("/admin/config/canary/revoke");
    await loadVersions();
  }

  async function publishFull(): Promise<ConfigVersionView> {
    const result = await api.post<{ view: ConfigVersionView }>("/admin/config/publish-full", {
      ...(draftPayload.value ? { payload: draftPayload.value } : {}),
      comment: draftComment.value || undefined,
    });
    await loadVersions();
    return result.view;
  }

  /** 灰度验证通过后直接转全量（无草稿、有 canary 的场景，后端识别并直接提升） */
  async function promoteCanaryToFull(comment?: string): Promise<ConfigVersionView> {
    const result = await api.post<{ view: ConfigVersionView }>("/admin/config/publish-full", { comment });
    await loadVersions();
    return result.view;
  }

  async function rollback(version: number, comment?: string): Promise<ConfigVersionView> {
    const result = await api.post<{ view: ConfigVersionView }>(`/admin/config/rollback/${version}`, { comment });
    await loadVersions();
    return result.view;
  }

  async function preview(identity: {
    userId?: string;
    userUuid?: string;
    role?: string;
  }): Promise<ConfigPreviewResult> {
    // 带上编辑器里尚未保存的灰度规则，实现「保存前就能试算」
    return api.post<ConfigPreviewResult>("/admin/config/preview", { ...identity, rollout: draftRollout.value });
  }

  return {
    specs,
    versions,
    active,
    canary,
    draft,
    draftPayload,
    draftRollout,
    draftComment,
    loadSpecs,
    loadVersions,
    ensureDraft,
    saveDraft,
    discardDraft,
    publishCanary,
    updateCanaryRollout,
    revokeCanary,
    publishFull,
    promoteCanaryToFull,
    rollback,
    preview,
  };
});
