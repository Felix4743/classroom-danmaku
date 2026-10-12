/**
 * 老师端（/host）。
 *
 * 产品文档 §7.3 定了它的形态：**默认是「提醒器」，需要时才展开成「控制台」**。
 * 老师一边讲课一边低头看手机观感很差，所以默认只有一个大徽章 + 震动提醒；
 * 那四个大按钮是"把课件抢回来"的手段，必须一次点击立刻生效、不做二次确认。
 *
 * 身份（学号姓名）**默认不下发**，只有老师点某一条的「身份」才会拉取那一条（§4.9）。
 * 这里因此把身份单独存在 `identities` 里，而不是塞进弹幕对象 —— 混在一起，
 * 哪天有人顺手把它渲染进列表，红线就破了。
 */

import { CONFIG_LIMITS, DEFAULT_CONFIG } from "../../shared/config.js";
import { STATUS, createClassroomClient } from "../../shared/client.js";
import { C2S, ROLE, S2C } from "../../shared/protocol.js";

const CLASS_ID = "default"; // 一台服务只上一节课（和学生页同一个约定）
const MUTE_MINUTES = 5; // 产品文档 §7.3 的「静音5分钟」，是唯一的一档
const DONE_LIMIT = 20;

/**
 * 所有 id 都写成字面量，不用 `el(id)` 这类小工具。
 *
 * `tests/unit/static-graph.test.mjs` 靠正则抓 getElementById 后面的字符串字面量，
 * 再断言这些 id 在 HTML 里都找得到 —— 它能挡掉"改名只改了一边"。
 * 包一层函数它就一个也抓不到，那条测试会直接失败。
 * （同一个原因：注释里也别写带引号的假 id，正则分不出注释和代码。）
 */
const dom = {
  alerter: document.getElementById("alerter"),
  badge: document.getElementById("badge"),
  badgeCount: document.getElementById("badge-count"),
  alerterFlash: document.getElementById("alerter-flash"),
  alerterStatus: document.getElementById("alerter-status"),
  alerterStats: document.getElementById("alerter-stats"),
  console: document.getElementById("console"),
  collapse: document.getElementById("collapse"),
  consoleStatus: document.getElementById("console-status"),
  banner: document.getElementById("banner"),
  pool: document.getElementById("pool"),
  poolEmpty: document.getElementById("pool-empty"),
  done: document.getElementById("done"),
  doneTitle: document.getElementById("done-title"),
  clear: document.getElementById("clear"),
  pause: document.getElementById("pause"),
  mute: document.getElementById("mute"),
  pinHottest: document.getElementById("pin-hottest"),
  stats: document.getElementById("stats"),
  sliders: document.getElementById("sliders"),
  configReset: document.getElementById("config-reset"),
  export: document.getElementById("export"),
  exportOut: document.getElementById("export-out"),
};

/** id → 弹幕。含已回应与已删除的，删除的只用来把它从列表里踢掉。 */
const items = new Map();
/** id → {studentId, name} | null（拉过一次就不再拉）。 */
const identities = new Map();

let client = null;
let config = { ...DEFAULT_CONFIG };
let serverState = { paused: false, mutedUntil: 0, online: 0, danmakuCount: 0 };
let lastAlert = null;
let flashUntil = 0;

// ── 渲染 ────────────────────────────────────────────────────────────────

function liveItems() {
  return [...items.values()].filter((item) => !item.removed);
}

/**
 * 问题池的排序（§4.7、产品文档 §7.3）。
 *
 * 置顶的永远在最上面（那是老师自己选的，不能被算法挤下去），
 * 其余按"点赞 + 聚合"从高到低。同分时早出现的在前 —— 先问的人应该先被回答。
 */
function rankOf(item) {
  return (item.likes ?? 0) + (item.aggregate ?? 0);
}

function byImportance(a, b) {
  if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (rankOf(a) !== rankOf(b)) return rankOf(b) - rankOf(a);
  return a.ts - b.ts;
}

function makeButton(label, onClick, { danger = false, disabled = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (danger) button.dataset.danger = "true";
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function renderRow(item) {
  const row = document.createElement("li");
  row.dataset.pinned = String(Boolean(item.pinned));
  row.dataset.resolved = String(Boolean(item.resolved));

  const body = document.createElement("div");
  body.className = "body";
  // textContent 而不是 innerHTML：这是学生打的字，永远不会被当成标记解析
  body.textContent = item.text;
  row.append(body);

  const meta = document.createElement("div");
  meta.className = "meta";
  const bits = [`${item.nickname ?? "匿名同学"}`];
  if (item.aggregate) bits.push(`同样的 ×${item.aggregate}`);
  if (item.likes) bits.push(`👍 ${item.likes}`);
  if (item.pinned) bits.push("已置顶");
  if (item.resolved) bits.push("已回应");
  for (const bit of bits) {
    const span = document.createElement("span");
    span.textContent = bit;
    meta.append(span);
  }
  row.append(meta);

  const identity = identities.get(item.id);
  if (identity) {
    const line = document.createElement("p");
    line.className = "identity";
    line.textContent =
      identity.studentId || identity.name
        ? `学号 ${identity.studentId ?? "—"} · 姓名 ${identity.name ?? "—"}`
        : "这位同学没有填学号姓名";
    row.append(line);
  }

  const ops = document.createElement("div");
  ops.className = "ops";

  if (!item.resolved) {
    ops.append(
      makeButton(item.pinned ? "取消置顶" : "置顶", () =>
        send(C2S.HOST_PIN, { id: item.id, pinned: !item.pinned }),
      ),
    );
    ops.append(makeButton("已回应", () => send(C2S.HOST_RESOLVED, { id: item.id })));
  }

  if (!identity) {
    ops.append(makeButton("看身份", () => send(C2S.HOST_FETCH_IDENTITY, { id: item.id })));
  }

  ops.append(
    makeButton("删掉", () => send(C2S.HOST_REMOVE, { id: item.id }), { danger: true }),
  );

  if (item.deviceId) {
    ops.append(
      makeButton(
        "拉黑",
        () => {
          // 拉黑是有代价的动作（这个人之后连不进来），值得一次确认
          if (!window.confirm(`把「${item.nickname ?? "匿名同学"}」移出这节课堂？`)) return;
          send(C2S.HOST_BAN, { deviceId: item.deviceId, banned: true });
        },
        { danger: true },
      ),
    );
  }

  row.append(ops);
  return row;
}

function renderPool() {
  const live = liveItems().sort(byImportance);
  const waiting = live.filter((item) => !item.resolved);
  const done = live.filter((item) => item.resolved).slice(-DONE_LIMIT);

  dom.pool.replaceChildren(...waiting.map(renderRow));
  dom.poolEmpty.hidden = waiting.length > 0;

  dom.doneTitle.hidden = done.length === 0;
  dom.done.replaceChildren(...done.map(renderRow));

  const badgeText = String(waiting.length);
  dom.badgeCount.textContent = badgeText;
  dom.badge.dataset.level = waiting.length === 0 ? "none" : waiting.length >= 3 ? "many" : "some";

  dom.pause.textContent = serverState.paused ? "继续" : "暂停";
  dom.pause.dataset.active = String(serverState.paused);

  const muted = serverState.mutedUntil > Date.now();
  dom.mute.textContent = muted
    ? `静音中 ${Math.ceil((serverState.mutedUntil - Date.now()) / 1000)}s`
    : `静音 ${MUTE_MINUTES} 分钟`;
  dom.mute.dataset.active = String(muted);

  const numbers = `在线 ${serverState.online} · 弹幕 ${serverState.danmakuCount} · 待回应 ${waiting.length}`;
  dom.stats.textContent = numbers;
  dom.alerterStats.textContent = `在线 ${serverState.online} · 弹幕 ${serverState.danmakuCount}`;

  const status = client ? client.status : STATUS.IDLE;
  const statusText = describeStatus(status);
  dom.consoleStatus.textContent = statusText;
  dom.consoleStatus.dataset.state = status;
  dom.alerterStatus.textContent = statusText;

  if (lastAlert && Date.now() < flashUntil) {
    dom.alerterFlash.textContent = `${lastAlert.reason} ×${lastAlert.aggregate}`;
    dom.alerterFlash.hidden = false;
    dom.badge.dataset.flash = "true";
  } else {
    dom.alerterFlash.hidden = true;
    dom.badge.dataset.flash = "false";
  }
}

function describeStatus(status) {
  if (status === STATUS.OPEN) return "已连上";
  if (status === STATUS.CONNECTING) return "连接中…";
  if (status === STATUS.RECONNECTING) return "正在重连…";
  if (status === STATUS.CLOSED) return "已断开";
  return "准备中…";
}

function showBanner(text) {
  dom.banner.textContent = text;
  dom.banner.hidden = !text;
}

function upsert(payload) {
  const existing = items.get(payload.id);
  if (existing) {
    Object.assign(existing, payload, { removed: false });
    return existing;
  }
  const item = { likes: 0, aggregate: 0, pinned: false, resolved: false, removed: false };
  Object.assign(item, payload);
  items.set(payload.id, item);
  return item;
}

// ── 协议 ────────────────────────────────────────────────────────────────

function send(event, payload = {}) {
  const ok = client?.send(event, payload) ?? false;
  if (!ok) showBanner("还没连上课堂，等一下再试。");
  return ok;
}

const handlers = {
  [S2C.JOINED]: (payload) => {
    if (payload.config) {
      config = { ...DEFAULT_CONFIG, ...payload.config };
      syncSliders();
    }
  },

  // 老师加入时服务端会把当前屏幕上还在的弹幕逐条补发过来（§4.3.2 全量同步）
  [S2C.NEW]: (payload) => upsert(payload),

  [S2C.UPDATE]: (payload) => {
    const item = items.get(payload.id);
    if (!item) return;
    if (payload.likes !== undefined) item.likes = payload.likes;
    if (payload.aggregate !== undefined) item.aggregate = payload.aggregate;
    if (payload.resolved !== undefined) item.resolved = payload.resolved;
  },

  [S2C.PIN]: (payload) => {
    const item = items.get(payload.id);
    if (item) item.pinned = payload.pinned;
  },

  [S2C.REMOVE]: (payload) => {
    const item = items.get(payload.id);
    if (item) item.removed = true;
  },

  [S2C.STATE]: (payload) => {
    serverState = {
      paused: Boolean(payload.paused),
      mutedUntil: payload.mutedUntil ?? 0,
      online: payload.online ?? 0,
      danmakuCount: payload.danmakuCount ?? 0,
    };
  },

  [S2C.CONFIG]: (payload) => {
    config = { ...DEFAULT_CONFIG, ...payload };
    syncSliders();
  },

  /**
   * §4.6 的提醒：某个预置话题在一个 30 秒窗口里攒够了人。
   *
   * 震动是这个页面的核心功能，不是点缀 —— 老师的注意力在 PPT 上，
   * 手机在口袋里震一下才是"被通知到"。iOS Safari 没有 vibrate，
   * 所以它是加强项而不是依赖项，缺了就只闪不震。
   */
  [S2C.HOST_ALERT]: (payload) => {
    lastAlert = payload;
    flashUntil = Date.now() + 6000;
    if (typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate([120, 80, 120]);
      } catch {
        // 有些浏览器有 vibrate 但会抛（需要用户手势），忽略即可
      }
    }
    render();
  },

  [S2C.HOST_IDENTITY]: (payload) => {
    identities.set(payload.id, { studentId: payload.studentId, name: payload.name });
    render();
  },

  [S2C.EXPORT_READY]: (payload) => {
    showBanner(null);
    dom.exportOut.hidden = false;
    dom.exportOut.textContent = JSON.stringify(payload, null, 2);
  },

  [S2C.ERROR]: (payload) => {
    showBanner(payload?.message ? `服务端：${payload.message}` : "服务端拒绝了这次操作。");
  },

  // 老师不会收到这两类，但万一服务端行为改了，静默比崩掉好
  [S2C.RATE_LIMITED]: () => {},
  [S2C.REJECTED]: () => {},
};

// ── 参数滑块 ────────────────────────────────────────────────────────────

const sliderInputs = new Map();

function buildSliders() {
  dom.sliders.replaceChildren();
  for (const [key, limit] of Object.entries(CONFIG_LIMITS)) {
    const wrap = document.createElement("div");
    wrap.className = "slider";

    const top = document.createElement("div");
    top.className = "slider-top";
    const name = document.createElement("span");
    name.textContent = limit.label;
    const value = document.createElement("b");
    value.id = `value-${key}`;
    value.textContent = formatValue(key, config[key]);
    top.append(name, value);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(limit.min);
    input.max = String(limit.max);
    input.step = String(limit.step);
    input.value = String(config[key]);
    input.setAttribute("aria-label", limit.label);
    input.addEventListener("input", () => {
      const next = Number(input.value);
      value.textContent = formatValue(key, next);
      // 不在这里更新本地 config：以服务端回过来的 config 为准，
      // 否则老师屏幕上的数字会和投影上的实际效果脱节
      send(C2S.HOST_CONFIG, { [key]: next });
    });

    sliderInputs.set(key, { input, value });
    wrap.append(top, input);
    dom.sliders.append(wrap);
  }
}

function formatValue(key, raw) {
  const limit = CONFIG_LIMITS[key];
  const value = Number(raw);
  const shown = Number.isInteger(limit.step) ? String(value) : value.toFixed(2).replace(/0$/, "");
  return `${shown}${limit.unit}`;
}

function syncSliders() {
  for (const [key, entry] of sliderInputs) {
    const value = config[key];
    if (value === undefined) continue;
    entry.input.value = String(value);
    entry.value.textContent = formatValue(key, value);
  }
}

// ── 交互 ────────────────────────────────────────────────────────────────

function showConsole(open) {
  dom.console.hidden = !open;
  dom.alerter.hidden = open;
}

dom.badge.addEventListener("click", () => showConsole(true));
dom.collapse.addEventListener("click", () => showConsole(false));

// 清屏与暂停不做二次确认：它们是老师把课件抢回来的唯一手段（§7.3）
dom.clear.addEventListener("click", () => {
  if (send(C2S.HOST_CLEAR)) showBanner(null);
});

dom.pause.addEventListener("click", () => {
  send(C2S.HOST_PAUSE, { paused: !serverState.paused });
});

dom.mute.addEventListener("click", () => {
  send(C2S.HOST_MUTE, { minutes: MUTE_MINUTES });
});

dom.pinHottest.addEventListener("click", () => {
  const hottest = liveItems()
    .filter((item) => !item.resolved && !item.pinned)
    .sort(byImportance)[0];
  if (!hottest) {
    showBanner("现在没有可以置顶的问题。");
    return;
  }
  showBanner(null);
  send(C2S.HOST_PIN, { id: hottest.id, pinned: true });
});

dom.configReset.addEventListener("click", () => send(C2S.HOST_CONFIG, { ...DEFAULT_CONFIG }));

dom.export.addEventListener("click", () => {
  dom.exportOut.hidden = true;
  send(C2S.HOST_EXPORT, {});
});

function render() {
  renderPool();
}

buildSliders();

client = createClassroomClient({
  url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
  join: { role: ROLE.HOST, classId: CLASS_ID },
  // 注意参数是**整条消息** `{event, payload}`，不是 (event, payload)。
  // 拆成两个参数看待的话 handlers 永远查不到东西，页面会安静地什么都不做
  // —— 连接是好的、状态是"已连上"、只是列表永远空着。见 host-page.test.mjs。
  onEvent: (message) => {
    const handler = handlers[message?.event];
    if (handler) handler(message.payload ?? {});
    render();
  },
  // §4.3.2：重连必须清空本地重建。身份是老师主动拉的，跟着一起清 ——
  // 不清的话重连后旧身份会留在屏幕上，而它不一定还属于同一条弹幕。
  onReset: () => {
    items.clear();
    identities.clear();
    lastAlert = null;
    flashUntil = 0;
    render();
  },
  onStatus: () => render(),
});

client.open();

// 静音倒计时和提醒闪烁都要靠定时器推，没有别的时钟
setInterval(render, 1000);
