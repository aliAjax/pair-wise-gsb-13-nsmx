<script setup lang="ts">
import { computed } from "vue";
import { useReconStore } from "../stores/recon";
import { viewShift, formatMoney } from "../domain/recon";
import { receiptsForOpenShift } from "../domain/server";

const store = useReconStore();

const rows = computed(() =>
  store.shifts.map((shift) => {
    const receipts =
      shift.status === "open" ? receiptsForOpenShift(store.server, shift) : [];
    const view = viewShift(shift, receipts);
    return {
      shift,
      view,
      pendingCount: store.pendingOutbox.filter((o) =>
        "shiftId" in o.op ? o.op.shiftId === shift.id : false
      ).length,
      conflicts: store.shiftConflicts(shift.id).length,
    };
  })
);

function select(id: string) {
  store.selectShift(id);
}
</script>

<template>
  <aside class="shift-list">
    <h2>班次</h2>
    <article
      v-for="row in rows"
      :key="row.shift.id"
      class="shift-card"
      :class="{
        active: (store.activeShift?.id ?? '') === row.shift.id,
        confirmed: row.shift.status === 'confirmed',
      }"
      @click="select(row.shift.id)"
    >
      <div class="shift-card-head">
        <strong>{{ row.shift.date }} {{ row.shift.name }}</strong>
        <span class="badge" :class="row.shift.status">
          {{ row.shift.status === "confirmed" ? "已确认" : "开放中" }}
        </span>
      </div>
      <p class="shift-window">{{ row.shift.window }} · v{{ row.shift.version }}</p>
      <div class="shift-metrics">
        <span>当班收入 <b>{{ formatMoney(row.view.current.incomeTotal) }}</b></span>
        <span
          class="warn"
          v-if="row.view.current.pendingDiff > 0"
        >待核差异 <b>{{ formatMoney(row.view.current.pendingDiff) }}</b></span>
      </div>
      <div v-if="row.shift.corrections.length" class="chain-tag">
        冲正链 {{ row.shift.corrections.length }} 条
      </div>
      <div class="card-flags">
        <span v-if="row.pendingCount" class="flag draft">待发草稿 {{ row.pendingCount }}</span>
        <span v-if="row.conflicts" class="flag conflict">冲突草稿 {{ row.conflicts }}</span>
      </div>
    </article>
  </aside>
</template>
