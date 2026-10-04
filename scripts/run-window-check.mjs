// 打包多窗口测试 worker（含真实 store），再运行 window-check
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist-api/worker.mjs",
  logLevel: "warning",
  alias: {
    "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
  },
});

const child = spawn(process.execPath, ["scripts/window-check.mjs"], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
