/**
 * 「学生该扫哪个地址」（技术方案 §4.10）。
 *
 * 挑网卡本身的规则在 `netinfo.test.mjs` 里钉死了，这里只测**它变成
 * `/api/info` 之后长什么样** —— 老师页和 /diag 都吃这个响应，
 * 字段名改了却没人发现的话，现场表现是"二维码指向 127.0.0.1"。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OVERLAY_PATH,
  DEFAULT_STUDENT_PATH,
  createInfoRoute,
  infoPayload,
} from "../../src/main/server/info.js";
import { request, serve } from "../helpers/server.mjs";

/** 一份典型的教室电脑网卡表：物理 WLAN + VMware + WSL + 一条没拿到 IP 的网线。 */
function fakeInterfaces() {
  return {
    "WLAN": [
      { family: "IPv4", address: "10.109.12.63", internal: false, netmask: "255.255.0.0" },
      { family: "IPv6", address: "fe80::1", internal: false },
    ],
    "以太网 (VMware Network Adapter VMnet1)": [
      { family: "IPv4", address: "192.168.56.1", internal: false },
    ],
    "vEthernet (WSL)": [{ family: "IPv4", address: "172.24.96.1", internal: false }],
    "本地连接": [{ family: "IPv4", address: "169.254.10.7", internal: false }],
    "Loopback Pseudo-Interface 1": [
      { family: "IPv4", address: "127.0.0.1", internal: true },
    ],
    "以太网": [{ family: "IPv4", address: "192.168.1.20", internal: false }],
  };
}

test("infoPayload", async (t) => {
  await t.test("首选地址是物理网卡的私有地址，学生页地址拼对了", () => {
    const info = infoPayload({ interfaces: fakeInterfaces(), port: 3210, now: 1234 });
    assert.equal(info.best.name, "WLAN");
    assert.equal(info.best.address, "10.109.12.63");
    assert.equal(info.best.studentUrl, "http://10.109.12.63:3210/m");
    assert.equal(info.port, 3210);
    assert.equal(info.serverTime, 1234);
    assert.equal(info.studentPath, DEFAULT_STUDENT_PATH);
    assert.equal(info.overlayPath, DEFAULT_OVERLAY_PATH);
  });

  await t.test("虚拟网卡不进候选，APIPA 网卡只留下警告", () => {
    const info = infoPayload({ interfaces: fakeInterfaces(), port: 3000 });
    const addresses = info.candidates.map((c) => c.address);
    assert.deepEqual(addresses, ["10.109.12.63", "192.168.1.20"]);
    assert.ok(addresses.every((a) => !a.startsWith("169.254")));
    assert.ok(info.warnings.some((w) => w.includes("169.254.10.7")));
  });

  await t.test("每个候选地址都带学生页 URL —— 「换一个地址」换的就是它", () => {
    const info = infoPayload({ interfaces: fakeInterfaces(), port: 3000, studentPath: "/m" });
    for (const candidate of info.candidates) {
      assert.equal(candidate.studentUrl, `http://${candidate.address}:3000/m`);
    }
  });

  await t.test("一台机器都不能用时 best 是 null，而不是退回 127.0.0.1", () => {
    const info = infoPayload({
      interfaces: { "vEthernet (WSL)": [{ family: "IPv4", address: "172.24.96.1", internal: false }] },
      port: 3000,
    });
    assert.equal(info.best, null);
    assert.deepEqual(info.candidates, []);
    assert.ok(info.warnings.length > 0);
  });

  await t.test("空网卡表也要有话说", () => {
    const info = infoPayload({ interfaces: {}, port: 3000 });
    assert.equal(info.best, null);
    assert.match(info.warnings.join("\n"), /一张网卡都没找到/);
  });

  await t.test("在线人数来自会话，老师靠它判断到底有没有人连上", () => {
    assert.equal(infoPayload({ interfaces: fakeInterfaces(), port: 3000 }).online, 0);
    assert.equal(
      infoPayload({ interfaces: fakeInterfaces(), port: 3000, online: 37 }).online,
      37,
    );
  });
});

test("infoPayload 与公网隧道", async (t) => {
  const tunnelOn = { state: "on", publicUrl: "https://5db4e2ac62dc.hz-1.aicp.space", expiresAt: "2026-10-14T09:59:40+08:00" };

  await t.test("没开这个功能时 available 是 false —— 老师端整块不显示", () => {
    const info = infoPayload({ interfaces: fakeInterfaces(), port: 3000 });
    assert.equal(info.tunnel.available, false);
    assert.equal(info.tunnel.state, "off");
    assert.equal(info.tunnel.publicUrl, null);
  });

  await t.test("隧道开着：公网地址排第一，网卡地址留着当备选", () => {
    const info = infoPayload({ interfaces: fakeInterfaces(), port: 3000, tunnel: tunnelOn });
    assert.equal(info.tunnel.available, true);
    assert.equal(info.tunnel.state, "on");
    assert.equal(info.best.address, "5db4e2ac62dc.hz-1.aicp.space");
    assert.equal(info.best.studentUrl, "https://5db4e2ac62dc.hz-1.aicp.space/m");
    assert.equal(info.best.scope, "wan");
    assert.equal(info.best.public, true);
    // 「换一个地址」还得能换回局域网
    assert.equal(info.candidates[1].address, "10.109.12.63");
    assert.equal(info.candidates[1].studentUrl, "http://10.109.12.63:3000/m");
  });

  await t.test("公网地址不带端口 —— 端口藏在隧道后面，带上就是错的", () => {
    const info = infoPayload({ interfaces: fakeInterfaces(), port: 3210, tunnel: tunnelOn });
    assert.ok(!info.best.studentUrl.includes("3210"));
    assert.equal(info.best.studentUrl, "https://5db4e2ac62dc.hz-1.aicp.space/m");
  });

  await t.test("这张机器一张网卡都没有时，公网地址仍然是可用的 best", () => {
    const info = infoPayload({
      interfaces: { "vEthernet (WSL)": [{ family: "IPv4", address: "172.24.96.1", internal: false }] },
      port: 3000,
      tunnel: tunnelOn,
    });
    assert.equal(info.best.studentUrl, "https://5db4e2ac62dc.hz-1.aicp.space/m");
    assert.deepEqual(info.candidates.filter((c) => !c.public), []);
  });

  await t.test("隧道开不起来时，原因进 warnings 而不是被吞掉", () => {
    const info = infoPayload({
      interfaces: fakeInterfaces(),
      port: 3000,
      tunnel: { state: "error", message: "穿透程序 45 秒内没给出公网地址" },
    });
    assert.equal(info.best.address, "10.109.12.63");
    assert.match(info.warnings.join("\n"), /公网地址没开起来.*45 秒/);
  });

  await t.test("还没绑账号时也提醒老师", () => {
    const info = infoPayload({
      interfaces: fakeInterfaces(),
      port: 3000,
      tunnel: { state: "no_account", message: "还没绑定花生壳账号" },
    });
    assert.match(info.warnings.join("\n"), /还没绑定花生壳账号/);
  });

  await t.test("隧道给的字段缺斤少两也不会漏到页面上", () => {
    const info = infoPayload({ interfaces: fakeInterfaces(), port: 3000, tunnel: { state: "on" } });
    assert.equal(info.tunnel.publicUrl, null);
    assert.equal(info.tunnel.expiresAt, null);
    assert.equal(info.tunnel.message, null);
    // publicUrl 是 null 就不该凭空多出一个候选
    assert.equal(info.best.address, "10.109.12.63");
  });

  await t.test("getTunnel 每次请求都被现问一次 —— 隧道状态随时会变", async () => {
    const dir = { tunnel: null };
    const started = await serve(t, {
      routes: {
        "/api/info": createInfoRoute({
          getPort: () => 3000,
          interfaces: fakeInterfaces(),
          getTunnel: () => dir.tunnel,
          logger: { error() {} },
        }),
      },
    });

    const before = await request(started.url, "/api/info");
    assert.equal(JSON.parse(before.body).tunnel.available, false);

    dir.tunnel = tunnelOn;
    const after = await request(started.url, "/api/info");
    const body = JSON.parse(after.body);
    assert.equal(body.tunnel.available, true);
    assert.equal(body.best.studentUrl, "https://5db4e2ac62dc.hz-1.aicp.space/m");
  });
});

test("createInfoRoute", async (t) => {
  await t.test("缺 getPort 当场报错，不等到请求时才炸", () => {
    assert.throws(() => createInfoRoute({}), /getPort/);
    assert.throws(() => createInfoRoute({ getPort: 3000 }), /getPort/);
  });

  await t.test("端口是现问的 —— 递增过的端口必须反映出来", async () => {
    const dir = { port: 3000 };
    const route = createInfoRoute({
      getPort: () => dir.port,
      interfaces: fakeInterfaces(),
      clock: () => 999,
      logger: { error() {} },
    });
    const started = await serve(t, { routes: { "/api/info": route } });

    const first = await request(started.url, "/api/info");
    assert.equal(JSON.parse(first.body).port, 3000);

    // 模拟 3000 被占用后递增到 3007
    dir.port = 3007;
    const second = await request(started.url, "/api/info");
    assert.equal(JSON.parse(second.body).best.studentUrl, "http://10.109.12.63:3007/m");
  });

  await t.test("Content-Type 与 Content-Length 按字节算（警告里有中文）", async () => {
    const started = await serve(t, {
      routes: {
        "/api/info": createInfoRoute({
          getPort: () => 3000,
          interfaces: fakeInterfaces(),
          logger: { error() {} },
        }),
      },
    });
    const res = await request(started.url, "/api/info");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^application\/json/);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(Number(res.headers["content-length"]), Buffer.byteLength(res.body, "utf8"));
  });

  await t.test("探测失败返回 500 而不是把服务带崩", async () => {
    const started = await serve(t, {
      routes: {
        "/api/info": createInfoRoute({
          getPort: () => {
            throw new Error("网卡查询炸了");
          },
          logger: { error() {} },
        }),
      },
    });
    const res = await request(started.url, "/api/info");
    assert.equal(res.status, 500);
    assert.match(res.body, /地址探测失败/);
    // 服务还活着
    const again = await request(started.url, "/api/info");
    assert.equal(again.status, 500);
  });

  await t.test("getExtraWarnings：防火墙没放行时那句话要出现在 warnings 里", async () => {
    // 现场故障：老师扫了码、手机一直转圈，因为便携版每次解压到新的随机临时目录，
    // 防火墙按程序路径放行的那条规则下一次启动就失效了。二维码本身是对的，
    // 唯一能提醒老师的地方就是这里。
    const warnings = ["防火墙没有放行本程序（当前网络配置：Public），学生连不上"];
    const started = await serve(t, {
      routes: {
        "/api/info": createInfoRoute({
          getPort: () => 3000,
          interfaces: fakeInterfaces(),
          getExtraWarnings: () => warnings,
          logger: { error() {} },
        }),
      },
    });
    const res = await request(started.url, "/api/info");
    const info = JSON.parse(res.body);
    // 网卡自己的警告要留着，额外的那条要接在后面
    assert.equal(info.warnings.at(-1), warnings[0]);
  });

  await t.test("getExtraWarnings：每次请求现问，不缓存", async () => {
    // 自检是启动后异步跑的，老师打开老师端时它可能还没回来 ——
    // 缓存住空数组就等于永远不提醒。
    const box = { warnings: [] };
    const started = await serve(t, {
      routes: {
        "/api/info": createInfoRoute({
          getPort: () => 3000,
          interfaces: fakeInterfaces(),
          getExtraWarnings: () => box.warnings,
          logger: { error() {} },
        }),
      },
    });
    const before = JSON.parse((await request(started.url, "/api/info")).body).warnings;
    assert.ok(!before.includes("防火墙没放行"));
    box.warnings = ["防火墙没放行"];
    const after = JSON.parse((await request(started.url, "/api/info")).body).warnings;
    assert.equal(after.at(-1), "防火墙没放行");
  });

  await t.test("只认 GET，别的动词 405", async () => {
    const started = await serve(t, {
      routes: {
        "/api/info": createInfoRoute({
          getPort: () => 3000,
          interfaces: fakeInterfaces(),
          logger: { error() {} },
        }),
      },
    });
    const res = await request(started.url, "/api/info", { method: "POST" });
    assert.equal(res.status, 405);
  });
});
