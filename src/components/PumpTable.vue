<script setup lang="ts">
import { computed } from "vue";
import type { PumpReading } from "../domain/types";
import { formatLiters, formatMoney, pumpAmount, pumpLiters } from "../domain/recon";

const props = defineProps<{
  pumps: PumpReading[];
  editable?: boolean;
}>();
const emit = defineEmits<{
  (e: "update", pumps: PumpReading[]): void;
}>();

const totalLiters = computed(() =>
  props.pumps.reduce((s, p) => s + pumpLiters(p), 0)
);
const totalAmount = computed(() =>
  props.pumps.reduce((s, p) => s + pumpAmount(p), 0)
);

function patch(id: string, key: keyof PumpReading, raw: string | number) {
  const value = typeof raw === "string" ? Number(raw) : raw;
  emit(
    "update",
    props.pumps.map((p) => (p.id === id ? { ...p, [key]: value } : p))
  );
}

function num(p: PumpReading, key: "startReading" | "endReading" | "pricePerL") {
  return p[key];
}
</script>

<template>
  <div class="pump-table">
    <table>
      <thead>
        <tr>
          <th>油枪</th>
          <th>油品</th>
          <th>开班泵码</th>
          <th>收班泵码</th>
          <th>发油量</th>
          <th>单价</th>
          <th class="num">油款</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in pumps" :key="p.id">
          <td>{{ p.pumpNo }} 号枪</td>
          <td>{{ p.grade }}</td>
          <td>
            <input
              v-if="editable"
              type="number"
              :value="num(p, 'startReading')"
              @input="patch(p.id, 'startReading', ($event.target as HTMLInputElement).value)"
            />
            <template v-else>{{ (p.startReading / 100).toFixed(2) }}</template>
          </td>
          <td>
            <input
              v-if="editable"
              type="number"
              :value="num(p, 'endReading')"
              @input="patch(p.id, 'endReading', ($event.target as HTMLInputElement).value)"
            />
            <template v-else>{{ (p.endReading / 100).toFixed(2) }}</template>
          </td>
          <td>{{ formatLiters(pumpLiters(p)) }}</td>
          <td>
            <input
              v-if="editable"
              type="number"
              :value="num(p, 'pricePerL')"
              @input="patch(p.id, 'pricePerL', ($event.target as HTMLInputElement).value)"
            />
            <template v-else>¥{{ (p.pricePerL / 100).toFixed(2) }}/L</template>
          </td>
          <td class="num">{{ formatMoney(pumpAmount(p)) }}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="4">合计</td>
          <td>{{ formatLiters(totalLiters) }}</td>
          <td></td>
          <td class="num"><b>{{ formatMoney(totalAmount) }}</b></td>
        </tr>
      </tfoot>
    </table>
  </div>
</template>
