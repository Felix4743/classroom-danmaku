/**
 * 本地把一整节课跑起来：静态页面 + WebSocket + 会话。
 *
 * 和 `dev-server.mjs` 的区别：那个只有 HTTP，页面能打开但连不上服务端，
 * 所以只能用来调手感；这个是真的能发弹幕的，也是老师拿手机实测的唯一方式
 * —— **二维码指向的地址必须是手机连得上的那个**，所以这里直接调 netinfo
 * 把候选地址都打出来（§4.10）。
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pickAddress, pageUrl } from "../src/main/netinfo.js";
import { startClassroom } from "../src/main/server/start.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_ROOT = join(ROOT, "src");

const classroom = await startClassroom({
  staticRoot: STATIC_ROOT,
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  // 和真实交付一样落盘（§4.11）：每 30 秒 + 老师导出时写一份到 data/。
  // 开发期就打开，是为了让"导出按钮点了没反应"这类问题在讲台上出现之前先暴露
  dataDir: process.env.DATA_DIR ?? join(ROOT, "data"),
  // 公网开关也照 Electron 那边的接法接上（§4.11）。**不接的话开发时
  // `/api/info` 里 `tunnel.available` 是 false，老师端那一整块是隐藏的**，
  // 这个功能就只能在打包之后才试得出来。
  tunnelOptions: {
    appPath: ROOT,
    homeDir: homedir(),
    logger: console,
  },
});

const { best, candidates, warnings } = pickAddress(undefined, { port: classroom.port });

console.log(`[dev] 静态根目录：${STATIC_ROOT}`);
console.log(`[dev] 挂载点：${Object.keys(classroom.mounts).sort().join(", ")}`);
console.log("");
console.log("[dev] 本机开这几个（就是这台电脑自己）：");
console.log(`        投影/弹幕层  http://127.0.0.1:${classroom.port}/screen/`);
console.log(`        老师端       http://127.0.0.1:${classroom.port}/host/`);
if (classroom.studentPath) {
  console.log(`        学生页       http://127.0.0.1:${classroom.port}${classroom.studentPath}/`);
}
console.log(`        手感调参页   http://127.0.0.1:${classroom.port}/tune/`);
console.log("");
console.log(`[dev] 落盘目录：${classroom.store?.dir ?? "（未开启）"}`);

if (best) {
  console.log(`[dev] 手机扫这个（学生会用到的地址）：`);
  console.log(`        ${pageUrl(best.address, classroom.port, `${classroom.studentPath ?? "/m"}/`)}`);
  console.log(`        走的是「${best.name}」`);
} else {
  console.log("[dev] 没有找到能给学生用的地址，手机连不上这台电脑。");
}

for (const warning of warnings) console.log(`[dev] ⚠ ${warning}`);

if (candidates.length > 1) {
  console.log("");
  console.log("[dev] 其它候选地址（首选不对时用这些）：");
  for (const candidate of candidates) {
    if (candidate === best) continue;
    console.log(`        ${pageUrl(candidate.address, classroom.port, "/m/")}  「${candidate.name}」`);
  }
}

console.log("");
console.log("[dev] 按 Ctrl+C 结束。");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await classroom.close();
    process.exit(0);
  });
}
