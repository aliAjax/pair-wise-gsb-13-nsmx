<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useStore } from "../store";
import { time, yuan } from "../lib/format";

const store = useStore();
const { conflicts, queue } = storeToRefs(store);

const kindText: Record<string, string> = {
  commit: "班次保存",
  confirm: "班次确认",
  correction: "追加冲正",
};

function payloadSummary(c: (typeof conflicts.value)[number]): string {
  const p = c.clientPayload as Record<string, any>;
  if (c.kind === "commit") {
    const pumps = (p.pumps ?? []).map((x: any) => `${x.pumpNo}:${x.startMeter}→${x.endMeter}`).join("，");
    return `旧版本 v${p.version}；泵码 ${pumps}；收款 ${(p.payments ?? []).length} 笔`;
  }
  if (c.kind === "confirm") return `基于旧版本 v${p.version} 的确认请求`;
  return `基于旧版本 v${p.version} 的冲正：${p.reason ?? ""}`;
}
</script>

<template>
  <el-card v-if="conflicts.length || queue.length" shadow="never" class="cf">
    <template #header>
      <div class="h">
        <span>⚖️ 冲突草稿 与 待发队列</span>
        <el-text size="small" type="info">后到的旧版本永不覆盖已生效结果</el-text>
      </div>
    </template>

    <template v-if="conflicts.length">
      <el-alert
        v-for="c in conflicts"
        :key="c.id"
        type="error"
        show-icon
        :closable="false"
        class="item"
      >
        <template #title>
          <div class="row">
            <b>「{{ c.shiftName }}」{{ kindText[c.kind] }}冲突</b>
            <el-tag size="small" type="danger">旧版基线 v{{ (c.clientPayload as any).version }}</el-tag>
            <el-tag size="small" type="success">服务端已生效 v{{ c.serverSnapshot.version }}</el-tag>
            <el-text size="small" type="info">{{ time(c.at) }} · 终端 {{ c.terminalNo }}</el-text>
          </div>
        </template>
        <div class="body">{{ payloadSummary(c) }}</div>
        <div class="body dim">
          生效结果应收 {{ yuan(store.view(c.shiftId)?.income) }}，冲正链 {{ c.serverSnapshot.correctionChain.length }} 条。
          旧版本未被覆盖，请选择：
        </div>
        <div class="ops">
          <el-button size="small" type="primary" @click="store.resolveConflictRebase(c.id)">
            以旧内容基于最新版本重做（转草稿）
          </el-button>
          <el-button size="small" @click="store.resolveConflictDiscard(c.id)">放弃旧版本</el-button>
          <el-button size="small" text @click="store.discardConflict(c.id)">仅关闭提示</el-button>
        </div>
      </el-alert>
    </template>

    <template v-if="queue.length">
      <el-divider style="margin: 8px 0">待发队列（断网期间）</el-divider>
      <el-table :data="queue" size="small">
        <el-table-column prop="label" label="操作" min-width="200" />
        <el-table-column prop="type" label="类型" width="100" />
        <el-table-column label="时间" width="150">
          <template #default="{ row }">{{ time(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
    </template>
  </el-card>
</template>

<style scoped>
.cf { margin-bottom: 12px; border-color: #f56c6c55; }
.h { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
.item { margin: 8px 0; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.body { font-size: 13px; margin: 4px 0; }
.dim { color: #909399; }
.ops { margin-top: 6px; }
</style>
