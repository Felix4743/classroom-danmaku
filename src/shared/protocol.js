/**
 * 协议常量与载荷整形（技术方案 §4.3.1、§4.4）。
 *
 * 这个文件是客户端与服务端唯一的"词典"，两端都 import 它，任何一侧都不许
 * 再硬编码事件名 —— 事件名写错的表现是"消息发出去了但没人处理"，
 * 在浏览器和 Node 两侧都不会报错，只能靠通读代码发现。
 *
 * 另一件更重要的事：**身份字段的过滤放在这里**（§4.4）。视图流隔离是安全红线，
 * 而红线只靠"广播时记得别带上 deviceId"是守不住的 —— 所以身份字段的集合
 * 集中定义为 IDENTITY_FIELDS，出站载荷一律经由 publicDanmaku() 过一遍。
 */

/** 角色。overlay 是投影图层，screen 是网页版降级形态（§4.1 的 L2）。 */
export const ROLE = Object.freeze({
  HOST: "host",
  STUDENT: "student",
  OVERLAY: "overlay",
  SCREEN: "screen",
});

export const ALL_ROLES = Object.freeze(Object.values(ROLE));

/**
 * 广播房间。overlay / screen 只进 PUBLIC，**永远不进 HOST**（§4.4 硬规则 2）。
 */
export const ROOM = Object.freeze({
  PUBLIC: "public",
  HOST: "host",
});

/** 客户端 → 服务端。 */
export const C2S = Object.freeze({
  JOIN: "join",
  SEND: "danmaku:send",
  LIKE: "danmaku:like",
  HOST_CLEAR: "host:clear",
  HOST_PAUSE: "host:pause",
  HOST_MUTE: "host:mute",
  HOST_REMOVE: "host:remove",
  HOST_PIN: "host:pin",
  HOST_BAN: "host:ban",
  HOST_FETCH_IDENTITY: "host:fetchIdentity",
  HOST_RESOLVED: "host:resolved",
  HOST_CONFIG: "host:config",
  HOST_EXPORT: "host:export",
});

/** 服务端 → 客户端。 */
export const S2C = Object.freeze({
  JOINED: "joined",
  NEW: "danmaku:new",
  UPDATE: "danmaku:update",
  REMOVE: "danmaku:remove",
  PIN: "danmaku:pin",
  STATE: "state",
  CONFIG: "config",
  RATE_LIMITED: "rateLimited",
  REJECTED: "rejected",
  HOST_ALERT: "host:alert",
  HOST_IDENTITY: "host:identity",
  ERROR: "error",
});

export const CLIENT_EVENTS = Object.freeze(Object.values(C2S));
export const SERVER_EVENTS = Object.freeze(Object.values(S2C));

/** 只有老师角色能发的事件。学生发了直接 error，不算一次限流惩罚。 */
export const HOST_ONLY_EVENTS = Object.freeze(
  Object.values(C2S).filter((name) => name.startsWith("host:")),
);

/** 出站弹幕的公共字段。**这是白名单，不是黑名单** —— 新增字段必须显式加进来。 */
export const PUBLIC_DANMAKU_FIELDS = Object.freeze([
  "id",
  "text",
  "nickname",
  "color",
  "presetId",
  "ts",
]);

/** 身份字段：只在 host 房间、且只有主动 fetchIdentity 时才允许出站（§4.9）。 */
export const IDENTITY_FIELDS = Object.freeze(["studentId", "name", "deviceId"]);

export const MAX_TEXT_LENGTH = 100;
export const MAX_NICKNAME_LENGTH = 12;
export const MAX_CLASS_ID_LENGTH = 32;
export const MAX_ID_LENGTH = 64;

/** 学生端被拒绝的原因码，前端据此决定提示文案。 */
export const REJECT = Object.freeze({
  EMPTY: "empty",
  TOO_LONG: "too_long",
  FILTERED: "filtered",
  MUTED: "muted",
  BANNED: "banned",
  RATE_LIMITED: "rate_limited",
  PRESET_ONLY: "preset_only",
});

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 去掉不可见字符：零宽字符能绕过屏蔽词，也能把昵称显示成空白。 */
function stripInvisible(value) {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[\u0000-\u001F\u007F]/g, "");
}

function cleanString(value, maxLength) {
  if (typeof value !== "string") return null;
  const cleaned = stripInvisible(value).trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, maxLength);
}

/**
 * id 与 cleanString 的区别：超长一律拒绝，**不截断**。
 * 截断一个 id 只会得到一个永远匹配不上任何一条弹幕的字符串，
 * 表现为"老师点了删除但什么都没发生"，比直接报错难查得多。
 */
function cleanId(value) {
  if (typeof value !== "string") return null;
  const cleaned = stripInvisible(value).trim();
  if (cleaned.length === 0 || cleaned.length > MAX_ID_LENGTH) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(cleaned) ? cleaned : null;
}

/**
 * 把入站数值收紧成有限数，收不了就返回 null。
 *
 * 刻意**不接受** null / 布尔 / 数组 / 空串：`Number(null)` 是 0、`Number([])` 也是 0，
 * 用 `Number()` 直接转会让 `host:mute {minutes: null}` 静默变成"静音 0 分钟"，
 * 也就是一条本该报错的指令悄悄执行成了另一件事。数字字符串（表单里的值）
 * 是唯一放行的宽松形式。
 */
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

/**
 * 从一条内存态弹幕构造**公共**载荷。
 *
 * 显式列举字段而不是展开，是为了让"新增了一个带身份的字段但忘了过滤"这件事
 * 在代码评审时一眼可见。§8.2 那条安全红线测试会抓取发给 overlay 房间的
 * 所有消息，断言这里没有漏出。
 */
export function publicDanmaku(item) {
  return {
    id: item.id,
    text: item.text,
    nickname: item.nickname,
    color: item.color,
    presetId: item.presetId ?? null,
    ts: item.ts,
  };
}

/** 公共载荷 + 设备标识。只允许发往 host 房间。 */
export function hostDanmaku(item) {
  return { ...publicDanmaku(item), deviceId: item.deviceId ?? null };
}

/**
 * 深扫一个载荷里有没有身份字段。
 * 测试用它兜住"以后有人手滑把整个 item 广播出去"。
 */
export function findIdentityLeak(payload, path = "$", found = []) {
  if (Array.isArray(payload)) {
    payload.forEach((value, index) => findIdentityLeak(value, `${path}[${index}]`, found));
    return found;
  }
  if (!isPlainObject(payload)) return found;

  for (const [key, value] of Object.entries(payload)) {
    if (IDENTITY_FIELDS.includes(key)) found.push(`${path}.${key}`);
    findIdentityLeak(value, `${path}.${key}`, found);
  }
  return found;
}

/**
 * 校验并整形一条客户端消息。
 *
 * 返回 `{ ok: true, value }` 或 `{ ok: false, reason }`。
 * 校验放在这里而不是各处 handler 里，是因为"少校验一个字段"的代价极不对称：
 * 一个 NaN 或超长字符串会一路流到 Canvas 和落盘文件里。
 */
export function normalizeClientMessage(event, payload) {
  if (!CLIENT_EVENTS.includes(event)) {
    return { ok: false, reason: `未知事件 ${String(event)}` };
  }
  if (!isPlainObject(payload)) {
    return { ok: false, reason: `${event} 的载荷必须是对象` };
  }

  switch (event) {
    case C2S.JOIN: {
      const role = payload.role;
      if (!ALL_ROLES.includes(role)) return { ok: false, reason: `未知角色 ${String(role)}` };
      const classId = cleanString(payload.classId, MAX_CLASS_ID_LENGTH);
      if (classId === null) return { ok: false, reason: "classId 不能为空" };

      const value = { role, classId };
      // deviceId 由服务端下发；客户端带上就复用，没有就新发一个
      const deviceId = payload.deviceId === undefined ? null : cleanId(payload.deviceId);
      if (payload.deviceId !== undefined && deviceId === null) {
        return { ok: false, reason: "deviceId 格式非法" };
      }
      value.deviceId = deviceId;
      value.nickname = cleanString(payload.nickname, MAX_NICKNAME_LENGTH);
      value.identity = normalizeIdentity(payload.identity);
      return { ok: true, value };
    }

    case C2S.SEND: {
      const text = cleanString(payload.text, MAX_TEXT_LENGTH + 1);
      if (text === null) return { ok: false, reason: REJECT.EMPTY };
      if (text.length > MAX_TEXT_LENGTH) return { ok: false, reason: REJECT.TOO_LONG };

      const value = { text, presetId: null, tempId: cleanId(payload.tempId) };
      if (payload.presetId !== undefined && payload.presetId !== null) {
        const presetId = cleanId(payload.presetId);
        if (presetId === null) return { ok: false, reason: "presetId 格式非法" };
        value.presetId = presetId;
      }
      return { ok: true, value };
    }

    case C2S.LIKE:
    case C2S.HOST_REMOVE:
    case C2S.HOST_RESOLVED:
    case C2S.HOST_FETCH_IDENTITY: {
      const id = cleanId(payload.id);
      if (id === null) return { ok: false, reason: "id 格式非法" };
      return { ok: true, value: { id } };
    }

    case C2S.HOST_PAUSE: {
      if (typeof payload.paused !== "boolean") return { ok: false, reason: "paused 必须是布尔值" };
      return { ok: true, value: { paused: payload.paused } };
    }

    case C2S.HOST_MUTE: {
      const minutes = toFiniteNumber(payload.minutes);
      if (minutes === null || minutes < 0 || minutes > 120) {
        return { ok: false, reason: "minutes 必须是 0~120 的数字" };
      }
      return { ok: true, value: { minutes } };
    }

    case C2S.HOST_PIN: {
      const id = cleanId(payload.id);
      if (id === null) return { ok: false, reason: "id 格式非法" };
      if (typeof payload.pinned !== "boolean") return { ok: false, reason: "pinned 必须是布尔值" };
      return { ok: true, value: { id, pinned: payload.pinned } };
    }

    case C2S.HOST_BAN: {
      const deviceId = cleanId(payload.deviceId);
      if (deviceId === null) return { ok: false, reason: "deviceId 格式非法" };
      return { ok: true, value: { deviceId, banned: payload.banned !== false } };
    }

    case C2S.HOST_CONFIG: {
      const value = {};
      for (const [key, raw] of Object.entries(payload)) {
        const number = toFiniteNumber(raw);
        if (number === null) return { ok: false, reason: `${key} 不是数字` };
        value[key] = number;
      }
      if (Object.keys(value).length === 0) return { ok: false, reason: "config 是空的" };
      return { ok: true, value };
    }

    default:
      // host:clear / host:export 没有载荷
      return { ok: true, value: {} };
  }
}

function normalizeIdentity(identity) {
  if (!isPlainObject(identity)) return null;
  const studentId = cleanString(identity.studentId, 32);
  const name = cleanString(identity.name, 32);
  if (studentId === null && name === null) return null;
  return { studentId, name };
}

/**
 * 学号格式校验（§4.9）。
 * 故意宽松：各校学号形态差异极大（纯数字、带字母、带连字符），
 * 这里只拦明显不是学号的东西，不做"必须是 10 位数字"这种假设。
 */
export function isPlausibleStudentId(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text.length >= 4 && text.length <= 24 && /^[A-Za-z0-9-]+$/.test(text);
}
