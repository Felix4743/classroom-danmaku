/**
 * 落盘与导出（技术方案 §4.11、§5.2）。
 *
 * 这一层没有算法，但它的失败方式都是**不可逆**的：写坏的文件没有第二份，
 * 写错的位置老师下节课再也找不到。所以测试的重点不是"能不能写"，而是
 * "写坏了会怎样"：目录不存在、磁盘不可写、被强行中断。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SCHEMA_VERSION,
  createStore,
  humanTime,
  rankIssues,
  renderMarkdown,
  sessionFileName,
} from "../../src/main/store.js";

/** 建一个用完整场删除的临时目录。 */
async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "danmaku-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function sampleData(overrides = {}) {
  return {
    schema: SCHEMA_VERSION,
    startedAt: new Date(2026, 9, 12, 15, 30).getTime(),
    exportedAt: new Date(2026, 9, 12, 16, 10).getTime(),
    config: { duration: 12, fontSize: 28, alpha: 0.9, maxDensity: 60 },
    stats: { online: 42, total: 213, filtered: 4, rateLimited: 17, removed: 1 },
    presets: [{ id: "not_understood", label: "没听懂" }],
    danmaku: [
      {
        seq: 1,
        text: "没听懂",
        presetId: "not_understood",
        nickname: "小明",
        ts: 1_000,
        likes: 0,
        aggregate: 3,
        pinned: true,
        resolved: false,
        removed: false,
        studentId: "2023xxxx",
        name: "张三",
      },
      {
        seq: 2,
        text: "没听懂",
        presetId: "not_understood",
        nickname: "小红",
        ts: 40_000,
        likes: 2,
        aggregate: 5,
        pinned: false,
        resolved: true,
        removed: false,
        studentId: null,
        name: null,
      },
      {
        seq: 3,
        text: "老师，第三题没讲",
        presetId: null,
        nickname: "匿名同学",
        ts: 61_000,
        likes: 7,
        aggregate: 0,
        pinned: false,
        resolved: false,
        removed: true,
        studentId: null,
        name: null,
      },
    ],
    ...overrides,
  };
}

test("文件名与时间戳", async (t) => {
  await t.test("按本地时间排成 年-月-日-时分.json", () => {
    const ts = new Date(2026, 9, 12, 15, 30).getTime();
    assert.equal(sessionFileName(ts), "2026-10-12-1530.json");
  });

  await t.test("同一分钟内是同一个名字", () => {
    const a = new Date(2026, 9, 12, 15, 30, 1).getTime();
    const b = new Date(2026, 9, 12, 15, 30, 58).getTime();
    assert.equal(sessionFileName(a), sessionFileName(b));
  });

  await t.test("humanTime 补零", () => {
    assert.equal(humanTime(new Date(2026, 0, 5, 8, 7).getTime()), "2026-01-05 08:07");
  });
});

test("高频问题排序", async (t) => {
  await t.test("同一个预置项跨聚合窗口要相加，不是取最大值", () => {
    const ranked = rankIssues(sampleData().danmaku);
    const notUnderstood = ranked.find((issue) => issue.presetId === "not_understood");
    // ×3 与 ×5 是同一群人在两个 30 秒窗口里的两次表达，总数是 8
    assert.equal(notUnderstood.count, 8);
    assert.equal(notUnderstood.likes, 2);
  });

  await t.test("自由打字按原文归并，预置项按 id 归并", () => {
    const ranked = rankIssues([
      { text: "这里不懂", presetId: null, ts: 1 },
      { text: "这里不懂", presetId: null, ts: 2 },
      { text: "没听懂", presetId: "not_understood", aggregate: 9, ts: 3 },
    ]);
    assert.equal(ranked[0].presetId, "not_understood");
    assert.equal(ranked[0].count, 9);
    assert.equal(ranked[1].count, 2);
  });

  await t.test("空文本被跳过，条数受 limit 限制", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      text: `问题 ${i}`,
      presetId: null,
      ts: i,
    }));
    many.push({ text: "   ", presetId: null, ts: 99 });
    assert.equal(rankIssues(many).length, 20);
    assert.equal(rankIssues(many, 5).length, 5);
  });
});

test("人可读摘要", async (t) => {
  await t.test("包含时间、规模、置顶与已回应", () => {
    const md = renderMarkdown(sampleData());
    assert.match(md, /^# 课堂弹幕 · 2026-10-12 15:30/);
    assert.match(md, /弹幕条数：3/);
    assert.match(md, /收到 213 条/);
    assert.match(md, /## 高频问题 Top 20/);
    assert.match(md, /## 被置顶的问题/);
    assert.match(md, /### 没听懂 ×3/);
    assert.match(md, /小明（张三 2023xxxx）/);
    assert.match(md, /## 已被回应的问题/);
    assert.match(md, /没听懂 ×5 —— 小红/);
  });

  await t.test("被删除的弹幕留在文件里，不是被抹掉", () => {
    const md = renderMarkdown(sampleData());
    assert.match(md, /## 被删除的弹幕/);
    assert.match(md, /老师，第三题没讲/);
  });

  await t.test("一节课什么都没收到时也要能读", () => {
    const md = renderMarkdown({
      schema: 1,
      startedAt: 0,
      exportedAt: 0,
      stats: {},
      danmaku: [],
    });
    assert.match(md, /这节课没有收到弹幕/);
    assert.match(md, /没有置顶任何弹幕/);
    assert.match(md, /没有标记已回应/);
  });

  await t.test("缺字段不炸（旧版本文件、手工改过的文件）", () => {
    assert.doesNotThrow(() => renderMarkdown(null));
    assert.doesNotThrow(() => renderMarkdown({}));
    assert.doesNotThrow(() => renderMarkdown({ danmaku: [{}] }));
  });
});

test("落盘", async (t) => {
  await t.test("写进 sessions/，内容能完整读回来", async () => {
    const dir = await makeTempDir(t);
    const store = createStore({ dir, logger: { error() {} } });
    const data = sampleData();

    const file = await store.save(data);
    assert.ok(file.startsWith(store.sessionsDir));
    assert.ok(file.endsWith("2026-10-12-1530.json"));

    const roundTrip = JSON.parse(await readFile(file, "utf8"));
    assert.equal(roundTrip.schema, 1);
    assert.equal(roundTrip.danmaku.length, 3);
    assert.equal(roundTrip.danmaku[0].studentId, "2023xxxx");
  });

  await t.test("原子写：写完不留 .tmp", async () => {
    const dir = await makeTempDir(t);
    const store = createStore({ dir, logger: { error() {} } });
    await store.save(sampleData());
    const names = await readdir(store.sessionsDir);
    assert.deepEqual(names, ["2026-10-12-1530.json"]);
  });

  await t.test("同一节课反复落盘覆盖同一个文件，不会攒出一堆", async () => {
    const dir = await makeTempDir(t);
    const store = createStore({ dir, logger: { error() {} } });
    await store.save(sampleData());
    await store.save(sampleData({ stats: { total: 999 } }));
    const names = await readdir(store.sessionsDir);
    assert.deepEqual(names, ["2026-10-12-1530.json"]);
    const saved = JSON.parse(await readFile(join(store.sessionsDir, names[0]), "utf8"));
    assert.equal(saved.stats.total, 999);
  });

  await t.test("目录不存在会自己建", async () => {
    const dir = await makeTempDir(t);
    const store = createStore({ dir: join(dir, "深", "一层"), logger: { error() {} } });
    const file = await store.save(sampleData());
    assert.ok(file);
    assert.ok((await stat(file)).isFile());
  });

  await t.test("磁盘不可写时返回 null 而不是抛异常", async () => {
    const dir = await makeTempDir(t);
    // 把"数据目录"指到一个**文件**上：建子目录必然失败
    const blocked = join(dir, "not-a-dir");
    await writeFile(blocked, "占位", "utf8");

    const errors = [];
    const store = createStore({ dir: blocked, logger: { error: (m) => errors.push(m) } });
    const result = await store.save(sampleData());
    assert.equal(result, null, "落盘失败不能把异常扔回课堂");
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /落盘失败/);
  });

  await t.test("list 在有目录和没目录时都返回数组", async () => {
    const dir = await makeTempDir(t);
    const store = createStore({ dir, logger: { error() {} } });
    assert.deepEqual(await store.list(), []);
    await store.save(sampleData());
    assert.deepEqual(await store.list(), ["2026-10-12-1530.json"]);
  });
});

test("导出", async (t) => {
  await t.test("同时产出 .json 与 .md", async () => {
    const dir = await makeTempDir(t);
    const store = createStore({ dir, logger: { error() {} } });

    const out = await store.exportTo(sampleData());
    assert.ok(out.json.endsWith("exports\\2026-10-12-1610.json") || out.json.endsWith("exports/2026-10-12-1610.json"));
    assert.ok(out.markdown.endsWith(".md"));
    assert.match(out.markdownText, /# 课堂弹幕/);

    // 导出与自动落盘是两个目录：老师主动导出的那份不该被下一轮自动落盘覆盖
    assert.deepEqual(await store.list("exports"), ["2026-10-12-1610.json", "2026-10-12-1610.md"]);
    assert.deepEqual(await store.list("sessions"), []);
    assert.equal(await readFile(out.markdown, "utf8"), out.markdownText);
  });

  await t.test("JSON 里带着身份，摘要里也带（导出是给老师追溯用的）", async () => {
    const dir = await makeTempDir(t);
    const store = createStore({ dir, logger: { error() {} } });
    const out = await store.exportTo(sampleData());
    const saved = JSON.parse(await readFile(out.json, "utf8"));
    assert.equal(saved.danmaku[0].name, "张三");
    assert.match(out.markdownText, /张三/);
  });
});
