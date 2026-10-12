/**
 * 传输与会话之间的胶水层。
 *
 * 这一层**不做任何业务判断**。它只干三件事：
 *
 * 1. 把浏览器发来的 JSON 原样交给 `session.receive`，再把 `drain` 产生的
 *    出站数组按房间投递出去。限流、屏蔽词、聚合、视图隔离全部在 session 里，
 *    这里一条规则都不重复 —— 规则散在两个地方就一定会有一个地方先过期。
 *
 * 2. 按会话自己的连接表解析房间。"谁在哪个房间"只有一个真相来源：
 *    没 join 过的连接没有角色，因此不在任何房间里，什么都收不到。
 *
 * 3. 按固定节拍排空队列。老师的指令要"按下去就生效"，不能等到下一个
 *    学生发言才被顺带处理 —— 没人发言的教室恰恰是老师最需要操作的时候。
 *
 * 隔离的意义：将来真要换成 socket.io，只需要重写这一个文件和
 * `websocket.js`，session 及其全部测试原封不动。
 */

import { ERROR_CODE, ROLE, ROOM, S2C, isPlainObject } from "../../shared/protocol.js";

/**
 * 排空节拍。50ms 意味着老师指令最坏晚 50ms 生效（§9 的 V2 验收是 <1s，
 * 这里留了两个数量级的余量），而聚合广播的 200ms 节流最多被多延迟 50ms。
 * 空转一次只是两个 Map/Set 判空，代价可以忽略。
 */
export const TICK_INTERVAL_MS = 50;

export function createHub(options = {}) {
  const {
    session,
    logger = console,
    clock = () => Date.now(),
    tickMs = TICK_INTERVAL_MS,
  } = options;

  if (!session) throw new TypeError("createHub 需要一个 session");

  /** clientId → 该连接的发送函数。会话知道角色，这里知道往哪儿写。 */
  const sockets = new Map();
  let timer = null;
  let closed = false;

  const counts = { received: 0, sent: 0, malformed: 0, dropped: 0 };

  function roleOf(clientId) {
    return session.clients.get(clientId)?.role ?? null;
  }

  /** 一个房间名 → 该收这条消息的连接。room 也可以是某个 clientId。 */
  function resolveRoom(room) {
    if (room === ROOM.PUBLIC) {
      // 公共房间 = 除了老师以外的所有人（学生页、投影页、弹幕层）。
      // §4.4 的红线就落在这里：发给公共房间的载荷在 session 里已经
      // 逐字段挑过了，这里连一个身份字段都拿不到。
      return [...sockets.keys()].filter((id) => {
        const role = roleOf(id);
        return role !== null && role !== ROLE.HOST;
      });
    }
    if (room === ROOM.HOST) {
      return [...sockets.keys()].filter((id) => roleOf(id) === ROLE.HOST);
    }
    return sockets.has(room) ? [room] : [];
  }

  function deliver(actions) {
    for (const action of actions) {
      if (action.disconnect) {
        // 拉黑要当场把人踢下线，而不是等他下次发言
        kick(action.disconnect.clientId, action.disconnect.reason);
        continue;
      }

      const targets = resolveRoom(action.room);
      if (targets.length === 0) {
        counts.dropped += 1;
        continue;
      }

      const data = JSON.stringify({ event: action.event, payload: action.payload });
      for (const clientId of targets) {
        if (clientId === action.except) continue;
        const write = sockets.get(clientId);
        if (!write) continue;
        if (write(data) !== false) counts.sent += 1;
      }
    }
  }

  function kick(clientId, reason) {
    const write = sockets.get(clientId);
    if (!write) return;
    logger.info?.(`[hub] 断开 ${clientId}：${reason}`);
    write(null);
  }

  /**
   * 一条连接接上来了。
   *
   * `write` 的约定：传字符串就往这条连接上发，传 `null` 就关掉它。
   * 发送函数自己知道"怎么关一条 WebSocket"，hub 不需要知道 ——
   * 这是它跟 `websocket.js` 之间唯一的接口。
   */
  function attach(clientId, write) {
    if (closed) return;
    sockets.set(clientId, write);
  }

  /** 连接断了。会话那边也要知道，否则在线人数会一直挂着一个幽灵。 */
  function detach(clientId) {
    if (!sockets.delete(clientId)) return;
    deliver(session.leave(clientId));
  }

  /**
   * 收一条原始消息。整个函数里唯一相信的东西是"它是一段合法 JSON"，
   * 其余全部交给 session 校验。
   */
  function onMessage(clientId, raw) {
    if (closed) return;

    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      counts.malformed += 1;
      return deliver([
        errorAction(clientId, ERROR_CODE.BAD_MESSAGE, "消息不是合法的 JSON"),
      ]);
    }

    if (!isPlainObject(message) || typeof message.event !== "string") {
      counts.malformed += 1;
      return deliver([
        errorAction(clientId, ERROR_CODE.BAD_MESSAGE, "消息缺少 event 字段"),
      ]);
    }

    counts.received += 1;
    const actions = session.receive(clientId, message.event, message.payload, clock());
    return deliver(actions);
  }

  /** 把队列里攒着的东西处理掉。构造函数不自动调，测试可以自己驱动时间。 */
  function pump() {
    if (closed) return [];
    const actions = session.drain(clock());
    deliver(actions);
    return actions;
  }

  /** 聚合窗口的回收与计数广播。比 pump 慢一档也没关系。 */
  function tick() {
    if (closed) return [];
    const actions = session.heartbeat(clock());
    deliver(actions);
    return actions;
  }

  function start() {
    if (timer || closed) return;
    timer = setInterval(() => {
      // 顺序不能反：先排空队列（老师刚才按的"撤回"），再处理聚合的过期与广播
      pump();
      tick();
    }, tickMs);
    // 测试进程不该被这个定时器吊着不退出
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function close() {
    closed = true;
    stop();
    sockets.clear();
  }

  return {
    tickMs,
    attach,
    detach,
    onMessage,
    pump,
    tick,
    start,
    stop,
    close,
    stats: () => ({ connections: sockets.size, ...counts }),
  };
}

function errorAction(clientId, code, message) {
  return {
    room: clientId,
    event: S2C.ERROR,
    payload: { code, message },
  };
}
