import assert from "node:assert/strict";
import test from "node:test";
import { createSession, MAX_PINNED, REPLAY_LIMIT } from "../../src/main/server/session.js";
import { createRateLimiter } from "../../src/main/server/ratelimit.js";
import { BROADCAST_THROTTLE_MS } from "../../src/main/server/aggregate.js";
import { DEFAULT_CONFIG } from "../../src/shared/config.js";
import {
  C2S,
  ERROR_CODE,
  REJECT,
  ROLE,
  ROOM,
  S2C,
  findIdentityLeak,
} from "../../src/shared/protocol.js";

/** 可控时钟。限流的最小间隔是 3 秒，用真实时间跑测试会慢得没法看。 */
function makeClock(start = 1_000_000) {
  let value = start;
  const now = () => value;
  now.set = (next) => {
    value = next;
  };
  now.advance = (ms) => {
    value += ms;
  };
  return now;
}

function makeSession(options = {}) {
  const clock = options.clock ?? makeClock();
  const session = createSession({ clock, logger: { warn() {}, error() {} }, ...options, clock });
  return { session, clock };
}

function joinAs(session, clientId, role, extra = {}) {
  return session.join({
    clientId,
    role,
    classId: "class-1",
    ts: 1_000_000,
    ...extra,
  });
}

function joinStudent(session, clientId, extra = {}) {
  const actions = joinAs(session, clientId, ROLE.STUDENT, extra);
  const joined = actions.find((a) => a.event === S2C.JOINED);
  return { actions, deviceId: joined.payload.deviceId };
}

/** 走一遍完整的"发一条弹幕"：入队 + 跑一轮队列。 */
function send(session, clientId, payload, ts) {
  session.receive(clientId, C2S.SEND, payload, ts);
  return session.drain(ts);
}

const room = (actions, name) => actions.filter((a) => a.room === name);
const event = (actions, name) => actions.filter((a) => a.event === name);

test("join：下发 deviceId、配置与状态", async (t) => {
  await t.test("学生 join 拿到 joined + state，老师房间收到在线数变化", () => {
    const { session } = makeSession();
    const { actions } = joinStudent(session, "c1", { nickname: "小明" });

    const joined = actions.find((a) => a.event === S2C.JOINED);
    assert.match(joined.payload.deviceId, /^[0-9a-f-]{36}$/, "deviceId 该是服务端发的 UUID");
    assert.equal(joined.payload.serverTime, 1_000_000);
    assert.deepEqual(joined.payload.config, session.config);
    assert.equal(joined.payload.online, 1);

    // §4.3.2：joined 之后必须跟一份全量 state，客户端据此重建本地队列
    const state = actions.find((a) => a.event === S2C.STATE && a.room === "c1");
    assert.equal(state.payload.online, 1);
    assert.equal(state.payload.paused, false);

    assert.equal(room(actions, ROOM.HOST).length, 1, "老师要知道在线人数变了");
  });

  await t.test("重连带上原 deviceId 会复用，不会变成新设备", () => {
    const { session } = makeSession();
    const first = joinStudent(session, "c1", { nickname: "小明" });
    session.leave("c1");
    const second = joinStudent(session, "c2", { deviceId: first.deviceId });

    const joined = second.actions.find((a) => a.event === S2C.JOINED);
    assert.equal(joined.payload.deviceId, first.deviceId, "重连必须还是同一个人，否则限流追不住");
    assert.equal(session.devices.size, 1);
  });

  await t.test("同一台设备开两个页面只算一个人在线", () => {
    const { session } = makeSession();
    const { deviceId } = joinStudent(session, "c1");
    joinStudent(session, "c2", { deviceId });
    assert.equal(session.state().online, 1);
  });

  await t.test("老师的 joined 里没有身份字段，但补发了历史弹幕", () => {
    const { session } = makeSession();
    const { deviceId } = joinStudent(session, "c1", {
      nickname: "小明",
      identity: { studentId: "20230001", name: "王小明" },
    });
    send(session, "c1", { text: "没听懂", presetId: "not_understood" }, 1_000_000);

    const actions = joinAs(session, "h1", ROLE.HOST);
    const replayed = event(actions, S2C.NEW);
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].payload.deviceId, deviceId, "老师这条可以带 deviceId");
    assert.equal(replayed[0].payload.likes, 0);
    assert.equal(findIdentityLeak(replayed[0].payload).includes("$.deviceId"), true);
    assert.equal(
      findIdentityLeak(actions.find((a) => a.event === S2C.JOINED).payload).length,
      1,
      "joined 里的 deviceId 是连接自己的，不是别人的身份",
    );
  });

  await t.test("被拉黑的人 join 直接被挡住，且不会进入在线名单", () => {
    const { session } = makeSession();
    const { deviceId } = joinStudent(session, "c1");
    session.leave("c1");
    // 老师得先 join 才能用 host 指令 —— 没 join 的连接连门禁都过不去
    joinAs(session, "h1", ROLE.HOST);
    session.receive("h1", C2S.HOST_BAN, { deviceId }, 1_000_000);
    session.drain(1_000_000);

    const actions = joinAs(session, "c2", ROLE.STUDENT, { deviceId });
    const err = actions.find((a) => a.event === S2C.ERROR);
    assert.equal(err.payload.code, ERROR_CODE.BANNED);
    assert.equal(actions.some((a) => a.event === S2C.JOINED), false);
    assert.equal(session.state().online, 0);
  });

  await t.test("没 join 就发消息会被提醒", () => {
    const { session } = makeSession();
    const actions = session.receive("c1", C2S.SEND, { text: "喂" }, 1_000_000);
    assert.equal(actions[0].event, S2C.ERROR);
    assert.equal(actions[0].payload.code, ERROR_CODE.NOT_JOINED);
  });
});

test("发弹幕", async (t) => {
  await t.test("一条弹幕产生三份出站消息：公共、自己、老师", () => {
    const { session } = makeSession();
    joinStudent(session, "c1", { nickname: "小明" });
    const actions = send(session, "c1", { text: "举个栗子", tempId: "t1" }, 1_000_000);

    const toPublic = room(actions, ROOM.PUBLIC).find((a) => a.event === S2C.NEW);
    assert.equal(toPublic.payload.text, "举个栗子");
    assert.equal(toPublic.except, "c1", "自己那份要单独发，好带上 tempId");
    assert.deepEqual(
      Object.keys(toPublic.payload).sort(),
      ["color", "id", "nickname", "presetId", "text", "ts"],
    );

    const toSelf = actions.find((a) => a.room === "c1" && a.event === S2C.NEW);
    assert.equal(toSelf.payload.tempId, "t1");

    const toHost = room(actions, ROOM.HOST).find((a) => a.event === S2C.NEW);
    assert.equal(toHost.payload.deviceId, session.devices.keys().next().value);
  });

  await t.test("没有昵称时显示匿名同学", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    const actions = send(session, "c1", { text: "在" }, 1_000_000);
    assert.equal(room(actions, ROOM.PUBLIC)[0].payload.nickname, "匿名同学");
  });

  await t.test("被屏蔽词拦下的内容只告诉发的人，一条都不广播", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    const actions = send(session, "c1", { text: "加微信 私聊", tempId: "t1" }, 1_000_000);

    assert.deepEqual(actions, [
      { room: "c1", event: S2C.REJECTED, payload: { tempId: "t1", reason: REJECT.FILTERED } },
    ]);
    assert.equal(session.itemCount, 0);
    assert.equal(session.stats().filtered, 1);
  });

  await t.test("发太快会被限流，提示里带倒计时", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    send(session, "c1", { text: "第一条" }, 1_000_000);
    const actions = send(session, "c1", { text: "第二条" }, 1_001_000);

    const limited = actions.find((a) => a.event === S2C.RATE_LIMITED);
    assert.equal(limited.room, "c1");
    assert.equal(limited.payload.retryAfterMs, 2000);
    assert.match(limited.payload.message, /2 秒后再试/);
    assert.equal(session.itemCount, 1);
  });

  await t.test("等够最小间隔就又能发了", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    send(session, "c1", { text: "第一条" }, 1_000_000);
    send(session, "c1", { text: "第二条" }, 1_003_000);
    assert.equal(session.itemCount, 2);
  });

  await t.test("overlay 和老师都没有发言权", () => {
    const { session } = makeSession();
    joinAs(session, "o1", ROLE.OVERLAY);
    session.receive("o1", C2S.SEND, { text: "我是投影" }, 1_000_000);
    session.drain(1_000_000);
    assert.equal(session.itemCount, 0);
  });
});

test("聚合计数（§4.6）", async (t) => {
  await t.test("同一个预置按钮在窗口内累加，第一条立刻可见", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    joinStudent(session, "c2");
    const first = send(session, "c1", { text: "没听懂", presetId: "not_understood" }, 1_000_000);
    // 第一次命中不走 200ms 节流
    const update = first.find((a) => a.event === S2C.UPDATE && a.room === ROOM.PUBLIC);
    assert.equal(update.payload.aggregate, 1);

    const second = send(session, "c2", { text: "没听懂", presetId: "not_understood" }, 1_000_100);
    assert.equal(second.some((a) => a.event === S2C.UPDATE), false, "200ms 内不该重复广播");

    // 攒着的计数不会丢，过了节流窗口的下一次排空就发出去
    const flushed = session.drain(1_000_100 + BROADCAST_THROTTLE_MS);
    const late = flushed.find((a) => a.event === S2C.UPDATE && a.room === ROOM.PUBLIC);
    assert.equal(late.payload.aggregate, 2);
  });

  await t.test("跨过 5/10 档时提醒老师一次，同一条只提醒一次", () => {
    const { session } = makeSession();
    const ids = [];
    for (let i = 0; i < 6; i += 1) {
      const clientId = `c${i}`;
      joinStudent(session, clientId);
      ids.push(clientId);
    }
    let alerts = 0;
    for (let i = 0; i < 6; i += 1) {
      const actions = send(session, ids[i], { text: "没听懂", presetId: "not_understood" }, 1_000_000 + i);
      alerts += event(actions, S2C.HOST_ALERT).length;
    }
    assert.equal(alerts, 1, "只在跨过 5 的那一条上提醒");
  });

  await t.test("自由打字不参与聚合 —— 文本两两不同，统计不出'23 个人都点了'", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    const actions = send(session, "c1", { text: "这里我没听懂" }, 1_000_000);
    assert.equal(actions.some((a) => a.event === S2C.UPDATE), false);
  });

  await t.test("窗口内第二次点击不再新建弹幕，只加数字", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    joinStudent(session, "c2");
    const first = send(session, "c1", { text: "没听懂", presetId: "not_understood" }, 1_000_000);
    const itemId = room(first, ROOM.PUBLIC).find((a) => a.event === S2C.NEW).payload.id;

    const second = send(
      session,
      "c2",
      { text: "没听懂", presetId: "not_understood", tempId: "t-2" },
      1_000_100,
    );

    // 这一条是整个聚合机制存在的理由：屏幕上是一条「没听懂 ×2」，
    // 不是两条一模一样的弹幕各顶着同一个数字
    assert.equal(session.itemCount, 1, "屏幕上只该有一条「没听懂」");
    assert.equal(
      room(second, ROOM.PUBLIC).some((a) => a.event === S2C.NEW),
      false,
      "不该再往公共流里塞一条新弹幕",
    );

    // 但点的人自己要收到回应，否则他会以为没点上；这份回显指向屏幕上真实的那一条
    const echo = event(room(second, "c2"), S2C.NEW);
    assert.equal(echo.length, 1);
    assert.equal(echo[0].payload.id, itemId);
    assert.equal(echo[0].payload.tempId, "t-2", "回显必须带上学生自己那个 tempId");
  });

  await t.test("31 个人同时点，广播只有几次而不是 31 次", () => {
    const { session } = makeSession();
    const ids = [];
    for (let i = 0; i < 31; i += 1) {
      const clientId = `c${i}`;
      joinStudent(session, clientId);
      ids.push(clientId);
    }

    let updates = 0;
    for (const clientId of ids) {
      const actions = send(session, clientId, { text: "没听懂", presetId: "not_understood" }, 1_000_000);
      updates += room(actions, ROOM.PUBLIC).filter((a) => a.event === S2C.UPDATE).length;
    }
    // 同一时刻的 31 次点击全被节流压住，等过了 200ms 才合成一次广播
    assert.equal(updates, 1, "第一条立刻可见的那次之外，同一时刻不该再有广播");
    updates += room(session.drain(1_000_000 + BROADCAST_THROTTLE_MS), ROOM.PUBLIC).filter(
      (a) => a.event === S2C.UPDATE,
    ).length;

    assert.equal(session.itemCount, 1, "31 个人点的是同一条弹幕");
    assert.equal(updates, 2, "31 次点击只该产生两次计数广播：第一次立刻可见，之后合并成一次");
  });

  await t.test("聚合的那条被老师删掉之后，后面的点击退化成一条新弹幕", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    joinStudent(session, "c2");
    joinAs(session, "h1", ROLE.HOST);

    const first = send(session, "c1", { text: "没听懂", presetId: "not_understood" }, 1_000_000);
    const itemId = room(first, ROOM.PUBLIC).find((a) => a.event === S2C.NEW).payload.id;
    session.receive("h1", C2S.HOST_REMOVE, { id: itemId }, 1_000_050);
    session.drain(1_000_050);

    const again = send(session, "c2", { text: "没听懂", presetId: "not_understood" }, 1_000_100);
    // 宁可多一条弹幕，也不能让学生点了按钮却什么都没发生
    assert.equal(
      room(again, ROOM.PUBLIC).some((a) => a.event === S2C.NEW),
      true,
      "目标弹幕已经不在屏幕上了，就该老老实实新建一条",
    );
  });

  await t.test("老师清屏之后聚合计数重新开始", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    joinStudent(session, "c2");
    joinAs(session, "h1", ROLE.HOST);

    send(session, "c1", { text: "没听懂", presetId: "not_understood" }, 1_000_000);
    session.receive("h1", C2S.HOST_CLEAR, {}, 1_000_050);
    session.drain(1_000_050);

    const again = send(session, "c2", { text: "没听懂", presetId: "not_understood" }, 1_000_100);
    const update = room(again, ROOM.PUBLIC).find((a) => a.event === S2C.UPDATE);
    assert.equal(update.payload.aggregate, 1, "屏幕上已经没有那条 ×1 了，新一轮从 1 开始数");
  });
});

test("点赞（§4.7）", async (t) => {
  await t.test("同一台设备只算一次，重复点是幂等的", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    const actions = send(session, "c1", { text: "能举个例子吗" }, 1_000_000);
    const id = actions.find((a) => a.event === S2C.NEW && a.room === ROOM.PUBLIC).payload.id;

    session.receive("c1", C2S.LIKE, { id }, 1_000_000);
    const first = session.drain(1_000_000);
    assert.equal(first.find((a) => a.event === S2C.UPDATE).payload.likes, 1);

    session.receive("c1", C2S.LIKE, { id }, 1_000_000);
    assert.deepEqual(session.drain(1_000_000), [], "重复点赞不该再广播");
  });

  await t.test("两台设备各算一次", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    joinStudent(session, "c2");
    const actions = send(session, "c1", { text: "能举个例子吗" }, 1_000_000);
    const id = actions.find((a) => a.event === S2C.NEW && a.room === ROOM.PUBLIC).payload.id;
    session.receive("c2", C2S.LIKE, { id }, 1_000_000);
    const out = session.drain(1_000_000);
    assert.equal(out.find((a) => a.event === S2C.UPDATE).payload.likes, 1);
  });

  await t.test("点一条已经被删掉的弹幕，静默忽略而不是报错", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    const actions = send(session, "c1", { text: "在" }, 1_000_000);
    const id = actions.find((a) => a.event === S2C.NEW && a.room === ROOM.PUBLIC).payload.id;
    session.receive("c1", C2S.LIKE, { id: "does-not-exist" }, 1_000_000);
    assert.deepEqual(session.drain(1_000_000), []);
  });
});

test("老师管控", async (t) => {
  function setup() {
    const { session, clock } = makeSession();
    joinAs(session, "h1", ROLE.HOST);
    joinStudent(session, "c1");
    const actions = send(session, "c1", { text: "这里没听懂" }, 1_000_000);
    const id = actions.find((a) => a.event === S2C.NEW && a.room === ROOM.PUBLIC).payload.id;
    return { session, clock, id };
  }

  await t.test("暂停/继续广播给所有人", () => {
    const { session } = setup();
    session.receive("h1", C2S.HOST_PAUSE, { paused: true }, 1_000_000);
    const actions = session.drain(1_000_000);
    const state = actions.find((a) => a.room === ROOM.PUBLIC && a.event === S2C.STATE);
    assert.equal(state.payload.paused, true);
  });

  await t.test("清屏只清显示，数据一条都不删 —— 导出时老师要看完整课堂", () => {
    const { session } = setup();
    session.receive("h1", C2S.HOST_CLEAR, {}, 1_000_000);
    const actions = session.drain(1_000_000);
    assert.equal(actions.find((a) => a.room === ROOM.PUBLIC).payload.clearedAt, 1_000_000);
    assert.equal(session.itemCount, 1);
  });

  await t.test("静音期间学生发不出，提示带剩余秒数", () => {
    const { session } = setup();
    session.receive("h1", C2S.HOST_MUTE, { minutes: 1 }, 1_000_000);
    session.drain(1_000_000);
    const actions = send(session, "c1", { text: "喂" }, 1_010_000);
    const limited = actions.find((a) => a.event === S2C.RATE_LIMITED);
    assert.match(limited.payload.message, /全班静音中，还有 50 秒/);
  });

  await t.test("静音 0 分钟等于解除", () => {
    const { session } = setup();
    session.receive("h1", C2S.HOST_MUTE, { minutes: 1 }, 1_000_000);
    session.drain(1_000_000);
    session.receive("h1", C2S.HOST_MUTE, { minutes: 0 }, 1_001_000);
    session.drain(1_001_000);
    assert.equal(session.state().mutedUntil, 0);
  });

  await t.test("撤回一条弹幕，广播 remove", () => {
    const { session, id } = setup();
    session.receive("h1", C2S.HOST_REMOVE, { id }, 1_000_000);
    const actions = session.drain(1_000_000);
    const removed = actions.find((a) => a.event === S2C.REMOVE);
    assert.deepEqual(removed.payload, { id, reason: "host" });
    assert.equal(removed.room, ROOM.PUBLIC);
  });

  await t.test("置顶的广播带着完整内容，投影没见过这条也能钉上", () => {
    const { session, id } = setup();
    session.receive("h1", C2S.HOST_PIN, { id, pinned: true }, 1_000_000);
    const actions = session.drain(1_000_000);

    for (const room of [ROOM.PUBLIC, ROOM.HOST]) {
      const pin = actions.find((a) => a.event === S2C.PIN && a.room === room);
      // 只发 id 的话，投影那边查无此条 —— 老师按了置顶、投影上什么都没发生
      assert.equal(pin.payload.id, id);
      assert.equal(typeof pin.payload.text, "string");
      assert.ok(pin.payload.text.length > 0, "置顶载荷必须带正文");
      assert.equal(pin.payload.pinned, true);
      assert.equal(typeof pin.payload.aggregate, "number", "计数也要带上，钉上去不能把数字弄丢");
    }
  });

  await t.test("钉住的弹幕继续涨计数，再置顶时带上新的数字", () => {
    const { session } = makeSession();
    joinAs(session, "h1", ROLE.HOST);
    // 三个人点同一个预置项。限流是按设备算的，所以必须是三条连接；
    // 三条都要落在同一个 30 秒聚合窗口里，才数得成一条 ×3
    let id = null;
    for (const [index, clientId] of ["c1", "c2", "c3"].entries()) {
      joinStudent(session, clientId);
      const actions = send(
        session,
        clientId,
        { text: "没听懂", presetId: "not_understood" },
        1_000_000 + index * 4_000,
      );
      // 只有第一下会在公共房间广播 `danmaku:new`；后面两下是"合并进已有那条"，
      // 只回显给点的人自己（屏幕上不该因此多飘两条，§4.6）
      const created = actions.find((a) => a.event === S2C.NEW && a.room === ROOM.PUBLIC);
      if (created) id = created.payload.id;
      else assert.ok(actions.some((a) => a.event === S2C.NEW), `${clientId} 该收到回显`);
    }
    session.drain(1_010_000);

    session.receive("h1", C2S.HOST_PIN, { id, pinned: true }, 1_011_000);
    const pin = session
      .drain(1_011_000)
      .find((a) => a.event === S2C.PIN && a.room === ROOM.PUBLIC);
    assert.equal(pin.payload.aggregate, 3, "钉上去的正是「×3 个没听懂」，数字不能丢");
    assert.equal(pin.payload.text, "没听懂");
  });

  await t.test("置顶最多 3 条，超出淘汰最旧的", () => {
    const { session } = setup();
    const ids = [setup().id];
    for (let i = 0; i < MAX_PINNED; i += 1) {
      const actions = send(session, "c1", { text: `第${i}条` }, 1_100_000 + i * 4_000);
      ids.push(actions.find((a) => a.event === S2C.NEW && a.room === ROOM.PUBLIC).payload.id);
    }
    for (const [index, id] of ids.entries()) {
      session.receive("h1", C2S.HOST_PIN, { id, pinned: true }, 1_200_000 + index);
      session.drain(1_200_000 + index);
    }
    const pinned = [...session.items.values()].filter((item) => item.pinned);
    assert.equal(pinned.length, MAX_PINNED);
    assert.equal(session.items.get(ids[0]).pinned, false, "最旧的被挤掉了");
  });

  await t.test("拉黑会立刻把这个设备的连接踢掉", () => {
    const { session } = setup();
    const deviceId = session.clients.get("c1").deviceId;
    session.receive("h1", C2S.HOST_BAN, { deviceId }, 1_000_000);
    const actions = session.drain(1_000_000);
    const kick = actions.find((a) => a.disconnect);
    assert.equal(kick.disconnect.clientId, "c1");
    assert.equal(kick.disconnect.reason, "banned");
  });

  await t.test("fetchIdentity 只发给要它的那个老师，而且只在他要的时候", () => {
    const { session } = makeSession();
    joinAs(session, "h1", ROLE.HOST);
    joinStudent(session, "c1", { identity: { studentId: "20230001", name: "王小明" } });
    const actions = send(session, "c1", { text: "在" }, 1_000_000);
    const id = actions.find((a) => a.event === S2C.NEW && a.room === ROOM.PUBLIC).payload.id;

    assert.equal(
      JSON.stringify(actions).includes("20230001"),
      false,
      "老师没要，学号就不该出现在任何出站消息里",
    );

    session.receive("h1", C2S.HOST_FETCH_IDENTITY, { id }, 1_000_000);
    const out = session.drain(1_000_000);
    assert.deepEqual(out, [
      {
        room: "h1",
        event: S2C.HOST_IDENTITY,
        payload: { id, studentId: "20230001", name: "王小明" },
      },
    ]);
  });

  await t.test("改配置会广播给所有人，非法值被夹回去", () => {
    const { session } = makeSession();
    joinAs(session, "h1", ROLE.HOST);
    session.receive("h1", C2S.HOST_CONFIG, { duration: 9999 }, 1_000_000);
    const actions = session.drain(1_000_000);
    const config = actions.find((a) => a.event === S2C.CONFIG);
    assert.equal(config.room, ROOM.PUBLIC);
    assert.equal(config.payload.duration, 30, "被夹到上限");
    assert.equal(config.payload.fontSize, 28, "只改一个字段，其余保持");
  });

  await t.test("标记已回应是单向的", () => {
    const { session, id } = setup();
    session.receive("h1", C2S.HOST_RESOLVED, { id }, 1_000_000);
    const first = session.drain(1_000_000);
    assert.equal(first[0].payload.resolved, true);
    session.receive("h1", C2S.HOST_RESOLVED, { id }, 1_000_000);
    assert.deepEqual(session.drain(1_000_000), []);
    assert.equal(session.items.get(id).resolved, true);
  });

  await t.test("没接上导出功能时明确报错，而不是假装成功", () => {
    const { session } = makeSession();
    joinAs(session, "h1", ROLE.HOST);
    session.receive("h1", C2S.HOST_EXPORT, {}, 1_000_000);
    const actions = session.drain(1_000_000);
    assert.equal(actions[0].payload.code, ERROR_CODE.NOT_READY);
  });

  await t.test("接了导出功能就把摘要发给老师", () => {
    const { session } = makeSession({ onExport: (data) => ({ file: "x.json", count: data.danmaku.length }) });
    joinAs(session, "h1", ROLE.HOST);
    session.receive("h1", C2S.HOST_EXPORT, {}, 1_000_000);
    const actions = session.drain(1_000_000);
    assert.deepEqual(actions, [
      { room: "h1", event: S2C.EXPORT_READY, payload: { file: "x.json", count: 0 } },
    ]);
  });
});

test("载荷校验：receive 就是服务端的边界", async (t) => {
  await t.test("不认识的事件名直接回 unknown_event，不进队列", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    const actions = session.receive("c1", "danmaku:explode", {}, 1_000_000);
    assert.equal(actions[0].payload.code, ERROR_CODE.UNKNOWN_EVENT);
    assert.equal(session.stats().queued, 0, "不许把不认识的指令排进队列");
  });

  await t.test("超长文本回 rejected 并带上 tempId，客户端才知道撤哪一条", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    const actions = session.receive("c1", C2S.SEND, { text: "字".repeat(200), tempId: "t9" }, 1_000_000);
    assert.deepEqual(actions, [
      { room: "c1", event: S2C.REJECTED, payload: { tempId: "t9", reason: REJECT.TOO_LONG } },
    ]);
    assert.equal(session.itemCount, 0);
  });

  await t.test("空文本回 rejected，而不是安静地什么都不发生", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    const actions = session.receive("c1", C2S.SEND, { text: "   ", tempId: "t1" }, 1_000_000);
    assert.equal(actions[0].event, S2C.REJECTED);
    assert.equal(actions[0].payload.reason, REJECT.EMPTY);
  });

  await t.test("host:config 传 null 被拒 —— Number(null) 是 0，会让弹幕一帧穿过屏幕", () => {
    const { session } = makeSession();
    joinAs(session, "h1", ROLE.HOST);
    const actions = session.receive("h1", C2S.HOST_CONFIG, { duration: null }, 1_000_000);
    assert.equal(actions[0].payload.code, ERROR_CODE.BAD_MESSAGE);
    assert.equal(session.config.duration, DEFAULT_CONFIG.duration, "配置一点都不该动");
  });

  await t.test("host:config 传空对象被拒", () => {
    const { session } = makeSession();
    joinAs(session, "h1", ROLE.HOST);
    const actions = session.receive("h1", C2S.HOST_CONFIG, {}, 1_000_000);
    assert.equal(actions[0].payload.code, ERROR_CODE.BAD_MESSAGE);
  });

  await t.test("host:mute 传 null 被拒，不会静默变成'静音 0 分钟'", () => {
    const { session } = makeSession();
    joinAs(session, "h1", ROLE.HOST);
    const actions = session.receive("h1", C2S.HOST_MUTE, { minutes: null }, 1_000_000);
    assert.equal(actions[0].payload.code, ERROR_CODE.BAD_MESSAGE);
    assert.equal(session.state().mutedUntil, 0);
  });
});

test("角色门禁", async (t) => {
  await t.test("学生发老师指令只会收到 forbidden，状态一点都不变", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    session.receive("c1", C2S.HOST_PAUSE, { paused: true }, 1_000_000);
    const actions = session.drain(1_000_000);
    assert.deepEqual(actions, [
      {
        room: "c1",
        event: S2C.ERROR,
        payload: { code: ERROR_CODE.FORBIDDEN, message: "这个操作只有老师能做" },
      },
    ]);
    assert.equal(session.paused, false);
  });

  await t.test("投影页发老师指令同样被挡", () => {
    const { session } = makeSession();
    joinAs(session, "o1", ROLE.OVERLAY);
    session.receive("o1", C2S.HOST_CLEAR, {}, 1_000_000);
    const actions = session.drain(1_000_000);
    assert.equal(actions[0].payload.code, ERROR_CODE.FORBIDDEN);
  });
});

test("双队列优先级（§4.3.4）", async (t) => {
  await t.test("老师指令插到学生弹幕前面执行", () => {
    const { session } = makeSession();
    joinAs(session, "h1", ROLE.HOST);
    joinStudent(session, "c1");

    // 先排一堆学生的，再插一条老师的
    session.receive("c1", C2S.SEND, { text: "第一条" }, 1_000_000);
    session.receive("c1", C2S.SEND, { text: "第二条" }, 1_000_000);
    session.receive("h1", C2S.HOST_PAUSE, { paused: true }, 1_000_000);

    const actions = session.drain(1_000_000);
    const pauseAt = actions.findIndex((a) => a.event === S2C.STATE);
    const firstDanmakuAt = actions.findIndex((a) => a.event === S2C.NEW);
    assert.ok(pauseAt >= 0 && firstDanmakuAt >= 0);
    assert.ok(pauseAt < firstDanmakuAt, "老师按的暂停必须排在积压的弹幕前面");
  });

  await t.test("一轮最多处理 50 条学生消息，剩下的留到下一轮", () => {
    const { session } = makeSession();
    for (let i = 0; i < 60; i += 1) {
      joinStudent(session, `c${i}`);
      session.receive(`c${i}`, C2S.SEND, { text: `第${i}条` }, 1_000_000);
    }
    session.drain(1_000_000);
    assert.equal(session.itemCount, 50);
    assert.equal(session.stats().queued, 10);
    session.drain(1_000_000);
    assert.equal(session.itemCount, 60);
  });
});

test("安全红线：发给投影/学生的消息里绝不能有身份（§4.4）", async (t) => {
  await t.test("把一整节课的所有出站消息抓下来逐条扫", () => {
    const { session } = makeSession();
    const publicActions = [];
    const collect = (actions) => {
      for (const action of actions) {
        if (action.room === ROOM.PUBLIC) publicActions.push(action);
      }
      return actions;
    };

    // 一整套会碰到身份的流程：填了学号姓名的人发言、老师拉取身份、
    // 老师撤回、点赞、改配置、清屏、重放
    collect(joinAs(session, "h1", ROLE.HOST));
    const student = joinStudent(session, "c1", {
      nickname: "小明",
      identity: { studentId: "20230001", name: "王小明" },
    });
    collect(student.actions);
    collect(joinAs(session, "o1", ROLE.OVERLAY));
    collect(joinAs(session, "s1", ROLE.SCREEN));

    const sent = collect(send(session, "c1", { text: "没听懂", presetId: "not_understood" }, 1_000_000));
    const id = sent.find((a) => a.event === S2C.NEW && a.room === ROOM.PUBLIC).payload.id;

    collect(session.receive("h1", C2S.HOST_FETCH_IDENTITY, { id }, 1_000_000));
    collect(session.drain(1_000_000));
    collect(session.receive("c1", C2S.LIKE, { id }, 1_000_000));
    collect(session.drain(1_000_000));
    collect(session.receive("h1", C2S.HOST_CONFIG, { fontSize: 40 }, 1_000_000));
    collect(session.drain(1_000_000));
    collect(session.receive("h1", C2S.HOST_REMOVE, { id }, 1_000_000));
    collect(session.drain(1_000_000));

    // 真正要防的是"这条测试变成空转"：公共房间里一条消息都没有，
    // 上面的循环当然一条泄露都查不出来，测试绿得毫无意义。
    // 所以要求它确实扫过每一种会出现在公共房间的消息。
    const kinds = new Set(publicActions.map((a) => a.event));
    for (const expected of [S2C.NEW, S2C.UPDATE, S2C.CONFIG, S2C.REMOVE]) {
      assert.ok(kinds.has(expected), `公共房间里没出现 ${expected}，这条红线就没扫到它`);
    }
    for (const action of publicActions) {
      const leaks = findIdentityLeak(action.payload);
      assert.deepEqual(
        leaks,
        [],
        `发给公共房间的 ${action.event} 泄露了身份：${leaks.join(", ")}\n${JSON.stringify(action.payload)}`,
      );
    }

    // 顺带确认"确实存在过身份" —— 否则上面的断言可能是空转
    assert.equal(session.devices.get(student.deviceId).identity.studentId, "20230001");
  });
});

test("维护", async (t) => {
  await t.test("人走了在线数要掉下来", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    const actions = session.leave("c1");
    assert.equal(actions[0].payload.online, 0);
  });

  await t.test("重复 leave 不会出错", () => {
    const { session } = makeSession();
    joinStudent(session, "c1");
    session.leave("c1");
    assert.deepEqual(session.leave("c1"), []);
  });

  await t.test("弹幕条数有上限，超出丢最旧的", () => {
    const { session } = makeSession({ maxItems: 3 });
    joinStudent(session, "c1");
    for (let i = 0; i < 5; i += 1) {
      send(session, "c1", { text: `第${i}条` }, 1_000_000 + i * 4_000);
    }
    assert.equal(session.itemCount, 3);
  });

  await t.test("重放不超过 REPLAY_LIMIT 条", () => {
    // 这条测的是重放的截断，不是限流。默认限流下一台设备最多发 200 条，
    // 会先被限流挡住，于是"重放 200 条"这条断言永远测不到真正想测的边界。
    const { session } = makeSession({
      limiter: createRateLimiter({
        rules: { minIntervalMs: 0, perMinute: 100_000, perSession: 100_000 },
      }),
    });
    joinStudent(session, "c1");
    for (let i = 0; i < REPLAY_LIMIT + 10; i += 1) {
      send(session, "c1", { text: `第${i}条` }, 1_000_000 + i * 4_000);
    }
    assert.equal(session.itemCount, REPLAY_LIMIT + 10, "前提是这些弹幕真的都发出去了");
    const actions = joinAs(session, "h1", ROLE.HOST);
    assert.equal(event(actions, S2C.NEW).length, REPLAY_LIMIT);
  });

  await t.test("stats 里的字段都拿得到，不会因为没初始化而炸", () => {
    const { session } = makeSession();
    const stats = session.stats();
    assert.equal(stats.online, 0);
    assert.equal(stats.danmaku, 0);
    assert.equal(typeof stats.limiter.devices, "number");
    assert.equal(typeof stats.aggregator.buckets, "number");
  });
});
