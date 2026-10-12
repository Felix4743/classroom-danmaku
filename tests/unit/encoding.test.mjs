/**
 * 编码守卫。
 *
 * 这条测试来自一次真实事故：用 Windows PowerShell 5.1 的
 * `(Get-Content …) -replace … | Set-Content -Encoding utf8` 批量改一个测试文件，
 * PS 5.1 的 `Get-Content` 默认按**系统 ANSI 代码页（简体中文下是 GBK）**读取，
 * 于是整个文件的中文被 UTF-8 编码了两次，变成 `鎵嬫劅` 这样的乱码。
 * 更糟的是：测试照旧全绿，因为乱码只出现在字符串字面量和注释里。
 *
 * 所以这里对所有源文件做一次廉价的体检：能按 UTF-8 解码、
 * 解码后重新编码必须与原字节完全一致、且不含替换字符。
 * 只要有人再用管道改文件，这里就会先炸。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

const SCANNED_DIRS = ["src", "scripts", "tests"];
const SCANNED_EXT = new Set([".js", ".mjs", ".json", ".css", ".html", ".md"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function scannedFiles() {
  const files = [];
  for (const dir of SCANNED_DIRS) {
    const base = join(REPO_ROOT, dir);
    try {
      statSync(base);
    } catch {
      continue;
    }
    for (const file of walk(base)) {
      if (SCANNED_EXT.has(extname(file))) files.push(file);
    }
  }
  return files;
}

test("所有源文件都是合法 UTF-8，没有双重编码的乱码", () => {
  const files = scannedFiles();
  assert.ok(files.length >= 10, `只扫到 ${files.length} 个文件，目录列表是不是写错了`);

  const problems = [];
  for (const file of files) {
    const raw = readFileSync(file);
    const text = raw.toString("utf8");
    const rel = file.slice(REPO_ROOT.length + 1).replaceAll("\\", "/");

    if (text.includes("\uFFFD")) {
      problems.push(`${rel}: 含替换字符 U+FFFD，文件不是合法 UTF-8`);
      continue;
    }
    if (!Buffer.from(text, "utf8").equals(raw)) {
      problems.push(`${rel}: 重新编码后字节不一致，说明不是合法的 UTF-8 文本`);
      continue;
    }
    // UTF-8 被当成 GBK 读出来的典型产物：一串本不该出现在源码里的汉字组合
    if (rel === "tests/unit/encoding.test.mjs") continue; // 本文件自己要举例说明，跳过自检
    if (/[鎵娴璺鏂鐨涓寮绯]{2,}/.test(text)) {
      problems.push(`${rel}: 疑似 PowerShell 双重编码事故留下的乱码`);
    }
  }

  assert.deepEqual(problems, []);
});

test("中文注释与文案确实被扫到了（否则上面那条是空转）", () => {
  const text = readFileSync(join(REPO_ROOT, "src/shared/config.js"), "utf8");
  assert.match(text, /[\u4e00-\u9fa5]{4,}/, "源文件里应当有中文注释");
});
