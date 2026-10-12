import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";

import {
  CLOSE_CODE,
  MAX_PAYLOAD,
  OPCODE,
  WebSocketConnection,
  WebSocketProtocolError,
  attachWebSocket,
  computeAccept,
  createMessageAssembler,
  decodeFrames,
  encodeClose,
  encodeFrame,
  isValidKey,
  pathnameOf,
} from "../../src/main/server/websocket.js";

const silent = { info() {}, warn() {} };

/** 手工编一条**加掩码**的客户端帧 —— 真实浏览器就是这么发的。 */
function clientFrame(payload, options = {}) {
  const { opcode = OPCODE.TEXT, fin = true, mask = Buffer.from([0x12, 0x34, 0x56, 0x78]), rsv = 0 } = options;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const header = [(fin ? 0x80 : 0x00) | rsv | opcode];

  if (body.length < 126) {
    header.push(0x80 | body.length);
  } else if (body.length <= 0xffff) {
    header.push(0x80 | 126, (body.length >> 8) & 0xff, body.length & 0xff);
  } else {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(body.length));
    header.push(0x80 | 127, ...length);
  }

  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([Buffer.from(header), mask, masked]);
}

/** 不完整的帧头，用来测"数据还没到齐"。 */
function truncated(buffer, keep) {
  return buffer.subarray(0, keep);
}

function framesOf(buffer) {
  return decodeFrames(buffer, { requireMask: false }).frames;
}

test("握手：Sec-WebSocket-Accept", async (t) => {
  await t.test("RFC 6455 给的样例必须算出同一个值", () => {
    // 这是 RFC 里唯一的官方测试向量，算错了浏览器一定连不上
    assert.equal(computeAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  await t.test("Key 必须是 16 字节的 base64", () => {
    assert.equal(isValidKey("dGhlIHNhbXBsZSBub25jZQ=="), true);
    assert.equal(isValidKey("short"), false);
    assert.equal(isValidKey(""), false);
    assert.equal(isValidKey(null), false);
    assert.equal(isValidKey(undefined), false);
    assert.equal(isValidKey("!!!!!!!!!!!!!!!!!!!!!!=="), false);
    // 22 个字符 + "==" 的 base64 必然解出 16 字节，所以那个长度检查只是
    // 防止将来把正则改坏时的兜底；真正拦住非法输入的是正则本身
    assert.equal(isValidKey("AAAAAAAAAAAAAAAAAAAAA=="), false, "少一位");
    assert.equal(isValidKey("AAAAAAAAAAAAAAAAAAAAAA=="), true);
  });

  await t.test("pathnameOf 只取路径", () => {
    assert.equal(pathnameOf("/ws"), "/ws");
    assert.equal(pathnameOf("/ws?token=abc"), "/ws");
    assert.equal(pathnameOf("/ws#frag"), "/ws");
    assert.equal(pathnameOf("/ws?a=1#frag"), "/ws");
    assert.equal(pathnameOf("/"), "/");
    // 绝对形式的目标不是浏览器会发的，明确拒掉好过猜
    assert.throws(() => pathnameOf("ws://127.0.0.1:3000/ws"), /不是路径/);
    assert.throws(() => pathnameOf(""), /没有请求目标/);
    assert.throws(() => pathnameOf(null), /没有请求目标/);
  });
});

test("编帧", async (t) => {
  await t.test("短消息是两字节头", () => {
    const frame = encodeFrame("hi");
    assert.equal(frame[0], 0x81, "FIN + 文本帧");
    assert.equal(frame[1], 2, "服务端发出的帧不加掩码");
    assert.equal(frame.subarray(2).toString("utf8"), "hi");
  });

  await t.test("126 ~ 65535 字节用 16 位长度", () => {
    const payload = "a".repeat(300);
    const frame = encodeFrame(payload);
    assert.equal(frame[0], 0x81);
    assert.equal(frame[1], 126);
    assert.equal(frame.readUInt16BE(2), 300);
    assert.equal(frame.length, 4 + 300);
  });

  await t.test("超过 65535 字节用 64 位长度", () => {
    // MAX_PAYLOAD 是 65536，所以 64 位长度这条分支只在 65536 这一个尺寸上走到。
    // 别把它删掉：一旦今后放宽 MAX_PAYLOAD，这里就是唯一的回归防线
    const payload = Buffer.alloc(MAX_PAYLOAD, 0x61);
    const frame = encodeFrame(payload);
    assert.equal(frame[1], 127);
    assert.equal(frame.readBigUInt64BE(2), BigInt(MAX_PAYLOAD));
    assert.equal(frame.length, 10 + MAX_PAYLOAD);
  });

  await t.test("正好等于上限可以发，多一个字节就抛", () => {
    assert.doesNotThrow(() => encodeFrame(Buffer.alloc(MAX_PAYLOAD)));
    assert.throws(() => encodeFrame(Buffer.alloc(MAX_PAYLOAD + 1)), /超过上限/);
  });

  await t.test("opcode 与 fin 可控", () => {
    assert.equal(encodeFrame("x", { opcode: OPCODE.PING })[0], 0x89);
    assert.equal(encodeFrame("x", { opcode: OPCODE.BINARY })[0], 0x82);
    assert.equal(encodeFrame("x", { fin: false })[0], 0x01);
  });

  await t.test("超过上限要抛错，而不是编一个对面解不开的帧", () => {
    assert.throws(() => encodeFrame(Buffer.alloc(MAX_PAYLOAD + 1)), /超过上限/);
  });

  await t.test("关闭帧带 2 字节状态码", () => {
    const frame = encodeClose(1002, "坏了");
    assert.equal(frame[0], 0x88);
    const payload = frame.subarray(2);
    assert.equal(payload.readUInt16BE(0), 1002);
    assert.equal(payload.subarray(2).toString("utf8"), "坏了");
  });

  await t.test("关闭原因是 UTF-8 中文时截断也要落在字符边界内", () => {
    const frame = encodeClose(1008, "很".repeat(200));
    const payload = frame.subarray(2);
    assert.ok(payload.length <= 125, `控制帧载荷 ${payload.length} 字节，超过 125 就非法了`);
    const reason = payload.subarray(2).toString("utf8");
    assert.equal(reason.includes("\ufffd"), false, "截断不许把一个汉字劈成两半");
  });
});

test("拆帧", async (t) => {
  await t.test("一条完整的文本帧", () => {
    const { frames, rest } = decodeFrames(clientFrame("没听懂"));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].opcode, OPCODE.TEXT);
    assert.equal(frames[0].fin, true);
    assert.equal(frames[0].payload.toString("utf8"), "没听懂");
    assert.equal(rest.length, 0);
  });

  await t.test("数据没到齐时什么都不返回，且一个字节都不丢", () => {
    const frame = clientFrame("一二三四五");
    for (let keep = 0; keep < frame.length; keep += 1) {
      const { frames, rest } = decodeFrames(truncated(frame, keep));
      assert.equal(frames.length, 0, `只收到 ${keep} 字节时不该凑出一帧`);
      assert.equal(rest.length, keep);
    }
    // 补齐最后几个字节就出来了
    const { frames } = decodeFrames(frame);
    assert.equal(frames[0].payload.toString("utf8"), "一二三四五");
  });

  await t.test("一次收到两帧能全拆出来", () => {
    const buffer = Buffer.concat([clientFrame("一"), clientFrame("二")]);
    const { frames, rest } = decodeFrames(buffer);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].payload.toString("utf8"), "一");
    assert.equal(frames[1].payload.toString("utf8"), "二");
    assert.equal(rest.length, 0);
  });

  await t.test("一帧半：先出一帧，剩下的留在 rest 里", () => {
    const half = clientFrame("半截");
    const full = Buffer.concat([clientFrame("完整"), half]);
    const keep = 3; // 只留下半截帧的头 3 个字节
    const { frames, rest } = decodeFrames(truncated(full, full.length - (half.length - keep)));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.toString("utf8"), "完整");
    assert.equal(rest.length, keep, "不完整的帧要原样留在 rest 里等后续字节");
  });

  await t.test("掩码是按字节位置循环的，不是按帧重置", () => {
    // 同一段明文，两个不同的掩码 key 编出来的字节必须不同 ——
    // 否则说明掩码根本没生效，只是碰巧对上了
    const a = clientFrame("abcdef", { mask: Buffer.from([1, 2, 3, 4]) });
    const b = clientFrame("abcdef", { mask: Buffer.from([4, 3, 2, 1]) });
    assert.notEqual(a.subarray(6).toString("hex"), b.subarray(6).toString("hex"));
    assert.equal(decodeFrames(a).frames[0].payload.toString("utf8"), "abcdef");
    assert.equal(decodeFrames(b).frames[0].payload.toString("utf8"), "abcdef");
  });

  await t.test("requireMask:false 时能解自己的出站帧", () => {
    const frame = encodeFrame("服务端发的");
    const { frames } = decodeFrames(frame, { requireMask: false });
    assert.equal(frames[0].payload.toString("utf8"), "服务端发的");
  });
});

test("拆帧时的协议错误", async (t) => {
  const cases = [
    ["没有掩码的客户端帧", () => {
      const frame = encodeFrame("hi"); // 服务端风格的帧，没有掩码
      return frame;
    }, /掩码/],
    ["RSV 位被置起来", () => clientFrame("hi", { rsv: 0x40 }), /RSV/],
    ["16 位长度却是用 126 编码的小数", () => {
      const body = Buffer.from("hi");
      return Buffer.concat([Buffer.from([0x81, 0x80 | 126, 0x00, 0x02]), Buffer.from([1, 2, 3, 4]), body]);
    }, /最短/],
    ["64 位长度却小于 65536", () => {
      const body = Buffer.from("hi");
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(2n);
      return Buffer.concat([Buffer.from([0x81, 0x80 | 127]), length, Buffer.from([1, 2, 3, 4]), body]);
    }, /最短/],
    ["控制帧载荷超过 125 字节", () => {
      const body = Buffer.alloc(126, 0x61);
      return Buffer.concat([Buffer.from([0x89, 0x80 | 126, 0x00, 126]), Buffer.from([1, 2, 3, 4]), body]);
    }, /控制帧太长/],
    ["控制帧被分片", () => clientFrame("x", { opcode: OPCODE.PING, fin: false }), /不允许分片/],
  ];

  for (const [name, build, pattern] of cases) {
    await t.test(name, () => {
      assert.throws(() => decodeFrames(build()), (err) => {
        assert.ok(err instanceof WebSocketProtocolError, `${name} 应该抛 WebSocketProtocolError`);
        assert.equal(err.code, CLOSE_CODE.PROTOCOL_ERROR);
        assert.match(err.message, pattern);
        return true;
      });
    });
  }

  await t.test("声明的长度超过上限时立刻拒绝，不等数据", () => {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(MAX_PAYLOAD + 1));
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | 127]), length]);
    assert.throws(() => decodeFrames(frame), (err) => {
      assert.equal(err.code, CLOSE_CODE.TOO_LARGE);
      return true;
    });
  });
});

test("分片组装", async (t) => {
  await t.test("未分片的帧直接就算一条完整消息", () => {
    const assembler = createMessageAssembler();
    const message = assembler.push({ opcode: OPCODE.TEXT, fin: true, payload: Buffer.from("hi") });
    assert.equal(message.payload.toString("utf8"), "hi");
  });

  await t.test("两段拼一条", () => {
    const assembler = createMessageAssembler();
    assert.equal(assembler.push({ opcode: OPCODE.TEXT, fin: false, payload: Buffer.from("没听") }), null);
    const message = assembler.push({ opcode: OPCODE.CONTINUATION, fin: true, payload: Buffer.from("懂") });
    assert.equal(message.opcode, OPCODE.TEXT);
    assert.equal(message.payload.toString("utf8"), "没听懂");
  });

  await t.test("三段拼一条", () => {
    const assembler = createMessageAssembler();
    assembler.push({ opcode: OPCODE.TEXT, fin: false, payload: Buffer.from("a") });
    assert.equal(
      assembler.push({ opcode: OPCODE.CONTINUATION, fin: false, payload: Buffer.from("b") }),
      null,
    );
    const message = assembler.push({ opcode: OPCODE.CONTINUATION, fin: true, payload: Buffer.from("c") });
    assert.equal(message.payload.toString("utf8"), "abc");
  });

  await t.test("拼完之后状态清干净，下一条不受影响", () => {
    const assembler = createMessageAssembler();
    assembler.push({ opcode: OPCODE.TEXT, fin: false, payload: Buffer.from("a") });
    assembler.push({ opcode: OPCODE.CONTINUATION, fin: true, payload: Buffer.from("b") });
    const next = assembler.push({ opcode: OPCODE.TEXT, fin: true, payload: Buffer.from("c") });
    assert.equal(next.payload.toString("utf8"), "c");
  });

  await t.test("没有起始帧的续帧要抛错", () => {
    const assembler = createMessageAssembler();
    assert.throws(
      () => assembler.push({ opcode: OPCODE.CONTINUATION, fin: true, payload: Buffer.from("x") }),
      /没有起始帧/,
    );
  });

  await t.test("上一条还没拼完就插进新的一条要抛错", () => {
    const assembler = createMessageAssembler();
    assembler.push({ opcode: OPCODE.TEXT, fin: false, payload: Buffer.from("a") });
    assert.throws(
      () => assembler.push({ opcode: OPCODE.TEXT, fin: true, payload: Buffer.from("b") }),
      /还没结束/,
    );
  });

  await t.test("分片总长超上限要抛错并清空状态", () => {
    const assembler = createMessageAssembler({ maxPayload: 10 });
    assembler.push({ opcode: OPCODE.TEXT, fin: false, payload: Buffer.alloc(6) });
    assert.throws(
      () => assembler.push({ opcode: OPCODE.CONTINUATION, fin: false, payload: Buffer.alloc(6) }),
      /超过上限/,
    );
    // 出错之后要能继续用，不然这条连接上后面的消息全废
    const next = assembler.push({ opcode: OPCODE.TEXT, fin: true, payload: Buffer.from("ok") });
    assert.equal(next.payload.toString("utf8"), "ok");
  });
});

/** 一个假 socket，让 WebSocketConnection 可以脱离网络单独测。 */
function fakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writableLength = 0;
  socket.written = [];
  socket.setNoDelay = () => {};
  socket.remoteAddress = "10.0.0.9";
  socket.remotePort = 50000;
  socket.write = (chunk) => {
    socket.written.push(Buffer.from(chunk));
    return true;
  };
  socket.end = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
  };
  socket.lastFrame = () => framesOf(Buffer.concat(socket.written)).at(-1) ?? null;
  return socket;
}

function makeConn(options) {
  const socket = fakeSocket();
  const conn = new WebSocketConnection(socket, options);
  return { socket, conn };
}

test("连接：收消息与发消息", async (t) => {
  await t.test("收到一条文本帧会触发 message", () => {
    const { conn } = makeConn();
    const received = [];
    conn.on("message", (text) => received.push(text));
    conn.feed(clientFrame("没听懂"));
    assert.deepEqual(received, ["没听懂"]);
    assert.equal(conn.messagesReceived, 1);
  });

  await t.test("粘包时分片到达也能正确还原", () => {
    const { conn } = makeConn();
    const received = [];
    conn.on("message", (text) => received.push(text));
    const frame = clientFrame("再讲一遍");
    for (let i = 0; i < frame.length; i += 1) conn.feed(frame.subarray(i, i + 1));
    assert.deepEqual(received, ["再讲一遍"], "一个字节一个字节喂也要能拼回来");
  });

  await t.test("两个数据块各带半条中文，不能把汉字劈坏", () => {
    const { conn } = makeConn();
    const received = [];
    conn.on("message", (text) => received.push(text));
    const frame = clientFrame("举栗子");
    conn.feed(frame.subarray(0, frame.length - 2));
    conn.feed(frame.subarray(frame.length - 2));
    assert.deepEqual(received, ["举栗子"]);
  });

  await t.test("分片帧组成的消息照常触发一次 message", () => {
    const { conn } = makeConn();
    const received = [];
    conn.on("message", (text) => received.push(text));
    conn.feed(clientFrame("没听懂", { fin: false }));
    conn.feed(clientFrame("吗", { opcode: OPCODE.CONTINUATION, fin: true }));
    assert.deepEqual(received, ["没听懂吗"], "整条消息只触发一次，不是两次");
  });

  await t.test("send 出去的帧没有掩码、opcode 是文本", () => {
    const { socket, conn } = makeConn();
    assert.equal(conn.send("你好"), true);
    const frame = socket.lastFrame();
    assert.equal(frame.opcode, OPCODE.TEXT);
    assert.equal(frame.payload.toString("utf8"), "你好");
  });

  await t.test("sendJson 编成 JSON 文本", () => {
    const { socket, conn } = makeConn();
    conn.sendJson({ type: "joined", online: 3 });
    assert.deepEqual(JSON.parse(socket.lastFrame().payload.toString("utf8")), { type: "joined", online: 3 });
  });

  await t.test("二进制帧走 binary 事件，不走 message", () => {
    const { conn } = makeConn();
    const texts = [];
    const bins = [];
    conn.on("message", (text) => texts.push(text));
    conn.on("binary", (buf) => bins.push(buf));
    conn.feed(clientFrame(Buffer.from([0xef, 0xbf, 0xbd]), { opcode: OPCODE.BINARY }));
    assert.equal(texts.length, 0);
    assert.equal(bins.length, 1);
    assert.deepEqual([...bins[0]], [0xef, 0xbf, 0xbd], "二进制里的 EF BF BD 不该被当成乱码");
  });

  await t.test("非法 UTF-8 的文本帧要按 1007 拒绝", () => {
    const { socket, conn } = makeConn();
    const errors = [];
    conn.on("error", (err) => errors.push(err));
    conn.feed(clientFrame(Buffer.from([0xff, 0xfe, 0xfd])));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, CLOSE_CODE.INVALID_PAYLOAD);
    assert.equal(socket.lastFrame().payload.readUInt16BE(0), CLOSE_CODE.INVALID_PAYLOAD);
  });

  await t.test("关掉的连接上 send 返回 false，不抛错", () => {
    const { conn } = makeConn();
    conn.terminate();
    assert.equal(conn.send("还有人在广播"), false);
    assert.equal(conn.isOpen, false);
    assert.equal(conn.readyState, 3);
  });
});

test("连接：心跳", async (t) => {
  await t.test("收到 ping 自动回 pong", () => {
    const { socket, conn } = makeConn();
    conn.feed(clientFrame("", { opcode: OPCODE.PING }));
    const frame = socket.lastFrame();
    assert.equal(frame.opcode, OPCODE.PONG);
    assert.equal(frame.payload.length, 0);
  });

  await t.test("收到 pong 会把 isAlive 置回 true", () => {
    const { conn } = makeConn();
    conn.isAlive = false;
    conn.feed(clientFrame("", { opcode: OPCODE.PONG }));
    assert.equal(conn.isAlive, true);
  });

  await t.test("ping() 发的是空载荷的 ping 帧", () => {
    const { socket, conn } = makeConn();
    conn.ping();
    const frame = socket.lastFrame();
    assert.equal(frame.opcode, OPCODE.PING);
    assert.equal(frame.payload.length, 0);
  });
});

test("连接：关闭握手", async (t) => {
  await t.test("收到关闭帧会回一个，然后才算关掉", () => {
    const { socket, conn } = makeConn();
    const closed = [];
    conn.on("close", (code) => closed.push(code));

    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(CLOSE_CODE.NORMAL, 0);
    conn.feed(clientFrame(payload, { opcode: OPCODE.CLOSE }));

    assert.deepEqual(closed, [CLOSE_CODE.NORMAL]);
    assert.equal(conn.closed, true);
    assert.equal(socket.lastFrame().opcode, OPCODE.CLOSE);
  });

  await t.test("自己发起 close 会先进入 CLOSING，等对方回", () => {
    const { socket, conn } = makeConn();
    assert.equal(conn.close(1000, "下课了"), true);
    assert.equal(conn.readyState, 2);
    assert.equal(conn.closed, false, "还没真的关掉");
    assert.equal(socket.lastFrame().payload.readUInt16BE(0), 1000);
    assert.equal(conn.close(), false, "重复关闭不该再发一帧");
  });

  await t.test("协议错误时按错误码关闭并断开", () => {
    const { socket, conn } = makeConn();
    const errors = [];
    const closed = [];
    conn.on("error", (err) => errors.push(err));
    conn.on("close", (code) => closed.push(code));

    conn.feed(encodeFrame("没有掩码")); // 服务端风格的帧
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, CLOSE_CODE.PROTOCOL_ERROR);
    assert.deepEqual(closed, [CLOSE_CODE.PROTOCOL_ERROR]);
    assert.equal(socket.destroyed, true);
    assert.equal(socket.lastFrame().payload.readUInt16BE(0), CLOSE_CODE.PROTOCOL_ERROR);
  });

  await t.test("terminate 不等对方，直接断", () => {
    const { socket, conn } = makeConn();
    const closed = [];
    conn.on("close", (code) => closed.push(code));
    conn.terminate();
    assert.equal(socket.destroyed, true);
    assert.deepEqual(closed, [CLOSE_CODE.GOING_AWAY]);
  });

  await t.test("socket 自己断了也要通知上层，且只通知一次", () => {
    const { socket, conn } = makeConn();
    let count = 0;
    conn.on("close", () => {
      count += 1;
    });
    socket.emit("close");
    socket.emit("close");
    assert.equal(count, 1);
  });

  await t.test("积压太多就直接断开这条连接", () => {
    const { socket, conn } = makeConn({ maxBufferedBytes: 10 });
    const errors = [];
    conn.on("error", (err) => errors.push(err));
    socket.writableLength = 999;
    assert.equal(conn.send("发不出去"), false);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /积压/);
    assert.equal(socket.destroyed, true);
  });
});

/** 起一个真实的 http 服务 + WebSocket 端点。 */
async function startServer(t, options = {}) {
  const server = createServer((req, res) => {
    const body = "没有 HTTP 路由";
    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const connections = [];
  const handle = attachWebSocket({
    server,
    logger: silent,
    pingIntervalMs: options.pingIntervalMs ?? 60_000,
    onConnection: (conn) => {
      connections.push(conn);
      options.onConnection?.(conn);
    },
  });

  t.after(() => {
    handle.close();
    server.closeAllConnections?.();
    server.close();
  });

  const { port } = server.address();
  return { server, handle, connections, port, url: `ws://127.0.0.1:${port}/ws` };
}

function openClient(url) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    client.onopen = () => resolve(client);
    client.onerror = () => reject(new Error(`连不上 ${url}`));
  });
}

function waitClose(client) {
  return new Promise((resolve) => {
    client.onclose = (event) => resolve(event);
  });
}

test("端到端：真的连一次", async (t) => {
  await t.test("握手成功、收发中文、正常关闭", async () => {
    const { url, handle } = await startServer(t, {
      onConnection: (conn) => conn.on("message", (text) => conn.send(`echo:${text}`)),
    });

    const client = await openClient(url);
    assert.equal(handle.size, 1);

    const reply = await new Promise((resolve) => {
      client.onmessage = (event) => resolve(event.data);
      client.send("没听懂");
    });
    assert.equal(reply, "echo:没听懂");

    const closed = waitClose(client);
    client.close();
    const event = await closed;
    assert.equal(event.code, 1000);
    assert.equal(handle.size, 0, "断开之后端点里不该还留着这条连接");
  });

  await t.test("多条消息按顺序到达", async () => {
    const { url } = await startServer(t, {
      onConnection: (conn) => conn.on("message", (text) => conn.send(text)),
    });
    const client = await openClient(url);

    const received = [];
    client.onmessage = (event) => received.push(event.data);
    for (const text of ["一", "二", "三"]) client.send(text);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(received, ["一", "二", "三"]);
    client.close();
  });

  await t.test("浏览器的 ping 会被自动回 pong（连接不会因此断掉）", async () => {
    const { url, handle } = await startServer(t, {
      pingIntervalMs: 30,
      onConnection: (conn) => conn.on("message", (text) => conn.send(text)),
    });
    const client = await openClient(url);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(handle.size, 1, "对手动回复 ping 的客户端，心跳不该误杀");
    const reply = await new Promise((resolve) => {
      client.onmessage = (event) => resolve(event.data);
      client.send("还活着");
    });
    assert.equal(reply, "还活着");
    client.close();
  });

  await t.test("不回 pong 的连接会被心跳断掉", async () => {
    const { port, handle } = await startServer(t, { pingIntervalMs: 30 });
    // 用裸 socket 完成握手，然后故意不读不回
    const raw = net.connect(port, "127.0.0.1");
    await new Promise((resolve) => raw.once("connect", resolve));
    raw.write(
      "GET /ws HTTP/1.1\r\n"
      + `Host: 127.0.0.1:${port}\r\n`
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
      + "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    await new Promise((resolve) => raw.once("data", resolve));
    assert.equal(handle.size, 1);

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(handle.size, 0, "两个心跳周期没响应就该被断掉");
    raw.destroy();
  });
});

/** 手工拼一个升级请求。用裸 socket 是因为要测的正是浏览器不会发的那几种请求。 */
function rawUpgradeRequest(port, options = {}) {
  const {
    path = "/ws",
    key = "dGhlIHNhbXBsZSBub25jZQ==",
    version = "13",
    upgrade = "websocket",
  } = options;
  const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade"];
  if (upgrade !== null) lines.push(`Upgrade: ${upgrade}`);
  if (key !== null) lines.push(`Sec-WebSocket-Key: ${key}`);
  if (version !== null) lines.push(`Sec-WebSocket-Version: ${version}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** 发一段原始请求，收集 response 直到安静下来。 */
async function sendRaw(port, request, waitMs = 150) {
  const raw = net.connect(port, "127.0.0.1");
  await new Promise((resolve) => raw.once("connect", resolve));
  raw.write(request);
  const response = await new Promise((resolve) => {
    let data = "";
    raw.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    setTimeout(() => resolve(data), waitMs);
  });
  raw.destroy();
  return response;
}

test("端到端：握手被拒绝的情况", async (t) => {
  await t.test("别的路径回 404，不走 WebSocket", async () => {
    const { port, handle } = await startServer(t);
    const response = await sendRaw(port, rawUpgradeRequest(port, { path: "/api/other" }));
    assert.match(response, /^HTTP\/1\.1 404/);
    assert.equal(handle.size, 0);
  });

  await t.test("Key 不合法回 400", async () => {
    const { port, handle } = await startServer(t);
    const response = await sendRaw(port, rawUpgradeRequest(port, { key: "not-a-valid-key" }));
    assert.match(response, /^HTTP\/1\.1 400/);
    assert.match(response, /Sec-WebSocket-Key/);
    assert.equal(handle.size, 0);
  });

  await t.test("版本不是 13 回 426 并告知支持 13", async () => {
    const { port, handle } = await startServer(t);
    const response = await sendRaw(port, rawUpgradeRequest(port, { version: "8" }));
    assert.match(response, /^HTTP\/1\.1 426/);
    assert.match(response, /Sec-WebSocket-Version: 13/);
    assert.equal(handle.size, 0);
  });

  await t.test("没有 Upgrade 头时压根不会走到 WebSocket 层，Node 自己当普通请求处理", async () => {
    // 这是 Node 的行为，不是我们写的：llhttp 判定这不是升级请求，
    // 于是走正常的 request 事件。记录在这里是为了将来别误以为是 bug
    const { port, handle } = await startServer(t);
    const response = await sendRaw(port, rawUpgradeRequest(port, { upgrade: null }));
    assert.match(response, /^HTTP\/1\.1 404/);
    assert.match(response, /没有 HTTP 路由/);
    assert.equal(handle.size, 0);
  });

  await t.test("缺少 Sec-WebSocket-Version 也回 426", async () => {
    const { port, handle } = await startServer(t);
    const response = await sendRaw(port, rawUpgradeRequest(port, { version: null }));
    assert.match(response, /^HTTP\/1\.1 426/);
    assert.equal(handle.size, 0);
  });

  await t.test("普通 HTTP 请求照常走 HTTP，不受影响", async () => {
    const { port } = await startServer(t);
    const response = await new Promise((resolve, reject) => {
      const req = net.connect(port, "127.0.0.1");
      req.on("connect", () => {
        req.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      });
      let data = "";
      req.on("data", (chunk) => {
        data += chunk.toString();
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
    assert.match(response, /^HTTP\/1\.1 404/);
    assert.match(response, /没有 HTTP 路由/);
  });
});

test("attachWebSocket 的入参检查", async (t) => {
  await t.test("没有 server 直接抛错", () => {
    assert.throws(() => attachWebSocket(), /http\.Server/);
    assert.throws(() => attachWebSocket({}), /http\.Server/);
  });

  await t.test("close 之后不再接受新连接", async () => {
    const { port, handle } = await startServer(t);
    handle.close();
    const response = await sendRaw(port, rawUpgradeRequest(port), 200);
    assert.doesNotMatch(response, /101 Switching Protocols/, "关掉之后不许再握手成功");
    assert.equal(handle.size, 0, "关掉之后不许再留下连接");
  });

  await t.test("close 是幂等的", async () => {
    const { handle } = await startServer(t);
    handle.close();
    assert.doesNotThrow(() => handle.close());
  });
});
