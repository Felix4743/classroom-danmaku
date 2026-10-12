/**
 * 学生端（/m），手机优先。
 *
 * 三条产品约束决定了这里的大部分写法（产品文档 §7.2）：
 *
 *   1. **加入只填一次。** 学号姓名存本地，之后每次扫码直接进。
 *   2. **发送要即时。** 按下就先在本地画出那一条，等服务的回执回来再替换成
 *      真实 id；被拒绝时把它标成失败并说明原因，而不是悄悄消失。
 *   3. **反馈必须闭环。** 自己发过的每一条都留在"我发过的"里，跟着点赞、
 *      聚合计数、"老师已回应"一起更新 —— 学生得看得见自己的声音起了作用。
 *
 * 投影上永远不会出现学号姓名（安全红线），所以这里可以放心把它们放进 join。
 */

import { CLIENT_SEND_COOLDOWN_MS } from "../../shared/config.js";
import { STATUS, createClassroomClient } from "../../shared/client.js";
import { PRESETS } from "../../shared/presets.js";
import { C2S, REJECT, S2C, isPlausibleStudentId } from "../../shared/protocol.js";

const PROFILE_KEY = "classroom-danmaku.m.profile";
const DEVICE_KEY = "classroom-danmaku.m.device";

/**
 * 这节课的标识。一台服务只上一节课，所以是个常量；
 * 留着它是因为协议里 join 必须带 classId，将来一个服务带多个班时改这里。
 */
const CLASS_ID = "default";

/** 断线多久之后改说"与课堂断开"，而不是一直"正在重连"（§4.3.2）。 */
const DISCONNECT_NOTICE_MS = 5 * 60_000;

/**
 * 页面元素。这里**故意一个个写死 id 字符串**，不写 `el(id)` 那种小工具 ——
 * `tests/unit/static-graph.test.mjs` 靠正则抓 getElementById 后面的字符串字面量，
 * 用变量传 id 它就只能抓到 0 个然后放弃检查，而"JS 里查的 id 在 HTML 里
 * 不存在"正是白屏事故那一类最难查的故障。
 */
const dom = {
  join: document.getElementById("join"),
  joinForm: document.getElementById("join-form"),
  studentId: document.getElementById("student-id"),
  realName: document.getElementById("real-name"),
  nickname: document.getElementById("nickname"),
  joinError: document.getElementById("join-error"),
  room: document.getElementById("room"),
  conn: document.getElementById("conn"),
  me: document.getElementById("me"),
  banner: document.getElementById("banner"),
  mine: document.getElementById("mine"),
  mineEmpty: document.getElementById("mine-empty"),
  presets: document.getElementById("presets"),
  sendForm: document.getElementById("send-form"),
  text: document.getElementById("text"),
  send: document.getElementById("send"),
  cooldown: document.getElementById("cooldown"),
};

/** 我发过的弹幕。key 是 tempId（还没被确认时）或服务端给的 id。 */
const mine = new Map();
let tempSeq = 0;

/** 服务端状态。这几项在每次重连后都会被全量重发覆盖。 */
const serverState = { paused: false, mutedUntil: 0, online: 0 };

let client = null;
let profile = null;
let cooldownUntil = 0;
let disconnectedAt = 0;
let bannedMessage = null;

// ── 本地存储 ──────────────────────────────────────────────────────────
// 隐私模式下 localStorage 会直接抛异常。存不下就退化成"这次会话有效"，
// 绝不能因为存不了就进不去课堂。

function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存不下就算了 */
  }
}

function loadProfile() {
  const raw = readStore(PROFILE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!isPlausibleStudentId(parsed.studentId)) return null;
    return {
      studentId: parsed.studentId,
      name: typeof parsed.name === "string" ? parsed.name.slice(0, 32) : "",
      nickname: typeof parsed.nickname === "string" ? parsed.nickname.slice(0, 12) : "",
    };
  } catch {
    return null;
  }
}

// ── 渲染 ──────────────────────────────────────────────────────────────

const REJECT_TEXT = {
  [REJECT.EMPTY]: "内容不能是空的",
  [REJECT.TOO_LONG]: "太长了，短一点",
  [REJECT.FILTERED]: "这句话被屏蔽词拦下了，换个说法",
  [REJECT.MUTED]: "全班静音中",
  [REJECT.BANNED]: "你已被移出本课弹幕",
  [REJECT.RATE_LIMITED]: "发得太快了，等一下",
  [REJECT.PRESET_ONLY]: "现在只能点上面的按钮",
};

function renderMine() {
  dom.mine.textContent = "";
  for (const entry of mine.values()) {
    const li = document.createElement("li");
    li.dataset.state = entry.state;

    const body = document.createElement("div");
    body.className = "body";
    body.textContent = entry.text;
    li.append(body);

    const meta = document.createElement("div");
    meta.className = "meta";

    if (entry.state === "pending") {
      meta.append(badge("发送中…"));
    } else if (entry.state === "failed") {
      meta.append(badge(entry.reason ?? "没发出去", "failed"));
    } else if (entry.state === "removed") {
      meta.append(badge("已被老师删除"));
    } else {
      if (entry.aggregate > 1) meta.append(badge(`×${entry.aggregate}`));
      if (entry.likes > 0) meta.append(badge(`👍${entry.likes}`));
      if (entry.pinned) meta.append(badge("置顶", "pin"));
      if (entry.resolved) meta.append(badge("老师已回应", "done"));
    }

    li.append(meta);
    dom.mine.append(li);
  }
  dom.mineEmpty.hidden = mine.size > 0;
}

function badge(text, kind) {
  const span = document.createElement("span");
  span.className = kind ? `badge ${kind}` : "badge";
  span.textContent = text;
  return span;
}

function renderPresets() {
  dom.presets.textContent = "";
  for (const preset of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = preset.label;
    button.title = preset.hint;
    button.dataset.preset = preset.id;
    button.addEventListener("click", () => submit(preset.label, preset.id));
    dom.presets.append(button);
  }
}

function renderConnection() {
  if (bannedMessage) {
    dom.conn.textContent = "已被移出";
    dom.conn.dataset.state = "closed";
    return;
  }
  const status = client?.status ?? STATUS.IDLE;
  const labels = {
    [STATUS.IDLE]: "准备中…",
    [STATUS.CONNECTING]: "连接中…",
    [STATUS.OPEN]: "已连上",
    [STATUS.RECONNECTING]: "正在重连…",
    [STATUS.CLOSED]: "已断开",
  };
  dom.conn.textContent = labels[status] ?? status;
  dom.conn.dataset.state = status;
}

function renderBanner() {
  const now = Date.now();
  let text = null;

  if (bannedMessage) {
    text = bannedMessage;
  } else if (client && client.status !== STATUS.OPEN) {
    // §4.3.2：短时间重连不必惊动学生，超过 5 分钟才明说。
    // disconnectedAt 为 0 表示"压根还没连上过"（还在填表单），那就别喊重连。
    if (disconnectedAt === 0) text = null;
    else if (now - disconnectedAt > DISCONNECT_NOTICE_MS) text = "与课堂断开，正在重连…";
    else text = "正在重连…";
  } else if (serverState.paused) {
    text = "老师已暂停弹幕";
  } else if (serverState.mutedUntil > now) {
    text = `全班静音中，还有 ${Math.ceil((serverState.mutedUntil - now) / 1000)} 秒`;
  }

  dom.banner.hidden = text === null;
  if (text !== null) dom.banner.textContent = text;
}

function renderCooldown() {
  const left = cooldownUntil - Date.now();
  const cooling = left > 0;
  dom.cooldown.hidden = !cooling;
  dom.send.disabled = cooling || bannedMessage !== null;
  dom.send.textContent = cooling ? `${Math.ceil(left / 1000)}s` : "发送";
  for (const button of dom.presets.querySelectorAll("button")) {
    button.disabled = cooling || bannedMessage !== null;
  }
}

function renderAll() {
  renderConnection();
  renderBanner();
  renderCooldown();
}

// ── 发送 ──────────────────────────────────────────────────────────────

function newTempId() {
  tempSeq += 1;
  return `t${tempSeq}-${Date.now().toString(36)}`;
}

function submit(text, presetId = null) {
  const body = String(text ?? "").trim();
  if (!body || bannedMessage) return;
  if (Date.now() < cooldownUntil) return;
  if (!client) return;

  const tempId = newTempId();
  // 本地先回显，不等服务端确认（§7.2 的关键交互）
  mine.set(tempId, {
    id: null,
    tempId,
    text: body,
    presetId,
    state: "pending",
    likes: 0,
    aggregate: 0,
    pinned: false,
    resolved: false,
    reason: null,
  });
  renderMine();

  const sent = client.send(C2S.SEND, { text: body, tempId, ...(presetId ? { presetId } : {}) });
  if (!sent) {
    const entry = mine.get(tempId);
    entry.state = "failed";
    entry.reason = "还没连上，等一下再发";
    renderMine();
  }
}

function startCooldown(ms) {
  cooldownUntil = Date.now() + Math.max(0, ms);
  renderCooldown();
}

// ── 服务端事件 ────────────────────────────────────────────────────────

function applyServerState(payload) {
  if (!payload || typeof payload !== "object") return;
  if (typeof payload.paused === "boolean") serverState.paused = payload.paused;
  if (Number.isFinite(payload.mutedUntil)) serverState.mutedUntil = payload.mutedUntil;
  if (Number.isFinite(payload.online)) serverState.online = payload.online;
}

function onNew(payload) {
  const tempId = payload.tempId;

  // 自己那份回执：把本地先回显的那条换成真实 id
  if (tempId && mine.has(tempId)) {
    const entry = mine.get(tempId);
    mine.delete(tempId);
    entry.id = payload.id;
    entry.text = payload.text;
    entry.state = "sent";
    entry.reason = null;
    mine.set(payload.id, entry);
    renderMine();
    // 服务端已经收下了，把发送按钮按下去几秒，省掉必然会被拒的连点
    startCooldown(CLIENT_SEND_COOLDOWN_MS);
    return;
  }

  // 别人的弹幕不进"我发过的"，但如果是自己另一台设备发的同一条就不要重复加
  if (payload.id && mine.has(payload.id)) {
    const entry = mine.get(payload.id);
    entry.text = payload.text;
    renderMine();
  }
}

function onUpdate(payload) {
  const entry = payload?.id ? mine.get(payload.id) : null;
  if (!entry) return;
  if (Number.isFinite(payload.likes)) entry.likes = payload.likes;
  if (Number.isFinite(payload.aggregate)) entry.aggregate = payload.aggregate;
  if (payload.resolved === true) entry.resolved = true;
  renderMine();
}

function onPin(payload) {
  const entry = payload?.id ? mine.get(payload.id) : null;
  if (!entry) return;
  entry.pinned = payload.pinned === true;
  renderMine();
}

function onRemove(payload) {
  const entry = payload?.id ? mine.get(payload.id) : null;
  if (!entry) return;
  entry.state = "removed";
  renderMine();
}

function onRejected(payload) {
  const tempId = payload?.tempId;
  if (!tempId || !mine.has(tempId)) return;
  const entry = mine.get(tempId);
  entry.state = "failed";
  entry.reason = REJECT_TEXT[payload.reason] ?? "没发出去";
  renderMine();
}

function onEvent(message) {
  const payload = message?.payload ?? {};
  switch (message?.event) {
    case S2C.JOINED:
      bannedMessage = null;
      renderAll();
      break;
    case S2C.STATE:
      applyServerState(payload);
      renderBanner();
      break;
    case S2C.NEW:
      onNew(payload);
      break;
    case S2C.UPDATE:
      onUpdate(payload);
      break;
    case S2C.PIN:
      onPin(payload);
      break;
    case S2C.REMOVE:
      onRemove(payload);
      break;
    case S2C.REJECTED:
      onRejected(payload);
      break;
    case S2C.RATE_LIMITED:
      if (Number.isFinite(payload.retryAfterMs)) startCooldown(payload.retryAfterMs);
      break;
    case S2C.ERROR:
      if (payload.code === "banned") {
        bannedMessage = payload.message ?? "你已被移出本课弹幕";
        client?.close();
      }
      renderAll();
      break;
    default:
      break;
  }
}

function onReset() {
  // §4.3.2 要求在重连后清空本地状态重建。这里清的是**服务端派生的**状态：
  // 暂停、静音、在线人数。**不动 mine** —— "我发过的"是学生自己的记录，
  // 不是服务端的视图流，服务端重连时也不会重放它。把它一起清掉，
  // 学生就会觉得"我的弹幕丢了"，而那正是这个产品最不该有的感觉。
  serverState.paused = false;
  serverState.mutedUntil = 0;
  serverState.online = 0;
  renderAll();
}

function onStatus(status) {
  if (status === STATUS.OPEN) {
    disconnectedAt = 0;
  } else if (disconnectedAt === 0 && (status === STATUS.RECONNECTING || status === STATUS.CLOSED)) {
    disconnectedAt = Date.now();
  }
  renderAll();
}

// ── 启动 ──────────────────────────────────────────────────────────────

function connect(nextProfile) {
  profile = nextProfile;
  dom.join.hidden = true;
  dom.room.hidden = false;
  dom.me.textContent = profile.nickname || "匿名同学";

  client = createClassroomClient({
    url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
    deviceId: readStore(DEVICE_KEY),
    join: {
      role: "student",
      classId: CLASS_ID,
      nickname: profile.nickname,
      identity: { studentId: profile.studentId, name: profile.name },
    },
    onEvent,
    onReset,
    onStatus,
    onDeviceId: (id) => writeStore(DEVICE_KEY, id),
  });
  client.open();

  // 一个 500ms 的节拍同时喂三件事：冷却倒计时、静音倒计时、断线提示的升级。
  // 用轮询而不是一堆 setTimeout，是因为这三样都要"跟着时间走"，
  // 而它们各自的触发条件随时可能被服务端一条消息改掉。
  setInterval(renderAll, 500);
}

function showJoinForm(prefillError = null) {
  dom.join.hidden = false;
  dom.room.hidden = true;
  if (prefillError) {
    dom.joinError.hidden = false;
    dom.joinError.textContent = prefillError;
  }
}

renderPresets();
renderAll();

dom.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const studentId = dom.studentId.value.trim();
  const name = dom.realName.value.trim();
  const nickname = dom.nickname.value.trim();

  if (!isPlausibleStudentId(studentId)) {
    dom.joinError.hidden = false;
    dom.joinError.textContent = "学号看起来不太对（4~24 位字母数字）";
    return;
  }
  if (!name) {
    dom.joinError.hidden = false;
    dom.joinError.textContent = "请填一下姓名，只有老师看得到";
    return;
  }

  const next = { studentId, name, nickname };
  writeStore(PROFILE_KEY, JSON.stringify(next));
  dom.joinError.hidden = true;
  connect(next);
});

dom.sendForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = dom.text.value;
  if (!text.trim()) return;
  submit(text);
  dom.text.value = "";
});

const saved = loadProfile();
if (saved) {
  // 已经有身份了就直接进，学生扫码之后不该再看到表单
  dom.studentId.value = saved.studentId;
  dom.realName.value = saved.name;
  dom.nickname.value = saved.nickname;
  connect(saved);
} else {
  showJoinForm();
}
