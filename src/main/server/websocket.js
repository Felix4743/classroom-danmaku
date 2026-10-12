/**
 * 零依赖的 WebSocket 服务端（RFC 6455）。
 *
 * 为什么手写而不是用 socket.io / ws：
 *  1. 这台电脑最终要装进一个 portable exe，靠 U 盘带进教室。每多一个
 *     运行时依赖，就多一个"在教室那台机器上解不开"的可能。
 *  2. 教室的外网等于没有外网（§10.1），任何"连不上就退化"的设计都不能要。
 *  3. 我们需要的功能窄得可怜：一个端点、文本帧、25 秒心跳、房间由
 *     应用层自己分（§4.4 的房间隔离是协议层的事，不是传输层的事）。
 *
 * 这个文件只做机械的事：握手、拆帧、组装分片、心跳、关闭。
 * "谁是老师、谁是学生、这条弹幕发给谁"全部在 ws.js 里 —— 这样传输层
 * 可以单独测，将来真换成 socket.io 也只需要替换这一个文件。
 */

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

/** RFC 6455 规定的手握 GUID，不许改。 */
export const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

/** 单条消息上限。弹幕文本最长 100 字，64KB 留足了余量。 */
export const MAX_PAYLOAD = 64 * 1024;

/** 单个连接允许堆积的待发送字节数。超过就说明这个客户端已经跟不上了。 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

/** 控制帧（CLOSE/PING/PONG）的载荷上限，RFC 规定 125 字节。 */
const MAX_CONTROL_PAYLOAD = 125;

/** fatal 模式下遇到非法 UTF-8 会抛错，这正是我们要的。 */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export const CLOSE_CODE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  INVALID_PAYLOAD: 1007,
  POLICY_VIOLATION: 1008,
  TOO_LARGE: 1009,
  INTERNAL_ERROR: 1011,
});

export class WebSocketProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WebSocketProtocolError";
    this.code = code;
  }
}

/** 算出握手响应里的 Sec-WebSocket-Accept。 */
export function computeAccept(key) {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

/** 客户端发来的 Sec-WebSocket-Key 必须是 16 字节的 base64。 */
export function isValidKey(key) {
  if (typeof key !== "string") return false;
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return false;
  return Buffer.from(key, "base64").length === 16;
}

/**
 * 从请求目标里取出路径，丢掉查询串与片段。
 *
 * 故意不走 `new URL()`：那需要一个 base，而"仓库里不许出现任何外部地址"这条
 * 规则（教室的外网等于没有外网，§10.1）是被 tests/unit/static-graph.test.mjs
 * 逐字扫源码强制的，一个纯粹的解析用常量也会被它拦下 —— 与其把测试改松，不如
 * 让代码里真的没有外部地址。升级请求的目标本来就只有 origin-form 这一种形态。
 */
export function pathnameOf(target) {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("升级请求没有请求目标");
  }
  const cut = target.search(/[?#]/);
  const pathOnly = cut === -1 ? target : target.slice(0, cut);
  if (!pathOnly.startsWith("/")) {
    throw new TypeError(`升级请求的目标不是路径：${pathOnly}`);
  }
  return pathOnly;
}

/** 把一条消息编成帧。服务端发出的帧**不加掩码**（RFC 6455 §5.1）。 */
export function encodeFrame(payload, { opcode = OPCODE.TEXT, fin = true } = {}) {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(String(payload ?? ""), "utf8");
  if (body.length > MAX_PAYLOAD) {
    throw new WebSocketProtocolError(CLOSE_CODE.TOO_LARGE, "要发的消息超过上限");
  }

  const header = [];
  header.push((fin ? 0x80 : 0x00) | opcode);

  if (body.length < 126) {
    header.push(body.length);
  } else if (body.length <= 0xffff) {
    header.push(126, (body.length >> 8) & 0xff, body.length & 0xff);
  } else {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(body.length));
    header.push(127, ...length);
  }

  return Buffer.concat([Buffer.from(header), body]);
}

/** 关闭帧的载荷 = 2 字节大端状态码 + UTF-8 原因。 */
export function encodeClose(code = CLOSE_CODE.NORMAL, reason = "") {
  const budget = MAX_CONTROL_PAYLOAD - 2;
  const full = String(reason);
  let text = Buffer.from(full, "utf8");

  if (text.length > budget) {
    // 按**字符**截断，不能按字节 —— 按字节会把一个汉字劈成两半，
    // 对面解出来就是一个 U+FFFD，中文原因全变乱码
    const chars = [...full];
    while (chars.length > 0 && Buffer.byteLength(chars.join(""), "utf8") > budget) {
      chars.pop();
    }
    text = Buffer.from(chars.join(""), "utf8");
  }

  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(payload, { opcode: OPCODE.CLOSE });
}

/**
 * 从 buffer 里读一帧。
 * @returns {{opcode:number, fin:boolean, payload:Buffer, size:number}|null}
 *   null 表示数据还不够一帧，调用方继续等。
 */
function readFrame(buffer, offset, options) {
  const { maxPayload, requireMask } = options;
  if (buffer.length - offset < 2) return null;

  const first = buffer[offset];
  const second = buffer[offset + 1];
  const fin = (first & 0x80) !== 0;
  const rsv = first & 0x70;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let cursor = offset + 2;

  if (rsv !== 0) {
    // 我们没有协商任何扩展，RSV 位必须是 0。非 0 说明对面在发我们看不懂的东西
    throw new WebSocketProtocolError(CLOSE_CODE.PROTOCOL_ERROR, "RSV 位不为 0");
  }
  if (requireMask && !masked) {
    // 客户端到服务端的帧必须加掩码，否则可能是被中间人拼出来的
    throw new WebSocketProtocolError(CLOSE_CODE.PROTOCOL_ERROR, "客户端帧没有加掩码");
  }

  if (length === 126) {
    if (buffer.length - cursor < 2) return null;
    length = buffer.readUInt16BE(cursor);
    cursor += 2;
    if (length < 126) {
      throw new WebSocketProtocolError(CLOSE_CODE.PROTOCOL_ERROR, "长度没有用最短的编码方式");
    }
  } else if (length === 127) {
    if (buffer.length - cursor < 8) return null;
    const big = buffer.readBigUInt64BE(cursor);
    cursor += 8;
    if (big < 65536n) {
      throw new WebSocketProtocolError(CLOSE_CODE.PROTOCOL_ERROR, "长度没有用最短的编码方式");
    }
    if (big > BigInt(maxPayload)) {
      throw new WebSocketProtocolError(CLOSE_CODE.TOO_LARGE, "帧长度超过上限");
    }
    length = Number(big);
  }

  const isControl = (opcode & 0x8) !== 0;
  if (isControl) {
    if (!fin) {
      throw new WebSocketProtocolError(CLOSE_CODE.PROTOCOL_ERROR, "控制帧不允许分片");
    }
    if (length > MAX_CONTROL_PAYLOAD) {
      throw new WebSocketProtocolError(CLOSE_CODE.PROTOCOL_ERROR, "控制帧太长");
    }
  } else if (length > maxPayload) {
    throw new WebSocketProtocolError(CLOSE_CODE.TOO_LARGE, "帧长度超过上限");
  }

  if (buffer.length - cursor < (masked ? 4 : 0) + length) return null;

  let payload;
  if (masked) {
    const mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
    payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) {
      payload[i] = buffer[cursor + i] ^ mask[i & 3];
    }
  } else {
    // 复制一份，这样返回值不会随着 rest 的 slice 而变
    payload = Buffer.from(buffer.subarray(cursor, cursor + length));
  }

  return { opcode, fin, payload, size: cursor + length - offset };
}

/**
 * 把一段（可能不完整的）字节流拆成若干帧。
 *
 * `requireMask` 默认 true（服务端视角：客户端帧必须加掩码）。
 * 传 false 就能解自己的出站帧，测试和将来的客户端实现都用得上。
 *
 * @returns {{frames: Array, rest: Buffer}}
 */
export function decodeFrames(buffer, options = {}) {
  const maxPayload = options.maxPayload ?? MAX_PAYLOAD;
  const requireMask = options.requireMask ?? true;
  const frames = [];
  let offset = 0;

  for (;;) {
    const frame = readFrame(buffer, offset, { maxPayload, requireMask });
    if (!frame) break;
    offset += frame.size;
    frames.push(frame);
  }

  return { frames, rest: offset === 0 ? buffer : buffer.subarray(offset) };
}


/**
 * 把分片拼成完整消息。控制帧不走这里（RFC 不允许它们分片）。
 */
export function createMessageAssembler(options = {}) {
  const maxPayload = options.maxPayload ?? MAX_PAYLOAD;
  let opcode = null;
  let chunks = [];
  let size = 0;

  function reset() {
    opcode = null;
    chunks = [];
    size = 0;
  }

  return {
    reset,
    /**
     * @returns {{opcode:number, payload:Buffer}|null} null 表示还差后续分片
     */
    push(frame) {
      const isContinuation = frame.opcode === OPCODE.CONTINUATION;

      if (isContinuation) {
        if (opcode === null) {
          throw new WebSocketProtocolError(CLOSE_CODE.PROTOCOL_ERROR, "收到没有起始帧的续帧");
        }
      } else if (opcode !== null) {
        throw new WebSocketProtocolError(CLOSE_CODE.PROTOCOL_ERROR, "上一条分片消息还没结束");
      }

      // 没分片的完整消息，直接返回，不碰内部状态
      if (frame.fin && !isContinuation) {
        return { opcode: frame.opcode, payload: frame.payload };
      }

      if (!isContinuation) opcode = frame.opcode;
      chunks.push(frame.payload);
      size += frame.payload.length;
      if (size > maxPayload) {
        reset();
        throw new WebSocketProtocolError(CLOSE_CODE.TOO_LARGE, "分片消息总长超过上限");
      }

      if (!frame.fin) return null;

      const payload = Buffer.concat(chunks, size);
      const result = { opcode, payload };
      reset();
      return result;
    },
  };
}

/**
 * 一条已经握手完成的连接。
 *
 * 事件：`message`(text: string, isBinary: boolean)、`binary`(Buffer)、
 *      `close`(code, reason)、`error`(err)。
 * 另外暴露一个空白的 `data` 对象给上层挂自己的东西（角色、deviceId…），
 * 传输层不关心里面是什么。
 */
export class WebSocketConnection extends EventEmitter {
  constructor(socket, options = {}) {
    super();
    this.id = randomUUID();
    this.data = {};
    this.socket = socket;
    this.maxPayload = options.maxPayload ?? MAX_PAYLOAD;
    this.maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    this.remoteAddress = socket.remoteAddress ?? null;
    this.remotePort = socket.remotePort ?? null;
    this.closed = false;
    this.closing = false;
    this.closeCode = null;
    this.closeReason = "";
    /** 心跳用：上一轮 ping 之后有没有收到 pong。 */
    this.isAlive = true;
    this.bytesReceived = 0;
    this.bytesSent = 0;
    this.messagesReceived = 0;

    this._buffer = Buffer.alloc(0);
    this._assembler = createMessageAssembler({ maxPayload: this.maxPayload });

    socket.setNoDelay?.(true);
    socket.on("data", (chunk) => this.feed(chunk));
    socket.on("error", (err) => this._onSocketError(err));
    socket.on("close", () => this._onSocketClose());
  }

  /** 1=OPEN 2=CLOSING 3=CLOSED，和浏览器保持一致，方便前端复用同一套判断。 */
  get readyState() {
    if (this.closed) return 3;
    if (this.closing) return 2;
    return 1;
  }

  get isOpen() {
    return this.readyState === 1;
  }

  send(data) {
    if (!this.isOpen) return false;
    const isBuffer = Buffer.isBuffer(data);
    const frame = encodeFrame(isBuffer ? data : String(data), {
      opcode: isBuffer ? OPCODE.BINARY : OPCODE.TEXT,
    });
    return this._write(frame);
  }

  sendJson(value) {
    return this.send(JSON.stringify(value));
  }

  ping() {
    if (!this.isOpen) return false;
    return this._write(encodeFrame(Buffer.alloc(0), { opcode: OPCODE.PING }));
  }

  pong() {
    if (!this.isOpen) return false;
    return this._write(encodeFrame(Buffer.alloc(0), { opcode: OPCODE.PONG }));
  }

  /** 正常关闭：给对方一个关闭帧，然后等它回。 */
  close(code = CLOSE_CODE.NORMAL, reason = "") {
    if (this.closed || this.closing) return false;
    this.closing = true;
    this.closeCode = code;
    this.closeReason = reason;
    return this._write(encodeClose(code, reason));
  }

  /** 立刻断掉，不等对方。心跳超时、协议错误、发不出去的时候用。 */
  terminate() {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.socket.destroy();
    this.emit("close", this.closeCode ?? CLOSE_CODE.GOING_AWAY, this.closeReason);
  }

  _write(frame) {
    if (this.socket.destroyed) return false;
    this.bytesSent += frame.length;
    // 写不进去说明对方已经不读了。房间广播时这种情况必须有出口，
    // 否则一条卡住的连接会把整个进程的内存吃光
    if (this.socket.writableLength > this.maxBufferedBytes) {
      this._emitError(new Error("客户端积压太多，断开"));
      this.terminate();
      return false;
    }
    return this.socket.write(frame);
  }

  /**
   * 喂一段原始字节进来。公开出来是为了让测试可以不建真连接就测拆帧，
   * 也用于把握手时顺带读到的 `head` 补进来。
   */
  feed(chunk) {
    if (this.closed) return;
    this.bytesReceived += chunk.length;
    this._buffer = this._buffer.length === 0
      ? chunk
      : Buffer.concat([this._buffer, chunk]);

    let frames;
    let rest;
    try {
      ({ frames, rest } = decodeFrames(this._buffer, { maxPayload: this.maxPayload }));
    } catch (err) {
      this._buffer = Buffer.alloc(0);
      this._fail(err);
      return;
    }
    this._buffer = rest;

    for (const frame of frames) {
      if (this.closed) return;
      try {
        this._handleFrame(frame);
      } catch (err) {
        this._fail(err);
        return;
      }
    }
  }

  _handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.PING:
        this.pong();
        return;
      case OPCODE.PONG:
        this.isAlive = true;
        return;
      case OPCODE.CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : CLOSE_CODE.NORMAL;
        const reason = frame.payload.length > 2
          ? frame.payload.subarray(2).toString("utf8")
          : "";
        // 对方的关闭帧要回一个，然后我们这边就可以断了
        this.closeCode = code;
        this.closeReason = reason;
        if (!this.closing) this._write(encodeClose(code, ""));
        this.closed = true;
        this.socket.end();
        this.emit("close", code, reason);
        return;
      }
      case OPCODE.TEXT:
      case OPCODE.BINARY:
      case OPCODE.CONTINUATION: {
        const message = this._assembler.push(frame);
        if (!message) return;
        this.messagesReceived += 1;
        if (message.opcode === OPCODE.BINARY) {
          this.emit("binary", message.payload);
          return;
        }
        const text = this._decodeText(message.payload);
        this.emit("message", text, false);
        return;
      }
      default:
        throw new WebSocketProtocolError(
          CLOSE_CODE.PROTOCOL_ERROR,
          `不认识的 opcode 0x${frame.opcode.toString(16)}`,
        );
    }
  }

  _decodeText(payload) {
    try {
      return utf8Decoder.decode(payload);
    } catch {
      // 只有文本帧要校验 UTF-8：二进制帧里出现 0xEF 0xBF 0xBD 是正常数据
      throw new WebSocketProtocolError(CLOSE_CODE.INVALID_PAYLOAD, "文本帧不是合法的 UTF-8");
    }
  }

  /**
   * EventEmitter 上 emit("error") 而没有监听者会直接抛出去变成一个
   * 未捕获异常 —— 对一条已经坏掉的连接来说，这比断掉它严重得多。
   */
  _emitError(err) {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  _fail(err) {
    const code = err instanceof WebSocketProtocolError ? err.code : CLOSE_CODE.INTERNAL_ERROR;
    this._emitError(err);
    if (this.closed) return;
    this.closing = true;
    this.closeCode = code;
    this.closeReason = err.message;
    try {
      this._write(encodeClose(code, err.message.slice(0, 100)));
    } catch {
      // 连关闭帧都发不出去，那就只能直接断
    }
    this.closed = true;
    this.socket.destroy();
    this.emit("close", code, err.message);
  }

  _onSocketError(err) {
    if (this.closed) return;
    this._emitError(err);
  }

  _onSocketClose() {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.emit("close", this.closeCode ?? CLOSE_CODE.GOING_AWAY, this.closeReason);
  }
}

/**
 * 把 WebSocket 端点挂到一个 http.Server 上。
 *
 * @param {object} options
 * @param {import("node:http").Server} options.server
 * @param {string} [options.path="/ws"] 只处理这个路径的 upgrade，其它路径回 404
 * @param {number} [options.pingIntervalMs=25000] 心跳间隔（§4.3.3 定的 25 秒）
 * @param {(conn: WebSocketConnection) => void} [options.onConnection]
 * @param {(err: Error, conn: WebSocketConnection) => void} [options.onError]
 * @param {{info?: Function, warn?: Function}} [options.logger]
 */
export function attachWebSocket(options) {
  const {
    server,
    path = "/ws",
    maxPayload = MAX_PAYLOAD,
    pingIntervalMs = 25_000,
    onConnection = null,
    onError = null,
    logger = console,
  } = options ?? {};

  if (!server || typeof server.on !== "function") {
    throw new TypeError("attachWebSocket 需要一个 http.Server");
  }

  /** @type {Set<WebSocketConnection>} */
  const clients = new Set();
  let closed = false;

  function rejectUpgrade(socket, status, message) {
    const body = `${message}\n`;
    socket.write(
      `HTTP/1.1 ${status}\r\n`
      + "Connection: close\r\n"
      + "Content-Type: text/plain; charset=utf-8\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + "\r\n"
      + body,
    );
    socket.destroy();
  }

  function onUpgrade(req, socket, head) {
    if (closed) {
      socket.destroy();
      return;
    }

    let urlPath;
    try {
      urlPath = pathnameOf(req.url);
    } catch {
      rejectUpgrade(socket, "400 Bad Request", "请求行看不懂");
      return;
    }
    if (urlPath !== path) {
      // 教室电脑上可能同时开着别的服务探测这个端口，明确回 404 比静默断掉好排查
      rejectUpgrade(socket, "404 Not Found", `这里没有 WebSocket 端点：${urlPath}`);
      return;
    }

    const key = req.headers["sec-websocket-key"];
    const version = req.headers["sec-websocket-version"];
    const upgrade = String(req.headers.upgrade ?? "").toLowerCase();

    if (upgrade !== "websocket") {
      rejectUpgrade(socket, "400 Bad Request", "Upgrade 头必须是 websocket");
      return;
    }
    if (!isValidKey(key)) {
      rejectUpgrade(socket, "400 Bad Request", "Sec-WebSocket-Key 不合法");
      return;
    }
    if (version !== "13") {
      // 13 是 RFC 6455。老版本（8）是早期草案，浏览器早就不会发了
      socket.write("HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n`
      + "\r\n",
    );

    const conn = new WebSocketConnection(socket, { maxPayload });
    clients.add(conn);
    conn.on("close", () => clients.delete(conn));
    if (onError) conn.on("error", (err) => onError(err, conn));

    logger.info?.(`[ws] 新连接 ${conn.id} 来自 ${conn.remoteAddress}`);
    onConnection?.(conn);

    // 握手时可能已经把 body 读进来了一部分，补喂给解析器
    if (head && head.length > 0) conn.feed(head);
  }

  const heartbeat = setInterval(() => {
    for (const conn of clients) {
      if (!conn.isAlive) {
        logger.warn?.(`[ws] ${conn.id} 两个心跳周期没响应，断开`);
        conn.terminate();
        continue;
      }
      conn.isAlive = false;
      conn.ping();
    }
  }, pingIntervalMs);
  // 别让心跳把测试进程和 CLI 吊着不退出
  heartbeat.unref?.();

  server.on("upgrade", onUpgrade);

  return {
    path,
    pingIntervalMs,
    clients,
    get size() {
      return clients.size;
    },
    broadcast(data) {
      let sent = 0;
      for (const conn of clients) {
        if (conn.send(data)) sent += 1;
      }
      return sent;
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      server.off("upgrade", onUpgrade);
      for (const conn of [...clients]) {
        conn.close(CLOSE_CODE.GOING_AWAY, "服务端关闭");
        conn.terminate();
      }
      clients.clear();
    },
  };
}
