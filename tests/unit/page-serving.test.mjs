/**
 * 页面托管测试 —— 这条是 V0 白屏事故的回归用例。
 *
 * 事故经过：`index.html` 被直接挂在 `/screen`（不带尾斜杠）上。页面能打开、
 * 单元测试全绿、控制台没有报错指向真正的原因，但**白屏** —— 浏览器把
 * `./screen.js` 按当前 URL 解析成了 `/screen.js`，404。
 *
 * 所以这里不只检查"文件存在"，而是**完全按浏览器的方式**走一遍：
 * 用真实的挂载点起一个真实的服务，从页面 URL 出发，把 script/link 和
 * 整个 ES module 依赖图逐个请求一遍，每一步都必须 200。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { homePage, pageMounts } from "../../src/main/server/routes.js";
import { request, serve } from "../helpers/server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../src");

const { mounts, pages } = pageMounts(SRC);

/** 页面目录里真的有 index.html 的才算数。 */
function pageFiles() {
  return pages
    .map((prefix) => ({ prefix, index: join(SRC, mounts[prefix], "index.html") }))
    .filter(({ index }) => existsSync(index));
}

function importSpecifiers(source) {
  const specs = [];
  const re = /\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(re)) specs.push(match[1] ?? match[2]);
  return specs;
}

test("挂载点覆盖了页面目录与公共资源", () => {
  assert.ok(mounts["/screen"], "缺少 /screen 挂载点");
  assert.ok(mounts["/shared"], "缺少 /shared 挂载点");
  assert.ok(mounts["/overlay"], "缺少 /overlay 挂载点");
  assert.equal(homePage(pages), "/screen");
  assert.ok(pageFiles().length >= 1, "src/web 下没有任何可托管的页面");
});

test("页面必须挂在带尾斜杠的目录 URL 上，裸路径要 302 过去", async (t) => {
  const { url } = await serve(t, { staticRoot: SRC, mounts });

  for (const { prefix } of pageFiles()) {
    const bare = await request(url, prefix);
    assert.equal(bare.status, 302, `${prefix} 应当 302 到 ${prefix}/`);
    assert.equal(bare.headers.location, `${prefix}/`);

    const slash = await request(url, `${prefix}/`);
    assert.equal(slash.status, 200, `${prefix}/ 应当能打开`);
    assert.match(slash.headers["content-type"], /^text\/html/);
  }
});

test("页面从挂载点托管的相对引用全部可加载", async (t) => {
  const { url } = await serve(t, { staticRoot: SRC, mounts });

  for (const { prefix } of pageFiles()) {
    const pageUrl = `${url}${prefix}/`;
    const html = (await request(url, `${prefix}/`)).body;

    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, `${prefix}/ 的页面一个资源都没引用`);

    for (const ref of refs) {
      if (!ref.startsWith(".")) continue;
      // 浏览器就是这么解析的：相对引用以**当前页面 URL** 为基准
      const target = new URL(ref, pageUrl);
      const res = await request(url, target.pathname);
      assert.equal(
        res.status,
        200,
        `页面 ${prefix}/ 引用了 ${ref}，浏览器会去取 ${target.pathname}，得到 ${res.status}`,
      );
    }
  }
});

test("页面的 ES module 依赖图能逐个加载成功", async (t) => {
  const { url } = await serve(t, { staticRoot: SRC, mounts });

  for (const { prefix } of pageFiles()) {
    const pageUrl = `${url}${prefix}/`;
    const html = (await request(url, `${prefix}/`)).body;

    const queue = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
      .map((m) => new URL(m[1], pageUrl).pathname)
      .filter((p) => extname(p) === ".js");

    assert.ok(queue.length > 0, `${prefix}/ 没有入口脚本`);

    const seen = new Set();
    let loaded = 0;
    while (queue.length > 0) {
      const pathname = queue.shift();
      if (seen.has(pathname)) continue;
      seen.add(pathname);

      const res = await request(url, pathname);
      assert.equal(res.status, 200, `模块 ${pathname} 取不到（${res.status}）`);
      assert.match(
        res.headers["content-type"],
        /^text\/javascript/,
        `${pathname} 的 Content-Type 不是 JS，浏览器会拒绝执行`,
      );
      loaded += 1;

      // 用模块自己的 URL 作为基准解析它的 import
      const moduleUrl = new URL(pathname, url);
      for (const spec of importSpecifiers(res.body)) {
        if (!spec.startsWith(".")) {
          assert.fail(`${pathname} 引用了裸说明符 "${spec}"，没有构建步骤就没有解析器`);
        }
        queue.push(new URL(spec, moduleUrl).pathname);
      }
    }

    assert.ok(loaded >= 3, `${prefix}/ 的依赖图只加载了 ${loaded} 个文件，是不是正则失效了`);
  }
});

test("页面 URL 与磁盘路径的对应关系没有被改错", () => {
  // 这条把 routes.js 的约定钉死：改了挂载点就得改这里，是刻意的
  assert.deepEqual(
    Object.keys(mounts).sort(),
    ["/host", "/m", "/overlay", "/screen", "/shared", "/tune"],
  );
  // 投影页（技术方案 §4.1 的 L2）。它盖在 PPT 上，是学生弹幕唯一的去处
  assert.equal(
    readFileSync(join(SRC, mounts["/screen"], "index.html"), "utf8").includes("screen.js"),
    true,
  );
  // 手感调参页是开发工具，不是给老师或学生用的页面（V0 的交付物）
  assert.equal(
    readFileSync(join(SRC, mounts["/tune"], "index.html"), "utf8").includes("tune.js"),
    true,
  );
  // 学生扫码进的就是这个地址，它必须真的存在（产品文档 §7.1）
  assert.equal(
    readFileSync(join(SRC, mounts["/m"], "index.html"), "utf8").includes("m.js"),
    true,
  );
  // 老师手机端（产品文档 §7.3）：投影上不出现它，所以它是老师唯一的操作入口
  assert.equal(
    readFileSync(join(SRC, mounts["/host"], "index.html"), "utf8").includes("host.js"),
    true,
  );
});
