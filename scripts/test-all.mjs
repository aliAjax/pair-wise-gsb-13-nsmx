// 统一测试：领域纯逻辑单测 → API e2e → 多窗口（真实前端 store）e2e
// 前置：API 服务已在 localhost:3001 运行（npm run server），否则自动跳过 e2e 并提示
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

async function apiUp() {
  try {
    const r = await fetch("http://localhost:3001/api/state");
    return r.ok;
  } catch {
    return false;
  }
}

let failed = 0;

// 1) 领域纯逻辑单测
await build({
  entryPoints: [fileURLToPath(new URL("../shared/domain.test.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", target: "node20",
  outfile: "dist-api/domain.test.mjs", logLevel: "warning",
});
failed += await run(process.execPath, ["--test", "dist-api/domain.test.mjs"]);

const up = await apiUp();
if (!up) {
  console.log("\n⚠️  API 未运行（http://localhost:3001），跳过 e2e。请先执行：npm run server");
} else {
  // 2) API 端到端
  failed += await run(process.execPath, ["scripts/e2e-check.mjs"]);

  // 3) 多窗口（worker realm 里跑真实前端 Pinia store）
  await build({
    entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", target: "node20",
    outfile: "dist-api/worker.mjs", logLevel: "warning",
    alias: { "@shared": fileURLToPath(new URL("../shared", import.meta.url)) },
  });
  failed += await run(process.execPath, ["scripts/window-check.mjs"]);
}

process.exit(failed ? 1 : 0);
