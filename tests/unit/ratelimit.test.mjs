import assert from "node:assert/strict";
import test from "node:test";

import { RULES, createRateLimiter } from "../../src/main/server/ratelimit.js";
import { REJECT } from "../../src/shared/protocol.js";

/** 可控时钟。限流器的所有判断都基于时间，用真实时间测就只能写出一堆 flaky 用例。 */
function makeClock(start = 1_000_000) {
  let value = start;
  const clock = () => value;
  clock.set = (next) => {
    value = next;
  };
  clock.advance = (ms) => {
    value += ms;
    return value;
  };
  return clock;
}

const DEVICE = "dev-0001";
const IP = "192.168.1.20";

test("限流参数与方案一致", () => {
  // 这几个数字是产品决定，不是实现细节，改了必须是有意的
  assert.equal(RULES.minIntervalMs, 3000);
  assert.equal(RULES.perMinute, 10);
  assert.equal(RULES.perSession, 200);
  assert.equal(RULES.strikeMuteMs, 60_000);
  assert.equal(RULES.strikeThreshold, 3);
  assert.ok(RULES.ipPerMinute > RULES.perMinute, "IP 级必须比设备级松，否则 NAT 下会误伤整班");
});

test("设备级限流：最小间隔", async (t) => {
  await t.test("第一条放行，并记录累计数", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    const result = limiter.check({ deviceId: DEVICE, ip: IP });
    assert.equal(result.allowed, true);
    assert.equal(result.total, 1);
    assert.equal(result.muted, false);
  });

  await t.test("间隔不够时拒绝，并给出还需等多久", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    limiter.check({ deviceId: DEVICE, ip: IP });
    clock.advance(1000);

    const result = limiter.check({ deviceId: DEVICE, ip: IP });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REJECT.RATE_LIMITED);
    assert.equal(result.retryAfterMs, 2000);
    assert.match(result.message, /2 秒/);
    // 被拒的那次不算进累计数
    assert.equal(limiter.totalOf(DEVICE), 1);
  });

  await t.test("等够了就放行", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    limiter.check({ deviceId: DEVICE, ip: IP });
    clock.advance(3000);
    assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, true);
    assert.equal(limiter.totalOf(DEVICE), 2);
  });

  await t.test("边界：正好 3000ms 放行", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    limiter.check({ deviceId: DEVICE, ip: IP });
    clock.advance(2999);
    assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, false);
    clock.advance(1);
    assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, true);
  });

  await t.test("缺 deviceId 直接抛错，不退化成只按 IP 限", () => {
    const limiter = createRateLimiter();
    assert.throws(() => limiter.check({ ip: IP }), /deviceId/);
    assert.throws(() => limiter.check({ deviceId: "", ip: IP }), /deviceId/);
  });
});

test("设备级限流：每分钟与每节课", async (t) => {
  await t.test("一分钟内第 11 条被拒", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    for (let i = 0; i < 10; i += 1) {
      assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, true, `第 ${i + 1} 条`);
      clock.advance(3000);
    }
    const result = limiter.check({ deviceId: DEVICE, ip: IP });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REJECT.RATE_LIMITED);
    assert.match(result.message, /一分钟最多 10 条/);
  });

  await t.test("滑出 60 秒窗口后恢复", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    for (let i = 0; i < 10; i += 1) {
      limiter.check({ deviceId: DEVICE, ip: IP });
      clock.advance(3000);
    }
    // 第一条时间戳是 0，现在在 30000，还差 30 秒才滑出窗口
    clock.advance(30_000);
    assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, true);
  });

  await t.test("单节课上限是终局状态，不给 retryAfterMs", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({
      now: clock,
      rules: { minIntervalMs: 0, perMinute: 1000, perSession: 5 },
    });
    for (let i = 0; i < 5; i += 1) {
      assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, true, `第 ${i + 1} 条`);
    }
    const result = limiter.check({ deviceId: DEVICE, ip: IP });
    assert.equal(result.allowed, false);
    assert.equal(result.retryAfterMs, 0, "等多久都没用，所以不该给倒计时");
    assert.match(result.message, /上限/);
  });
});

test("设备级限流：静音与拉黑", async (t) => {
  await t.test("连续违规 3 次触发静音 60 秒", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    limiter.check({ deviceId: DEVICE, ip: IP });

    const first = limiter.check({ deviceId: DEVICE, ip: IP });
    assert.equal(first.allowed, false);
    assert.equal(first.reason, REJECT.RATE_LIMITED, "第 1 次违规只是被拦，不静音");

    limiter.check({ deviceId: DEVICE, ip: IP });
    const third = limiter.check({ deviceId: DEVICE, ip: IP });
    assert.equal(third.reason, REJECT.MUTED);
    assert.equal(third.retryAfterMs, 60_000);
    assert.ok(limiter.isMuted(DEVICE));
  });

  await t.test("静音期间即使等够了最小间隔也发不出去", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    for (let i = 0; i < 4; i += 1) limiter.check({ deviceId: DEVICE, ip: IP });
    assert.ok(limiter.isMuted(DEVICE));

    clock.advance(10_000); // 远超 minIntervalMs
    const result = limiter.check({ deviceId: DEVICE, ip: IP });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REJECT.MUTED);
    assert.match(result.message, /静音/);
  });

  await t.test("静音 60 秒后自动恢复", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    for (let i = 0; i < 4; i += 1) limiter.check({ deviceId: DEVICE, ip: IP });
    clock.advance(60_001);
    assert.equal(limiter.isMuted(DEVICE), false);
    assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, true);
  });

  await t.test("静音期间继续硬顶会延长静音", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    for (let i = 0; i < 4; i += 1) limiter.check({ deviceId: DEVICE, ip: IP });
    clock.advance(59_000);
    // 还剩 1 秒时又顶 3 次，静音被重新计满 60 秒
    for (let i = 0; i < 3; i += 1) limiter.check({ deviceId: DEVICE, ip: IP });
    clock.advance(2000);
    assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, false);
  });

  await t.test("违规计数会随时间清零，偶尔手快不该攒成静音", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({
      now: clock,
      rules: { minIntervalMs: 0, perMinute: 1 },
    });
    limiter.check({ deviceId: DEVICE, ip: IP }); // 用掉唯一的配额
    clock.advance(4000);
    limiter.check({ deviceId: DEVICE, ip: IP }); // 违规 1
    assert.equal(limiter.strikesOf(DEVICE), 1);
    clock.advance(4000);
    limiter.check({ deviceId: DEVICE, ip: IP }); // 违规 2
    assert.equal(limiter.strikesOf(DEVICE), 2);

    // 超过 strikeDecayMs 之后，计数从 0 重新数
    clock.advance(RULES.strikeDecayMs + 1000);
    limiter.check({ deviceId: DEVICE, ip: IP });
    assert.equal(limiter.strikesOf(DEVICE), 1, "隔了 31 秒，不该接着上次的数");
    assert.equal(limiter.isMuted(DEVICE), false);
    assert.equal(limiter.stats().muted, 0);
  });

  await t.test("成功发言不清零违规计数", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    limiter.check({ deviceId: DEVICE, ip: IP });
    clock.advance(1000);
    limiter.check({ deviceId: DEVICE, ip: IP }); // 违规 1
    clock.advance(3000);
    assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, true);
    assert.equal(limiter.strikesOf(DEVICE), 1, "清零只由时间窗口负责，不由成功发言负责");
  });

  await t.test("拉黑后一律拒绝，且不会被静音计时放行", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    limiter.check({ deviceId: DEVICE, ip: IP });
    assert.equal(limiter.setBanned(DEVICE, true), true);

    clock.advance(600_000);
    const result = limiter.check({ deviceId: DEVICE, ip: IP });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REJECT.BANNED);
    assert.equal(result.retryAfterMs, 0);
    assert.equal(limiter.isBanned(DEVICE), true);

    assert.equal(limiter.setBanned(DEVICE, false), true);
    assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, true);
    assert.equal(limiter.setBanned(DEVICE, false), false, "重复解禁不该报告为改动");
  });

  await t.test("老师可以手动解除静音", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    for (let i = 0; i < 4; i += 1) limiter.check({ deviceId: DEVICE, ip: IP });
    assert.equal(limiter.unmute(DEVICE), true);
    assert.equal(limiter.isMuted(DEVICE), false);
    // 解除静音不等于送你一次免最小间隔：刚被拦的那条已经消耗了发言时机
    assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, false);
    clock.advance(RULES.minIntervalMs);
    assert.equal(limiter.check({ deviceId: DEVICE, ip: IP }).allowed, true);
    assert.equal(limiter.unmute("从没见过的设备"), false);
  });

  await t.test("拉黑是终局状态，不会被 prune 忘掉", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    limiter.check({ deviceId: DEVICE, ip: IP });
    limiter.setBanned(DEVICE, true);
    clock.advance(RULES.idleMs + 1);
    limiter.prune();
    assert.equal(limiter.isBanned(DEVICE), true);
  });
});

test("IP 级限流只做兜底", async (t) => {
  await t.test("同一 IP 冒出大量设备时才会触发", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({
      now: clock,
      rules: { minIntervalMs: 0, perMinute: 1000 },
    });
    for (let i = 0; i < RULES.ipPerMinute; i += 1) {
      const result = limiter.check({ deviceId: `dev-${i}`, ip: IP });
      assert.equal(result.allowed, true, `第 ${i + 1} 台设备`);
    }
    const result = limiter.check({ deviceId: "dev-one-more", ip: IP });
    assert.equal(result.allowed, false);
    assert.match(result.message, /稍后再试/);
  });

  await t.test("不同 IP 互不影响", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({
      now: clock,
      rules: { minIntervalMs: 0, perMinute: 1000, ipPerMinute: 2 },
    });
    assert.equal(limiter.check({ deviceId: "a", ip: "10.0.0.1" }).allowed, true);
    assert.equal(limiter.check({ deviceId: "b", ip: "10.0.0.1" }).allowed, true);
    assert.equal(limiter.check({ deviceId: "c", ip: "10.0.0.1" }).allowed, false);
    assert.equal(limiter.check({ deviceId: "d", ip: "10.0.0.2" }).allowed, true);
  });

  await t.test("IP 级必须比设备级松得多（NAT 下整班共用一个出口）", () => {
    // 一个班 40 人用同一个 NAT 出口，每人一分钟 10 条就是 400 条，
    // 虽然会被 IP 级拦下 —— 但那是"全班同时刷屏"的极端情况，
    // 正常上课时每分钟几十条远够用。这里只钉住"至少能容纳 5 个人的满配额"
    assert.ok(RULES.ipPerMinute >= RULES.perMinute * 5);
  });

  await t.test("没有 IP 时跳过这一层，不报错", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock, rules: { minIntervalMs: 0 } });
    assert.equal(limiter.check({ deviceId: DEVICE }).allowed, true);
    assert.equal(limiter.check({ deviceId: DEVICE, ip: "" }).allowed, true);
    assert.equal(limiter.check({ deviceId: DEVICE, ip: null }).allowed, true);
  });
});

test("限流器的回收与统计", async (t) => {
  await t.test("prune 回收长时间没动静的记录", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    limiter.check({ deviceId: "a", ip: "10.0.0.1" });
    limiter.check({ deviceId: "b", ip: "10.0.0.2" });

    // a 停在原地，b 一直有动静
    clock.advance(RULES.idleMs - 1000);
    limiter.check({ deviceId: "b", ip: "10.0.0.2" });
    clock.advance(1001);

    assert.equal(limiter.prune(), 2, "a 的设备记录与 10.0.0.1 的 IP 记录都该回收");
    assert.equal(limiter.stats().devices, 1);
    assert.equal(limiter.isMuted("b"), false, "b 的记录还在，问它状态不该是未知");
  });

  await t.test("stats 反映真实状态", () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ now: clock });
    limiter.check({ deviceId: "a", ip: "10.0.0.1" });
    limiter.check({ deviceId: "b", ip: "10.0.0.2" }); // 放行
    for (let i = 0; i < 3; i += 1) limiter.check({ deviceId: "b", ip: "10.0.0.2" }); // 3 次违规
    limiter.setBanned("c", true);

    const stats = limiter.stats();
    assert.equal(stats.allowed, 2);
    assert.equal(stats.blocked, 3);
    assert.equal(stats.mutes, 1);
    assert.equal(stats.banned, 1);
    assert.equal(stats.muted, 1);
    assert.ok(stats.devices >= 3);
  });
});
