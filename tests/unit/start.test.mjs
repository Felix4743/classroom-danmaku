/**
 * `src/main/server/start.js` 的端到端测试：真的起一个服务，真的连上去发弹幕。
 *
 * 其它测试文件都在验"某一层对不对"（会话层零 I/O、胶水层收发、HTTP 路由），
 * 这个文件只验一件事：**这些层拼起来之后，一个学生发的弹幕能不能到投影上**。
 * 拼装的错误（路径写错、hub 忘了 start、WebSocket 挂到了别的 server 上）
 * 在分层测试里全都是绿的。
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { startClassroom } from "../../src/main/server/start.js";
import { ROLE, S2C } from "../../src/shared/protocol.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, "..", "..", "src");

const silent = { warn() {}, error() {}, log() {} };

async function startStack(t, options = {}) {
  const classroom = await startClassroom({
    staticRoot: SRC_ROOT,
    port: 0,
    host: "127.0.0.1",
    logger: silent,
    ...options,
  });
  t.after(() => classroom.close());
  return classroom;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 连一条真实的 WebSocket 上来。
 *
 * `outcome` 等的是 joined 或 error —— 只等 joined 的话，一条被服务端拒绝的连接
 * 会让测试永远挂住而不失败（这个坑 hub.test.mjs 里踩过一次）。
 */
async function connect(classroom, role, extra = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${classroom.port}/ws`);
  const messages = [];
  let deviceId = null;
  let joinError = null;

  const outcome = new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      messages.push(message);
      if (message.event === S2C.JOINED) {
        deviceId = message.payload?.deviceId ?? null;
        resolve();
      } else if (message.event === S2C.ERROR && joinError === null) {
        joinError = message.payload;
        resolve();
      }
    });
    socket.addEventListener("error", () => reject(new Error("连接出错")));
    socket.addEventListener("close", () => reject(new Error("连接被关掉了")));
  });

  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        event: "join",
        payload: { role, classId: "demo", ...extra },
      }),
    );
  });

  await Promise.race([
    outcome,
    sleep(3000).then(() => {
      throw new Error(`${role} 连上之后既没收到 joined 也没收到 error`);
    }),
  ]);

  return {
    socket,
    messages,
    get deviceId() {
      return deviceId;
    },
    get joinError() {
      return joinError;
    },
    send: (event, payload) => socket.send(JSON.stringify({ event, payload })),
    async waitFor(predicate, label, { timeoutMs = 3000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(`等不到${label}`);
        }
        await sleep(10);
      }
    },
  };
}

test("根地址跳到投影页，投影页与它的资源都取得到", async (t) => {
  const classroom = await startStack(t);

  const home = await fetch(`http://127.0.0.1:${classroom.port}/`, { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), "/screen/");

  const page = await fetch(`http://127.0.0.1:${classroom.port}/screen/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /投影/);

  const engine = await fetch(`http://127.0.0.1:${classroom.port}/overlay/engine.js`);
  assert.equal(engine.status, 200);
  assert.match(engine.headers.get("content-type"), /text\/javascript/);
});

test("挂载点与首页来自 pageMounts，不是写死的", async (t) => {
  const classroom = await startStack(t);
  assert.ok(classroom.pages.includes("/screen"));
  assert.equal(classroom.mounts["/shared"], "shared");
  assert.equal(classroom.mounts["/overlay"], "overlay");
});

test("学生发的弹幕会到投影上，且投影那份不带任何身份字段", async (t) => {
  const classroom = await startStack(t);
  const overlay = await connect(classroom, ROLE.OVERLAY);
  const host = await connect(classroom, ROLE.HOST);
  const student = await connect(classroom, ROLE.STUDENT, { nickname: "小明" });

  assert.ok(student.deviceId, "学生应该拿到 deviceId");

  student.send("danmaku:send", { text: "这里没听懂", tempId: "t1" });

  const onOverlay = await overlay.waitFor((m) => m.event === S2C.NEW, "投影收到弹幕");
  assert.equal(onOverlay.payload.text, "这里没听懂");
  assert.equal(onOverlay.payload.nickname, "小明");
  assert.equal(onOverlay.payload.tempId, undefined, "公共广播不该带 tempId");
  assert.equal(
    JSON.stringify(onOverlay.payload).includes(student.deviceId),
    false,
    "投影收到的任何东西里都不许出现学生的 deviceId（§4.4）",
  );

  // 发的人自己那份带 tempId，用来把本地先回显的那条替换掉
  const onStudent = await student.waitFor((m) => m.event === S2C.NEW, "自己那份回显");
  assert.equal(onStudent.payload.tempId, "t1");
  assert.equal(onStudent.payload.id, onOverlay.payload.id);

  // 老师那份带 deviceId，否则点"拉黑"时不知道拉谁
  const onHost = await host.waitFor((m) => m.event === S2C.NEW && m.payload.text, "老师收到弹幕");
  assert.equal(onHost.payload.deviceId, student.deviceId);
  assert.equal(onHost.payload.likes, 0);
});

test("投影与教室电脑都不是人：它们不拿 deviceId", async (t) => {
  const classroom = await startStack(t);
  for (const role of [ROLE.OVERLAY, ROLE.SCREEN]) {
    const client = await connect(classroom, role);
    assert.equal(client.deviceId, null, `${role} 不该拿到 deviceId`);
    assert.equal(
      client.messages.some((m) => JSON.stringify(m).includes("deviceId")),
      false,
      `${role} 收到的任何消息里都不该出现 deviceId`,
    );
    client.socket.close();
  }
});

test("投影没有说话权：它发弹幕不会有任何人收到", async (t) => {
  const classroom = await startStack(t);
  const overlay = await connect(classroom, ROLE.OVERLAY);
  const host = await connect(classroom, ROLE.HOST);

  const before = host.messages.length;
  overlay.send("danmaku:send", { text: "我是投影我在说话" });
  await sleep(200);

  const leaked = host.messages
    .slice(before)
    .filter((m) => m.event === S2C.NEW && m.payload.text === "我是投影我在说话");
  assert.deepEqual(leaked, []);
});

test("学生发老师指令会被拒绝，而不是当成一次限流违规", async (t) => {
  const classroom = await startStack(t);
  const student = await connect(classroom, ROLE.STUDENT);

  student.send("host:clear", {});
  const error = await student.waitFor((m) => m.event === S2C.ERROR, "拒绝提示");
  assert.equal(error.payload.code, "forbidden");
});

test("不认识的载荷回到发的人身上，且不影响别人", async (t) => {
  const classroom = await startStack(t);
  const student = await connect(classroom, ROLE.STUDENT);

  student.send("danmaku:send", { text: "x".repeat(200) });
  const rejected = await student.waitFor((m) => m.event === S2C.REJECTED, "被判超长");
  assert.equal(rejected.payload.reason, "too_long");
  assert.equal(classroom.session.itemCount, 0);
});

test("没 join 就说话会被挡住", async (t) => {
  const classroom = await startStack(t);
  const socket = new WebSocket(`ws://127.0.0.1:${classroom.port}/ws`);

  const message = await new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ event: "danmaku:send", payload: { text: "我进来了吗" } }));
    });
    socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))));
    socket.addEventListener("error", () => reject(new Error("连接出错")));
    setTimeout(() => reject(new Error("服务端没有回应")), 3000).unref?.();
  });

  assert.equal(message.event, S2C.ERROR);
  assert.equal(message.payload.code, "not_joined");
  socket.close();
});

test("在线人数随学生进出变化，而且会广播给老师", async (t) => {
  const classroom = await startStack(t);
  const host = await connect(classroom, ROLE.HOST);
  const first = await connect(classroom, ROLE.STUDENT);

  await host.waitFor((m) => m.event === S2C.STATE && m.payload.online === 1, "在线 1 人");

  first.socket.close();
  await host.waitFor((m) => m.event === S2C.STATE && m.payload.online === 0, "在线 0 人");
});

test("老师的暂停会全量广播，学生端收到 state", async (t) => {
  const classroom = await startStack(t);
  const host = await connect(classroom, ROLE.HOST);
  const student = await connect(classroom, ROLE.STUDENT);

  host.send("host:pause", { paused: true });
  const state = await student.waitFor((m) => m.event === S2C.STATE && m.payload.paused, "暂停状态");
  assert.equal(state.payload.paused, true);
  assert.equal(classroom.session.paused, true);
});

test("不传 staticRoot 就直接抛错，而不是起一个什么都取不到的服务", async () => {
  await assert.rejects(() => startClassroom({ port: 0 }), /需要 staticRoot/);
});
