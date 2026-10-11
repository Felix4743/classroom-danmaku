#!/usr/bin/env node
/**
 * 文档完整性校验。
 *
 * 校验范围：仓库根目录与 docs/ 下的所有 Markdown 文件。
 * 校验项：
 *   1. 文件为合法 UTF-8，且非空
 *   2. 代码块围栏（```）成对闭合
 *   3. 相对路径链接指向的文件真实存在
 *   4. 文档包含且仅包含一个一级标题
 *
 * 设计原则：零依赖、零配置，直接 `npm test` 运行。
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = [".", "docs"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

/** 收集所有待校验的 Markdown 文件路径（去重）。 */
function collectMarkdownFiles() {
  const found = new Set();
  for (const dir of SCAN_DIRS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      const full = join(entry.parentPath ?? entry.path, entry.name);
      const rel = relative(ROOT, full);
      if (rel.split(/[\\/]/).some((part) => SKIP_DIRS.has(part))) continue;
      found.add(rel);
    }
  }
  return [...found].sort();
}

/** 对单个文件执行全部校验，返回问题列表。 */
function checkFile(relPath) {
  const problems = [];
  let text;
  try {
    text = readFileSync(join(ROOT, relPath), "utf8");
  } catch (err) {
    return [`无法按 UTF-8 读取：${err.message}`];
  }

  if (text.trim().length === 0) {
    return ["文件为空"];
  }

  // 2. 代码块围栏必须成对闭合
  const fenceCount = text.split("\n").filter((line) => /^\s*```/.test(line)).length;
  if (fenceCount % 2 !== 0) {
    problems.push(`代码块围栏数量为奇数（${fenceCount}），存在未闭合的 \`\`\``);
  }

  // 3. 相对路径链接必须指向真实存在的文件
  const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const clean = decodeURIComponent(target.split("#")[0].split("?")[0]);
    if (!clean) continue;
    const resolved = resolve(ROOT, dirname(relPath), clean);
    if (!existsSync(resolved)) {
      problems.push(`链接指向不存在的路径：${target}`);
    } else if (statSync(resolved).isDirectory() === false && clean.endsWith("/")) {
      problems.push(`链接以 / 结尾但目标是文件：${target}`);
    }
  }

  // 4. 一级标题唯一
  const h1Count = text.split("\n").filter((line) => /^#\s+\S/.test(line)).length;
  if (h1Count === 0) {
    problems.push("缺少一级标题（# 标题）");
  } else if (h1Count > 1) {
    problems.push(`存在 ${h1Count} 个一级标题，应只有 1 个`);
  }

  return problems;
}

const files = collectMarkdownFiles();
let failed = 0;

for (const file of files) {
  const problems = checkFile(file);
  if (problems.length === 0) {
    console.log(`  ok   ${file}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${file}`);
    for (const problem of problems) console.log(`         - ${problem}`);
  }
}

console.log(`\n共校验 ${files.length} 个文档，${failed} 个未通过。`);
process.exit(failed === 0 ? 0 : 1);
