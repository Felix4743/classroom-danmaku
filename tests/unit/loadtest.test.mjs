/**
 * 压测脚本本身的自测（技术方案 §8.3）。
 *
 * 压测脚本是"没有 80 个学生时唯一的验证手段"，那它自己就必须是可信的 ——
 * 一个悄悄把所有消息都算成成功的压测，比没有压测更糟。所以这里真的起一个
 * 服务、真的开几个学生连接、真的发几条，然后断言账目对得上：
 * 发出去多少、回来了多少、投影端看到多少，三者必须一致。
 *
 * 规模刻意压到最小（3 个人、2 秒），因为它是一道回归网，不是性能基准 ——
 * 真正的压测由 `node tests/simulate/loadtest.mjs --students 100` 手工跑。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  LATENCY_BUDGET_MS,
  formatReport,
  parseArgs,
  percentile,
  runLoadTest,
  verdicts,
} from "../simulate/loadtest.mjs";

test("percentile：边界与插值", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 1), 5);
  // p95 落在 4 和 5 之间，插值而不是取端点
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 4.8);
});

test("parseArgs：默认值、短参数与换算", () => {
  const base = parseArgs([]);
  assert.equal(base.students, 100);
  assert.equal(base.durationMs, 10_000);
  assert.equal(base.rate, 6);
  assert.equal(base.url, null);

  const custom = parseArgs(["--students", "30", "-d", "5", "--rate", "12", "--json"]);
  assert.equal(custom.students, 30);
  assert.equal(custom.durationMs, 5000);
  assert.equal(custom.rate, 12);
  assert.equal(custom.json, true);
});

test("parseArgs：参数不合法时直接报错，不要默默按默认值跑", () => {
  assert.throws(() => parseArgs(["--students", "0"]), /必须是正数/);
  assert.throws(() => parseArgs(["--students", "abc"]), /必须是正数/);
  assert.throws(() => parseArgs(["--students"]), /缺少值/);
  assert.throws(() => parseArgs(["--nonsense"]), /不认识的参数/);
});

test("verdicts：全绿时没有问题，任一红线被踩到都要报出来", () => {
  const clean = {
    students: 3,
    connected: 3,
    connectFailures: [],
    disconnected: [],
    sent: 3,
    acked: 3,
    rejected: 0,
    rateLimited: 0,
    timeouts: 0,
    unacked: 0,
    missedOnScreen: 0,
    latencies: { p95: 12 },
  };
  assert.deepEqual(verdicts(clean), []);

  assert.match(verdicts({ ...clean, connected: 2 }).join(), /握手/);
  assert.match(verdicts({ ...clean, connectFailures: [3] }).join(), /连不上/);
  assert.match(verdicts({ ...clean, disconnected: [{ index: 1 }] }).join(), /掉线/);
  assert.match(verdicts({ ...clean, timeouts: 2 }).join(), /没收到回执/);
  assert.match(verdicts({ ...clean, missedOnScreen: 1 }).join(), /没到投影端/);
  assert.match(verdicts({ ...clean, latencies: { p95: 900 } }).join(), /超过验收线/);
  // 一条回执都没有说明链路根本没通，这时候 p95 是 null，不能因此判成通过
  assert.match(verdicts({ ...clean, acked: 0, latencies: { p95: null } }).join(), /链路根本没通/);
});

test("verdicts：收发对不上账要报出来", () => {
  const result = {
    students: 1,
    connected: 1,
    connectFailures: [],
    disconnected: [],
    sent: 10,
    acked: 4,
    rejected: 0,
    rateLimited: 0,
    timeouts: 0,
    unacked: 0,
    missedOnScreen: 0,
    latencies: { p95: 10 },
  };
  assert.match(verdicts(result).join(), /对不上账/);
});

test("formatReport：把人要看的数字都写进去了", () => {
  const result = {
    students: 3,
    durationMs: 2000,
    rate: 20,
    url: "http://127.0.0.1:1",
    inProcess: true,
    connected: 3,
    connectFailures: [],
    disconnected: [],
    socketErrors: 0,
    sent: 3,
    acked: 3,
    rejected: 0,
    rateLimited: 0,
    timeouts: 0,
    unacked: 0,
    latencies: { count: 3, p50: 48, p95: 66, p99: 67, max: 68 },
    observer: { connected: true, received: 3, distinct: 3, closed: false },
    heap: { before: 0, after: 0, delta: 0 },
    missedOnScreen: 0,
  };
  const text = formatReport(result);
  assert.match(text, /学生 3 人/);
  assert.match(text, /连接成功 3\/3/);
  assert.match(text, /p95 66\.0ms/);
  assert.match(text, /结论：通过/);
});

test("端到端：真的开几个学生连上去发弹幕，账目要对得上", async () => {
  const result = await runLoadTest({
    students: 3,
    durationMs: 2000,
    rate: 20,
    port: 0,
    host: "127.0.0.1",
    quiet: true,
    logger: { log() {} },
  });

  assert.equal(result.inProcess, true);
  assert.equal(result.connected, 3, "三个人都该完成握手");
  assert.deepEqual(result.connectFailures, []);
  assert.deepEqual(result.disconnected, [], "不该有人掉线");
  assert.equal(result.socketErrors, 0);

  assert.ok(result.sent >= 3, `三个人至少各发一条，实际 ${result.sent}`);
  assert.ok(result.acked >= 3, `至少该收到三个回执，实际 ${result.acked}`);
  assert.equal(result.timeouts, 0, "不该有发出去没回执的");

  // 投影端必须看见发送者收到回执的每一条
  assert.equal(result.observer.connected, true);
  assert.equal(result.observer.closed, false);
  assert.equal(result.missedOnScreen, 0);
  assert.equal(result.observer.distinct, result.ackedDistinct);

  assert.equal(result.latencies.count, result.acked);
  assert.ok(
    result.latencies.p95 < LATENCY_BUDGET_MS,
    `本机回环的 p95 必须远低于验收线，实际 ${result.latencies.p95}`,
  );

  assert.deepEqual(verdicts(result), [], "压测自己给出的结论必须是通过");
  // 服务端会话真的被用过了，而不是"连上了但什么都没进去"
  assert.ok(result.userCounts.accepted >= 3, `会话层至少接受了 3 条，实际 ${result.userCounts.accepted}`);
});
