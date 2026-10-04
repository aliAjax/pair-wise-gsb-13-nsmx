// 启动服务端：先打包再运行
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist-api/index.mjs",
  logLevel: "warning",
});

const child = spawnSync(process.execPath, ["dist-api/index.mjs"], { stdio: "inherit" });
process.exit(child.status ?? 0);
