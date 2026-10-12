/**
 * 浏览器端连接管理（src/shared/client.js）的单元测试。
 *
 * 这里所有用例都用假的 WebSocket 和假的定时器：真实定时器会让"退避 1s→2s→4s"
 * 这条测试跑 7 秒，而假定时器下它是瞬时的。假 socket 还让"服务端发来一段
 * 不是 JSON 的东西"这种真机上很难制造的输入变得随手可得。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { STATUS, backoffDelay, createClassroomClient } from "../../src/shared/client.js";

/** 记录所有实例的假 WebSocket，方便测试从外部触发各种事件。 */
class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    this.listeners = new Map();
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  /** 模拟"连上了"：真实浏览器是先 open 再能 send。 */
  connect() {
    this.readyState = 1;
    this.emit("open");
  }

  send(data) {
    if (this.readyState !== 1) throw new Error("还没连上就 send");
    this.sent.push(JSON.parse(data));
  }

  /** 模拟服务端发来一条消息。 */
  deliver(message) {
    this.emit("message", { data: typeof message === "string" ? message : JSON.stringify(message) });
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
}

function fakeTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimeout(handler, ms) {
      const id = nextId++;
      scheduled.set(id, { handler, ms });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
    /** 跑掉当前所有挂着的定时器（包括它们回调里又挂上的新的）。 */
    flush() {
      let guard = 0;
      while (scheduled.size > 0) {
        if (guard++ > 100) throw new Error("定时器停不下来");
        const [id, entry] = scheduled.entries().next().value;
        scheduled.delete(id);
        entry.handler();
      }
    },
    get pending() {
      return scheduled.size;
    },
    delays() {
      return [...scheduled.values()].map((entry) => entry.ms);
    },
  };
}

function makeClient(overrides = {}) {
  FakeSocket.instances = [];
  const timers = overrides.timers ?? fakeTimers();
  const events = [];
  const statuses = [];
  let resets = 0;
  const deviceIds = [];

  const client = createClassroomClient({
    url: "ws://127.0.0.1:3000/ws",
    join: { role: "student", classId: "demo" },
    WebSocketImpl: FakeSocket,
    timers,
    onEvent: (message) => events.push(message),
    onStatus: (status) => statuses.push(status),
    onReset: () => {
      resets += 1;
    },
    onDeviceId: (id) => deviceIds.push(id),
    logger: { warn() {} },
    ...overrides.options,
  });

  return {
    client,
    timers,
    events,
    statuses,
    deviceIds,
    get resets() {
      return resets;
    },
    get socket() {
      return FakeSocket.instances.at(-1);
    },
    get sockets() {
      return FakeSocket.instances;
    },
  };
}

test("退避序列是 1s→2s→4s→8s→10s 封顶（§4.3.2）", () => {
  assert.equal(backoffDelay(1), 1000);
  assert.equal(backoffDelay(2), 2000);
  assert.equal(backoffDelay(3), 4000);
  assert.equal(backoffDelay(4), 8000);
  assert.equal(backoffDelay(5), 10_000);
  assert.equal(backoffDelay(50), 10_000);
  // 0 / 负数 / NaN 都当成第一次，不能让 2 ** -1 算出 500ms 这种"比第一次还急"的间隔
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(-3), 1000);
  assert.equal(backoffDelay(Number.NaN), 1000);
});

test("缺 url 或没有 WebSocket 实现时当场报错，而不是等到用的时候才炸", () => {
  assert.throws(() => createClassroomClient({ WebSocketImpl: FakeSocket }), /需要 url/);
  // 用 null 而不是 undefined：undefined 会触发参数默认值（Node 22+ 有全局
  // WebSocket，默认值是能用的），测不到这条守卫
  assert.throws(
    () => createClassroomClient({ url: "ws://x/ws", WebSocketImpl: null }),
    /没有 WebSocket/,
  );
});

test("默认的定时器在真浏览器里可用：window.setTimeout 不能拆出来裸调", () => {
  /*
   * 浏览器里的 window.setTimeout 要求 this 就是 window。把它拆出来存进一个
   * 普通对象（`{ setTimeout: globalThis.setTimeout }`）之后，调用时 this 变成
   * 那个对象，浏览器抛 TypeError: Illegal invocation。Node 完全不检查 this，
   * 所以这个 bug 在别的用例里永远是绿的。
   *
   * 它曾经真的发生过：每条消息进来都会先 bumpWatchdog（重置看门狗），那一步
   * 抛异常 → 永远走不到 onEvent → 老师页显示"已连上"但问题池永远空着，
   * 除了控制台之外没有任何线索。
   */
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const strict = (name, real) =>
    function (...args) {
      if (this !== globalThis) throw new TypeError(`Illegal invocation: ${name}`);
      return real.apply(globalThis, args);
    };
  globalThis.setTimeout = strict("setTimeout", realSetTimeout);
  globalThis.clearTimeout = strict("clearTimeout", realClearTimeout);

  try {
    FakeSocket.instances = [];
    const events = [];
    // 刻意不传 timers：要测的就是那条默认值
    const client = createClassroomClient({
      url: "ws://127.0.0.1:3000/ws",
      join: { role: "student", classId: "demo" },
      WebSocketImpl: FakeSocket,
      onEvent: (message) => events.push(message),
      logger: { warn() {} },
    });

    client.open();
    const socket = FakeSocket.instances.at(-1);
    socket.connect();
    socket.deliver({ event: "joined", payload: { deviceId: "d-1" } });
    socket.deliver({ event: "danmaku:new", payload: { id: "x", text: "你好" } });

    assert.equal(events.length, 2, "消息必须真的走到 onEvent，而不是半路抛异常");
    client.close();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("连上之后立刻 join，第一次不带 deviceId", () => {
  const kit = makeClient();
  assert.equal(kit.client.status, STATUS.IDLE);

  kit.client.open();
  assert.equal(kit.client.status, STATUS.CONNECTING);
  assert.equal(kit.socket.sent.length, 0, "还没 open 就不该发东西");

  kit.socket.connect();
  assert.equal(kit.client.status, STATUS.OPEN);
  assert.deepEqual(kit.socket.sent, [
    { event: "join", payload: { role: "student", classId: "demo" } },
  ]);
  assert.deepEqual(kit.statuses, [STATUS.CONNECTING, STATUS.OPEN]);
});

test("服务端下发的 deviceId 会被记住，重连时带上（§4.5 限流要追得住同一个人）", () => {
  const kit = makeClient();
  kit.client.open();
  kit.socket.connect();
  kit.socket.deliver({ event: "joined", payload: { deviceId: "dev-1", serverTime: 1, online: 3 } });

  assert.equal(kit.client.deviceId, "dev-1");
  assert.deepEqual(kit.deviceIds, ["dev-1"]);

  kit.socket.close();
  kit.timers.flush();
  kit.socket.connect();

  assert.deepEqual(kit.socket.sent, [
    { event: "join", payload: { role: "student", classId: "demo", deviceId: "dev-1" } },
  ]);
});

test("joined 里没有 deviceId（投影/教室电脑）时不会凭空造一个", () => {
  const kit = makeClient();
  kit.client.open();
  kit.socket.connect();
  kit.socket.deliver({ event: "joined", payload: { serverTime: 1, online: 0 } });

  assert.equal(kit.client.deviceId, null);
  assert.deepEqual(kit.deviceIds, []);
});

test("每次连上（含重连）都先 onReset 再让消息进来（§4.3.2 全量同步）", () => {
  const order = [];
  const kit = makeClient({
    options: {
      onReset: () => order.push("reset"),
      onEvent: (message) => order.push(`event:${message.event}`),
    },
  });

  kit.client.open();
  kit.socket.connect();
  kit.socket.deliver({ event: "joined", payload: {} });
  kit.socket.deliver({ event: "state", payload: { online: 1 } });
  assert.deepEqual(order, ["reset", "event:joined", "event:state"]);

  // 断了再连：reset 必须再来一次，否则页面会拿着上一次连接的弹幕列表继续用
  kit.socket.close();
  kit.timers.flush();
  kit.socket.connect();
  assert.deepEqual(order.slice(-1), ["reset"]);
});

test("断线后按退避重连，状态在 reconnecting 与 open 之间来回", () => {
  const kit = makeClient();
  kit.client.open();
  kit.socket.connect();

  kit.socket.close();
  assert.equal(kit.client.status, STATUS.RECONNECTING);
  assert.deepEqual(kit.timers.delays(), [1000]);

  kit.timers.flush();
  assert.equal(kit.sockets.length, 2, "1 秒后应该真的又开了一条连接");
  assert.equal(kit.client.status, STATUS.RECONNECTING, "还没 open，仍然是重连中");

  // 这次连都没连上就断了（教室 WiFi 抖一下就是这样）—— 间隔应该翻倍
  kit.socket.close();
  assert.deepEqual(kit.timers.delays(), [2000]);

  kit.timers.flush();
  kit.socket.connect();
  assert.equal(kit.client.status, STATUS.OPEN);
});

test("连上之后又断，退避从 1s 重新数，而不是接着上次的档位", () => {
  const kit = makeClient();
  kit.client.open();
  kit.socket.connect();
  kit.socket.close();
  kit.timers.flush();
  kit.socket.connect();

  // 这次是"连上过又断了"，attempt 已被 open 清零
  kit.socket.close();
  assert.deepEqual(kit.timers.delays(), [1000]);
});

test("send 只在连接可用时发得出去，返回布尔值让调用方能提示用户", () => {
  const kit = makeClient();
  assert.equal(kit.client.send("danmaku:send", { text: "在吗" }), false, "还没连上");

  kit.client.open();
  assert.equal(kit.client.send("danmaku:send", { text: "在吗" }), false, "正在连接中");

  kit.socket.connect();
  assert.equal(kit.client.send("danmaku:send", { text: "在吗", tempId: "t1" }), true);
  assert.deepEqual(kit.socket.sent.at(-1), {
    event: "danmaku:send",
    payload: { text: "在吗", tempId: "t1" },
  });

  kit.socket.close();
  assert.equal(kit.client.send("danmaku:send", { text: "还在吗" }), false, "断了就别假装发出去了");
});

test("服务端发来不是 JSON 的东西只记日志，不抛错也不交给页面", () => {
  const kit = makeClient();
  kit.client.open();
  kit.socket.connect();
  kit.socket.deliver("{这不是 JSON");

  assert.deepEqual(kit.events, [], "解析不了的消息不该进 onEvent");
  assert.equal(kit.client.status, STATUS.OPEN, "一条脏消息不该把连接判定成坏了");
});

test("安静超过 watchdogMs 就当断线处理，收到任何消息都会重置看门狗", () => {
  const kit = makeClient({ options: { watchdogMs: 90_000 } });
  kit.client.open();
  kit.socket.connect();
  assert.deepEqual(kit.timers.delays(), [90_000]);

  // 收到消息 → 重新计时
  kit.socket.deliver({ event: "state", payload: {} });
  assert.deepEqual(kit.timers.delays(), [90_000]);

  const before = kit.sockets.length;
  kit.timers.flush();
  assert.equal(kit.sockets.length, before + 1, "看门狗超时后应该走重连");
  assert.equal(kit.client.status, STATUS.RECONNECTING);
});

test("watchdogMs 设成 0 表示关掉看门狗", () => {
  const kit = makeClient({ options: { watchdogMs: 0 } });
  kit.client.open();
  kit.socket.connect();
  assert.equal(kit.timers.pending, 0);
});

test("主动 close 之后不再重连，状态停在 closed", () => {
  const kit = makeClient();
  kit.client.open();
  kit.socket.connect();
  kit.client.close();

  assert.equal(kit.client.status, STATUS.CLOSED);
  assert.equal(kit.client.ready, false);
  assert.equal(kit.timers.pending, 0, "主动关闭不该留一个重连定时器");

  // 关连接的回调随后才到，也不能再触发重连
  kit.socket.close();
  assert.equal(kit.timers.pending, 0);
  assert.equal(kit.sockets.length, 1);
});

test("error 事件只记日志，状态由随后的 close 决定", () => {
  const warnings = [];
  const kit = makeClient({ options: { logger: { warn: (...args) => warnings.push(args) } } });
  kit.client.open();
  kit.socket.connect();
  kit.socket.emit("error");

  assert.equal(kit.client.status, STATUS.OPEN);
  assert.ok(warnings.length >= 1);
});

test("连接失败（构造函数抛错）也会退避重试，而不是放弃", () => {
  const timers = fakeTimers();
  let calls = 0;
  class FlakySocket extends FakeSocket {
    constructor(url) {
      calls += 1;
      if (calls === 1) throw new Error("网络不可达");
      super(url);
    }
  }
  const client = createClassroomClient({
    url: "ws://127.0.0.1:3000/ws",
    join: {},
    WebSocketImpl: FlakySocket,
    timers,
    logger: { warn() {} },
  });

  client.open();
  assert.equal(client.status, STATUS.RECONNECTING);
  assert.deepEqual(timers.delays(), [1000]);
  timers.flush();
  assert.equal(calls, 2);
});
