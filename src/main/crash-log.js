/**
 * 崩溃日志（技术方案 §7.4）。
 *
 * 这个模块的存在理由不是"记录崩溃"，而是**别让记录崩溃的动作把课堂搞死**。
 * 2026-10-12 实测踩到的真实事故：
 *
 *   `uncaughtException` 处理函数里调了 `console.error` → 控制台管道已经断了
 *   （EPIPE: broken pipe, write）→ `console.error` **同步抛出** → 这个异常又变成
 *   一次新的 `uncaughtException` → 处理函数再调 `console.error` → 无限循环。
 *   11 分钟里往 U 盘上的 `data/logs/crash.log` 写了 **1.97 GB**，
 *   主进程 100% 占着一个核，最后日志还在涨。
 *
 * 所以这里叠了四道闸，每一道单独都能挡住上面那条链：
 *   1. `hardenConsole()` —— 把 `console.*` 包成永不抛的函数。控制台在桌面程序里
 *      根本不是可靠信道（双击启动的 exe 没有控制台，被脚本拉起来时管道随时会断），
 *      往一个会抛异常的东西上写日志，本身就是 bug。
 *   2. 重入闸 —— 已经在处理异常时又抛进来的异常直接丢掉。处理过程自己抛的异常
 *      没有任何诊断价值，它只会自激。
 *   3. 条数预算 —— 一次运行最多落盘 `CRASH_BUDGET` 条。一个每帧都炸的错误
 *      （比如某个 `setInterval` 里）不该被忠实地记录一百万次。
 *   4. 字节上限 + 轮转 —— 单个 `crash.log` 不超过 `MAX_CRASH_LOG_BYTES`，
 *      超了就滚成 `crash.log.1`。老师拔着 U 盘来上课，写爆 U 盘比不写日志更糟。
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** 单个日志文件的上限。一条堆栈约 1–3 KB，512 KB 够留几百条。 */
export const MAX_CRASH_LOG_BYTES = 512 * 1024;

/** 一次运行最多落盘多少条。超了只计数，不再写盘。 */
export const CRASH_BUDGET = 200;

export const CRASH_LOG_NAME = "crash.log";
export const CRASH_LOG_ROTATED = "crash.log.1";

const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug", "trace"];

/**
 * 调 `log[level](...)`，**保证不抛**。
 *
 * 注意调用方传进来的 `log` 可能就是 `console`，而我们要包的就是它自己抛异常
 * 这件事 —— 所以这里必须先取函数再调，不能直接 `log[level](...)`。
 */
export function safeLog(log, level, ...args) {
  try {
    const fn = typeof log?.[level] === "function" ? log[level] : log?.log;
    if (typeof fn !== "function") return false;
    fn.apply(log, args);
    return true;
  } catch {
    // 管道断了、控制台句柄没了…… 控制台不是可靠信道，这里咽掉是对的
    return false;
  }
}

/**
 * 把 `console.*` 换成永不抛的版本，就地改。
 *
 * 必须在 `installCrashLog` **之前**调用，否则第 1 道闸形同虚设。
 */
export function hardenConsole(target = console, levels = CONSOLE_LEVELS) {
  for (const level of levels) {
    const original = target[level];
    if (typeof original !== "function") continue;
    const bound = original.bind(target);
    target[level] = (...args) => {
      try {
        bound(...args);
      } catch {
        /* 见上：控制台不是可靠信道 */
      }
    };
  }
  return target;
}

/** 一行日志的文本。读不出错误内容时也要给出一行，不能在这里抛。 */
export function formatCrashLine(tag, error, now = new Date()) {
  const stamp = `[${now.toISOString()}] ${tag}`;
  try {
    return `${stamp} ${error?.stack ?? error}\n`;
  } catch {
    return `${stamp} （连错误本身都读不出来）\n`;
  }
}

/** 单条日志长过上限时截断。一个超长的堆栈不该把整块 U 盘顶穿。 */
const TRUNCATED_MARK = "…（单条日志超过上限，已截断）\n";

function clampLine(line, maxBytes) {
  const buffer = Buffer.from(line, "utf8");
  if (buffer.length <= maxBytes) return line;

  const mark = Buffer.from(TRUNCATED_MARK, "utf8");
  let end = Math.max(0, maxBytes - mark.length);
  // 别把多字节汉字劈成半个：UTF-8 的续字节形如 10xxxxxx
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return Buffer.concat([buffer.subarray(0, end), mark]).toString("utf8");
}

/**
 * 写一条，超上限就轮转。
 *
 * 轮转失败（Windows 上文件被别的进程占着）时宁可删掉重来 —— 无论如何都不能
 * 让这个文件无限长下去，它长的是老师的 U 盘。
 */
function appendCapped(path, rotatedPath, rawLine, maxBytes) {
  // 先截断再量长度，这样"文件永远不超过 maxBytes"是个无条件的保证
  const line = clampLine(rawLine, maxBytes);
  const bytes = Buffer.byteLength(line, "utf8");
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    size = 0; // 还没有这个文件
  }

  if (size + bytes > maxBytes) {
    try {
      renameSync(path, rotatedPath);
    } catch {
      try {
        unlinkSync(path);
      } catch {
        /* 删不掉就算了，下面的 append 还会再抛一次，交给调用方的 try */
      }
    }
  }

  appendFileSync(path, line, "utf8");
}

/**
 * 造一个崩溃记录器：`{report(tag, error), path, written, dropped, disabled}`。
 */
export function createCrashReporter(options = {}) {
  const {
    logDir,
    maxBytes = MAX_CRASH_LOG_BYTES,
    budget = CRASH_BUDGET,
    now = () => new Date(),
  } = options;

  if (!logDir) throw new TypeError("createCrashReporter 需要一个 logDir");

  const path = join(logDir, CRASH_LOG_NAME);
  const rotatedPath = join(logDir, CRASH_LOG_ROTATED);
  let written = 0;
  let dropped = 0;

  function report(tag, error) {
    // 第 3 道闸：预算用光后只计数。一个每帧都抛的错误不该写满整块 U 盘。
    if (written >= budget) {
      dropped += 1;
      return false;
    }
    written += 1;

    const line = formatCrashLine(tag, error, now());
    try {
      mkdirSync(logDir, { recursive: true });
      appendCapped(path, rotatedPath, line, maxBytes);
    } catch {
      // 连日志都写不下去（U 盘拔了/写保护/盘满了），能做的只有别让程序再崩一次
      dropped += 1;
    }
    return true;
  }

  return {
    report,
    path,
    get written() {
      return written;
    },
    get dropped() {
      return dropped;
    },
  };
}

/**
 * 往 `process` 上挂 `uncaughtException` / `unhandledRejection`。
 *
 * 第 2 道闸（重入）就在这里：处理过程自己抛出来的异常直接丢掉。
 * 那种异常没有任何诊断价值，它只会自激成死循环。
 */
export function installCrashLog(target, options = {}) {
  const reporter = createCrashReporter(options);
  const log = options.log ?? console;
  const defer = options.defer ?? setImmediate;
  let handling = false;

  const guard = (tag) => (error) => {
    if (handling) return;
    handling = true;
    try {
      reporter.report(tag, error);
      safeLog(log, "error", `[main] ${tag}`, error);
    } finally {
      // 故意推迟到下一个宏任务才放行。处理函数**自己抛出**的时候，Node 是在
      // 同一个调用栈里再发一次 uncaughtException 的 —— 同步清标志位正好挡不住它，
      // 这正是 2026-10-12 那次 1.97 GB 日志的循环方式。
      defer(() => {
        handling = false;
      });
    }
  };

  target.on("uncaughtException", guard("uncaughtException"));
  target.on("unhandledRejection", guard("unhandledRejection"));
  return reporter;
}
