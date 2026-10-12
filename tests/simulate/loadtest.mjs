/**
 * 多客户端模拟压测（技术方案 §8.3）。
 *
 * 这是**唯一能在没有 80 个学生的情况下验证并发能力**的手段：开 N 个真的
 * WebSocket 客户端，每人按固定节奏发弹幕，然后把三件事量出来 ——
 * 连接成功率、消息端到端延迟分布、服务端内存增长。再加一个投影端连接，
 * 用来回答"发出去的东西是不是每条都真的到了屏幕上"。
 *
 * 端到端延迟是怎么测的：客户端发送时带一个自己的 `tempId`（§4.3.1），
 * 服务端在回给**发送者本人**的那条 `danmaku:new` 里把 `tempId` 原样带回
 * （session.js:368）。所以 `收到带这个 tempId 的回执的时刻 − 发送的时刻`
 * 就是一次完整的往返：客户端 → 服务端 → 会话层处理 → 广播回来。
 * 这比"在服务端打点"更接近学生真实感受到的那个延迟。
 *
 * 关于限流：默认在**本进程内**起一个服务（端口随机），并且只放宽一条规则 ——
 * `ipPerMinute`。原因是所有模拟客户端都从 127.0.0.1 来，共用同一个 IP，
 * 而 IP 级限流（ratelimit.js:36）本来就是"同一 IP 冒出一堆设备"的兜底，
 * 不放宽的话 30 个学生发到第 61 条就全被拦住了。**其余规则（每人 3 秒间隔、
 * 每分钟 10 条、单节课 200 条）一条都没动**，它们本来就是按设备算的。
 * 想连一个已经在跑的真服务时用 `--url`，那时什么规则都不放宽。
 *
 * 用法：
 *   node tests/simulate/loadtest.mjs                       # 100 人，10 秒
 *   node tests/simulate/loadtest.mjs --students 30 --rate 6
 *   node tests/simulate/loadtest.mjs --url http://127.0.0.1:3000
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { startClassroom } from "../../src/main/server/start.js";
import { createSession } from "../../src/main/server/session.js";
import { createRateLimiter } from "../../src/main/server/ratelimit.js";
import { C2S, ROLE, S2C } from "../../src/shared/protocol.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = join(HERE, "..", "..", "src");
const CLASS_ID = "default";

/** 发出去之后等多久还没收到回执，就算这一条丢了。 */
export const ACK_TIMEOUT_MS = 5000;
/** 停止发送之后再多等一会儿，把在路上的回执收干净。 */
export const SETTLE_MS = 800;
/** 连上之后先静一下，让所有人的 joined/state 都到齐再开始计时。 */
export const WARMUP_MS = 300;
/**
 * 第一轮发送的错峰窗口。
 *
 * 错峰是为了不让 100 个定时器挤在同一个 tick 里。但窗口**不能**等于发送间隔：
 * 间隔是 10 秒时，最后一个人要等 10 秒才发第一条，短时压测里等于没发。
 * 所以窗口固定 400ms，所有人的第一条都在这 400ms 内出去（顺带也压一下突发），
 * 之后的节奏才是匀速的。
 */
export const STAGGER_MS = 400;

/** V1 的验收线（§9）：端到端 < 500ms。 */
export const LATENCY_BUDGET_MS = 500;

export function parseArgs(argv) {
  const options = {
    students: 100,
    durationMs: 10_000,
    rate: 6,
    url: null,
    port: 0,
    host: "127.0.0.1",
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`${arg} 后面缺少值`);
      return value;
    };
    switch (arg) {
      case "--students":
      case "-n":
        options.students = Number(next());
        break;
      case "--duration":
      case "-d":
        options.durationMs = Number(next()) * 1000;
        break;
      case "--rate":
      case "-r":
        options.rate = Number(next());
        break;
      case "--url":
        options.url = next();
        break;
      case "--port":
        options.port = Number(next());
        break;
      case "--json":
        options.json = true;
        break;
      case "--quiet":
      case "-q":
        options.quiet = true;
        break;
      default:
        throw new Error(`不认识的参数 ${arg}`);
    }
  }
  for (const [name, value] of [
    ["--students", options.students],
    ["--duration", options.durationMs],
    ["--rate", options.rate],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数`);
  }
  return options;
}

/** 本进程内起的那个服务不许往 stdout 打日志：报告必须是唯一的输出。 */
const SILENT_LOGGER = Object.freeze({
  log() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 百分位数，index 落在两个数之间时线性插值。空数组返回 null。 */
export function percentile(sorted, ratio) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * ratio;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/**
 * 一条模拟出来的学生连接。
 *
 * 它只做三件事：连上、按节奏发、把回执记下来。故意不引入 `src/shared/client.js`
 * —— 那个客户端带自动重连和本地回显，会把"掉了线"伪装成"还活着"，
 * 而压测最需要看见的恰恰就是掉线。
 */
function createStudent({ url, index, nickname, sendEnabled }) {
  const state = {
    index,
    nickname,
    socket: null,
    deviceId: null,
    connected: false,
    closed: false,
    closeCode: null,
    errors: [],
    sent: 0,
    acked: 0,
    rejected: 0,
    rateLimited: 0,
    timeouts: 0,
    pending: new Map(),
    latencies: [],
    ackedIds: new Set(),
  };

  function onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    const { event: name, payload } = message;
    if (name === S2C.JOINED) {
      state.deviceId = payload?.deviceId ?? null;
      state.connected = true;
      return;
    }
    if (name === S2C.NEW && payload?.tempId) {
      const sentAt = state.pending.get(payload.tempId);
      if (sentAt !== undefined) {
        state.pending.delete(payload.tempId);
        state.latencies.push(Date.now() - sentAt);
        state.acked += 1;
        state.ackedIds.add(payload.id);
      }
      return;
    }
    if (name === S2C.REJECTED && payload?.tempId) {
      state.pending.delete(payload.tempId);
      state.rejected += 1;
      return;
    }
    if (name === S2C.RATE_LIMITED) {
      // 限流回执里没有 tempId（session.js:293 只带 retryAfterMs 和文案），
      // 但同一条连接的消息是按顺序处理的，所以最老的那条未回执就是它
      state.rateLimited += 1;
      const oldest = state.pending.keys().next();
      if (!oldest.done) state.pending.delete(oldest.value);
      return;
    }
    if (name === S2C.ERROR && payload?.tempId) {
      state.pending.delete(payload.tempId);
    }
  }

  return {
    state,

    async open() {
      const socket = new WebSocket(url);
      state.socket = socket;
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", (event) => {
        state.closed = true;
        state.closeCode = event.code;
      });
      socket.addEventListener("error", () => {
        state.errors.push("socket error");
      });
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("连不上")), { once: true });
      });
      socket.send(
        JSON.stringify({
          event: C2S.JOIN,
          payload: { role: ROLE.STUDENT, classId: CLASS_ID, nickname },
        }),
      );
    },

    /** 发一条，返回是否真的写进了 socket。回执由 onMessage 记账。 */
    send(n) {
      if (!state.connected || state.closed || !sendEnabled()) return false;
      const tempId = `lt-${index}-${n}`;
      state.pending.set(tempId, Date.now());
      state.sent += 1;
      state.socket.send(
        JSON.stringify({ event: C2S.SEND, payload: { text: `${nickname}的第 ${n} 条`, tempId } }),
      );
      return true;
    },

    /** 把超时没回执的挑出来。返回这一轮新增的超时条数。 */
    sweepTimeouts(now) {
      let timedOut = 0;
      for (const [tempId, sentAt] of state.pending) {
        if (now - sentAt >= ACK_TIMEOUT_MS) {
          state.pending.delete(tempId);
          state.timeouts += 1;
          timedOut += 1;
        }
      }
      return timedOut;
    },

    close() {
      try {
        state.socket?.close();
      } catch {
        /* 已经关了 */
      }
    },
  };
}

/** 一个只旁观的投影端连接，用来确认每条弹幕都真的走到了"屏幕"上。 */
function createObserver(url) {
  const state = { received: 0, ids: new Set(), connected: false, closed: false };
  let socket = null;
  return {
    state,
    async open() {
      socket = new WebSocket(url);
      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.event === S2C.JOINED) state.connected = true;
        if (message.event === S2C.NEW && message.payload?.id) {
          state.received += 1;
          state.ids.add(message.payload.id);
        }
      });
      socket.addEventListener("close", () => {
        state.closed = true;
      });
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("投影端连不上")), { once: true });
      });
      socket.send(
        JSON.stringify({
          event: C2S.JOIN,
          payload: { role: ROLE.OVERLAY, classId: CLASS_ID },
        }),
      );
    },
    close() {
      try {
        socket?.close();
      } catch {
        /* 已经关了 */
      }
    },
  };
}

/**
 * 跑一次压测。
 *
 * 给了 `url` 就连过去，否则在本进程里起一个服务（返回的 `close` 负责收摊）。
 * 返回值是纯数据，方便测试直接断言，也方便 `--json` 原样打印。
 */
export async function runLoadTest(options = {}) {
  const {
    url: externalUrl = null,
    students: studentCount = 100,
    durationMs = 10_000,
    rate = 6,
    port = 0,
    host = "127.0.0.1",
    logger = console,
    quiet = false,
  } = options;

  let classroom = null;
  let baseUrl = externalUrl;
  const heapBefore = process.memoryUsage().heapUsed;

  if (!baseUrl) {
    classroom = await startClassroom({
      staticRoot: STATIC_ROOT,
      port,
      host,
      logger: SILENT_LOGGER,
      // 只放宽 IP 级限流，理由见文件头
      session: {
        limiter: createRateLimiter({
          rules: { ipPerMinute: Number.MAX_SAFE_INTEGER },
        }),
      },
    });
    baseUrl = classroom.url;
  }

  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws`;
  const intervalMs = 60_000 / rate;
  const started = Date.now();
  let deadline = started + durationMs;

  const observer = createObserver(wsUrl);
  await observer.open();

  const roster = [];
  for (let i = 1; i <= studentCount; i += 1) {
    roster.push(
      createStudent({
        url: wsUrl,
        index: i,
        nickname: `学生${String(i).padStart(2, "0")}`,
        sendEnabled: () => Date.now() < deadline,
      }),
    );
  }

  const connectResults = await Promise.allSettled(roster.map((student) => student.open()));
  const connectFailures = connectResults
    .map((result, index) => (result.status === "rejected" ? index + 1 : null))
    .filter((value) => value !== null);

  if (connectFailures.length > 0) {
    deadline = Date.now(); // 有人连不上就别再发了，直接进入收尾
  } else {
    await sleep(WARMUP_MS);
    deadline = Date.now() + durationMs;
  }

  const timers = roster.map((student, index) => {
    let attempt = 0;
    const stagger = Math.min(intervalMs, STAGGER_MS);
    const offset = (index / Math.max(1, roster.length)) * stagger;
    return setTimeout(function tick() {
      if (Date.now() >= deadline) return;
      attempt += 1;
      student.send(attempt);
      const jitter = intervalMs * 0.2 * (Math.random() * 2 - 1);
      setTimeout(tick, Math.max(1, intervalMs + jitter));
    }, offset);
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const student of roster) student.sweepTimeouts(now);
  }, 500);
  sweep.unref?.();

  while (Date.now() < deadline) {
    await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
  }
  for (const timer of timers) clearTimeout(timer);
  await sleep(SETTLE_MS);
  clearInterval(sweep);

  const now = Date.now();
  for (const student of roster) student.sweepTimeouts(now);

  const heapAfter = process.memoryUsage().heapUsed;

  const latencies = roster.flatMap((student) => student.state.latencies).sort((a, b) => a - b);
  const sent = roster.reduce((sum, student) => sum + student.state.sent, 0);
  const acked = roster.reduce((sum, student) => sum + student.state.acked, 0);
  const rejected = roster.reduce((sum, student) => sum + student.state.rejected, 0);
  const rateLimited = roster.reduce((sum, student) => sum + student.state.rateLimited, 0);
  const timeouts = roster.reduce((sum, student) => sum + student.state.timeouts, 0);
  const unacked = roster.reduce((sum, student) => sum + student.state.pending.size, 0);
  const disconnected = roster.filter((student) => student.state.closed);

  const result = {
    students: studentCount,
    durationMs: now - started,
    rate,
    url: baseUrl,
    inProcess: classroom !== null,
    connected: roster.filter((student) => student.state.connected).length,
    connectFailures,
    disconnected: disconnected.map((student) => ({
      index: student.state.index,
      code: student.state.closeCode,
    })),
    socketErrors: roster.reduce((sum, student) => sum + student.state.errors.length, 0),
    sent,
    acked,
    rejected,
    rateLimited,
    timeouts,
    unacked,
    latencies: {
      count: latencies.length,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length > 0 ? latencies[latencies.length - 1] : null,
    },
    observer: {
      connected: observer.state.connected,
      received: observer.state.received,
      distinct: observer.state.ids.size,
      closed: observer.state.closed,
    },
    heap: { before: heapBefore, after: heapAfter, delta: heapAfter - heapBefore },
    /** 投影端漏掉的条数：学生收到了回执但投影没看见的那几条。 */
    missedOnScreen: 0,
    userCounts: null,
  };

  if (classroom) {
    result.userCounts = classroom.session.stats();
  }

  const ackedIds = new Set(roster.flatMap((student) => [...student.state.ackedIds]));
  for (const id of ackedIds) if (!observer.state.ids.has(id)) result.missedOnScreen += 1;
  result.ackedDistinct = ackedIds.size;

  observer.close();
  for (const student of roster) student.close();
  await sleep(60);
  if (classroom) await classroom.close();

  if (!quiet) {
    logger.log?.(formatReport(result));
  }
  return result;
}

/** 压测结论：全绿返回空数组，否则每条是一个失败原因。 */
export function verdicts(result) {
  const problems = [];
  if (result.connectFailures.length > 0) {
    problems.push(`有 ${result.connectFailures.length} 个学生连不上（序号 ${result.connectFailures.join(",")}）`);
  }
  if (result.connected !== result.students) {
    problems.push(`只有 ${result.connected}/${result.students} 个学生完成了握手`);
  }
  if (result.disconnected.length > 0) {
    problems.push(`有 ${result.disconnected.length} 个学生掉线了`);
  }
  if (result.timeouts > 0) {
    problems.push(`有 ${result.timeouts} 条发出去没收到回执`);
  }
  const accounted = result.acked + result.rejected + result.rateLimited + result.timeouts + result.unacked;
  if (accounted !== result.sent) {
    problems.push(`收发对不上账：发出 ${result.sent} 条，只有 ${accounted} 条有下落`);
  }
  if (result.missedOnScreen > 0) {
    problems.push(`有 ${result.missedOnScreen} 条到了发送者却没到投影端`);
  }
  if (result.sent > 0 && result.acked === 0) {
    problems.push("一条回执都没收到，链路根本没通");
  }
  const p95 = result.latencies.p95;
  if (p95 !== null && p95 > LATENCY_BUDGET_MS) {
    problems.push(`p95 延迟 ${Math.round(p95)}ms 超过验收线 ${LATENCY_BUDGET_MS}ms`);
  }
  return problems;
}

function ms(value) {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)}ms`;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function formatReport(result) {
  const lines = [
    `学生 ${result.students} 人 · 时长 ${(result.durationMs / 1000).toFixed(1)}s · 每人 ${result.rate} 条/分` +
      ` · 服务 ${result.url}${result.inProcess ? "（本进程内）" : "（外部）"}`,
    `连接成功 ${result.connected}/${result.students} · 掉线 ${result.disconnected.length}` +
      ` · socket 错误 ${result.socketErrors}`,
    `发送 ${result.sent} 条 · 收到回执 ${result.acked} 条 · 被拒 ${result.rejected} 条` +
      ` · 被限流 ${result.rateLimited} 条 · 超时无回执 ${result.timeouts} 条 · 收尾时仍在途 ${result.unacked} 条`,
    `端到端延迟 p50 ${ms(result.latencies.p50)} · p95 ${ms(result.latencies.p95)}` +
      ` · p99 ${ms(result.latencies.p99)} · 最大 ${ms(result.latencies.max)}（样本 ${result.latencies.count}）`,
    `投影端收到 ${result.observer.received} 条（去重 ${result.observer.distinct} 条）` +
      ` · 发送者收到而投影没收到 ${result.missedOnScreen} 条`,
    `服务端堆内存 ${mb(result.heap.before)} → ${mb(result.heap.after)}` +
      `（${result.heap.delta >= 0 ? "+" : ""}${mb(Math.abs(result.heap.delta))}）`,
  ];
  const problems = verdicts(result);
  lines.push(problems.length === 0 ? "结论：通过" : `结论：不通过 —— ${problems.join("；")}`);
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runLoadTest({ ...options, quiet: true });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  const problems = verdicts(result);
  process.exitCode = problems.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`压测失败：${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
