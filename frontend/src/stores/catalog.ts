import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "@/api/client";
import type { Category } from "@/api/types";

interface MetaPayload {
  reviewReasonCodes: Array<{ code: string; label: string }>;
  reportReasons: Array<{ code: string; label: string }>;
  config?: {
    version: number;
    canary: boolean;
    thresholds: {
      commentEditWindowMs: number;
      commentMaxEdits: number;
      confirmationCooldownMs: number;
    };
  };
}

// 分类与属性 Schema 全部来自后端，前端不硬编码任何字段，
// 管理员在线发布（含灰度）后，命中灰度的用户会立即拿到新版本。
export const useCatalogStore = defineStore("catalog", () => {
  const categories = ref<Category[]>([]);
  const meta = ref<MetaPayload>({ reviewReasonCodes: [], reportReasons: [] });
  const loaded = ref(false);
  const configVersion = ref(0);
  const configCanary = ref(false);

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return;
    const [categoryResult, metaResult] = await Promise.all([
      api.get<{ items: Category[]; configVersion?: number; canary?: boolean }>("/categories"),
      api.get<MetaPayload>("/meta"),
    ]);
    categories.value = categoryResult.items;
    configVersion.value = categoryResult.configVersion ?? metaResult.config?.version ?? 0;
    configCanary.value = categoryResult.canary ?? metaResult.config?.canary ?? false;
    meta.value = metaResult;
    loaded.value = true;
  }

  function byCode(code: string): Category | undefined {
    return categories.value.find((item) => item.code === code);
  }

  return { categories, meta, loaded, configVersion, configCanary, load, byCode };
});
