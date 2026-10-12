/**
 * 崩溃日志的四道闸（crash-log.js）。
 *
 * 这批测试是从一次真实事故倒推出来的：`uncaughtException` 处理函数里调
 * `console.error`，而控制台管道已经断了（EPIPE）→ console.error 同步抛出 →
 * 这个异常又变成一次新的 uncaughtException → 无限循环，
 * 11 分钟往 U 盘写了 1.97 GB 的 crash.log，主进程一直占着一个核。
 *
 * 所以这里每一条测试对应的都是当初那根链条上的一环，不是"覆盖率凑数"。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CRASH_LOG_NAME,
  CRASH_LOG_ROTATED,
  formatCrashLine,
  hardenConsole,
  installCrashLog,
  safeLog,
  createCrashReporter,
} from "../../src/main/crash-log.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "crash-log-"));
}

// ── 第 1 道闸：console 永不抛 ──────────────────────────────────────────

test("safeLog：日志函数抛异常时咽掉并返回 false，绝不往外抛", () => {
  const exploding = {
    error() {
      const error = new Error("EPIPE: broken pipe, write");
      error.code = "EPIPE";
      throw error;
    },
  };
  assert.equal(safeLog(exploding, "error", "boom"), false);
});

test("safeLog：正常情况下转发参数并返回 true", () => {
  const seen = [];
  const log = { warn: (...args) => seen.push(args) };
  assert.equal(safeLog(log, "warn", "a", 1), true);
  assert.deepEqual(seen, [["a", 1]]);
});

test("safeLog：日志对象连 log 方法都没有时也不抛", () => {
  assert.equal(safeLog(undefined, "error", "x"), false);
  assert.equal(safeLog({}, "error", "x"), false);
});

test("hardenConsole：包过之后 console.error 断了管道也不会抛", () => {
  // 这就是事故的第一环。真实场景是 stdout 的管道被父进程关掉。
  const fake = {
    error() {
      throw new Error("EPIPE: broken pipe, write");
    },
    log() {
      throw new Error("EPIPE: broken pipe, write");
    },
  };
  hardenConsole(fake);
  assert.doesNotThrow(() => fake.error("boom"));
  assert.doesNotThrow(() => fake.log("boom"));
});

test("hardenConsole：正常 console 的行为不变，且 this 仍然指向原对象", () => {
  const seen = [];
  const fake = {
    tag: "console",
    log(...args) {
      seen.push([this.tag, ...args]);
    },
  };
  hardenConsole(fake);
  fake.log("hi", 2);
  assert.deepEqual(seen, [["console", "hi", 2]]);
});

// ── 一行日志本身 ──────────────────────────────────────────────────────

test("formatCrashLine：带标签、时间和堆栈", () => {
  const line = formatCrashLine("uncaughtException", new Error("炸了"), new Date("2026-10-12T07:35:33.061Z"));
  assert.match(line, /^\[2026-10-12T07:35:33\.061Z\] uncaughtException /);
  assert.match(line, /炸了/);
  assert.ok(line.endsWith("\n"));
});

test("formatCrashLine：连错误都读不出来时也要给出一行", () => {
  // 有些对象的 stack getter 自己会抛。日志写入路径上不能有任何能抛的东西。
  const evil = {
    get stack() {
      throw new Error("读不出来");
    },
    get message() {
      throw new Error("读不出来");
    },
  };
  const line = formatCrashLine("uncaughtException", evil);
  assert.match(line, /uncaughtException/);
  assert.match(line, /读不出来/);
});

// ── 第 3、4 道闸：条数预算与字节上限 ──────────────────────────────────

test("createCrashReporter：没有 logDir 直接抛 TypeError", () => {
  assert.throws(() => createCrashReporter({}), TypeError);
});

test("createCrashReporter：正常写一条到 crash.log", () => {
  const dir = tempDir();
  const reporter = createCrashReporter({ logDir: dir });
  assert.equal(reporter.report("uncaughtException", new Error("第一条")), true);

  const text = readFileSync(join(dir, CRASH_LOG_NAME), "utf8");
  assert.match(text, /uncaughtException/);
  assert.match(text, /第一条/);
  assert.equal(reporter.written, 1);
  assert.equal(reporter.dropped, 0);
});

test("字节上限：超过 maxBytes 就轮转，单个文件绝不超过上限", () => {
  const dir = tempDir();
  const reporter = createCrashReporter({ logDir: dir, maxBytes: 400 });

  for (let i = 0; i < 20; i += 1) {
    reporter.report("uncaughtException", new Error(`第 ${i} 条，用来把文件撑过上限`));
  }

  const main = statSync(join(dir, CRASH_LOG_NAME)).size;
  const rotated = statSync(join(dir, CRASH_LOG_ROTATED)).size;
  assert.ok(main <= 400, `crash.log 应该是 ${main} 字节，超过了 400`);
  assert.ok(rotated <= 400, `crash.log.1 应该是 ${rotated} 字节，超过了 400`);
  // 轮转过，说明上限真的生效了，而不是文件太小还没触发
  assert.ok(reporter.written > 1);
});

test("字节上限：轮转目标被占住（Windows 上文件被占用）时删掉重来，文件仍然是小的", () => {
  const dir = tempDir();
  // 把轮转目标做成一个非空目录：renameSync 必然失败，模拟"文件被别的进程占着"
  mkdirSync(join(dir, CRASH_LOG_ROTATED, "occupied"), { recursive: true });

  const reporter = createCrashReporter({ logDir: dir, maxBytes: 300 });
  for (let i = 0; i < 10; i += 1) {
    reporter.report("uncaughtException", new Error(`撑大它的第 ${i} 条错误信息`));
  }

  assert.ok(statSync(join(dir, CRASH_LOG_NAME)).size <= 300);
  assert.ok(reporter.written > 1);
});

test("条数预算：用完预算后只计数、不再写盘", () => {
  const dir = tempDir();
  const reporter = createCrashReporter({ logDir: dir, budget: 3, maxBytes: 1_000_000 });

  for (let i = 0; i < 50; i += 1) reporter.report("uncaughtException", new Error(`第 ${i} 条`));

  assert.equal(reporter.written, 3);
  assert.equal(reporter.dropped, 47);
  // 堆栈里自带换行，所以按"标签出现几次"数，不能按行数数
  const text = readFileSync(join(dir, CRASH_LOG_NAME), "utf8");
  assert.equal(text.match(/\] uncaughtException /g).length, 3);
});

test("写盘失败（目录不可写）时也不抛，只记一笔 dropped", () => {
  const dir = tempDir();
  // 把 crash.log 做成一个目录：appendFileSync 必然失败
  mkdirSync(join(dir, CRASH_LOG_NAME), { recursive: true });

  const reporter = createCrashReporter({ logDir: dir });
  assert.equal(reporter.report("uncaughtException", new Error("写不进去")), true);
  assert.equal(reporter.dropped, 1);
});

// ── 第 2 道闸：重入 ───────────────────────────────────────────────────

test("installCrashLog：正常的 uncaughtException / unhandledRejection 各写一条", () => {
  const dir = tempDir();
  const target = new EventEmitter();
  // defer 立刻放行：这是两个**互相独立**的异常，都该被记下来。
  // 真实运行用的是 setImmediate，同一个 tick 里的第二条会被当成自激重发挡掉。
  const reporter = installCrashLog(target, { logDir: dir, log: { error() {} }, defer: (fn) => fn() });

  target.emit("uncaughtException", new Error("崩了"));
  target.emit("unhandledRejection", new Error("拒绝了"));

  const text = readFileSync(join(dir, CRASH_LOG_NAME), "utf8");
  assert.match(text, /uncaughtException/);
  assert.match(text, /unhandledRejection/);
  assert.equal(reporter.written, 2);
});

test("installCrashLog：处理函数自己抛出导致 Node 同步重发时，被重入闸挡掉", () => {
  // 这是事故的完整还原：日志函数抛 → 触发新一轮 uncaughtException。
  // 真实事故里日志函数就是 console.error（管道断了）。
  const dir = tempDir();
  const target = new EventEmitter();
  let logCalls = 0;
  const log = {
    error() {
      logCalls += 1;
      // 模拟 Node：处理函数抛出后，在同一个调用栈里再发一次
      target.emit("uncaughtException", new Error("EPIPE: broken pipe, write"));
    },
  };

  const reporter = installCrashLog(target, { logDir: dir, log, defer: () => {} });
  target.emit("uncaughtException", new Error("EPIPE: broken pipe, write"));

  // 关键：不是 1.97 GB，而是 1 次。处理函数自己抛出来的那个"重发"被挡掉了。
  assert.equal(logCalls, 1, `日志函数被调了 ${logCalls} 次，重入闸没挡住`);
  assert.equal(reporter.written, 1, `落了 ${reporter.written} 条，重入闸没挡住`);
});

test("installCrashLog：日志函数抛异常时，installCrashLog 自己也要咽掉它", () => {
  const dir = tempDir();
  const target = new EventEmitter();
  const log = {
    error() {
      throw new Error("EPIPE: broken pipe, write");
    },
  };
  installCrashLog(target, { logDir: dir, log, defer: () => {} });
  assert.doesNotThrow(() => target.emit("uncaughtException", new Error("真正的错误")));
});

test("installCrashLog：日志写盘失败也不能影响程序继续跑", () => {
  const target = new EventEmitter();
  const reporter = installCrashLog(target, {
    logDir: join(tmpdir(), "绝对不存在的目录", "\u0000非法路径"),
    log: { error() {} },
    defer: () => {},
  });
  assert.doesNotThrow(() => target.emit("uncaughtException", new Error("崩了")));
  assert.equal(reporter.dropped, 1);
});

test("installCrashLog：defer 放行之后，下一次异常又能正常记录", () => {
  const dir = tempDir();
  const target = new EventEmitter();
  const pending = [];
  const reporter = installCrashLog(target, {
    logDir: dir,
    log: { error() {} },
    defer: (fn) => pending.push(fn),
  });

  target.emit("uncaughtException", new Error("第一次"));
  // 还没放行：这一条会被挡掉（同一次自激循环里的重发就该被挡）
  target.emit("uncaughtException", new Error("同一次里的重发"));
  assert.equal(reporter.written, 1);

  for (const fn of pending.splice(0)) fn();
  target.emit("uncaughtException", new Error("下一轮"));
  assert.equal(reporter.written, 2);
});

// ── 目录里不要留下意外的文件 ──────────────────────────────────────────

test("只用 crash.log 与 crash.log.1，不产生别的文件", () => {
  const dir = tempDir();
  const reporter = createCrashReporter({ logDir: dir, maxBytes: 200 });
  for (let i = 0; i < 10; i += 1) reporter.report("uncaughtException", new Error(`第 ${i} 条`));

  const names = readdirSync(dir).sort();
  assert.deepEqual(names, [CRASH_LOG_NAME, CRASH_LOG_ROTATED].sort());
});
