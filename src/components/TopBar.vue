<script setup lang="ts">
import { computed } from "vue";
import { useReconStore } from "../stores/recon";
import { demoLateReceipts, demoUnclaimedReceipt } from "../domain/seed";

const store = useReconStore();

const networkLabel = computed(() => (store.online ? "在线" : "断网"));

function toggleNetwork() {
  store.setOnline(!store.online);
}

function syncLate() {
  store.syncReceipts(demoLateReceipts(), "同步晚到回执");
}

function syncUnclaimed() {
  store.syncReceipts([demoUnclaimedReceipt()], "银行回执同步");
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <p class="eyebrow">石油零售 · 站点财务</p>
      <h1>班次核销台</h1>
      <p class="subtitle">
        汇总油枪读数、现金、电子支付与银行回执；断网留草稿，恢复后按
        <b>终端号 + 回执号</b> 合并；未匹配进待核并保留差异。
      </p>
    </div>

    <div class="top-actions">
      <div class="net" :class="store.online ? 'on' : 'off'">
        <span class="dot" />
        <strong>{{ networkLabel }}</strong>
        <button class="mini" type="button" @click="toggleNetwork">
          {{ store.online ? "模拟断网" : "模拟恢复" }}
        </button>
      </div>
      <div class="sync-btns">
        <button type="button" @click="syncLate" title="同步一笔晚到回执">
          同步晚到回执
        </button>
        <button type="button" class="secondary" @click="syncUnclaimed">
          模拟银行新到回执
        </button>
        <button type="button" class="ghost" @click="store.resetAll()">
          重置演示
        </button>
      </div>
      <a
        class="open-window"
        href="."
        target="_blank"
        rel="noopener"
        title="新开一个窗口，模拟两个窗口同时处理同一班次"
      >
        ↗ 新开窗口（并发演示）
      </a>
    </div>
  </header>
</template>
