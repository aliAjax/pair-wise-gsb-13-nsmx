<script setup lang="ts">
import { useReconStore, type ConflictDraft } from "../stores/recon";

defineProps<{ drafts: ConflictDraft[] }>();
const emit = defineEmits<{ (e: "load", draft: ConflictDraft): void }>();
const store = useReconStore();

function summary(c: ConflictDraft): string {
  switch (c.op.kind) {
    case "saveShift":
      return `保存油枪 ${c.op.pumps.length} 条、现金 ¥${(c.op.cashTotal / 100).toFixed(
        2
      )}、支付 ${c.op.payments.length} 条`;
    case "confirmShift":
      return "确认班次";
    case "addRefund":
      return "登记跨班退款";
    case "adjustPump":
      return "泵码更新冲正";
    default:
      return "银行回执同步";
  }
}
</script>

<template>
  <section v-if="drafts.length" class="conflict-box">
    <h3>⛔ 冲突草稿（{{ drafts.length }}）— 旧版本未覆盖已生效结果</h3>
    <article v-for="c in drafts" :key="c.id" class="conflict-item">
      <div class="conflict-main">
        <p class="conflict-label">{{ c.label }}</p>
        <p class="conflict-summary">{{ summary(c) }}</p>
        <p class="conflict-meta">
          草稿依据版本 <b>v{{ c.baseVersion }}</b>，保存时已被其它窗口生效到
          <b>v{{ c.serverVersion }}</b
          >；{{ new Date(c.createdAt).toLocaleString("zh-CN") }}
        </p>
      </div>
      <div class="conflict-actions">
        <button type="button" class="secondary" @click="emit('load', c)">
          载入编辑器人工合并
        </button>
        <button type="button" class="ghost danger-text" @click="store.discardConflict(c.id)">
          放弃草稿
        </button>
      </div>
    </article>
  </section>
</template>
