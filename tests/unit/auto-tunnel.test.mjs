/**
 * 启动时自动接公网（技术方案 §4.12）。
 *
 * 这一组的重点全在"什么时候**不**该开"上。自动开公网意味着老师的课堂地址
 * 会出现在公网上，所以判定必须保守：老师明确说了不开就不开，找不到穿透程序
 * 也不开，已经开着不重复开。只有"有二进制 + 没被禁 + 现在没开"同时成立才动手。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NO_AUTO_TUNNEL_ENV,
  autoTunnelDecision,
  maybeAutoStartTunnel,
} from "../../src/main/auto-tunnel.js";
import { TUNNEL_STATE } from "../../src/main/tunnel.js";

const quiet = { log() {}, warn() {}, error() {} };

/** 一个只会记账的假隧道。`hasBinary: false` 时表示装包漏了 hsk-cli。 */
function fakeTunnel(overrides = {}) {
  const calls = { start: 0 };
  const current = overrides.state ?? TUNNEL_STATE.OFF;
  return {
    calls,
    getState: () => ({ state: current, publicUrl: null }),
    resolveBinary: () => (overrides.hasBinary === false ? null : "/tmp/hsk-cli"),
    start: async () => {
      calls.start += 1;
      return { state: TUNNEL_STATE.STARTING };
    },
  };
}

test("自动公网：绑过账号、没被禁，就该自己连上", () => {
  const decision = autoTunnelDecision({ state: TUNNEL_STATE.OFF }, { hasBinary: true, env: {} });
  assert.equal(decision.start, true);
});

test("自动公网：老师说了不开就绝对不开", () => {
  const decision = autoTunnelDecision(
    { state: TUNNEL_STATE.OFF },
    { hasBinary: true, env: { [NO_AUTO_TUNNEL_ENV]: "1" } },
  );
  assert.equal(decision.start, false);
  assert.equal(decision.reason, "opted_out");
  // 日志里得留一条，否则老师会以为"自动接公网"这个功能坏了
  assert.match(decision.message, /CLASSROOM_NO_AUTO_TUNNEL/);
});

test("自动公网：逃生门优先于环境问题", () => {
  // 反过来的话，"找不到二进制"会盖掉老师明确的"别自动开"，
  // 日志里就会出现一条他不想看到的重试说明
  const decision = autoTunnelDecision(
    { state: TUNNEL_STATE.OFF },
    { hasBinary: false, env: { [NO_AUTO_TUNNEL_ENV]: "1" } },
  );
  assert.equal(decision.reason, "opted_out");
});

test("自动公网：只有 '1' 才算关，别的值当没设", () => {
  for (const value of ["0", "true", "", "yes"]) {
    const decision = autoTunnelDecision(
      { state: TUNNEL_STATE.OFF },
      { hasBinary: true, env: { [NO_AUTO_TUNNEL_ENV]: value } },
    );
    assert.equal(decision.start, true, `${NO_AUTO_TUNNEL_ENV}=${value} 不该被当成"关"`);
  }
});

test("自动公网：装包漏了穿透程序就跳过，但局域网照常", () => {
  const decision = autoTunnelDecision({ state: TUNNEL_STATE.OFF }, { hasBinary: false, env: {} });
  assert.equal(decision.start, false);
  assert.equal(decision.reason, "no_binary");
  assert.match(decision.message, /局域网不受影响/);
});

test("自动公网：已经开着 / 正在开就不重复开", () => {
  for (const state of [TUNNEL_STATE.ON, TUNNEL_STATE.STARTING]) {
    const decision = autoTunnelDecision({ state }, { hasBinary: true, env: {} });
    assert.equal(decision.start, false, `${state} 时不该再开一次`);
    assert.equal(decision.reason, `already_${state}`);
  }
});

test("自动公网：查过没绑账号就不再问第二遍", () => {
  const decision = autoTunnelDecision({ state: TUNNEL_STATE.NO_ACCOUNT }, { hasBinary: true, env: {} });
  assert.equal(decision.start, false);
  assert.equal(decision.reason, "no_account");
  assert.equal(decision.message, null, "没绑账号是正常状态，不需要解释");
});

test("自动公网：上次报错要重试一次", () => {
  // 上一次可能只是网络抖了一下，启动时正好该再给一次机会
  const decision = autoTunnelDecision({ state: TUNNEL_STATE.ERROR }, { hasBinary: true, env: {} });
  assert.equal(decision.start, true);
});

test("自动公网：该开的时候真的调了 start，并把状态带回来", async () => {
  const tunnel = fakeTunnel();
  const result = await maybeAutoStartTunnel({ tunnel, env: {}, logger: quiet });
  assert.equal(tunnel.calls.start, 1);
  assert.equal(result.snapshot.state, TUNNEL_STATE.STARTING);
});

test("自动公网：不该开的时候一次 start 都不调", async () => {
  const tunnel = fakeTunnel({ state: TUNNEL_STATE.NO_ACCOUNT });
  await maybeAutoStartTunnel({ tunnel, env: {}, logger: quiet });
  assert.equal(tunnel.calls.start, 0);
});

test("自动公网：start 抛异常也不能往上冒", async () => {
  // 公网是加餐。它起不来不该挡住上课，所以这里必须吞掉
  const tunnel = {
    getState: () => ({ state: TUNNEL_STATE.OFF }),
    resolveBinary: () => "/tmp/hsk-cli",
    start: async () => {
      throw new Error("端口被占");
    },
  };
  const result = await maybeAutoStartTunnel({ tunnel, env: {}, logger: quiet });
  assert.equal(result.error?.message, "端口被占");
});

test("自动公网：没有隧道对象也不能炸", async () => {
  const result = await maybeAutoStartTunnel({ tunnel: null, env: {}, logger: quiet });
  assert.equal(result.start, false);
});
