<script setup lang="ts">
import { reactive, ref } from "vue";
import { storeToRefs } from "pinia";
import { useStore } from "../store";
import { localId } from "../lib/terminal";
import { time, yuan } from "../lib/format";

const store = useStore();
const { pendingReceipts, state } = storeToRefs(store);

const form = reactive({
  terminalNo: "T01",
  receiptNo: "",
  amount: 0,
  txTime: "",
});
const sending = ref(false);

async function submit() {
  if (!form.receiptNo || !form.amount) return;
  sending.value = true;
  await store.dispatch({
    type: "receipt",
    label: `上报回执 ${form.terminalNo}/${form.receiptNo}`,
    endpoint: "/api/receipts",
    payload: {
      receipts: [
        {
          id: localId(form.terminalNo, "rcpt"),
          terminalNo: form.terminalNo,
          receiptNo: form.receiptNo.trim(),
          amount: form.amount,
          txTime: form.txTime ? new Date(form.txTime).toISOString() : new Date().toISOString(),
          arrivedAt: new Date().toISOString(),
        },
      ],
    },
  });
  sending.value = false;
  form.receiptNo = "";
  form.amount = 0;
  form.txTime = "";
}
</script>

<template>
  <el-card shadow="never" class="rcpt">
    <template #header>
      <div class="h">
        <span>银行到账回执上报</span>
        <el-text size="small" type="info">断网先留草稿，恢复后按 终端号+回执号 合并，重复自动幂等</el-text>
      </div>
    </template>
    <el-form inline @submit.prevent>
      <el-form-item label="终端">
        <el-select v-model="form.terminalNo" style="width: 96px">
          <el-option v-for="t in state?.station.terminals ?? ['T01','T02']" :key="t" :label="t" :value="t" />
        </el-select>
      </el-form-item>
      <el-form-item label="回执号"><el-input v-model="form.receiptNo" placeholder="如 R3002" style="width: 130px" /></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="form.amount" :precision="2" :controls="false" style="width: 130px" /></el-form-item>
      <el-form-item label="交易时间"><el-date-picker v-model="form.txTime" type="datetime" placeholder="可选" style="width: 180px" /></el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="sending" @click="submit">上报 / 入草稿</el-button>
      </el-form-item>
    </el-form>

    <el-divider style="margin: 6px 0" />
    <el-table :data="pendingReceipts" size="small" empty-text="没有待核回执">
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.amountMismatch ? 'danger' : 'warning'">
            {{ row.amountMismatch ? "金额不符" : "待核" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="terminalNo" label="终端" width="70" />
      <el-table-column prop="receiptNo" label="回执号" width="110" />
      <el-table-column label="金额" width="100">
        <template #default="{ row }">{{ yuan(row.amount) }}</template>
      </el-table-column>
      <el-table-column label="交易时间 → 到账时间" min-width="240">
        <template #default="{ row }">{{ time(row.txTime) }} → {{ time(row.arrivedAt) }}</template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.h { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
.rcpt { margin-bottom: 12px; }
</style>
