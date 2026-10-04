// 一键开发：API(3001) + Vite(5173)，API 改动自动重启
import { spawn } from "node:child_process";
import { context } from "esbuild";
import { resolve } from "node:path";

let apiProc = null;

function startApi() {
  apiProc?.kill();
  apiProc = spawn(process.execPath, ["dist-api/index.mjs"], { stdio: "inherit", env: process.env });
  apiProc.on("exit", (code) => {
    if (code && code !== 0) console.error(`[dev] API exited with ${code}`);
  });
}

const ctx = await context({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist-api/index.mjs",
  logLevel: "warning",
});
await ctx.watch();
await ctx.rebuild().then(() => console.log("[dev] API bundle ready"));
startApi();

// esbuild watch 负责重打包；再用 fs 监听重启 API 进程
import { watch } from "node:fs";
const watchDir = resolve("server");
let timer = null;
watch(watchDir, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await ctx.rebuild();
    console.log("[dev] API rebuilt, restarting...");
    startApi();
  }, 150);
});

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
  stdio: "inherit",
  env: process.env,
});

function shutdown() {
  apiProc?.kill();
  vite.kill();
  ctx.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
