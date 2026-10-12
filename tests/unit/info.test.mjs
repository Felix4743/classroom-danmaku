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
