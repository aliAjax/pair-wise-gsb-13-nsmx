<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useReconStore } from "./stores/recon";
import { formatMoney } from "./domain/recon";
import TopBar from "./components/TopBar.vue";
import ShiftList from "./components/ShiftList.vue";
import ShiftDetail from "./components/ShiftDetail.vue";

const store = useReconStore();
onMounted(() => store.init());

const active = computed(() => store.activeShift);
</script>

<template>
  <main class="app">
    <div class="shell">
      <TopBar />

      <div v-if="store.notice" class="notice-banner">{{ store.notice }}</div>

      <div class="layout">
        <ShiftList />

        <div class="detail-col">
          <ShiftDetail v-if="active" :key="active.id" :shift="active" />
          <div v-else class="empty-page">暂无班次</div>

          <!-- 待发草稿箱（断网留痕 / 关掉重开仍在） -->
          <section v-if="store.pendingOutbox.length" class="outbox">
            <h3>
              📮 待发草稿箱（{{ store.pendingOutbox.length }}）
              <span class="hint">{{ store.online ? "正在合并…" : "断网暂存，恢复后自动重放" }}</span>
            </h3>
            <ul>
              <li v-for="(o, i) in store.pendingOutbox" :key="i">
                <span class="ob-label">{{ o.label }}</span>
                <span class="ob-meta">
                  {{ "shiftId" in o.op ? "" : "" }}
                  {{ new Date(o.createdAt).toLocaleTimeString("zh-CN") }} ·
                  {{ o.clientId === store.clientId ? "本窗口" : "其它/历史窗口" }}
                </span>
                <span v-if="o.error" class="ob-error">{{ o.error }}</span>
              </li>
            </ul>
          </section>

          <!-- 站点待核池 -->
          <section class="orphan">
            <h3>
              站点待核回执池（{{ store.server.unassigned.length }}）
              <span class="hint">不属任何已确认收入；开放班按终端号+回执号实时匹配，其余保留差异</span>
            </h3>
            <ul v-if="store.server.unassigned.length">
              <li v-for="r in store.server.unassigned" :key="r.id">
                <span>终端 {{ r.terminalId }}</span>
                <span>回执号 {{ r.receiptNo }}</span>
                <span class="amt">{{ formatMoney(r.amount) }}</span>
              </li>
            </ul>
            <p v-else class="empty-inline">待核池为空</p>
          </section>
        </div>
      </div>
    </div>
  </main>
</template>
