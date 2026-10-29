// 把 cards 服务打成一个自带依赖的 server.cjs，放进插件包 bisca_server/。
// 引擎/静态页仍按原相对路径落盘（服务端会把引擎源码发给前端预判）。
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const src = join(repo, "cards");
const out = join(here, "..", "bisca_server");

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "cards"), { recursive: true });

await build({
  entryPoints: [join(src, "server.cjs")],
  outfile: join(out, "cards", "server.cjs"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  // 引擎要在磁盘上原样存在：服务端会读它们并原样发给前端。
  external: ["./engines/*"],
  logLevel: "info",
});

for (const dir of ["engines", "public"]) {
  await cp(join(src, dir), join(out, "cards", dir), { recursive: true });
}
for (const dir of ["assets", "fonts"]) {
  await cp(join(repo, dir), join(out, dir), { recursive: true });
}

console.log("bundle -> " + out);
