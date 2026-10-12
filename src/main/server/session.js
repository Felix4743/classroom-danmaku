/**
 * 课堂会话（技术方案 §4.3 / §4.4 / §4.6 / §4.7）。
 *
 * 这个文件里**没有一行 I/O**：它不知道 WebSocket 存在，不知道 HTTP 存在，
 * 只是一台"吃进事件、吐出要发的消息"的机器。理由有两个，都不是洁癖：
 *
 *   1. 视图流隔离（§4.4）是本项目唯一的安全红线 —— 发给投影的消息里绝不能
 *      出现学号、姓名、设备号。这条规则如果散落在 ws.js 的 send 调用里，
 *      就只能靠人工 review，而人工 review 一定会退化。放在这里以后，
 *      出站消息是一个**数组**，测试可以把它整个抓下来逐条断言。
 *   2. 传输层是唯一一个我打算将来可能替换掉的部件（换成 socket.io）。
 *      业务逻辑不该跟它绑在一起。
 *
 * 出站消息的形状：
 *   { room, event, payload, except? }   发给某个房间（except 是"除了谁"）
 *   { room: clientId, ... }             发给某一条连接（room 就是 clientId）
 *   { disconnect: { deviceId, reason } } 把某个设备的连接踢掉
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, DANMAKU_COLORS, sanitizeConfig } from "../../shared/config.js";
import { presetById } from "../../shared/presets.js";
import {
  C2S,
  CLIENT_EVENTS,
  ERROR_CODE,
  HOST_ONLY_EVENTS,
  REJECT,
  ROLE,
  ROOM,
  S2C,
  hostDanmaku,
  normalizeClientMessage,
  publicDanmaku,
} from "../../shared/protocol.js";
import { createAggregator } from "./aggregate.js";
import { createContentFilter } from "./filter.js";
import { createDispatcher } from "./dispatch.js";
import { createRateLimiter } from "./ratelimit.js";

/** 置顶最多 3 条，超出按置顶时间淘汰最旧的（§4.7）。 */
export const MAX_PINNED = 3;

/** 老师连上来时补发多少条历史。全量重放没有意义，几百条足够看清"现在在聊什么"。 */
export const REPLAY_LIMIT = 200;

/** 聚合计数每跨过一档就提醒老师一次（§4.6 的"进问题池"）。 */
export const ALERT_STEPS = Object.freeze([5, 10, 20, 40]);

export const DEFAULT_NICKNAME = "匿名同学";

export function createSession(options = {}) {
  const {
    clock = () => Date.now(),
    logger = console,
    config: initialConfig,
    filter = createContentFilter(),
    limiter = createRateLimiter(),
    aggregator = createAggregator(),
    dispatcher = createDispatcher(),
    onExport = null,
    maxItems = 20000,
  } = options;

  let config = sanitizeConfig(initialConfig ?? DEFAULT_CONFIG);
  let paused = false;
  let mutedUntil = 0;
  let clearedAt = 0;

  /** clientId → 连接上的角色与身份 */
  const clients = new Map();
  /** deviceId → { deviceId, nickname, identity, color, firstSeen, lastSeen } */
  const devices = new Map();
  /** id → 弹幕 */
  const items = new Map();
  /** 按时间顺序的 id，用于导出与重放 */
  const order = [];
  /** 聚合桶 key → 已经提醒过老师的档位，避免同一档位反复震动 */
  const alertedSteps = new Map();

  let seq = 0;
  let colorCursor = 0;

  const counts = { accepted: 0, filtered: 0, rateLimited: 0, removed: 0, kicked: 0 };

  // ── 小工具 ──────────────────────────────────────────────────────────

  function send(room, event, payload, except) {
    return except ? { room, event, payload, except } : { room, event, payload };
  }

  function errorTo(clientId, code, message) {
    return send(clientId, S2C.ERROR, { code, message });
  }

  function studentsOnline() {
    const seen = new Set();
    for (const client of clients.values()) {
      if (client.role === ROLE.STUDENT) seen.add(client.deviceId);
    }
    return seen.size;
  }

  function statePayload() {
    return {
      paused,
      mutedUntil,
      clearedAt,
      online: studentsOnline(),
      danmakuCount: items.size,
    };
  }

  /** 发给投影/学生页的完整配置。 */
  function configPayload() {
    return { ...config };
  }

  function deviceFor(deviceId, ts) {
    let device = devices.get(deviceId);
    if (!device) {
      device = {
        deviceId,
        nickname: DEFAULT_NICKNAME,
        identity: null,
        color: DANMAKU_COLORS[colorCursor % DANMAKU_COLORS.length],
        firstSeen: ts,
        lastSeen: ts,
      };
      colorCursor += 1;
      devices.set(deviceId, device);
    }
    return device;
  }

  /** 历史重放与导出都用这一份"带管理字段的完整弹幕"。 */
  function hostItem(item) {
    return {
      ...hostDanmaku(item),
      likes: item.likeCount,
      aggregate: item.aggregate ?? 0,
      pinned: item.pinned,
      resolved: item.resolved,
    };
  }

  function visibleItems() {
    const list = [];
    for (const id of order) {
      const item = items.get(id);
      if (item && !item.removed) list.push(item);
    }
    return list;
  }

  // ── 连接 ────────────────────────────────────────────────────────────

  /**
   * 处理 join。join 是同步的：一条连接在拿到 joined 之前不该发别的东西。
   * @returns {Array} 要发的消息
   */
  function join(input = {}) {
    const ts = input.ts ?? clock();
    const { clientId, role, nickname, identity, ip } = input;

    if (typeof clientId !== "string" || clientId.length === 0) {
      throw new TypeError("join 需要 clientId");
    }

    // 重连时复用原来的 deviceId，限流与拉黑才追得住同一个人
    const deviceId = input.deviceId ?? randomUUID();
    const device = deviceFor(deviceId, ts);
    if (nickname) device.nickname = nickname;
    if (identity) device.identity = identity;
    device.lastSeen = ts;

    if (role === ROLE.STUDENT && limiter.isBanned(deviceId)) {
      counts.kicked += 1;
      return [errorTo(clientId, ERROR_CODE.BANNED, "你已被移出本课弹幕")];
    }

    clients.set(clientId, {
      clientId,
      role,
      deviceId,
      nickname: device.nickname,
      ip: ip ?? null,
      joinedAt: ts,
    });

    const actions = [
      send(clientId, S2C.JOINED, {
        deviceId,
        serverTime: ts,
        config: configPayload(),
        online: studentsOnline(),
      }),
      // §4.3.2：重连之后必须全量同步。增量同步是幽灵弹幕的温床
      send(clientId, S2C.STATE, statePayload()),
    ];

    // 老师还需要看到"现在屏幕上都有什么"，否则刷新一次就瞎了
    if (role === ROLE.HOST) {
      const visible = visibleItems().slice(-REPLAY_LIMIT);
      for (const item of visible) {
        actions.push(send(clientId, S2C.NEW, hostItem(item)));
      }
    }

    actions.push(send(ROOM.HOST, S2C.STATE, statePayload(), clientId));
    return actions;
  }

  function leave(clientId) {
    const client = clients.get(clientId);
    if (!client) return [];
    clients.delete(clientId);
    return [send(ROOM.HOST, S2C.STATE, statePayload())];
  }

  // ── 学生事件 ────────────────────────────────────────────────────────

  function handleSend(client, payload, ts) {
    const { text, presetId, tempId } = payload;

    // 预置按钮优先：它决定聚合计数能否成立（§4.6）
    const preset = presetId ? presetById(presetId) : null;
    const body = preset ? preset.label : text;

    if (!body) {
      return [send(client.clientId, S2C.REJECTED, { tempId, reason: REJECT.EMPTY })];
    }

    if (mutedUntil > ts) {
      counts.rateLimited += 1;
      return [
        send(client.clientId, S2C.RATE_LIMITED, {
          retryAfterMs: mutedUntil - ts,
          message: `全班静音中，还有 ${Math.ceil((mutedUntil - ts) / 1000)} 秒`,
        }),
      ];
    }

    const verdict = limiter.check({ deviceId: client.deviceId, ip: client.ip, ts });
    if (!verdict.allowed) {
      counts.rateLimited += 1;
      return [
        send(client.clientId, S2C.RATE_LIMITED, {
          retryAfterMs: verdict.retryAfterMs,
          message: verdict.message,
        }),
      ];
    }

    const content = filter.check(body);
    if (content.blocked) {
      counts.filtered += 1;
      logger.warn?.(`[session] 拦截一条内容 kind=${content.kind} word=${content.word}`);
      // 只告诉发的人，不广播 —— 被拦下的内容不该再传播一次
      return [send(client.clientId, S2C.REJECTED, { tempId, reason: REJECT.FILTERED })];
    }

    const device = deviceFor(client.deviceId, ts);
    const id = `${ts.toString(36)}-${(seq++).toString(36)}`;
    const item = {
      id,
      text: body,
      nickname: device.nickname,
      color: device.color,
      presetId: preset ? preset.id : null,
      ts,
      deviceId: client.deviceId,
      likes: new Set(),
      likeCount: 0,
      pinned: false,
      pinnedAt: 0,
      resolved: false,
      removed: false,
      aggregate: 0,
      aggregateKey: null,
    };

    items.set(id, item);
    order.push(id);
    trimItems();
    counts.accepted += 1;

    const actions = [
      send(ROOM.PUBLIC, S2C.NEW, publicDanmaku(item), client.clientId),
      // 发的人自己也要收到一份，但带着 tempId，好把本地先回显的那条替换掉
      send(client.clientId, S2C.NEW, { ...publicDanmaku(item), tempId }),
      send(ROOM.HOST, S2C.NEW, hostItem(item)),
    ];

    if (preset) {
      const hit = aggregator.hit({ presetId: preset.id, id, ts });
      item.aggregateKey = hit.key;
      item.aggregate = hit.count;
      // 第一次命中不走节流：学生点了按钮却要等 200ms 才看到自己的弹幕，这个延迟感觉得到
      if (hit.isFirst) {
        actions.push(send(ROOM.PUBLIC, S2C.UPDATE, { id, aggregate: hit.count }));
      }
      const step = crossedStep(hit.count);
      // 提醒档位记在**桶**上，不是记在弹幕上。记在弹幕上的话第 5 条和第 6 条
      // 会各触发一次：第 6 条是新建的 item，它自己的档位又从 0 开始。
      // 老师收到的应该是"这个话题到 5 个人了"，而不是每来一条都震一下。
      if (step > (alertedSteps.get(hit.key) ?? 0)) {
        alertedSteps.set(hit.key, step);
        actions.push(
          send(ROOM.HOST, S2C.HOST_ALERT, {
            id,
            reason: preset.label,
            aggregate: hit.count,
          }),
        );
      }
    }

    return actions;
  }

  function crossedStep(count) {
    let step = 0;
    for (const threshold of ALERT_STEPS) {
      if (count >= threshold) step = threshold;
    }
    return step;
  }

  function handleLike(client, payload, ts) {
    const item = items.get(payload.id);
    // 点一条已经被删掉的弹幕是很正常的事（我看到的瞬间老师删了它），静默忽略
    if (!item || item.removed) return [];

    if (item.likes.has(client.deviceId)) {
      // 幂等，不做取消点赞：课堂上误触取消比误触点赞难受得多
      return [];
    }
    item.likes.add(client.deviceId);
    item.likeCount += 1;

    const actions = [
      send(ROOM.PUBLIC, S2C.UPDATE, { id: item.id, likes: item.likeCount }),
      send(ROOM.HOST, S2C.UPDATE, { id: item.id, likes: item.likeCount }),
    ];
    // 点赞数绝不改变弹幕在滚动流里的位置（§4.7），它只影响问题池排序与热点条
    return actions;
  }

  // ── 老师事件 ────────────────────────────────────────────────────────

  function handleHost(client, event, payload, ts) {
    switch (event) {
      case C2S.HOST_CLEAR: {
        clearedAt = ts;
        // 只是"清屏"，数据一条都不删 —— 导出时老师要看到完整的课堂
        return [send(ROOM.PUBLIC, S2C.STATE, statePayload())];
      }

      case C2S.HOST_PAUSE: {
        paused = payload.paused;
        return [send(ROOM.PUBLIC, S2C.STATE, statePayload())];
      }

      case C2S.HOST_MUTE: {
        mutedUntil = payload.minutes > 0 ? ts + payload.minutes * 60_000 : 0;
        return [send(ROOM.PUBLIC, S2C.STATE, statePayload())];
      }

      case C2S.HOST_REMOVE: {
        const item = items.get(payload.id);
        if (!item || item.removed) return [];
        item.removed = true;
        counts.removed += 1;
        return [
          send(ROOM.PUBLIC, S2C.REMOVE, { id: item.id, reason: "host" }),
          send(ROOM.HOST, S2C.REMOVE, { id: item.id, reason: "host" }),
        ];
      }

      case C2S.HOST_PIN: {
        const item = items.get(payload.id);
        if (!item || item.removed) return [];
        if (payload.pinned) {
          pinItem(item, ts);
        } else {
          item.pinned = false;
          item.pinnedAt = 0;
        }
        return [
          send(ROOM.PUBLIC, S2C.PIN, { id: item.id, pinned: item.pinned }),
          send(ROOM.HOST, S2C.PIN, { id: item.id, pinned: item.pinned }),
        ];
      }

      case C2S.HOST_BAN: {
        const changed = limiter.setBanned(payload.deviceId, payload.banned);
        if (!changed) return [];
        if (!payload.banned) {
          return [send(ROOM.HOST, S2C.STATE, statePayload())];
        }
        // 拉黑要立刻生效：等他自己刷新页面才被挡住，那不叫拉黑
        const actions = [send(ROOM.HOST, S2C.STATE, statePayload())];
        for (const [clientId, other] of clients) {
          if (other.deviceId === payload.deviceId) {
            actions.push({ disconnect: { clientId, reason: "banned" } });
          }
        }
        counts.kicked += 1;
        return actions;
      }

      case C2S.HOST_FETCH_IDENTITY: {
        const item = items.get(payload.id);
        if (!item) return [];
        const device = devices.get(item.deviceId);
        // §4.9：身份默认不下发。只有老师主动要，而且只发给这一个老师
        return [
          send(client.clientId, S2C.HOST_IDENTITY, {
            id: item.id,
            studentId: device?.identity?.studentId ?? null,
            name: device?.identity?.name ?? null,
          }),
        ];
      }

      case C2S.HOST_RESOLVED: {
        const item = items.get(payload.id);
        if (!item || item.resolved) return [];
        // 单向：标记成"已经回应过了"。取消回应在课堂里没有意义
        item.resolved = true;
        return [send(ROOM.HOST, S2C.UPDATE, { id: item.id, resolved: true })];
      }

      case C2S.HOST_CONFIG: {
        config = sanitizeConfig({ ...config, ...payload });
        return [send(ROOM.PUBLIC, S2C.CONFIG, configPayload())];
      }

      case C2S.HOST_EXPORT: {
        if (!onExport) {
          return [errorTo(client.clientId, ERROR_CODE.NOT_READY, "导出功能还没接上")];
        }
        return [send(client.clientId, S2C.EXPORT_READY, onExport(exportData()))];
      }

      default:
        return [errorTo(client.clientId, ERROR_CODE.UNKNOWN_EVENT, `不认识的事件：${event}`)];
    }
  }

  /** 置顶超过上限就淘汰最早置顶的那条（§4.7）。 */
  function pinItem(item, ts) {
    const pinned = [...items.values()]
      .filter((other) => other.pinned && !other.removed && other.id !== item.id)
      .sort((a, b) => a.pinnedAt - b.pinnedAt);

    item.pinned = true;
    item.pinnedAt = ts;
    pinned.push(item);

    while (pinned.length > MAX_PINNED) {
      const oldest = pinned.shift();
      oldest.pinned = false;
      oldest.pinnedAt = 0;
    }
  }

  // ── 队列 ────────────────────────────────────────────────────────────

  /**
   * 收一条客户端消息。join 之外的消息都进双队列（§4.3.4），
   * 由 drain 统一处理 —— 老师按一下"暂停"不该排在 80 条弹幕后面。
   *
   * **载荷在这里过一遍 normalizeClientMessage**：这是服务端的边界，
   * 传进来的东西一律当作"对面那个浏览器说的话"看待，而不是内部调用。
   * 少校验一个字段的代价极不对称 —— `host:ban` 的 `banned` 要是漏了，
   * 老师点"拉黑"会安静地什么都不发生；`host:config` 的 `duration`
   * 要是 `null`，`Number(null) === 0` 会让所有弹幕一帧穿过屏幕。
   */
  function receive(clientId, event, payload, ts = clock()) {
    if (typeof event !== "string" || !CLIENT_EVENTS.includes(event)) {
      return [errorTo(clientId, ERROR_CODE.UNKNOWN_EVENT, "不认识这个消息")];
    }

    const normalized = normalizeClientMessage(event, payload);
    if (!normalized.ok) {
      // 发弹幕失败要回 rejected：学生端靠 tempId 找到本地先回显的那一条并
      // 把它标成"没发出去"。回一个不带 tempId 的 error，它不知道该撤哪条。
      if (event === C2S.SEND) {
        return [
          send(clientId, S2C.REJECTED, {
            tempId: typeof payload?.tempId === "string" ? payload.tempId : null,
            reason: normalized.reason,
          }),
        ];
      }
      return [errorTo(clientId, ERROR_CODE.BAD_MESSAGE, normalized.reason)];
    }

    if (event === C2S.JOIN) {
      return join({ ...normalized.value, clientId, ts });
    }

    const client = clients.get(clientId);
    if (!client) return [errorTo(clientId, ERROR_CODE.NOT_JOINED, "请先加入课堂")];

    // 把"收到"的时刻记下来：弹幕的时间戳该是学生按下发送的那一刻，
    // 而不是它在队列里排到队的时刻
    const item = { clientId, event, payload: normalized.value, ts };
    if (HOST_ONLY_EVENTS.includes(event)) {
      // 老师指令插队。学生冒用老师指令不算限流违规，只是不理他
      dispatcher.enqueueHost(item);
    } else {
      dispatcher.enqueueNormal(item);
    }
    return [];
  }

  /** 跑一轮：先清空 hostQueue，再处理最多 50 条学生消息（§4.3.4）。 */
  function drain(ts = clock()) {
    const actions = [];
    dispatcher.drain((item) => {
      const client = clients.get(item.clientId);
      if (!client) return;

      if (HOST_ONLY_EVENTS.includes(item.event) && client.role !== ROLE.HOST) {
        actions.push(errorTo(item.clientId, ERROR_CODE.FORBIDDEN, "这个操作只有老师能做"));
        return;
      }

      switch (item.event) {
        case C2S.SEND:
          // overlay / screen 也在公共房间里，但它们没有发言权
          if (client.role !== ROLE.STUDENT) return;
          actions.push(...handleSend(client, item.payload, item.ts));
          return;
        case C2S.LIKE:
          if (client.role !== ROLE.STUDENT) return;
          actions.push(...handleLike(client, item.payload, item.ts));
          return;
        case C2S.JOIN:
          // join 是同步处理的，进不了队列
          return;
        default:
          actions.push(...handleHost(client, item.event, item.payload, ts));
      }
    });

    actions.push(...flushAggregates(ts));
    return actions;
  }

  /** 聚合的广播节流（§4.6）：31 个人点"没听懂"不该产生 31 次广播。 */
  function flushAggregates(ts) {
    const updates = aggregator.flush(ts);
    if (updates.length === 0) return [];
    aggregator.prune(ts);

    const actions = [];
    for (const update of updates) {
      const item = items.get(update.id);
      if (!item || item.removed) continue;
      item.aggregate = update.aggregate;
      actions.push(send(ROOM.PUBLIC, S2C.UPDATE, { id: update.id, aggregate: update.aggregate }));
      actions.push(send(ROOM.HOST, S2C.UPDATE, { id: update.id, aggregate: update.aggregate }));
    }
    return actions;
  }

  // ── 维护 ────────────────────────────────────────────────────────────

  /** 内存里的弹幕条数有上限：一节课撑死几千条，但不能让异常情况吃光内存。 */
  function trimItems() {
    while (order.length > maxItems) {
      const id = order.shift();
      items.delete(id);
    }
  }

  function heartbeat(ts = clock()) {
    const actions = [];
    actions.push(...flushAggregates(ts));
    // 聚合窗口过期后计数固定不再增长，桶要回收
    aggregator.prune(ts);
    pruneAlerts(ts);
    limiter.prune?.(ts);
    return actions;
  }

  /**
   * 提醒档位跟着聚合窗口一起过期。
   * 不清的话一节课下来会攒下几百个再也不会有第二次命中的 key
   * （每 30 秒就是一轮新窗口），虽然量不大，但这是纯粹的垃圾。
   */
  function pruneAlerts(ts) {
    if (alertedSteps.size === 0) return;
    const currentWindow = Math.floor(ts / aggregator.windowMs);
    for (const key of alertedSteps.keys()) {
      const window = Number(key.slice(key.indexOf("#") + 1));
      if (window < currentWindow) alertedSteps.delete(key);
    }
  }

  function exportData() {
    return {
      schema: 1,
      exportedAt: clock(),
      config: configPayload(),
      stats: stats(),
      danmaku: visibleItems().map(hostItem),
    };
  }

  function stats() {
    return {
      ...counts,
      online: studentsOnline(),
      connections: clients.size,
      devices: devices.size,
      danmaku: items.size,
      pinned: [...items.values()].filter((item) => item.pinned && !item.removed).length,
      paused,
      mutedUntil,
      clearedAt,
      queued: dispatcher.pending,
      limiter: limiter.stats(),
      aggregator: aggregator.stats(),
    };
  }

  return {
    join,
    leave,
    receive,
    drain,
    heartbeat,
    exportData,
    stats,
    state: statePayload,
    get config() {
      return configPayload();
    },
    get paused() {
      return paused;
    },
    get itemCount() {
      return items.size;
    },
    /** 只给测试与 /diag 用 */
    clients,
    devices,
    items,
  };
}
