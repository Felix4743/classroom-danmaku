/**
 * 老师端页面（/host）跑在 DOM 桩里的集成测试。
 *
 * 这一组存在的理由很具体：`client.js` 的单元测试全绿、静态检查也全绿，
 * 但页面曾经因为 `onEvent` 的参数形状看错（当成 `(event, payload)`，
 * 实际是整条 `{event, payload}`）而**列表永远空着、状态却显示"已连上"**。
 * 那种 bug 只有把页面真的跑起来、往里灌消息才能发现。
 */

import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FakeSocket,
  installWebSocket,
  loadPageScript,
  readPage,
} from "../helpers/dom.mjs";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const PAGE = join(SRC, "web", "host");

/** 把页面跑起来，返回元素表与那条连接。 */
async function boot() {
  const { elements } = readPage(join(PAGE, "index.html"));
  installWebSocket();
  await loadPageScript(pathToFileURL(join(PAGE, "host.js")));
  const socket = FakeSocket.instances.at(-1);
  socket.connect();
  return { els: elements, socket };
}

/** 发一条完整的弹幕给页面（服务端发的那份形状：带 deviceId）。 */
function danmaku(overrides = {}) {
  return {
    id: "d1",
    text: "这里没听懂",
    nickname: "小明",
    color: "#ffe066",
    presetId: "not_understood",
    ts: 1000,
    deviceId: "dev-1",
    likes: 0,
    aggregate: 0,
    pinned: false,
    resolved: false,
    ...overrides,
  };
}

const rows = (els, listId) => els.get(listId).children;
const buttonsOf = (row) => row.all().filter((el) => el.tagName === "BUTTON");
const buttonNamed = (row, label) =>
  buttonsOf(row).find((button) => button.textContent === label);

test("老师端：连上就以老师身份加入", async () => {
  const { socket } = await boot();
  const join = socket.lastSent("join");
  assert.equal(join.payload.role, "host");
  assert.equal(join.payload.classId, "default");
});

test("老师端：收到弹幕就进问题池，徽章跟着动", async () => {
  const { els, socket } = await boot();

  socket.deliver({ event: "danmaku:new", payload: danmaku() });
  assert.equal(rows(els, "pool").length, 1, "弹幕没进问题池");
  assert.equal(els.get("badge-count").textContent, "1");
  // 提醒器上写着弹幕正文，老师扫一眼就知道是什么事
  assert.match(rows(els, "pool")[0].text(), /这里没听懂/);

  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "d2", text: "再讲一遍" }) });
  assert.equal(rows(els, "pool").length, 2);
  assert.equal(els.get("badge-count").textContent, "2");
  assert.equal(els.get("badge").dataset.level, "some");
});

test("老师端：点赞和聚合都显示在同一条上", async () => {
  const { els, socket } = await boot();
  socket.deliver({ event: "danmaku:new", payload: danmaku() });
  socket.deliver({ event: "danmaku:update", payload: { id: "d1", likes: 4 } });
  socket.deliver({ event: "danmaku:update", payload: { id: "d1", aggregate: 23 } });

  const text = rows(els, "pool")[0].text();
  assert.match(text, /👍 4/);
  assert.match(text, /同样的 ×23/);
});

test("老师端：按点赞加聚合排序，置顶的永远在最上面", async () => {
  const { els, socket } = await boot();
  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "low", text: "冷门问题" }) });
  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "hot", text: "热门问题" }) });
  socket.deliver({ event: "danmaku:update", payload: { id: "hot", likes: 9 } });

  assert.match(rows(els, "pool")[0].text(), /热门问题/, "点赞多的应该排前面");

  // 置顶的是"冷门"那条，它必须被顶到最上面 —— 那是老师自己选的，
  // 不能被排序算法挤下去
  socket.deliver({ event: "danmaku:pin", payload: { id: "low", pinned: true } });
  assert.match(rows(els, "pool")[0].text(), /冷门问题/);
});

test("老师端：已回应的沉到底部单独一栏", async () => {
  const { els, socket } = await boot();
  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "d1" }) });
  socket.deliver({ event: "danmaku:resolved:fake", payload: {} }); // 不认识的事件不能炸
  socket.deliver({ event: "danmaku:update", payload: { id: "d1", resolved: true } });

  assert.equal(rows(els, "pool").length, 0);
  assert.equal(rows(els, "done").length, 1);
  assert.equal(els.get("done-title").hidden, false);
  assert.equal(els.get("badge-count").textContent, "0", "回应过的不该还算待回应");
});

test("老师端：删掉的弹幕从列表里消失", async () => {
  const { els, socket } = await boot();
  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "d1" }) });
  socket.deliver({ event: "danmaku:remove", payload: { id: "d1", reason: "host" } });

  assert.equal(rows(els, "pool").length, 0);
  assert.equal(els.get("badge-count").textContent, "0");
});

test("老师端：提醒到达时闪一下并震动（§4.6）", async () => {
  const { els, socket } = await boot();
  let vibrated = 0;
  globalThis.navigator.vibrate = () => {
    vibrated += 1;
    return true;
  };

  socket.deliver({
    event: "host:alert",
    payload: { id: "d1", reason: "没听懂", aggregate: 5 },
  });

  assert.equal(vibrated, 1, "提醒的核心是震动，不是屏幕上的字");
  assert.equal(els.get("alerter-flash").hidden, false);
  assert.match(els.get("alerter-flash").textContent, /没听懂 ×5/);
  assert.equal(els.get("badge").dataset.flash, "true");
});

test("老师端：四个大按钮各发一条对得上的指令", async () => {
  const { els, socket } = await boot();
  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "d1" }) });

  els.get("clear").click();
  assert.ok(socket.lastSent("host:clear"), "清屏没发出去");

  els.get("pause").click();
  assert.deepEqual(socket.lastSent("host:pause").payload, { paused: true });

  els.get("mute").click();
  assert.deepEqual(socket.lastSent("host:mute").payload, { minutes: 5 });

  // 「置顶最热」指的是问题池里排第一的那条
  els.get("pin-hottest").click();
  const pin = socket.lastSent("host:pin");
  assert.equal(pin.payload.id, "d1");
  assert.equal(pin.payload.pinned, true);
});

test("老师端：暂停之后按钮自己变成「继续」", async () => {
  const { els, socket } = await boot();
  socket.deliver({
    event: "state",
    payload: { paused: true, mutedUntil: 0, clearedAt: 0, online: 7, danmakuCount: 12 },
  });
  assert.equal(els.get("pause").textContent, "继续");
  assert.match(els.get("stats").textContent, /在线 7 · 弹幕 12/);
});

test("老师端：身份只有点「看身份」才会出现（§4.9）", async () => {
  const { els, socket } = await boot();
  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "d1" }) });

  // 默认列表上不该有任何身份线索，哪怕服务端把 deviceId 发过来了
  assert.doesNotMatch(rows(els, "pool")[0].text(), /20230001/);
  assert.doesNotMatch(rows(els, "pool")[0].text(), /王小明/);

  buttonNamed(rows(els, "pool")[0], "看身份").click();
  assert.deepEqual(socket.lastSent("host:fetchIdentity").payload, { id: "d1" });

  socket.deliver({
    event: "host:identity",
    payload: { id: "d1", studentId: "20230001", name: "王小明" },
  });
  const text = rows(els, "pool")[0].text();
  assert.match(text, /学号 20230001/);
  assert.match(text, /姓名 王小明/);
});

test("老师端：拉黑要问到人，且问一次就够", async () => {
  const { els, socket } = await boot();
  socket.deliver({ event: "danmaku:new", payload: danmaku({ id: "d1", deviceId: "dev-1" }) });

  buttonNamed(rows(els, "pool")[0], "拉黑").click();
  assert.deepEqual(socket.lastSent("host:ban").payload, { deviceId: "dev-1", banned: true });
});

test("老师端：改参数立刻下发，但显示以服务端回的为准", async () => {
  const { els, socket } = await boot();

  const duration = els.get("sliders").children[0];
  const input = duration.children[1];
  input.value = "20";
  input.fire("input");

  assert.equal(socket.lastSent("host:config").payload.duration, 20);

  // 服务端夹紧到合法范围之后回过来，界面要跟着服务端走
  socket.deliver({
    event: "config",
    payload: { duration: 4, fontSize: 28, alpha: 0.9, maxDensity: 60, laneGap: 1.6 },
  });
  assert.equal(input.value, "4");
});

test("老师端：导出还没接上时，把服务端的话原样告诉老师", async () => {
  const { els, socket } = await boot();
  els.get("export").click();
  assert.ok(socket.lastSent("host:export"));

  socket.deliver({
    event: "error",
    payload: { code: "not_ready", message: "导出功能还没接上" },
  });
  assert.equal(els.get("banner").hidden, false);
  assert.match(els.get("banner").textContent, /导出功能还没接上/);
});
