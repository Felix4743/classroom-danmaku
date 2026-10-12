/**
 * 零依赖静态服务的单元测试（技术方案 §8.2、§7.4）。
 *
 * 这里有两条是红线：
 *  1. 路径穿越必须挡住 —— 这个服务对整个局域网开放，学生敲一个 `/../` 就能
 *     把老师电脑上的文件读走。
 *  2. 端口被占用要自动递增 —— 教室电脑上 3000 端口从来不是干净的。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  contentTypeOf,
  createHttpServer,
  findMount,
  redirectTo,
  safeJoin,
  startHttpServer,
} from "../../src/main/server/http.js";
import { request, serve } from "../helpers/server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** 起一个以 src/ 为静态根的临时服务，测试结束自动收掉。 */
function serveSrc(t, options = {}) {
  return serve(t, { staticRoot: SRC_ROOT, ...options });
}

test("safeJoin 把 URL 路径限制在根目录内", () => {
  const root = resolve("/tmp/root");
  assert.equal(safeJoin(root, "/a/b.js"), join(root, "a", "b.js"));
  assert.equal(safeJoin(root, "/"), root);

  // 各种逃逸写法都必须被拒
  assert.equal(safeJoin(root, "/../secret.txt"), null);
  assert.equal(safeJoin(root, "/%2e%2e/secret.txt"), null);
  assert.equal(safeJoin(root, "/a/../../secret.txt"), null);
  assert.equal(safeJoin(root, "/a/%00b.js"), null);
  assert.equal(safeJoin(root, "/%E0%A4%A"), null, "非法百分号编码应被拒");

  if (process.platform === "win32") {
    // 反斜杠在 Windows 上同样是分隔符，不能被当成普通文件名字符混过去
    assert.equal(safeJoin(root, "/..%5csecret.txt"), null);
    assert.equal(safeJoin(root, "/..\\secret.txt"), null);
  }
});

test("contentTypeOf 认识静态资源必需的类型，未知类型退化为下载", () => {
  assert.match(contentTypeOf("/x/index.html"), /^text\/html/);
  assert.match(contentTypeOf("/x/engine.JS"), /^text\/javascript/);
  assert.match(contentTypeOf("/x/a.css"), /^text\/css/);
  assert.match(contentTypeOf("/x/a.png"), /^image\/png/);
  assert.equal(contentTypeOf("/x/a.woff"), "application/octet-stream");
});

test("静态文件：正确的 MIME、Content-Length 与 no-store", async (t) => {
  const { url } = await serveSrc(t);
  const res = await request(url, "/shared/config.js");

  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /^text\/javascript/);
  assert.equal(Number(res.headers["content-length"]), Buffer.byteLength(res.body));
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(res.body, /DEFAULT_CONFIG/);
});

test("HEAD 请求只回头不回体", async (t) => {
  const { url } = await serveSrc(t);
  const res = await request(url, "/shared/config.js", { method: "HEAD" });

  assert.equal(res.status, 200);
  assert.equal(res.body, "");
  assert.ok(Number(res.headers["content-length"]) > 0);
});

test("无扩展名的路径回落到 index.html", async (t) => {
  const { url } = await serveSrc(t);
  const res = await request(url, "/web/screen/");

  assert.equal(res.status, 200);
  assert.match(res.body, /<canvas/i);
});

test("路径穿越被拒：能读到上层文件也必须是 403", async (t) => {
  const { url } = await serveSrc(t);
  // 这条用例只有在上一层真的存在可读文件时才有意义
  assert.ok(existsSync(join(REPO_ROOT, "package.json")), "缺少测试前提：上层没有 package.json");

  for (const path of [
    "/../package.json",
    "/%2e%2e/package.json",
    "/..%2fpackage.json",
    "/web/../../package.json",
  ]) {
    const res = await request(url, path);
    assert.equal(res.status, 403, `${path} 应当被拒绝，实际 ${res.status}`);
    assert.ok(!res.body.includes("classroom-danmaku"), `${path} 漏出了上层文件内容`);
  }
});

test("不存在的文件返回 404", async (t) => {
  const { url } = await serveSrc(t);
  const res = await request(url, "/shared/not-found.js");
  assert.equal(res.status, 404);
});

test("只接受 GET / HEAD，其余返回 405 并带 Allow", async (t) => {
  const { url } = await serveSrc(t);
  const res = await request(url, "/shared/config.js", { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, "GET, HEAD");
});

test("routes 可以指向文件，也可以用函数接管", async (t) => {
  const handled = [];
  const { url } = await serveSrc(t, {
    routes: {
      "/": (req, res) => {
        handled.push(req.url);
        res.writeHead(302, { Location: "/screen" });
        res.end();
      },
      "/go": "shared/config.js",
    },
  });

  const root = await request(url, "/");
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, "/screen");
  assert.deepEqual(handled, ["/"]);

  const file = await request(url, "/go");
  assert.equal(file.status, 200);
  assert.match(file.headers["content-type"], /^text\/javascript/);
});

test("routes 匹配时忽略尾斜杠", async (t) => {
  const { url } = await serveSrc(t, { routes: { "/screen": "web/screen/index.html" } });
  assert.equal((await request(url, "/screen/")).status, 200);
});

test("端口被占用时自动递增（§7.4）", async (t) => {
  const first = await startHttpServer({ port: 0, host: "127.0.0.1", staticRoot: SRC_ROOT });
  t.after(() => new Promise((done) => first.server.close(done)));

  const second = await startHttpServer({
    port: first.port,
    host: "127.0.0.1",
    staticRoot: SRC_ROOT,
  });
  t.after(() => new Promise((done) => second.server.close(done)));

  // 递增行为本身。这里**不能**断言"恰好 +1"：`node --test` 会并行跑多个
  // 测试文件，紧邻的那个端口完全可能正被别的文件占着，于是重试会走到 +2。
  // 要钉住的是"往后找、且没跑出重试预算"，那是 §7.4 真正要求的东西。
  assert.ok(
    second.port > first.port && second.port < first.port + 10,
    `被占用时应当从原端口之后找一个空闲的，实际用了 ${second.port}（原本想用 ${first.port}）`,
  );
  assert.equal((await request(second.url, "/shared/config.js")).status, 200);
});

test("端口递增次数用尽后如实报错，不无限重试", async (t) => {
  const first = await startHttpServer({ port: 0, host: "127.0.0.1", staticRoot: SRC_ROOT });
  t.after(() => new Promise((done) => first.server.close(done)));

  await assert.rejects(
    startHttpServer({ port: first.port, host: "127.0.0.1", attempts: 1, staticRoot: SRC_ROOT }),
    (err) => err.code === "EADDRINUSE",
  );
});

test("处理函数抛异常时不会拖垮服务", async (t) => {
  const errors = [];
  const logger = { warn() {}, error: (...args) => errors.push(args) };
  const server = createHttpServer({
    staticRoot: SRC_ROOT,
    logger,
    routes: {
      "/boom": () => {
        throw new Error("故意炸一个");
      },
    },
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const boom = await request(base, "/boom");
  assert.equal(boom.status, 500);
  assert.equal(errors.length, 1);

  // 服务还活着
  assert.equal((await request(base, "/shared/config.js")).status, 200);
});

// ── 挂载点（URL 前缀 → 目录） ────────────────────────────────────────────────

const MOUNTS = { "/screen": "web/screen", "/shared": "shared", "/overlay": "overlay" };

test("findMount 按路径段匹配，取最长前缀", () => {
  const mounts = { "/a": "x", "/a/b": "y", "/c": "z" };

  assert.deepEqual(findMount("/a/b/c.js", mounts), { prefix: "/a/b", rest: "c.js" });
  assert.deepEqual(findMount("/a/d.js", mounts), { prefix: "/a", rest: "d.js" });
  assert.deepEqual(findMount("/a", mounts), { prefix: "/a", rest: "" });
  assert.deepEqual(findMount("/a/", mounts), { prefix: "/a", rest: "" });

  // 不能把 /abc 当成 /a 的子路径
  assert.equal(findMount("/abc/d.js", mounts), null);
  assert.equal(findMount("/", mounts), null);
});

test("redirectTo 生成 302", async (t) => {
  const { url } = await serveSrc(t, { routes: { "/go": redirectTo("/screen/") } });
  const res = await request(url, "/go");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/screen/");
});

test("挂载点：页面在目录 URL 下打开，同目录资源跟着能取到", async (t) => {
  const { url } = await serveSrc(t, { mounts: MOUNTS });

  const bare = await request(url, "/screen");
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.location, "/screen/");

  const page = await request(url, "/screen/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.match(page.body, /<canvas/i);

  // 白屏事故的根因就在这两条：URL 有目录层级，相对引用才落在同一个目录里
  const script = await request(url, "/screen/screen.js");
  assert.equal(script.status, 200);
  assert.match(script.headers["content-type"], /^text\/javascript/);

  const style = await request(url, "/screen/screen.css");
  assert.equal(style.status, 200);
  assert.match(style.headers["content-type"], /^text\/css/);

  // 页面里的 ../../shared/config.js 在浏览器里会被解析到这里
  assert.equal((await request(url, "/shared/config.js")).status, 200);
  assert.equal((await request(url, "/overlay/engine.js")).status, 200);
});

test("挂载点：跳转保留查询串", async (t) => {
  const { url } = await serveSrc(t, { mounts: MOUNTS });
  const res = await request(url, "/screen?v=2");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/screen/?v=2");
});

test("挂载点：前缀边界不会串味，也挡得住穿越", async (t) => {
  const { url } = await serveSrc(t, { mounts: MOUNTS });

  assert.equal((await request(url, "/screenx/screen.js")).status, 404);

  for (const path of [
    "/screen/../package.json",
    "/screen/%2e%2e/package.json",
    "/screen/../../package.json",
  ]) {
    const res = await request(url, path);
    assert.equal(res.status, 403, `${path} 应当被拒绝，实际 ${res.status}`);
    assert.ok(!res.body.includes("classroom-danmaku"), `${path} 漏出了上层文件内容`);
  }
});

test("没有 staticRoot 也没有挂载点时一律 404，不会去读当前目录", async (t) => {
  const { url } = await serveSrc(t, { staticRoot: undefined });
  assert.equal((await request(url, "/package.json")).status, 404);
  assert.equal((await request(url, "/")).status, 404);
});
