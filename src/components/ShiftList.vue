<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useStore } from "../store";
import { yuan, liters } from "../lib/format";

const props = defineProps<{ selectedId: string }>();
const emit = defineEmits<{ (e: "select", id: string): void }>();

const store = useStore();
const { shifts, drafts } = storeToRefs(store);

const rows = computed(() =>
  shifts.value.map((s) => {
    const v = store.view(s.id)!;
    return { shift: s, v, draft: drafts.value[s.id] };
  }),
);

function diffType(n: number) {
  return Math.abs(n) < 0.005 ? "success" : "danger";
}
</script>

<template>
  <el-card shadow="never" header="班次列表（按班次核销）">
    <el-table :data="rows" highlight-current-row @row-click="(r: any) => emit('select', r.shift.id)"
      :row-class-name="(r: any) => r.shift.id === props.selectedId ? 'selected-row' : ''">
      <el-table-column label="班次" min-width="150">
        <template #default="{ row }">
          <div class="sname">{{ row.shift.name }}</div>
          <el-tag size="small" :type="row.shift.status === 'confirmed' ? 'success' : 'warning'">
            {{ row.shift.status === "confirmed" ? "已确认 v" + row.shift.version : "进行中 v" + row.shift.version }}
          </el-tag>
          <el-tag v-if="row.draft" size="small" type="info" style="margin-left:4px">有本地草稿</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="泵码量 / 应收">
        <template #default="{ row }">
          <div>{{ liters(row.v.volume) }}</div>
          <div class="strong">{{ yuan(row.v.income) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="实收（现金+核销电子）" width="170">
        <template #default="{ row }">
          <div class="strong">{{ yuan(row.v.collected) }}</div>
          <div class="dim">未匹配电子 ¥{{ row.v.electronicUnmatched.toFixed(2) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="对账差异" width="120">
        <template #default="{ row }">
          <el-tag :type="diffType(row.v.diff)" size="small">
            {{ Math.abs(row.v.diff) < 0.005 ? "平账" : yuan(row.v.diff) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="冲正链" width="90">
        <template #default="{ row }">
          <el-badge :value="row.shift.correctionChain.length" :hidden="!row.shift.correctionChain.length" type="info">
            <el-text type="info">追加记录</el-text>
          </el-badge>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.sname { font-weight: 600; margin-bottom: 4px; }
.strong { font-weight: 600; }
.dim { color: #909399; font-size: 12px; }
:deep(.selected-row) { background-color: #ecf5ff !important; cursor: pointer; }
:deep(.el-table__row) { cursor: pointer; }
</style>
