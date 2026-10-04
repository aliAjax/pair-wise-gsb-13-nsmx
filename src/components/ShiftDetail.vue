<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useReconStore } from "../stores/recon";
import { receiptsForOpenShift } from "../domain/server";
import { formatMoney, viewShift } from "../domain/recon";
import type { Payment, PumpReading, Shift } from "../domain/types";
import PumpTable from "./PumpTable.vue";
import PaymentsTable from "./PaymentsTable.vue";
import CorrectionChain from "./CorrectionChain.vue";
import ConflictPanel from "./ConflictPanel.vue";

const store = useReconStore();

const props = defineProps<{ shift: Shift }>();

const confirmBy = ref("王站长");
const refundShift = ref("晚班");
const refundReason = ref("");
const adjustPumpId = ref("");
const adjustEnd = ref<number | null>(null);
const adjustReason = ref("");
const conflictHint = ref("");

/** 工作副本（仅开放班） */
const draft = reactive<{ pumps: PumpReading[]; cashTotal: number; payments: Payment[] }>({
  pumps: [],
  cashTotal: 0,
  payments: [],
});

function hydrateFrom(shift: Shift) {
  draft.pumps = JSON.parse(JSON.stringify(shift.pumps));
  draft.cashTotal = shift.cashTotal;
  draft.payments = JSON.parse(JSON.stringify(shift.payments));
  conflictHint.value = "";
}

watch(
  () => props.shift.id,
  (id) => {
    const s = store.server.shifts.find((x) => x.id === id);
    if (s) hydrateFrom(s);
  },
  { immediate: true }
);

// 已生效版本前进（其它窗口）时，若本地没有未保存改动则跟随刷新
watch(
  () => props.shift.version,
  () => {
    if (props.shift.status === "open" && !dirty.value) hydrateFrom(props.shift);
  }
);

/** 离线时预览：以最新一条待发保存草稿覆盖工作副本口径 */
const pendingSave = computed(() => store.pendingSaveFor(props.shift.id));

const effectiveSource = computed<Shift>(() => {
  if (props.shift.status === "open" && pendingSave.value && pendingSave.value.op.kind === "saveShift") {
    const op = pendingSave.value.op;
    return {
      ...props.shift,
      pumps: op.pumps,
      cashTotal: op.cashTotal,
      payments: op.payments,
    };
  }
  return props.shift;
});

const openReceipts = computed(() =>
  props.shift.status === "open"
    ? receiptsForOpenShift(store.server, effectiveSource.value)
    : []
);

const view = computed(() =>
  viewShift(effectiveSource.value, openReceipts.value)
);

// 已确认班冲正链晚到回执，供支付表显示「已核销」
const lateReceipts = computed(() =>
  props.shift.corrections
    .map((c) => c.lateReceipt)
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
);

const dirty = computed(() => {
  if (props.shift.status !== "open") return false;
  return (
    JSON.stringify(draft.pumps) !== JSON.stringify(props.shift.pumps) ||
    draft.cashTotal !== props.shift.cashTotal ||
    JSON.stringify(draft.payments) !== JSON.stringify(props.shift.payments)
  );
});

function save() {
  const res = store.saveShift({
    shiftId: props.shift.id,
    baseVersion: props.shift.version,
    pumps: draft.pumps,
    cashTotal: draft.cashTotal,
    payments: draft.payments,
  });
  if (res.conflict) {
    conflictHint.value =
      `保存与已生效 v${res.conflict.serverVersion} 冲突，已存为冲突草稿，未覆盖。请刷新工作副本后人工合并。`;
  }
}

function followServer() {
  hydrateFrom(props.shift);
}

function confirm() {
  store.confirmShift(props.shift.id, props.shift.version, confirmBy.value || "站长");
}

function addPaymentRow() {
  draft.payments.push({
    id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    terminalId: "T01",
    receiptNo: "",
    amount: 0,
    method: "微信",
    paidAt: Date.now(),
  });
}

function onRefund(p: Payment) {
  try {
    const res = store.addRefund({
      shiftId: props.shift.id,
      baseVersion: props.shift.version,
      paymentId: p.id,
      refundedInShiftId: refundShift.value,
      reason: refundReason.value,
    });
    if (res.conflict) {
      conflictHint.value =
        "退款操作与已生效版本冲突，已存为冲突草稿，未覆盖生效结果。";
    }
  } catch (e) {
    conflictHint.value =
      "退款登记失败：" + (e as Error).message + "（新增流水请先保存班次）";
  }
}

function onAdjust() {
  if (!adjustPumpId.value || adjustEnd.value === null) return;
  try {
    const res = store.adjustPump({
      shiftId: props.shift.id,
      baseVersion: props.shift.version,
      pumpId: adjustPumpId.value,
      toEndReading: Math.round(adjustEnd.value * 100),
      reason: adjustReason.value,
    });
    if (res.conflict) {
      conflictHint.value = "泵码冲正与已生效版本冲突，已存为冲突草稿。";
    }
  } catch (e) {
    conflictHint.value = "泵码冲正失败：" + (e as Error).message;
  }
  adjustEnd.value = null;
  adjustReason.value = "";
}

function loadConflictDraft(d: import("../stores/recon").ConflictDraft) {
  const draftObj = store.loadConflict(d.id);
  if (draftObj && draftObj.op.kind === "saveShift") {
    hydrateFrom({
      ...props.shift,
      pumps: draftObj.op.pumps,
      cashTotal: draftObj.op.cashTotal,
      payments: draftObj.op.payments,
    });
    conflictHint.value =
      `已载入冲突草稿内容（基于 v${draftObj.baseVersion}）。当前生效为 v${draftObj.serverVersion}，核对后可重新保存；原冲突草稿仍保留，可手动放弃。`;
  }
}
</script>

<template>
  <section class="detail">
    <ConflictPanel :drafts="store.shiftConflicts(shift.id)" @load="loadConflictDraft" />

    <div v-if="conflictHint" class="conflict-hint">
      {{ conflictHint }}
      <button class="mini secondary" type="button" @click="followServer">
        取最新生效结果重开
      </button>
    </div>

    <header class="detail-head">
      <div>
        <h2>{{ shift.date }} {{ shift.name }}</h2>
        <p class="meta">
          {{ shift.window }} · {{ shift.station }} · 当前版本
          <b>v{{ shift.version }}</b>
          <span class="badge" :class="shift.status">
            {{ shift.status === "confirmed" ? "已确认（依据已冻结）" : "开放中" }}
          </span>
        </p>
      </div>
    </header>

    <!-- 汇总卡 -->
    <div class="summary-grid">
      <article class="sum">
        <span>泵码油款</span>
        <strong>{{ formatMoney(view.current.pumpAmount) }}</strong>
      </article>
      <article class="sum">
        <span>现金</span>
        <strong>{{ formatMoney(view.current.cash) }}</strong>
      </article>
      <article class="sum">
        <span>电子支付·已匹配</span>
        <strong>{{ formatMoney(view.current.electronicMatched) }}</strong>
      </article>
      <article class="sum income">
        <span>当班收入</span>
        <strong>{{ formatMoney(view.current.incomeTotal) }}</strong>
        <small>未匹配回执不参与</small>
      </article>
      <article class="sum" :class="{ alert: view.current.electronicPending > 0 }">
        <span>电子无回执·待核</span>
        <strong>{{ formatMoney(view.current.electronicPending) }}</strong>
      </article>
      <article class="sum" :class="{ alert: view.current.receiptsUnmatched > 0 }">
        <span>回执无流水·挂账</span>
        <strong>{{ formatMoney(view.current.receiptsUnmatched) }}</strong>
      </article>
      <article class="sum" :class="{ alert: view.current.pendingDiff !== 0 }">
        <span>待核差异合计</span>
        <strong>{{ formatMoney(view.current.pendingDiff) }}</strong>
      </article>
      <article class="sum" :class="{ alert: view.current.crossDiff !== 0 }">
        <span>泵码↔收款差异</span>
        <strong>{{ formatMoney(view.current.crossDiff) }}</strong>
      </article>
    </div>

    <!-- 油枪 -->
    <section class="block">
      <h3>油枪读数（泵码）</h3>
      <PumpTable
        :pumps="effectiveSource.pumps"
        :editable="shift.status === 'open'"
        @update="(v: PumpReading[]) => (draft.pumps = v)"
      />
    </section>

    <!-- 现金 -->
    <section class="block cash-row">
      <h3>现金</h3>
      <label>
        当班现金（元）
        <input
          v-if="shift.status === 'open'"
          type="number"
          :value="(draft.cashTotal / 100).toFixed(2)"
          @input="draft.cashTotal = Math.round(Number(($event.target as HTMLInputElement).value) * 100)"
        />
        <strong v-else>{{ formatMoney(shift.snapshot?.cashTotal ?? shift.cashTotal) }}</strong>
      </label>
    </section>

    <!-- 支付 / 回执 -->
    <section class="block">
      <h3>
        电子支付 × 银行回执
        <span class="hint">按 终端号 + 回执号 匹配</span>
      </h3>
      <PaymentsTable
        :payments="effectiveSource.payments"
        :receipts="shift.status === 'open' ? openReceipts : (shift.snapshot?.matchedReceipts ?? [])"
        :resolved-payment-ids="view.resolvedPaymentIds"
        :resolved-receipts="lateReceipts"
        :refunded-payment-ids="view.refundedPaymentIds"
        :extra-receipts="view.base.extraReceipts"
        :editable="shift.status === 'open'"
        :can-refund="true"
        @update="(v: Payment[]) => (draft.payments = v)"
        @refund="onRefund"
      />
      <div v-if="shift.status === 'open'" class="refund-form">
        <button class="secondary" type="button" @click="addPaymentRow">＋ 添加电子支付流水</button>
        <label>
          跨班退款发生班次
          <input v-model="refundShift" placeholder="如 晚班 / 次日早班" />
        </label>
        <label>
          退款说明
          <input v-model="refundReason" placeholder="可选" />
        </label>
      </div>
    </section>

    <!-- 已确认：泵码更新冲正 -->
    <section v-if="shift.status === 'confirmed'" class="block adjust-block">
      <h3>泵码更新（只追加冲正，原确认终码保留）</h3>
      <div class="adjust-form">
        <label>
          油枪
          <select v-model="adjustPumpId">
            <option value="" disabled>选择油枪</option>
            <option v-for="p in shift.snapshot?.pumpTotals ?? []" :key="p.id" :value="p.id">
              {{ p.pumpNo }} 号枪 · {{ p.grade }}
            </option>
          </select>
        </label>
        <label>
          新收班泵码（升）
          <input v-model.number="adjustEnd" type="number" step="0.01" />
        </label>
        <label class="grow">
          说明
          <input v-model="adjustReason" placeholder="如 油机回传泵码修正" />
        </label>
        <button type="button" @click="onAdjust">追加泵码冲正</button>
      </div>
    </section>

    <!-- 冲正链 -->
    <section class="block">
      <h3>冲正链</h3>
      <CorrectionChain :corrections="shift.corrections" />
    </section>

    <!-- 确认依据 -->
    <section v-if="shift.snapshot" class="block snapshot">
      <h3>原始确认依据（冻结，不再改写）</h3>
      <p class="meta">
        确认人 {{ shift.snapshot.confirmedBy }} ·
        {{ new Date(shift.snapshot.confirmedAt).toLocaleString("zh-CN") }} ·
        依据版本 v{{ shift.snapshot.version }} ·
        确认时收入 {{ formatMoney(shift.snapshot.income.incomeTotal) }} ·
        确认时待核差异 {{ formatMoney(shift.snapshot.pending.pendingDiff) }}
      </p>
    </section>

    <!-- 开放班操作 -->
    <section v-if="shift.status === 'open'" class="block actions">
      <button type="button" :disabled="!dirty && !store.online" @click="save">
        {{ store.online ? "保存" : "离线留草稿" }}
      </button>
      <button type="button" class="primary" @click="confirm">确认班次（冻结依据）</button>
      <span v-if="dirty" class="dirty-tip">有未保存修改</span>
      <span v-else-if="!store.online" class="dirty-tip offline">断网中：保存将进入待发草稿</span>
    </section>
  </section>
</template>
