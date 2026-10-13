/**
 * 「一键开公网」的 HTTP 接口（技术方案 §4.11）。
 *
 * 这里测的不是隧道本身（那在 `tunnel.test.mjs`），而是**它对外长什么样**：
 * 动词、状态码、以及最要紧的那道同源闸门。因为这几个接口会花掉老师花生壳
 * 账号的配额、并把课堂服务推到公网上，学生如果能用一个 `<img>` 触发它就是
 * 真的安全问题。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { TUNNEL_PATHS, createTunnelRoutes, isSameOrigin } from "../../src/main/server/tunnel-routes.js";
import { request, serve } from "../helpers/server.mjs";

const silent = { info() {}, error() {}, warn() {} };

/** 一个只记调用次数的假管理器。 */
function fakeManager(state = {}, options = {}) {
  const calls = { start: 0, stop: 0, login: 0, checkAccount: 0 };
  let current = { state: "off", publicUrl: null, expiresAt: null, message: null, available: true, ...state };
  return {
    calls,
    getState: () => ({ ...current }),
    async start() {
      calls.start += 1;
      current = { ...current, ...(options.onStart ?? { state: "on", publicUrl: "https://x.hz-1.aicp.space" }) };
      return { ...current };
    },
    async stop() {
      calls.stop += 1;
      current = { state: "off", publicUrl: null, expiresAt: null, message: null, available: true };
      return { ...current };
    },
    async beginLogin() {
      calls.login += 1;
      return options.login ?? { ok: true, authorizeUrl: "https://console-hsk-ng.oray.com/oauth/authorize?a=1" };
    },
    async checkAccount() {
      calls.checkAccount += 1;
      return { authenticated: true, status: "authenticated", reason: "ok" };
    },
  };
}

async function serveTunnel(t, manager) {
  return serve(t, {
    staticRoot: "src",
    mounts: {},
    logger: silent,
    routes: createTunnelRoutes({ manager, logger: silent }),
  });
}

test("isSameOrigin", async (t) => {
  await t.test("本机脚本（没有 Origin/Referer/Sec-Fetch-Site）放行", () => {
    assert.equal(isSameOrigin({ headers: { host: "127.0.0.1:3000" } }), true);
  });

  await t.test("同源页面放行", () => {
    assert.equal(
      isSameOrigin({ headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }),
      true,
    );
  });

  await t.test("别的站点发来的请求拒掉 —— 学生不能替老师开公网", () => {
    assert.equal(
      isSameOrigin({ headers: { host: "192.168.1.5:3000", origin: "http://evil.example" } }),
      false,
    );
  });

  await t.test("同站不同端口也算跨站 —— 学生页是同一个 IP 的另一个端口", () => {
    assert.equal(
      isSameOrigin({ headers: { host: "192.168.1.5:3000", origin: "http://192.168.1.5:8080" } }),
      false,
    );
  });

  await t.test("Sec-Fetch-Site 是 cross-site 就直接拒，哪怕没有 Origin", () => {
    assert.equal(
      isSameOrigin({ headers: { host: "192.168.1.5:3000", "sec-fetch-site": "cross-site" } }),
      false,
    );
  });

  await t.test("Sec-Fetch-Site 是 same-origin 放行", () => {
    assert.equal(
      isSameOrigin({ headers: { host: "192.168.1.5:3000", "sec-fetch-site": "same-origin" } }),
      true,
    );
  });

  await t.test("没有 Host 一律拒（HTTP/1.0 那种残缺请求）", () => {
    assert.equal(isSameOrigin({ headers: {} }), false);
  });

  await t.test("Origin 是不合法的串，拒", () => {
    assert.equal(isSameOrigin({ headers: { host: "a:1", origin: "null" } }), false);
  });
});

test("隧道接口", async (t) => {
  await t.test("status 返回规范化过的隧道状态", async () => {
    const manager = fakeManager({ state: "on", publicUrl: "https://a.hz-1.aicp.space" });
    const server = await serveTunnel(t, manager);
    const res = await request(server.url, TUNNEL_PATHS.status);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.tunnel.state, "on");
    assert.equal(body.tunnel.publicUrl, "https://a.hz-1.aicp.space");
    // 默认**不**去问账号：那要起子进程，页面轮询不该触发
    assert.equal(manager.calls.checkAccount, 0);
  });

  await t.test("status?account=1 才去问账号", async () => {
    const manager = fakeManager();
    const server = await serveTunnel(t, manager);
    const res = await request(server.url, `${TUNNEL_PATHS.status}?account=1`);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).account.authenticated, true);
    assert.equal(manager.calls.checkAccount, 1);
  });

  await t.test("start 只有 POST 才认，GET 是 405", async () => {
    const manager = fakeManager();
    const server = await serveTunnel(t, manager);

    const get = await request(server.url, TUNNEL_PATHS.start);
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, "POST");
    assert.equal(manager.calls.start, 0);

    const post = await request(server.url, TUNNEL_PATHS.start, { method: "POST" });
    assert.equal(post.status, 200);
    assert.equal(JSON.parse(post.body).tunnel.state, "on");
    assert.equal(manager.calls.start, 1);
  });

  await t.test("没绑账号时 start 返回 502 和 no_account —— 老师端据此弹绑定引导", async () => {
    const manager = fakeManager({}, { onStart: { state: "no_account", message: "还没绑定花生壳账号" } });
    const server = await serveTunnel(t, manager);
    const res = await request(server.url, TUNNEL_PATHS.start, { method: "POST" });
    assert.equal(res.status, 502);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.tunnel.state, "no_account");
    assert.match(body.tunnel.message, /花生壳账号/);
  });

  await t.test("stop 只有 POST，调用后状态回 off", async () => {
    const manager = fakeManager({ state: "on", publicUrl: "https://a.hz-1.aicp.space" });
    const server = await serveTunnel(t, manager);

    assert.equal((await request(server.url, TUNNEL_PATHS.stop)).status, 405);

    const res = await request(server.url, TUNNEL_PATHS.stop, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).tunnel.state, "off");
    assert.equal(manager.calls.stop, 1);
  });

  await t.test("login 把授权链接原样交给老师端去打开", async () => {
    const manager = fakeManager();
    const server = await serveTunnel(t, manager);
    const res = await request(server.url, TUNNEL_PATHS.login, { method: "POST" });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.match(body.authorizeUrl, /oauth\/authorize/);
  });

  await t.test("login 失败时 502，并带上给老师看的原因", async () => {
    const manager = fakeManager({}, { login: { ok: false, error: "no_authorize_url", message: "授权流程没起来" } });
    const server = await serveTunnel(t, manager);
    const res = await request(server.url, TUNNEL_PATHS.login, { method: "POST" });
    assert.equal(res.status, 502);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, "no_authorize_url");
    assert.equal(body.message, "授权流程没起来");
  });

  await t.test("跨站发来的 POST 一律 403，且不碰管理器", async () => {
    const manager = fakeManager();
    const server = await serveTunnel(t, manager);
    const res = await request(server.url, TUNNEL_PATHS.start, {
      method: "POST",
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(res.status, 403);
    assert.equal(manager.calls.start, 0);
  });

  await t.test("管理器抛异常时转成 500，而不是把连接挂死", async () => {
    const manager = fakeManager();
    manager.start = async () => {
      throw new Error("taskkill 起不来");
    };
    const server = await serveTunnel(t, manager);
    const res = await request(server.url, TUNNEL_PATHS.start, { method: "POST" });
    assert.equal(res.status, 500);
    assert.match(JSON.parse(res.body).message, /taskkill/);
  });

  await t.test("createTunnelRoutes 没给管理器就直接抛，别等上线才发现", () => {
    assert.throws(() => createTunnelRoutes({}), TypeError);
  });
});
