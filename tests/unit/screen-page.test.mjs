/**
 * 投影页（/screen）跑在 DOM 桩里的集成测试。
 *
 * 这一组盯的是**投影不能出错**的那几件事：
 *   1. 它必须一句话都不发（它只收不发的角色才能保证 §4.4 的那条红线）；
 *   2. 老师按「清屏」时它必须立刻空掉，但**暂停/静音/有人上下线时不能清**；
 *   3. 断线要在投影上写出来 —— 老师站在讲台上除了投影什么都看不到。
 *
 * 第 2 条是最容易写错的一条：`state` 消息会因为很多种原因发过来，
 * 图省事写成"收到 state 就清屏"的话，表现是"教室里明明有人在发弹幕，
 * 投影上却总是空的"，而且现场根本不可能查出来。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FakeSocket,
  installWebSocket,
  loadPageScript,
  readPage,
  runFrame,
} from "../helpers/dom.mjs";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const PAGE = join(SRC, "web", "screen");

/** 把投影页跑起来。`search` 用来试 `?diag` / `?mode=overlay`。 */
async function boot(search = "?diag") {
  const { elements } = readPage(join(PAGE, "index.html"), { search });
  installWebSocket();
  await loadPageScript(pathToFileURL(join(PAGE, "screen.js")));
  const socket = FakeSocket.instances.at(-1);
  socket.connect();
  return { els: elements, socket };
}

/** 服务端广播给投影的那份形状：**没有任何身份字段**（§4.4）。 */
function danmaku(overrides = {}) {
  return {
    id: "d1",
    text: "这里没听懂",
    nickname: "小明",
    color: "#ffe066",
    presetId: "not_understood",
    ts: 1000,
    ...overrides,
  };
}

/** 推一帧并越过 HUD 的刷新间隔，让角标上显示当前的真实数量。 */
const tick = () => runFrame(300);

test("投影页：以只收不发的角色加入", async () => {
  const { socket } = await boot();
  const join = socket.lastSent("join");
  assert.equal(join.payload.role, "screen", "浏览器里的降级形态是 screen（§4.1 的 L2）");
  assert.equal(join.payload.classId, "default");
  assert.equal(join.payload.identity, undefined, "投影不该带任何身份信息");
});

test("投影页：接了 mode=overlay 就以 overlay 身份连（给透明窗口用）", async () => {
  const { socket } = await boot("?mode=overlay");
  assert.equal(socket.lastSent("join").payload.role, "overlay");
});

// ------------------------------------------------- 透明窗口（§4.1 的 L0）

test("投影页：mode=overlay 的开关加在 <html> 上，不是 <body> 上", async () => {
  /*
   * 这一条是"全屏黑板"事故的回归钉子。
   *
   * 窗口是不是真的透明，取决于**画布**的底色，而画布的底色由 `html` 决定：
   * `body` 的 background 只在 `html` 没有 background 时才往上传播。
   * `screen.css` 里 `html, body` 合并写了 `background: #0b0d12`，
   * 于是 `body.mode-overlay { background: transparent }` 一点用都没有，
   * 整块屏被涂成不透明的深色 —— 而启动探测测的是另一份探测页的 CSS，
   * 一路报告"透明浮层可用"。
   */
  await boot("?mode=overlay");
  assert.ok(
    globalThis.document.documentElement.classList.contains("mode-overlay"),
    "mode-overlay 没加在 <html> 上，透明窗口会变成一块全屏黑板",
  );
  assert.ok(
    !globalThis.document.body.classList.contains("mode-overlay"),
    "只加在 body 上是不够的：html 那层底色还在，照样会盖住 PPT",
  );
});

test("投影页：不带 mode=overlay 时 <html> 上不能有这个类（浏览器全屏形态要正常底色）", async () => {
  await boot("?diag");
  assert.ok(!globalThis.document.documentElement.classList.contains("mode-overlay"));
});

test("screen.css：底色只写在 html 上，overlay 模式由 html 自己让开", () => {
  const css = readFileSync(join(PAGE, "screen.css"), "utf8");

  // 1) `html, body` 合并的那条规则里不能出现 background —— 一旦出现，
  //    它就是画布底色，body 上的 mode-overlay 再怎么透明都没用。
  const shared = css.match(/html\s*,\s*body\s*\{[^}]*\}/);
  assert.ok(shared, "没找到 html, body 的公共规则");
  assert.ok(!/background/.test(shared[0]), "html, body 合并规则里不能写 background");

  // 2) overlay 模式的透明必须落在 html 上
  assert.match(css, /html\.mode-overlay[^{]*\{[^}]*background:\s*transparent/);

  // 3) 非 overlay 时画布得有底色，不然投影上是浏览器默认的白底
  assert.match(css, /html\s*\{[^}]*background:\s*#0b0d12/);
});

test("投影页：收到弹幕就画出来", async () => {
  const { els, socket } = await boot();
  tick();
  assert.equal(els.get("hud-active").textContent, "0");

  socket.deliver({ event: "danmaku:new", payload: danmaku() });
  tick();
  assert.equal(els.get("hud-active").textContent, "1", "弹幕没进引擎");

  // 同一个预置项的第二次点击不再新建一条，只涨计数（§4.6）
  socket.deliver({ event: "danmaku:update", payload: { id: "d1", aggregate: 23 } });
  tick();
  assert.equal(els.get("hud-active").textContent, "1", "聚合计数不该在屏幕上多出一条");
});

test("投影页：置顶的钉在顶上，删除之后两条都消失", async () => {
  const { els, socket } = await boot();
  socket.deliver({ event: "danmaku:new", payload: danmaku() });
  socket.deliver({
    event: "danmaku:pin",
    payload: { ...danmaku(), pinned: true },
  });
  tick();
  assert.equal(els.get("hud-pinned").textContent, "1");
  assert.equal(els.get("hud-active").textContent, "0", "钉上去的就不该还在滚动流里");

  socket.deliver({ event: "danmaku:pin", payload: { id: "d1", pinned: false } });
  tick();
  assert.equal(els.get("hud-pinned").textContent, "0");

  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "d2" }) });
  tick();
  socket.deliver({ event: "danmaku:remove", payload: { id: "d2", reason: "host" } });
  tick();
  assert.equal(els.get("hud-active").textContent, "0", "老师撤回的弹幕必须从投影上消失");
});

test("投影页：老师清屏时立刻空掉，但暂停和静音不清屏", async () => {
  const { els, socket } = await boot();
  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "d1" }) });
  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "d2", text: "再讲一遍" }) });
  tick();
  assert.equal(els.get("hud-active").textContent, "2");

  // 暂停：state 里 clearedAt 是 0（和本地一致），**不能**顺手清屏
  socket.deliver({
    event: "state",
    payload: { paused: true, mutedUntil: 0, clearedAt: 0, online: 7, danmakuCount: 2 },
  });
  tick();
  assert.equal(
    els.get("hud-active").textContent,
    "2",
    "暂停时清屏的话，表现就是「学生一直在发，投影却总是空的」",
  );
  assert.equal(els.get("status").hidden, false);
  assert.match(els.get("status-text").textContent, /暂停/);

  // 真的清屏：clearedAt 变了
  socket.deliver({
    event: "state",
    payload: { paused: false, mutedUntil: 0, clearedAt: 1780000000000, online: 7, danmakuCount: 2 },
  });
  tick();
  assert.equal(els.get("hud-active").textContent, "0", "老师按了清屏，投影上必须立刻没了");

  // 同一个 clearedAt 又来一遍（比如有人上下线），不能把新弹幕再清一次
  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "d3", text: "新的一条" }) });
  tick();
  socket.deliver({
    event: "state",
    payload: { paused: false, mutedUntil: 0, clearedAt: 1780000000000, online: 8, danmakuCount: 3 },
  });
  tick();
  assert.equal(els.get("hud-active").textContent, "1", "同一个 clearedAt 不该反复清屏");
});

test("投影页：清屏不清掉老师钉住的那条", async () => {
  const { els, socket } = await boot();
  socket.deliver({ event: "danmaku:new", payload: danmaku() });
  socket.deliver({ event: "danmaku:pin", payload: { ...danmaku(), pinned: true } });
  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "d2", text: "再讲一遍" }) });
  tick();

  socket.deliver({
    event: "state",
    payload: { paused: false, mutedUntil: 0, clearedAt: 1780000000001, online: 7, danmakuCount: 2 },
  });
  tick();
  assert.equal(els.get("hud-active").textContent, "0");
  assert.equal(els.get("hud-pinned").textContent, "1", "清屏顺手抹掉置顶等于废掉老师刚才的操作");
});

test("投影页：静音和断线都写在投影上（老师只看得到投影）", async () => {
  const { els, socket } = await boot();
  assert.equal(els.get("status").hidden, true, "一切正常时投影上不该有任何字");

  socket.deliver({
    event: "state",
    payload: {
      paused: false,
      mutedUntil: Date.now() + 60_000,
      clearedAt: 0,
      online: 7,
      danmakuCount: 2,
    },
  });
  tick();
  assert.equal(els.get("status").hidden, false);
  assert.match(els.get("status-text").textContent, /静音/);
  assert.equal(els.get("status").dataset.tone, "calm", "静音是老师自己按的，不是故障");

  socket.close();
  tick();
  assert.match(els.get("status-text").textContent, /重连/);
  assert.equal(els.get("status").dataset.tone, "alert", "断线是故障，要显眼");
});

test("投影页：服务端下发的参数会作用到引擎上", async () => {
  const { els, socket } = await boot();
  socket.deliver({
    event: "config",
    payload: { duration: 20, fontSize: 36, alpha: 0.5, maxDensity: 30, laneGap: 2 },
  });
  tick();
  // 字号变大会让轨道变少：这是参数真的传进引擎了的证据
  const lanes = Number(els.get("hud-lanes").textContent);
  assert.ok(lanes > 0 && lanes < 23, `轨道数应该是缩小后的，实际 ${lanes}`);

  // 非法参数不能让引擎拿到 NaN —— 那样画布上是"一片空白但控制台干净"
  socket.deliver({ event: "config", payload: { fontSize: "abc", duration: null } });
  tick();
  assert.equal(Number(els.get("hud-lanes").textContent), lanes, "坏参数必须被丢回默认值");
});

test("投影页：重连时清空本地重建（§4.3.2）", async () => {
  const { els, socket } = await boot();
  socket.deliver({ event: "danmaku:new", payload: danmaku() });
  socket.deliver({ event: "danmaku:pin", payload: { ...danmaku(), pinned: true } });
  tick();
  assert.equal(els.get("hud-pinned").textContent, "1");

  // 服务端会先推 state 再推 config，最后把还钉着的重发一遍
  socket.deliver({ event: "state", payload: { paused: false, mutedUntil: 0, clearedAt: 0 } });
  socket.deliver({ event: "danmaku:new", payload: danmaku() });
  socket.deliver({ event: "danmaku:pin", payload: { ...danmaku(), pinned: true } });
  tick();
  assert.equal(els.get("hud-pinned").textContent, "1", "重发之后仍然是那一条，不能变成两条");
});
