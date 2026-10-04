<script setup lang="ts">
import { computed } from "vue";
import type { BankReceipt, Payment } from "../domain/types";
import { formatMoney } from "../domain/recon";
import { receiptKey } from "../domain/types";

const props = defineProps<{
  payments: Payment[];
  receipts: BankReceipt[]; // 当前视图可匹配回执（开放班实时 / 已确认班快照匹配）
  resolvedPaymentIds?: string[]; // 冲正链已处理（晚到补齐 / 退款）
  resolvedReceipts?: BankReceipt[]; // 冲正链晚到回执（已确认班）
  refundedPaymentIds?: string[]; // 跨班退款冲正
  extraReceipts?: BankReceipt[]; // 银行有、支付无
  editable?: boolean;
  canRefund?: boolean;
}>();

const emit = defineEmits<{
  (e: "update", payments: Payment[]): void;
  (e: "refund", payment: Payment): void;
}>();

const receiptByKey = computed(() => {
  const m = new Map<string, BankReceipt>();
  for (const r of props.receipts) m.set(receiptKey(r.terminalId, r.receiptNo), r);
  for (const r of props.resolvedReceipts ?? [])
    m.set(receiptKey(r.terminalId, r.receiptNo), r);
  return m;
});

type RowState = "matched" | "pending" | "resolved" | "refunded";

function stateOf(p: Payment): RowState {
  if (p.refundedInShiftId) return "refunded";
  if (props.refundedPaymentIds?.includes(p.id)) return "refunded";
  if (props.resolvedPaymentIds?.includes(p.id)) {
    // 晚到回执冲正：已有回执则视为已核销
    return receiptByKey.value.has(receiptKey(p.terminalId, p.receiptNo))
      ? "resolved"
      : "pending";
  }
  return receiptByKey.value.has(receiptKey(p.terminalId, p.receiptNo))
    ? "matched"
    : "pending";
}

const stateText: Record<RowState, string> = {
  matched: "已匹配·计收入",
  pending: "无回执·待核",
  resolved: "冲正补齐·已核销",
  refunded: "已跨班退款",
};

function patch(id: string, key: keyof Payment, raw: string) {
  emit(
    "update",
    props.payments.map((p) =>
      p.id === id
        ? ({ ...p, [key]: key === "amount" ? Number(raw) : raw } as Payment)
        : p
    )
  );
}

const matchedTotal = computed(() =>
  props.payments
    .filter((p) => stateOf(p) === "matched" || stateOf(p) === "resolved")
    .reduce((s, p) => s + p.amount, 0)
);
const pendingTotal = computed(() =>
  props.payments
    .filter((p) => stateOf(p) === "pending")
    .reduce((s, p) => s + p.amount, 0)
);
</script>

<template>
  <div class="pay-table">
    <table>
      <thead>
        <tr>
          <th>终端号</th>
          <th>回执号</th>
          <th>方式</th>
          <th class="num">金额</th>
          <th>状态</th>
          <th v-if="canRefund || editable"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in payments" :key="p.id" :class="`st-${stateOf(p)}`">
          <td>
            <input
              v-if="editable"
              :value="p.terminalId"
              @input="patch(p.id, 'terminalId', ($event.target as HTMLInputElement).value)"
            />
            <template v-else>{{ p.terminalId }}</template>
          </td>
          <td>
            <input
              v-if="editable"
              :value="p.receiptNo"
              @input="patch(p.id, 'receiptNo', ($event.target as HTMLInputElement).value)"
            />
            <template v-else>{{ p.receiptNo }}</template>
          </td>
          <td>{{ p.method }}</td>
          <td class="num">{{ formatMoney(p.amount) }}</td>
          <td>
            <span class="pay-state" :class="stateOf(p)">{{ stateText[stateOf(p)] }}</span>
            <span v-if="p.refundedInShiftId" class="sub">退于 {{ p.refundedInShiftId }}</span>
          </td>
          <td v-if="canRefund && stateOf(p) !== 'refunded'">
            <button class="mini danger" type="button" @click="emit('refund', p)">
              登记跨班退款
            </button>
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3">
            已匹配 {{ formatMoney(matchedTotal) }} · 待核
            {{ formatMoney(pendingTotal) }}
          </td>
          <td class="num"><b>{{ formatMoney(matchedTotal) }}</b></td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>

    <div v-if="extraReceipts && extraReceipts.length" class="extra-receipts">
      <p class="group-title">⚠ 银行有到账、班次无对应支付流水（挂账待核，不计收入）</p>
      <table>
        <tbody>
          <tr v-for="r in extraReceipts" :key="r.id">
            <td>终端 {{ r.terminalId }}</td>
            <td>回执号 {{ r.receiptNo }}</td>
            <td class="num">{{ formatMoney(r.amount) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
