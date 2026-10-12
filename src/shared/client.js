/**
 * 浏览器这一侧的连接管理（技术方案 §4.3.2）。
 *
 * 这个文件只干一件事：**让页面永远不用自己处理断线**。页面调 `onEvent`
 * 拿到消息、调 `send` 发消息，剩下的全部在这层：
 *
 * · 指数退避重连 1s→2s→4s→…→10s 封顶（§4.3.2）
 * · 重连成功之后先 `onReset()` 再让消息进来。这一条是这个协议里最重要的
 *   约定：增量同步是幽灵弹幕的温床 —— 页面以为自己知道屏幕上有哪些弹幕，
 *   而它其实只是知道上一次连接时屏幕上有哪些。
 * · deviceId 由服务端下发、客户端存下来，重连时带上。不带的话，同一个人在
 *   服务端看来每次重连都是新设备，限流就追不住他（§4.5）。
 * · 静默超时的看门狗。浏览器看不到 WebSocket 协议层的 ping/pong，所以
 *   "服务还在不在"只能靠"有没有业务消息"。真误判了也不要紧：重连是幂等的，
 *   代价只是重新 join 一次。
 */

export const STATUS = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  OPEN: "open",
  RECONNECTING: "reconnecting",
  CLOSED: "closed",
});

/** 第 n 次重试要等多久。第 1 次 1s，第 2 次 2s，第 3 次 4s，之后 10s 封顶。 */
export function backoffDelay(attempt, { baseMs = 1000, maxMs = 10_000 } = {}) {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  return Math.min(baseMs * 2 ** (n - 1), maxMs);
}

export function createClassroomClient(options = {}) {
  const {
    url,
    join = {},
    WebSocketImpl = globalThis.WebSocket,
    /**
     * 这里必须用箭头函数包一层，不能写成 `{ setTimeout: globalThis.setTimeout }`。
     *
     * 浏览器里的 `window.setTimeout` 要求 `this` 就是 `window`。一旦把它拆出来
     * 存进一个普通对象，调用时 `this` 变成了那个对象，浏览器直接抛
     * `TypeError: Illegal invocation` —— 而 Node 完全不检查 `this`，
     * 所以这个 bug 在单元测试里永远是绿的，只在真浏览器里炸。
     *
     * 包一层之后 `globalThis.setTimeout(...)` 是以 `globalThis` 为接收者调用的，
     * 而且每次调用时才取，注入的假定时器也能生效。
     */
    timers = {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id),
    },
    onEvent = () => {},
    onStatus = () => {},
    onReset = () => {},
    onDeviceId = () => {},
    watchdogMs = 90_000,
    logger = console,
  } = options;

  if (!url) throw new TypeError("createClassroomClient 需要 url");
  if (typeof WebSocketImpl !== "function") {
    throw new TypeError("这个环境里没有 WebSocket，也没有注入 WebSocketImpl");
  }

  let socket = null;
  let status = STATUS.IDLE;
  let attempt = 0;
  let retryTimer = null;
  let watchdogTimer = null;
  let closedByUs = false;
  let deviceId = options.deviceId ?? null;

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus(status);
  }

  function clearWatchdog() {
    if (watchdogTimer !== null) timers.clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }

  /**
   * 静默看门狗。收到任何业务消息都会重置它。
   *
   * 阈值刻意给得很松（90 秒）：课堂上通常几十秒就会有一条弹幕或一次状态变化，
   * 而阈值给紧了会出现"安静的课堂里客户端每 90 秒无意义地重连一次"。
   * 就算真的误判，重连也只是重新 join 一次 —— 幂等、无副作用。
   */
  function bumpWatchdog() {
    clearWatchdog();
    if (watchdogMs <= 0) return;
    watchdogTimer = timers.setTimeout(() => {
      logger.warn?.("[client] 太久没收到任何消息，当成断线处理");
      // 主动 close 会走到 onclose 那条路，于是走正常的重连逻辑
      socket?.close();
    }, watchdogMs);
  }

  function sendRaw(event, payload) {
    if (!socket || status !== STATUS.OPEN) return false;
    try {
      socket.send(JSON.stringify({ event, payload }));
      return true;
    } catch (err) {
      logger.warn?.("[client] 发送失败", err);
      return false;
    }
  }

  function scheduleRetry() {
    if (closedByUs) return;
    attempt += 1;
    const delay = backoffDelay(attempt);
    setStatus(STATUS.RECONNECTING);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      open();
    }, delay);
  }

  function open() {
    if (closedByUs) return;
    setStatus(attempt === 0 ? STATUS.CONNECTING : STATUS.RECONNECTING);

    let next;
    try {
      next = new WebSocketImpl(url);
    } catch (err) {
      logger.warn?.("[client] 打不开连接", err);
      scheduleRetry();
      return;
    }
    socket = next;

    next.addEventListener("open", () => {
      if (closedByUs) return;
      attempt = 0;
      setStatus(STATUS.OPEN);
      // 顺序很重要：先让页面把上一次连接留下的东西全忘了，再加入。
      // §4.3.2：重连之后客户端必须清空本地队列并重建
      onReset();
      sendRaw("join", deviceId ? { ...join, deviceId } : { ...join });
      bumpWatchdog();
    });

    next.addEventListener("message", (event) => {
      bumpWatchdog();
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        logger.warn?.("[client] 收到不是 JSON 的消息");
        return;
      }
      if (message?.event === "joined") {
        const id = message.payload?.deviceId;
        if (id && id !== deviceId) {
          deviceId = id;
          onDeviceId(id);
        }
      }
      onEvent(message);
    });

    next.addEventListener("close", () => {
      clearWatchdog();
      if (socket !== next) return;
      socket = null;
      if (closedByUs) {
        setStatus(STATUS.CLOSED);
        return;
      }
      scheduleRetry();
    });

    next.addEventListener("error", () => {
      // 浏览器在 error 之后一定会再发一个 close，重连逻辑只需要写在 close 里
      logger.warn?.("[client] 连接出错");
    });
  }

  return {
    get status() {
      return status;
    },
    get deviceId() {
      return deviceId;
    },
    get ready() {
      return status === STATUS.OPEN;
    },
    open,
    send: sendRaw,
    close() {
      closedByUs = true;
      clearWatchdog();
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      retryTimer = null;
      try {
        socket?.close();
      } catch {
        // 已经断了就算了
      }
      socket = null;
      setStatus(STATUS.CLOSED);
    },
  };
}
