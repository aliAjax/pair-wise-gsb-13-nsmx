<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useStore } from "../store";

const store = useStore();
const { state, online, terminalNo, queue, conflicts } = storeToRefs(store);

const terminals = computed(() => state.value?.station.terminals ?? ["T01", "T02"]);
</script>

<template>
  <el-card shadow="never" class="header-card">
    <div class="bar">
      <div class="brand">
        <span class="logo">⛽</span>
        <div>
          <div class="title">班次核销台</div>
          <div class="sub">{{ state?.station.name ?? "加载中…" }} · 油枪读数 / 现金 / 电子支付 / 银行回执 班次级核销</div>
        </div>
      </div>
      <div class="actions">
        <el-tag :type="online ? 'success' : 'danger'" effect="dark" size="large">
          {{ online ? "🟢 联网" : "🔴 断网（本地草稿模式）" }}
        </el-tag>
        <el-switch
          :model-value="online"
          inline-prompt
          active-text="在线"
          inactive-text="离线"
          @change="(v: boolean | string | number) => store.setOnline(Boolean(v))"
        />
        <el-select
          :model-value="terminalNo"
          style="width: 110px"
          @update:model-value="(v: string) => store.setTerminal(v)"
        >
          <el-option v-for="t in terminals" :key="t" :label="`终端 ${t}`" :value="t" />
        </el-select>
        <el-button @click="store.refresh()" :disabled="!online">刷新</el-button>
        <el-popconfirm title="重置为演示种子数据？本地草稿也会清空。" @confirm="store.resetDemo()">
          <template #reference>
            <el-button text type="info" size="small">重置演示数据</el-button>
          </template>
        </el-popconfirm>
      </div>
    </div>
    <div class="badges">
      <el-tag v-if="queue.length" type="warning">待发队列 {{ queue.length }} 笔 —— 联网后按回执号/流水号幂等合并</el-tag>
      <el-tag v-if="conflicts.length" type="danger">冲突草稿 {{ conflicts.length }} 条 —— 旧版本未覆盖生效结果</el-tag>
    </div>
  </el-card>
</template>

<style scoped>
.header-card { margin-bottom: 12px; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.brand { display: flex; gap: 12px; align-items: center; }
.logo { font-size: 34px; }
.title { font-size: 20px; font-weight: 700; }
.sub { color: #909399; font-size: 13px; }
.actions { display: flex; align-items: center; gap: 10px; }
.badges { display: flex; gap: 8px; margin-top: 10px; }
</style>
