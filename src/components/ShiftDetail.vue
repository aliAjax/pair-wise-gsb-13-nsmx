<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { ElMessage } from "element-plus";
import type { Payment, PumpReading } from "@shared/types";
import { pumpVolume } from "@shared/domain";
import { useStore } from "../store";
import { localId } from "../lib/terminal";
import { liters, signedYuan, time, yuan } from "../lib/format";

const props = defineProps<{ shiftId: string }>();
const store = useStore();
const { terminalNo, pendingReceipts } = storeToRefs(store);

const shift = computed(() => store.state?.shifts.find((s) => s.id === props.shiftId) ?? null);

// 编辑工作副本：open 班次可改，改动即时入本地草稿（关页面也不丢）
const pumps = ref<PumpReading[]>([]);
const payments = ref<Payment[]>([]);
const saving = ref(false);

function syncWorkingCopy() {
  if (!shift.value) return;
  const d = store.getDraft(props.shiftId);
  if (d) {
    pumps.value = JSON.parse(JSON.stringify(d.pumps));
    payments.value = JSON.parse(JSON.stringify(d.payments));
  } else {
    pumps.value = JSON.parse(JSON.stringify(shift.value.pumps));
    payments.value = JSON.parse(JSON.stringify(shift.value.payments));
  }
}

watch(
  () => [props.shiftId, shift.value?.version, store.drafts[props.shiftId]?.savedAt ?? ""],
  syncWorkingCopy,
);
syncWorkingCopy();

const draft = computed(() => store.getDraft(props.shiftId));
const view = computed(() => store.view(props.shiftId));
const isOpen = computed(() => shift.value?.status === "open");

function touch() {
  if (!shift.value || !isOpen.value) return;
  store.saveDraft(props.shiftId, shift.value.version, pumps.value, payments.value);
}

function addPump() {
  pumps.value.push({ pumpNo: `P${pumps.value.length + 1}`, product: "92#", price: 7.62, startMeter: 0, endMeter: 0 });
  touch();
}
function addPayment(method: "cash" | "electronic") {
  payments.value.push({
    id: localId(terminalNo.value, "pay"),
    clientId: localId(terminalNo.value, "pay"),
    method,
    amount: 0,
    terminalNo: method === "electronic" ? terminalNo.value : undefined,
    paidAt: new Date().toISOString(),
  });
  touch();
}
function removePayment(p: Payment) {
  payments.value = payments.value.filter((x) => x.clientId !== p.clientId);
  touch();
}

async function save() {
  if (!draft.value) {
    ElMessage.info("没有未保存的改动");
    return;
  }
  saving.value = true;
  const ok = await store.commitDraft(props.shiftId, draft.value);
  saving.value = false;
  if (ok) ElMessage.success("已保存并生效");
}

async function confirmShift() {
  if (!shift.value) return;
  if (draft.value) {
    ElMessage.warning("请先保存本地草稿再确认班次");
    return;
  }
  await store.dispatch({
    type: "confirm",
    label: `确认班次 ${shift.value.name}`,
    shiftId: shift.value.id,
    endpoint: `/api/shifts/${shift.value.id}/confirm`,
    payload: { version: shift.value.version },
  });
}

function discard() {
  store.discardDraft(props.shiftId);
}

// 待核回执：挂到本班
async function linkReceipt(r: { terminalNo: string; receiptNo: string }) {
  if (!shift.value) return;
  const clientId = localId(terminalNo.value, "link");
  await store.dispatch({
    type: "linkReceipt",
    label: `核销回执 ${r.receiptNo}`,
    endpoint: "/api/receipts/link",
    payload: {
      terminalNo: r.terminalNo,
      receiptNo: r.receiptNo,
      shiftId: shift.value.id,
      version: shift.value.version,
      clientId,
    },
  });
}

// 冲正弹窗
const dialog = ref<null | "refund" | "pump">(null);
const refundForm = reactive({ amount: 260, reason: "", originShiftId: "" });
const pumpForm = reactive({ pumpNo: "", price: 0, oldMeter: 0, newMeter: 0, reason: "" });

function openPumpAdjust() {
  const p = shift.value?.confirmedBasis?.pumps[0] ?? shift.value?.pumps[0];
  if (p) {
    pumpForm.pumpNo = p.pumpNo;
    pumpForm.price = p.price;
    pumpForm.oldMeter = p.endMeter;
    pumpForm.newMeter = p.endMeter;
  }
  dialog.value = "pump";
}

async function submitRefund() {
  if (!shift.value) return;
  const ok = await store.dispatch({
    type: "correction",
    label: `跨班退款冲正 -${refundForm.amount}`,
    shiftId: shift.value.id,
    endpoint: `/api/shifts/${shift.value.id}/corrections/cross-shift-refund`,
    payload: {
      kind: "refund",
      version: shift.value.version,
      amount: refundForm.amount,
      reason: refundForm.reason || "跨班退款",
      originShiftId: refundForm.originShiftId || undefined,
      clientId: localId(terminalNo.value, "refund"),
    },
  });
  if (ok) {
    dialog.value = null;
    refundForm.reason = "";
  }
}

async function submitPump() {
  if (!shift.value) return;
  const ok = await store.dispatch({
    type: "correction",
    label: `泵码更新冲正 ${pumpForm.pumpNo}`,
    shiftId: shift.value.id,
    endpoint: `/api/shifts/${shift.value.id}/corrections/pump-adjust`,
    payload: {
      kind: "pump",
      version: shift.value.version,
      pumpNo: pumpForm.pumpNo,
      price: pumpForm.price,
      oldMeter: pumpForm.oldMeter,
      newMeter: pumpForm.newMeter,
      reason: pumpForm.reason || "确认后泵码更新",
      clientId: localId(terminalNo.value, "pumpadj"),
    },
  });
  if (ok) dialog.value = null;
}

const correctionTypeText: Record<string, string> = {
  cross_shift_refund: "跨班退款",
  late_receipt: "晚到回执",
  pump_adjust: "泵码更新",
};

// 本班可核销的待核回执（全部待核都可人工挂班）
const myPending = computed(() => pendingReceipts.value);
</script>

<template>
  <el-card v-if="shift && view" shadow="never" class="detail">
    <template #header>
      <div class="dhead">
        <div>
          <span class="dtitle">{{ shift.name }}</span>
          <el-tag :type="isOpen ? 'warning' : 'success'" style="margin-left: 8px">
            {{ isOpen ? "进行中 · 可编辑" : "已确认生效 · 只允许追加冲正" }}
          </el-tag>
          <el-tag size="small" type="info" style="margin-left:6px">版本 v{{ shift.version }}</el-tag>
        </div>
        <div v-if="isOpen" class="dops">
          <el-tag v-if="draft" size="small" type="warning">
            本地草稿（基于 v{{ draft.baseVersion }}）· 已自动保存于本机
          </el-tag>
          <el-button @click="discard" :disabled="!draft">放弃草稿</el-button>
          <el-button type="primary" :loading="saving" :disabled="!draft" @click="save">保存班次</el-button>
          <el-button type="success" @click="confirmShift">确认班次</el-button>
        </div>
        <div v-else class="dops">
          <el-button @click="dialog = 'refund'">＋ 跨班退款冲正</el-button>
          <el-button @click="openPumpAdjust">＋ 泵码更新冲正</el-button>
        </div>
      </div>
    </template>

    <!-- 核销总览 -->
    <el-descriptions :column="6" border size="small" class="summary">
      <el-descriptions-item label="泵码发油量">{{ liters(view.volume) }}</el-descriptions-item>
      <el-descriptions-item label="应收（泵码口径）">{{ yuan(view.income) }}</el-descriptions-item>
      <el-descriptions-item label="现金">{{ yuan(view.cash) }}</el-descriptions-item>
      <el-descriptions-item label="已核销电子">{{ yuan(view.electronicMatched) }}</el-descriptions-item>
      <el-descriptions-item label="实收合计">{{ yuan(view.collected) }}</el-descriptions-item>
      <el-descriptions-item label="对账差异（保留）">
        <el-text :type="Math.abs(view.diff) < 0.005 ? 'success' : 'danger'">{{ yuan(view.diff) }}</el-text>
      </el-descriptions-item>
    </el-descriptions>
    <el-alert
      v-if="view.electronicUnmatched > 0.005"
      type="warning"
      :closable="false"
      show-icon
      style="margin: 8px 0"
      :title="`有 ${yuan(view.electronicUnmatched)} 电子支付尚无银行回执，计入差异但不核销，绝不拉高当班收入`"
    />

    <el-row :gutter="12">
      <!-- 油枪 -->
      <el-col :span="12">
        <el-card shadow="never" class="panel">
          <template #header>
            <div class="ph">
              <span>油枪泵码读数</span>
              <el-button v-if="isOpen" size="small" text type="primary" @click="addPump">＋ 油枪</el-button>
            </div>
          </template>
          <el-table :data="isOpen ? pumps : shift.confirmedBasis?.pumps ?? shift.pumps" size="small">
            <el-table-column prop="pumpNo" label="油枪" width="70">
              <template #default="{ row }">
                <el-input v-if="isOpen" v-model="row.pumpNo" size="small" @change="touch" />
                <span v-else>{{ row.pumpNo }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="product" label="油品" width="80">
              <template #default="{ row }">
                <el-select v-if="isOpen" v-model="row.product" size="small" @change="touch">
                  <el-option label="92#" value="92#" /><el-option label="95#" value="95#" /><el-option label="0#" value="0#" />
                </el-select>
                <span v-else>{{ row.product }}</span>
              </template>
            </el-table-column>
            <el-table-column label="接班泵码" width="110">
              <template #default="{ row }">
                <el-input-number v-if="isOpen" v-model="row.startMeter" :controls="false" size="small" @change="touch" />
                <span v-else>{{ row.startMeter }}</span>
              </template>
            </el-table-column>
            <el-table-column label="交班泵码" width="110">
              <template #default="{ row }">
                <el-input-number v-if="isOpen" v-model="row.endMeter" :controls="false" size="small" @change="touch" />
                <span v-else>{{ row.endMeter }}</span>
              </template>
            </el-table-column>
            <el-table-column label="单价" width="90">
              <template #default="{ row }">
                <el-input-number v-if="isOpen" v-model="row.price" :controls="false" :precision="2" size="small" @change="touch" />
                <span v-else>{{ row.price.toFixed(2) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="发油量 / 金额">
              <template #default="{ row }">
                {{ liters(pumpVolume(row)) }} / <b>{{ yuan(pumpVolume(row) * row.price) }}</b>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <!-- 收款 -->
      <el-col :span="12">
        <el-card shadow="never" class="panel">
          <template #header>
            <div class="ph">
              <span>现金 / 电子支付</span>
              <span v-if="isOpen">
                <el-button size="small" text type="primary" @click="addPayment('cash')">＋ 现金</el-button>
                <el-button size="small" text type="primary" @click="addPayment('electronic')">＋ 电子支付</el-button>
              </span>
            </div>
          </template>
          <el-table :data="isOpen ? payments : shift.payments" size="small">
            <el-table-column label="方式" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.method === 'cash' ? '' : 'warning'">
                  {{ row.method === "cash" ? "现金" : "电子" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="金额" width="110">
              <template #default="{ row }">
                <el-input-number v-if="isOpen" v-model="row.amount" :controls="false" :precision="2" size="small" @change="touch" />
                <span v-else :class="{ neg: row.amount < 0 }">{{ yuan(row.amount) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="终端/回执" min-width="130">
              <template #default="{ row }">
                <span v-if="row.method === 'electronic'">
                  {{ row.terminalNo }} ·
                  <el-tag v-if="row.receiptNo" size="small" type="success">{{ row.receiptNo }}</el-tag>
                  <el-tag v-else size="small" type="info">待回执</el-tag>
                </span>
                <span v-else class="dim">柜面</span>
              </template>
            </el-table-column>
            <el-table-column prop="note" label="备注" min-width="120" />
            <el-table-column v-if="isOpen" label="" width="50">
              <template #default="{ row }">
                <el-button link type="danger" size="small" @click="removePayment(row)">删</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 待核回执 -->
    <el-card shadow="never" class="panel">
      <template #header>
        <div class="ph"><span>银行回执待核（全站收件箱）</span>
          <el-text size="small" type="info">按 终端号+回执号 幂等合并；未匹配只进待核，不计当班收入</el-text>
        </div>
      </template>
      <el-table :data="myPending" size="small" empty-text="暂无待核回执（新回执自动匹配未确认班次的电子支付）">
        <el-table-column prop="terminalNo" label="终端" width="80" />
        <el-table-column prop="receiptNo" label="回执号" width="120" />
        <el-table-column label="金额" width="110">
          <template #default="{ row }">{{ yuan(row.amount) }}
            <el-tag v-if="row.amountMismatch" size="small" type="danger">金额不符</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="交易/到账" min-width="200">
          <template #default="{ row }">{{ time(row.txTime) }} → {{ time(row.arrivedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="linkReceipt(row)">
              挂到「{{ shift.name }}」{{ isOpen ? "核销电子支付" : "作晚到回执冲正" }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 冲正链 -->
    <el-card v-if="shift.correctionChain.length" shadow="never" class="panel">
      <template #header>
        <div class="ph">
          <span>冲正链（只追加，原确认依据保留）</span>
          <el-text size="small" type="info">
            已确认部分重算 = 原确认依据 {{ yuan(shift.confirmedBasis?.income ?? 0) }}
            <template v-if="view.correctionIncome !== 0"> {{ signedYuan(view.correctionIncome) }}</template>
            = <b>{{ yuan(view.income) }}</b>
          </el-text>
        </div>
      </template>
      <el-timeline>
        <el-timeline-item
          v-for="x in shift.correctionChain"
          :key="x.id"
          :type="x.type === 'cross_shift_refund' ? 'danger' : x.type === 'pump_adjust' ? 'warning' : 'primary'"
          :timestamp="`${time(x.createdAt)} · 终端 ${x.terminalNo} · ${x.clientId}`"
        >
          <el-tag size="small">{{ correctionTypeText[x.type] }}</el-tag>
          <span style="margin-left: 8px">{{ x.reason }}</span>
          <div class="corr">
            <span>应收影响：<b :class="{ neg: x.incomeDelta < 0, pos: x.incomeDelta > 0 }">{{ signedYuan(x.incomeDelta) }}</b></span>
            <span>实收影响：<b :class="{ neg: x.collectedDelta < 0, pos: x.collectedDelta > 0 }">{{ signedYuan(x.collectedDelta) }}</b></span>
            <span v-if="x.volumeDelta">油量影响：<b :class="{ neg: x.volumeDelta < 0, pos: x.volumeDelta > 0 }">{{ x.volumeDelta > 0 ? "+" : "" }}{{ x.volumeDelta }} L</b></span>
            <span v-if="x.receiptSnapshot" class="dim">
              回执 {{ x.receiptSnapshot.terminalNo }}/{{ x.receiptSnapshot.receiptNo }} {{ yuan(x.receiptSnapshot.amount) }}
            </span>
            <span v-if="x.originShiftId" class="dim">退款发生于班次 {{ x.originShiftId }}</span>
          </div>
        </el-timeline-item>
      </el-timeline>
    </el-card>

    <el-alert
      v-if="!isOpen"
      type="info"
      :closable="false"
      show-icon
      style="margin-top: 10px"
      :title="`原确认依据冻结于 ${time(shift.confirmedBasis?.confirmedAt)}（确认版本 v${shift.confirmedBasis?.version}）：应收 ${yuan(shift.confirmedBasis?.income)} / 实收 ${yuan(shift.confirmedBasis?.collected)} / 差异 ${yuan(shift.confirmedBasis?.diff)} —— 此后所有变化仅以冲正追加呈现`"
    />

    <!-- 跨班退款弹窗 -->
    <el-dialog v-model="dialog" title="追加跨班退款冲正" width="420px">
      <el-form label-width="92px">
        <el-form-item label="退款金额"><el-input-number v-model="refundForm.amount" :min="0.01" :precision="2" /></el-form-item>
        <el-form-item label="发生班次">
          <el-select v-model="refundForm.originShiftId" clearable placeholder="退款实际发生在哪个班（可选）">
            <el-option v-for="s in store.shifts.filter(x => x.id !== shift?.id)" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="原因"><el-input v-model="refundForm.reason" placeholder="如：客户次日回站退加注款" /></el-form-item>
      </el-form>
      <p class="dim">冲正只追加到本班：应收与实收各 -{{ refundForm.amount }}，原确认依据不变。</p>
      <template #footer>
        <el-button @click="dialog = null">取消</el-button>
        <el-button type="primary" @click="submitRefund">追加冲正</el-button>
      </template>
    </el-dialog>

    <!-- 泵码更新弹窗 -->
    <el-dialog :model-value="dialog === 'pump'" title="追加泵码更新冲正" width="460px" @update:model-value="(v) => !v && (dialog = null)">
      <el-form label-width="100px">
        <el-form-item label="油枪"><el-input v-model="pumpForm.pumpNo" /></el-form-item>
        <el-form-item label="单价"><el-input-number v-model="pumpForm.price" :precision="2" :controls="false" /></el-form-item>
        <el-form-item label="原泵码"><el-input-number v-model="pumpForm.oldMeter" :controls="false" /></el-form-item>
        <el-form-item label="新泵码"><el-input-number v-model="pumpForm.newMeter" :controls="false" /></el-form-item>
        <el-form-item label="原因"><el-input v-model="pumpForm.reason" /></el-form-item>
      </el-form>
      <p class="dim">
        油量差 {{ pumpForm.newMeter - pumpForm.oldMeter }} L，应收追加
        <b :class="{ neg: (pumpForm.newMeter - pumpForm.oldMeter) * pumpForm.price < 0 }">
          {{ signedYuan((pumpForm.newMeter - pumpForm.oldMeter) * pumpForm.price) }}
        </b>，实收不变；原确认泵码保留。
      </p>
      <template #footer>
        <el-button @click="dialog = null">取消</el-button>
        <el-button type="primary" @click="submitPump">追加冲正</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.detail { margin-bottom: 12px; }
.dhead { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.dtitle { font-size: 17px; font-weight: 700; }
.dops { display: flex; gap: 8px; align-items: center; }
.panel { margin-top: 10px; }
.ph { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
.dim { color: #909399; font-size: 12px; }
.neg { color: #f56c6c; }
.pos { color: #67c23a; }
.corr { display: flex; gap: 18px; margin-top: 6px; font-size: 13px; flex-wrap: wrap; }
.summary { margin-top: 6px; }
</style>
