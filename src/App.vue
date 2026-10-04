<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useStore } from "./store";
import TopBar from "./components/TopBar.vue";
import ShiftList from "./components/ShiftList.vue";
import ShiftDetail from "./components/ShiftDetail.vue";
import ReceiptsPanel from "./components/ReceiptsPanel.vue";
import ConflictPanel from "./components/ConflictPanel.vue";
import { localId } from "./lib/terminal";

const store = useStore();

// 关掉再打开仍回到上次处理的班次
const selectedId = ref(localStorage.getItem("gas-shift:selected") || "");

const current = computed(() => store.state?.shifts.find((s) => s.id === selectedId.value) ?? null);

function select(id: string) {
  selectedId.value = id;
  localStorage.setItem("gas-shift:selected", id);
}

async function createShift() {
  const name = window.prompt("新班次名称（如 10-04 中班）", `新班次 ${new Date().toLocaleString("zh-CN")}`);
  if (!name) return;
  const id = localId(store.terminalNo, "shift");
  await store.dispatch({
    type: "createShift",
    label: `新建班次 ${name}`,
    endpoint: "/api/shifts",
    payload: { id, name, startTime: new Date().toISOString(), pumps: [], payments: [] },
  });
  if (store.state?.shifts.some((s) => s.id === id)) select(id);
}

onMounted(async () => {
  if (import.meta.env.DEV) (window as unknown as { deskStore?: unknown }).deskStore = store;
  await store.refresh();
  if (!selectedId.value && store.shifts.length) selectedId.value = store.shifts[0].id;
  await store.flushQueue();
  // 浏览器重新联机时自动同步
  window.addEventListener("online", () => store.setOnline(true));
});
</script>

<template>
  <div class="page">
    <TopBar />
    <ConflictPanel />
    <el-row :gutter="12">
      <el-col :span="9">
        <div style="margin-bottom: 10px">
          <el-button type="primary" plain @click="createShift">＋ 新建班次</el-button>
        </div>
        <ShiftList :selected-id="selectedId" @select="select" />
        <div style="margin-top: 12px">
          <ReceiptsPanel />
        </div>
      </el-col>
      <el-col :span="15">
        <ShiftDetail v-if="current" :key="current.id" :shift-id="current.id" />
        <el-empty v-else description="请选择或新建一个班次" />
      </el-col>
    </el-row>

    <div class="toasts">
      <transition-group name="fade">
        <el-alert
          v-for="t in store.toasts"
          :key="t.id"
          :type="t.type"
          :title="t.text"
          show-icon
          :closable="false"
          class="toast"
        />
      </transition-group>
    </div>
  </div>
</template>

<style scoped>
.page { max-width: 1560px; margin: 0 auto; padding: 14px; }
.toasts { position: fixed; right: 18px; bottom: 18px; width: 360px; z-index: 9999; display: flex; flex-direction: column; gap: 8px; }
.toast { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12); }
.fade-enter-active, .fade-leave-active { transition: all 0.25s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateY(8px); }
</style>
