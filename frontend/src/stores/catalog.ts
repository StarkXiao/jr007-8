import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "@/api/client";
import type { Category } from "@/api/types";

interface MetaPayload {
  reviewReasonCodes: Array<{ code: string; label: string }>;
  reportReasons: Array<{ code: string; label: string }>;
}

// 分类与属性 Schema 全部来自后端，前端不硬编码任何字段，
// 管理员改了 Schema 之后表单会自动跟着变。
export const useCatalogStore = defineStore("catalog", () => {
  const categories = ref<Category[]>([]);
  const meta = ref<MetaPayload>({ reviewReasonCodes: [], reportReasons: [] });
  const loaded = ref(false);
  // 后端灰度命中时该用户拿到的是 canary 版本，用版本号+状态标识
  const configVersion = ref<number | null>(null);
  const configStatus = ref<"active" | "canary" | null>(null);

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return;
    const [categoryResult, metaResult] = await Promise.all([
      api.get<{ items: Array<Category & { configStatus?: "active" | "canary" }> }>("/categories"),
      api.get<MetaPayload>("/meta"),
    ]);
    categories.value = categoryResult.items;
    configVersion.value = categoryResult.items[0]?.schemaVersion ?? null;
    configStatus.value = categoryResult.items[0]?.configStatus ?? "active";
    meta.value = metaResult;
    loaded.value = true;
  }

  function byCode(code: string): Category | undefined {
    return categories.value.find((item) => item.code === code);
  }

  return { categories, meta, loaded, configVersion, configStatus, load, byCode };
});
