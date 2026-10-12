/**
 * 静态资源图的完整性测试。
 *
 * V0 的交付物是一个**没有构建步骤**的网页（技术方案 §6、§7.1）：
 * 浏览器直接吃 `src/` 里的原始文件。这种形态最典型的翻车方式是——
 * 相对路径写错一个字母、或者 JS 里 getElementById 的 id 跟 HTML 对不上，
 * 页面白屏，而单元测试全绿（因为引擎本身没问题）。
 *
 * 另外两条红线也在这里守：
 *  · 页面不能引用任何 CDN —— 教室外网要手动认证，等于没有外网（§10.1）。
 *  · 跨文件路径必须是相对的 —— `file://` 下 ES module 会被 CORS 拦掉，
 *    所以只能靠本地服务托管，路径必须能被服务解析。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../src");

/** 递归列出 src/ 下的所有文件。 */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const FILES = walk(SRC);
const CODE_FILES = FILES.filter((f) => [".js", ".mjs", ".html"].includes(extname(f)));
const HTML_FILES = FILES.filter((f) => extname(f) === ".html");

function read(file) {
  return readFileSync(file, "utf8");
}

/** 抽出所有相对 import 的说明符。 */
function importSpecifiers(source) {
  const specs = [];
  const re = /\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(re)) specs.push(match[1] ?? match[2]);
  return specs;
}

test("src/ 下至少已经有一个页面要被托管", () => {
  assert.ok(HTML_FILES.length > 0, "src/ 里找不到任何 html");
});

test("所有相对 import 的目标都真实存在", () => {
  const checked = [];
  for (const file of CODE_FILES) {
    for (const spec of importSpecifiers(read(file))) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      assert.ok(
        statSync(target, { throwIfNoEntry: false })?.isFile(),
        `${file} 引用了不存在的文件：${spec}`,
      );
      checked.push(spec);
    }
  }
  assert.ok(checked.length > 0, "一个相对 import 都没抓到，说明正则失效了");
});

test("import 的说明符必须带扩展名，浏览器不会帮你补 .js", () => {
  for (const file of CODE_FILES) {
    for (const spec of importSpecifiers(read(file))) {
      if (!spec.startsWith(".")) continue;
      assert.ok(
        [".js", ".mjs", ".json", ".css"].includes(extname(spec)),
        `${file} 的 import "${spec}" 缺少扩展名，浏览器会 404`,
      );
    }
  }
});

test("页面不能引用 CDN —— 教室的外网等于没有外网（§10.1）", () => {
  for (const file of FILES) {
    if (![".html", ".css", ".js", ".mjs"].includes(extname(file))) continue;
    const source = read(file);
    const remote = source.match(/["'(]\s*https?:\/\/[^\s"')]+/g) ?? [];
    // 注释里出现网址是允许的，代码里不允许
    const inCode = remote.filter((hit) => !hit.includes("127.0.0.1") && !hit.includes("localhost"));
    assert.deepEqual(inCode, [], `${file} 引用了外部地址：${inCode.join(", ")}`);
  }
});

test("页面里的 script / link 目标都真实存在", () => {
  for (const file of HTML_FILES) {
    const source = read(file);
    const refs = [
      ...source.matchAll(/(?:src|href)="([^"]+)"/g),
      ...source.matchAll(/(?:src|href)='([^']+)'/g),
    ].map((m) => m[1]);

    assert.ok(refs.length > 0, `${file} 一个资源都没引用？`);
    for (const ref of refs) {
      if (!ref.startsWith(".")) continue;
      const target = resolve(dirname(file), ref);
      assert.ok(
        statSync(target, { throwIfNoEntry: false })?.isFile(),
        `${file} 引用了不存在的资源：${ref}`,
      );
    }
  }
});

test("每个页面都有自己的入口脚本，且用 type=module 加载", () => {
  for (const file of HTML_FILES) {
    const source = read(file);
    assert.match(
      source,
      /<script[^>]+type="module"/,
      `${file} 没有 type="module" 的脚本，多文件 import 不会生效`,
    );
    assert.match(source, /<script[^>]+src="\.\/[^"]+\.js"/, `${file} 的脚本必须是同级相对路径`);
  }
});

test("页面脚本里 document 查的 id 都能在 HTML 里找到", () => {
  for (const html of HTML_FILES) {
    const ids = new Set([...read(html).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

    const scripts = [...read(html).matchAll(/<script[^>]+src="\.\/([^"]+\.js)"/g)].map((m) =>
      resolve(dirname(html), m[1]),
    );
    assert.ok(scripts.length > 0, `${html} 没有入口脚本`);

    const queried = new Set();
    for (const script of scripts) {
      const source = read(script);
      for (const m of source.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
        queried.add(m[1]);
      }
      for (const m of source.matchAll(/querySelector(?:All)?\(\s*["'`]#([A-Za-z0-9_-]+)["'`]/g)) {
        queried.add(m[1]);
      }
    }

    assert.ok(queried.size > 5, `只抓到 ${queried.size} 个 id，检查一下正则`);
    for (const id of queried) {
      // 只认"像 id 的"东西：HTML 的 id 合法字符很宽，但本仓库的 id 一律是
      // `[a-z][a-z0-9-]*`。加这一条是因为正则分不出注释和代码 —— 注释里写一句
      // `getElementById("…")` 当举例，就会被当成查了一个叫「…」的元素。
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) continue;
      assert.ok(ids.has(id), `${html} 的脚本查了 id="${id}"，但页面上没有这个元素`);
    }
  }
});
