// 用 esbuild（随 vite 安装）把 TS 服务端打包为单文件 ESM，无需额外依赖
import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist-api/index.mjs",
  logLevel: "info",
});
