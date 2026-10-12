/**
 * 端到端：真的开一个 HTTP 服务、真的连 WebSocket、真的发 JSON。
 *
 * 这一组测试的价值在于它是**唯一会同时碰到传输层、胶水层和会话层**的地方。
 * 上面各层的单元测试都可以是对的，但拼起来仍然可能把身份发到投影上 ——
 * §4.4 明确要求"有一条自动化测试抓取发给 overlay 房间的所有消息"，
 * 这里就是那条测试：抓的是 overlay **真的从网线上收到的字节**，
 * 而不是我们以为会发出去的东西。
 *
 * 这里用真实定时器（tickMs 很小）而不是手工驱动 pump：手工 pump 会在
 * "消息还在路上"的时候就去排空队列，测出来的是测试自己的时序而不是产品行为。
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createHub } from "../../src/main/server/hub.js";
import { createSession } from "../../src/main/server/session.js";
import { attachWebSocket } from "../../src/main/server/websocket.js";
import { C2S, ERROR_CODE, REJECT, ROLE, S2C, findIdentityLeak } from "../../src/shared/protocol.js";

const silent = { info() {}, warn() {}, error() {} };

function makeClock(start = 1_000_000) {
  let value = start;
  const now = () => value;
  now.advance = (ms) => {
    value += ms;
  };
  return now;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startStack(t, sessionOptions = {}) {
  const clock = makeClock();
  const session = createSession({ clock, logger: silent, ...sessionOptions });
  const hub = createHub({ session, logger: silent, clock, tickMs: 5 });

  const server = createServer((req, res) => {
    res.writeHead(404).end("没有 HTTP 路由");
  });
  const ws = attachWebSocket({
    server,
    path: "/ws",
    logger: silent,
    onConnection(conn) {
      hub.attach(conn.id, (data) => {
        if (data === null) {
          conn.close(1008, "被移出课堂");
          return true;
        }
        return conn.send(data);
      });
      conn.on("message", (raw) => hub.onMessage(conn.id, String(raw)));
      conn.on("close", () => hub.detach(conn.id));
    },
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `ws://127.0.0.1:${port}/ws`;

  hub.start();

  t.after(async () => {
    hub.close();
    ws.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  /** 连一条。默认自动 join；`autoJoin: false` 用来测"没 join 就说话"。 */
  async function connect(name, role, extra = {}, { autoJoin = true } = {}) {
    const socket = new WebSocket(url);
    const messages = [];
    let resolveOutcome;
    // 注意：这里等的不是"joined"，而是"joined 或 error"。
    // 被拉黑的人再连回来时服务端只回一个 error —— 只等 joined 的话
    // 这条测试会永远挂在那里，而不是告诉你"他被挡住了"。
    const outcome = new Promise((resolve) => {
      resolveOutcome = resolve;
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      messages.push(message);
      if (message.event === S2C.JOINED || message.event === S2C.ERROR) {
        resolveOutcome(message);
      }
    });
    socket.addEventListener("error", () => {});

    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    const client = {
      name,
      socket,
      messages,
      deviceId: null,
      joinError: null,
      send(event, body) {
        socket.send(JSON.stringify({ event, payload: body }));
      },
      /**
       * 等到收到满足条件的消息，或超时。
       *
       * `from` 用来只看"这一刻之后"新到的消息。少了它，一条测试会匹配到
       * 早先那份内容恰好相同的广播（比如老师刚 join 时的 online: 0），
       * 于是测试通过与否取决于消息的先后，而不是行为本身。
       */
      async waitFor(predicate, label = "消息", { timeoutMs = 2000, from = 0 } = {}) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const hit = messages.slice(from).find(predicate);
          if (hit) return hit;
          if (Date.now() > deadline) {
            throw new Error(
              `等不到${label}。${name}已经收到的：${messages.map((m) => m.event).join(", ") || "（空）"}`,
            );
          }
          await sleep(5);
        }
      },
    };

    if (!autoJoin) return client;

    socket.send(
      JSON.stringify({
        event: C2S.JOIN,
        payload: { role, classId: "class-1", nickname: name, ...extra },
      }),
    );

    const first = await Promise.race([
      outcome,
      sleep(2000).then(() => {
        throw new Error(`${name} 连上之后既没收到 joined 也没收到 error`);
      }),
    ]);
    if (first.event === S2C.JOINED) client.deviceId = first.payload.deviceId;
    else client.joinError = first.payload;
    return client;
  }

  return { server, port, url, session, hub, clock, connect, ws };
}

test("端到端：一条弹幕走完整条链路", async (t) => {
  const { session, connect } = await startStack(t);

  const host = await connect("老师", ROLE.HOST);
  const student = await connect("小明", ROLE.STUDENT, {
    identity: { studentId: "20230001", name: "王小明" },
  });
  const projector = await connect("投影", ROLE.OVERLAY);

  student.send(C2S.SEND, { text: "没听懂", presetId: "not_understood", tempId: "t1" });

  const shown = await projector.waitFor((m) => m.event === S2C.NEW, "投影上的弹幕");
  assert.equal(shown.payload.text, "没听懂", "显示的是服务端预置表里的文字");
  assert.equal(shown.payload.nickname, "小明");

  const onHost = await host.waitFor(
    (m) => m.event === S2C.NEW && m.payload.deviceId,
    "老师那份带 deviceId 的弹幕",
  );
  assert.equal(onHost.payload.deviceId, student.deviceId);

  const mine = await student.waitFor(
    (m) => m.event === S2C.NEW && m.payload.tempId === "t1",
    "自己那份带 tempId 的回显",
  );
  assert.equal(mine.payload.id, shown.payload.id, "回显和广播必须是同一条");
  assert.equal(session.stats().accepted, 1);
});

test("安全红线：投影和学生真的收不到任何身份字段（§4.4）", async (t) => {
  const { connect } = await startStack(t);

  const host = await connect("老师", ROLE.HOST);
  const student = await connect("小明", ROLE.STUDENT, {
    identity: { studentId: "20230001", name: "王小明" },
    nickname: "小明",
  });
  const projector = await connect("投影", ROLE.OVERLAY);
  const screen = await connect("教室电脑", ROLE.SCREEN);

  // 一整套本来就会碰到身份的动作：发言、点赞
  student.send(C2S.SEND, { text: "加个例子", presetId: "example", tempId: "t1" });
  const onProjector = await projector.waitFor((m) => m.event === S2C.NEW, "弹幕");
  student.send(C2S.LIKE, { id: onProjector.payload.id });
  await projector.waitFor(
    (m) => m.event === S2C.UPDATE && m.payload.likes === 1,
    "点赞更新",
  );

  // 别人的身份，一个字都不许出现在投影或教室电脑上
  const foreignIds = [student.deviceId, host.deviceId];
  const forbiddenWords = ["20230001", "王小明"];

  for (const [label, client] of [
    ["投影", projector],
    ["教室电脑", screen],
  ]) {
    assert.ok(client.messages.length > 0, `${label}一条消息都没收到，这条红线就没扫到东西`);
    for (const message of client.messages) {
      const raw = JSON.stringify(message.payload);
      for (const word of forbiddenWords) {
        assert.ok(
          !raw.includes(word),
          `${label}收到的 ${message.event} 里出现了「${word}」：${raw}`,
        );
      }
      for (const id of foreignIds) {
        assert.ok(
          !raw.includes(id),
          `${label}收到的 ${message.event} 里出现了别人的 deviceId：${raw}`,
        );
      }
      // deviceId 只允许是它自己的那一个（`joined` 要用它来重连，§4.3.2）。
      // 投影和教室电脑一个都不该有 —— 它们没有身份，也不发弹幕。
      const leaks = findIdentityLeak(message.payload).filter((p) => p !== "$.deviceId");
      assert.deepEqual(
        leaks,
        [],
        `${label}收到了 ${message.event}，里面带着 ${leaks.join(", ")}：${raw}`,
      );
      assert.equal(
        message.payload.deviceId,
        undefined,
        `${label}收到的 ${message.event} 里带着 deviceId：${raw}`,
      );
    }
  }
});

test("端到端：老师拉黑之后那条连接当场就断了", async (t) => {
  const { connect } = await startStack(t);

  const host = await connect("老师", ROLE.HOST);
  const student = await connect("小明", ROLE.STUDENT);
  const projector = await connect("投影", ROLE.OVERLAY);

  student.send(C2S.SEND, { text: "喂" });
  await projector.waitFor((m) => m.event === S2C.NEW, "弹幕");

  const closed = new Promise((resolve) => {
    student.socket.addEventListener("close", resolve, { once: true });
  });
  host.send(C2S.HOST_BAN, { deviceId: student.deviceId });
  await closed;

  assert.equal(student.socket.readyState, WebSocket.CLOSED, "拉黑必须当场生效");

  // 而且他不能再连回来 —— 服务端只会回一个 error，不会给 joined
  const again = await connect("小明又来了", ROLE.STUDENT, { deviceId: student.deviceId });
  assert.equal(again.joinError?.code, ERROR_CODE.BANNED);
  assert.equal(again.deviceId, null, "被挡住的人不该拿到新身份");
});

test("端到端：没 join 就说话，什么都不会广播", async (t) => {
  const { connect } = await startStack(t);

  const projector = await connect("投影", ROLE.OVERLAY);
  const stranger = await connect("路人", ROLE.STUDENT, {}, { autoJoin: false });
  stranger.socket.send(JSON.stringify({ event: C2S.SEND, payload: { text: "在吗" } }));
  await sleep(150);

  assert.equal(projector.messages.some((m) => m.event === S2C.NEW), false);
});

test("端到端：坏消息只会得到一句提示，不会把服务打挂", async (t) => {
  const { session, connect } = await startStack(t);

  const student = await connect("小明", ROLE.STUDENT);

  student.socket.send("{ 这不是 JSON");
  const bad = await student.waitFor((m) => m.event === S2C.ERROR, "格式错误提示");
  assert.equal(bad.payload.code, ERROR_CODE.BAD_MESSAGE);

  student.socket.send(JSON.stringify({ event: "danmaku:explode", payload: {} }));
  const unknown = await student.waitFor(
    (m) => m.event === S2C.ERROR && m.payload.code === ERROR_CODE.UNKNOWN_EVENT,
    "未知事件提示",
  );
  assert.match(unknown.payload.message, /这个/);

  // 服务还活着，还能正常发弹幕
  student.send(C2S.SEND, { text: "还好", tempId: "t1" });
  await student.waitFor(
    (m) => m.event === S2C.NEW && m.payload.tempId === "t1",
    "正常弹幕",
  );
  assert.equal(session.stats().accepted, 1);
});

test("端到端：屏蔽词只回给发的人，投影上一条都没有", async (t) => {
  const { connect } = await startStack(t);

  const student = await connect("小明", ROLE.STUDENT);
  const projector = await connect("投影", ROLE.OVERLAY);

  student.send(C2S.SEND, { text: "加微信 私聊", tempId: "t1" });

  const rejected = await student.waitFor((m) => m.event === S2C.REJECTED, "拒绝提示");
  assert.equal(rejected.payload.reason, REJECT.FILTERED);
  assert.equal(rejected.payload.tempId, "t1");
  assert.equal(
    projector.messages.some((m) => m.event === S2C.NEW),
    false,
    "被拦下的内容一个字都不能上投影",
  );
});

test("端到端：断开连接之后在线人数会掉下来", async (t) => {
  const { session, connect } = await startStack(t);

  const host = await connect("老师", ROLE.HOST);
  const student = await connect("小明", ROLE.STUDENT);
  assert.equal(session.state().online, 1);

  // 只看"关掉之后新到的消息"：老师刚 join 时那份 state 也是 online: 0，
  // 不划出这条线的话，测试会在学生还没来之前就心满意足地通过
  const from = host.messages.length;
  student.socket.close();
  await host.waitFor(
    (m) => m.event === S2C.STATE && m.payload.online === 0,
    "人数掉的广播",
    { from },
  );
  assert.equal(session.state().online, 0, "老师看到的人数不能是个幽灵");
});

test("端到端：重连之后拿到全量 state，而不是只拿增量（§4.3.2）", async (t) => {
  const { session, connect } = await startStack(t);

  const student = await connect("小明", ROLE.STUDENT);
  student.send(C2S.SEND, { text: "第一条" });
  await student.waitFor((m) => m.event === S2C.NEW, "自己那份回显");

  const again = await connect("小明", ROLE.STUDENT, { deviceId: student.deviceId });
  const state = await again.waitFor((m) => m.event === S2C.STATE, "重连后的全量 state");
  assert.equal(state.payload.danmakuCount, session.itemCount);
  assert.equal(again.deviceId, student.deviceId, "重连还是同一个人，否则限流追不住");
});
