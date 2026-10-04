<script setup lang="ts">
import type { Correction } from "../domain/types";
import { formatMoney } from "../domain/recon";

const props = defineProps<{
  corrections: Correction[];
}>();

const labels: Record<Correction["type"], string> = {
  late_receipt: "晚到回执",
  cross_shift_refund: "跨班退款",
  pump_adjust: "泵码更新",
};

function chain(): Correction[] {
  return [...props.corrections].sort((a, b) => a.createdAt - b.createdAt);
}
</script>

<template>
  <div class="correction-chain">
    <p v-if="!props.corrections.length" class="empty-inline">
      暂无冲正。确认后若遇到跨班退款、晚到回执或泵码更新，只会追加到此链，原始确认依据保留。
    </p>
    <ol v-else class="chain">
      <li v-for="(c, i) in chain()" :key="c.id" class="chain-item">
        <div class="chain-dot">{{ i + 1 }}</div>
        <div class="chain-body">
          <div class="chain-head">
            <span class="chain-type" :class="c.type">{{ labels[c.type] }}</span>
            <span class="chain-time">{{ new Date(c.createdAt).toLocaleString("zh-CN") }}</span>
          </div>
          <p class="chain-reason">{{ c.reason }}</p>
          <div class="chain-deltas">
            <span v-if="c.incomeDelta !== 0" :class="c.incomeDelta < 0 ? 'neg' : 'pos'">
              收入 {{ c.incomeDelta > 0 ? "+" : "" }}{{ formatMoney(c.incomeDelta) }}
            </span>
            <span v-if="c.pendingDelta !== 0" class="pending">
              待核差异 {{ c.pendingDelta > 0 ? "+" : "" }}{{ formatMoney(c.pendingDelta) }}
            </span>
            <span v-if="c.pumpDelta !== 0" :class="c.pumpDelta < 0 ? 'neg' : 'pos'">
              泵码油款 {{ c.pumpDelta > 0 ? "+" : "" }}{{ formatMoney(c.pumpDelta) }}
            </span>
            <span v-if="c.fromEndReading !== undefined && c.toEndReading !== undefined" class="sub">
              终码 {{ (c.fromEndReading! / 100).toFixed(2) }} →
              {{ (c.toEndReading! / 100).toFixed(2) }}
            </span>
            <span v-if="c.refundedInShiftId" class="sub">退于 {{ c.refundedInShiftId }}</span>
          </div>
        </div>
      </li>
    </ol>
  </div>
</template>
