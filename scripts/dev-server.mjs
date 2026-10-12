#!/usr/bin/env node
/**
 * V0 开发服务器：只做一件事 —— 把 src/ 目录静态托管起来，让浏览器能打开
 * 手感调参页。模块化 ES import 在 file:// 下会被 CORS 拦掉，
 * 所以哪怕 V0 没有服务端逻辑，也必须有一个 HTTP 服务。
 *
 * 这个脚本与将来的 Electron 主进程共用 src/main/server/http.js 与 routes.js，
 * 不是一次性的临时脚手架。
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { redirectTo, startHttpServer } from "../src/main/server/http.js";
import { homePage, pageMounts } from "../src/main/server/routes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_ROOT = join(ROOT, "src");

const { mounts, pages } = pageMounts(STATIC_ROOT);
const home = homePage(pages);

const port = Number(process.env.PORT ?? 3000);
const { port: actual, url } = await startHttpServer({
  port,
  host: process.env.HOST ?? "0.0.0.0",
  staticRoot: STATIC_ROOT,
  mounts,
  routes: { "/": redirectTo(`${home}/`) },
});

console.log(`[dev] 手感调参页：${url}${home}/`);
console.log(`[dev] 挂载点：${Object.keys(mounts).map((p) => p + "/").join("  ")}`);
console.log(`[dev] 静态根目录：${STATIC_ROOT}`);
