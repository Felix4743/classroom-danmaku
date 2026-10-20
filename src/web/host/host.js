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
import {
  createAddressPicker,
  loadServerInfo,
  paintJoinCard,
} from "../../shared/join-card.js";
import { C2S, ROLE, S2C } from "../../shared/protocol.js";
import { TUNNEL_LABEL, TUNNEL_PATHS, TUNNEL_STATE } from "../../shared/tunnel-api.js";

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
  welcome: document.getElementById("welcome"),
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
  joinQr: document.getElementById("join-qr"),
  joinUrl: document.getElementById("join-url"),
  joinHint: document.getElementById("join-hint"),
  joinNotice: document.getElementById("join-notice"),
  joinWarn: document.getElementById("join-warn"),
  joinNext: document.getElementById("join-next"),
  tunnel: document.getElementById("tunnel"),
  tunnelState: document.getElementById("tunnel-state"),
  tunnelUrl: document.getElementById("tunnel-url"),
  tunnelMsg: document.getElementById("tunnel-msg"),
  tunnelToggle: document.getElementById("tunnel-toggle"),
  tunnelLink: document.getElementById("tunnel-link"),
  pool: document.getElementById("pool"),
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
/** §4.10 的扫码卡片。`picker` 为 null 表示还没查到地址（或者查失败了）。 */
let joinCard = null;

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

// ── 扫码入口（§4.10） ───────────────────────────────────────────────────

/**
 * 画一次卡片，并把「换一个地址」按钮的显隐定下来。
 *
 * 按钮在多条候选时才出现：只有一个地址的话，按它什么都不会变，
 * 老师按两下就会开始怀疑是不是坏了。
 */
function renderJoinCard() {
  const picker = joinCard;
  paintJoinCard(
    {
      canvas: dom.joinQr,
      urlText: dom.joinUrl,
      hintText: dom.joinHint,
      noticeText: dom.joinNotice,
    },
    picker?.current ?? null,
    { best: picker?.best ?? null },
  );
  dom.joinNext.hidden = !picker?.multiple;

  // 地址探测的提醒（网卡没拿到 IP、热点和别的网卡同时在、防火墙没放行…）
  // 不塞进 banner：banner 是"服务端拒绝了什么操作"的地方，混在一起会让两件事都变模糊。
  // 全部拼出来而不是只显示第一条 —— 只显示第一条会让后面的提醒被悄悄吃掉。
  const warning = (picker?.warnings ?? []).filter((line) => line).join(" ");
  dom.joinWarn.textContent = warning;
  dom.joinWarn.hidden = warning === "";
}

/**
 * 查地址这件事**不能挡住页面**。
 *
 * 网卡枚举在虚拟机、断线 VPN 上偶尔会卡几秒，而老师正站在讲台上等这个页面。
 * 所以它是后台跑的：先让控制台照常可用，地址回来后自己填进去。
 */
async function loadJoinCard() {
  let info = null;
  try {
    info = await loadServerInfo();
    const picker = createAddressPicker(info);
    // best 单独存着：picker.current 会随着「换一个地址」变，但"推荐"始终指首选
    joinCard = Object.assign(picker, {
      best: info?.best ?? null,
      warnings: Array.isArray(info?.warnings) ? info.warnings : [],
    });
  } catch (error) {
    // 开公网的那一分钟里这个函数每秒都在跑。某一次失败不该把已经画好的
    // 二维码抹掉 —— 老师站在讲台上看到二维码突然消失，只会去重连 Wi-Fi。
    console.warn("[host] 查学生地址失败", error?.message ?? error);
  }
  renderJoinCard();
  renderTunnel(info?.tunnel);
  return info;
}

// ── 公网地址（§4.12） ───────────────────────────────────────────────────

/** 上一次画出来的隧道状态。按钮被点击时不用再去问服务端。 */
let lastTunnel = { available: false };
/** 有一次操作正在飞。这期间按钮一律置灰，避免连点开出两条隧道。 */
let tunnelBusy = false;
/** 轮询用的定时器。同一时间只允许有一个。 */
let tunnelTimer = null;

/**
 * 把服务端给的隧道状态画出来。
 *
 * `available` 为假表示这次构建里根本没内置穿透程序（开发时没放二进制，
 * 或者以后把这个功能关掉了）—— 那就整块不显示，而不是摆一个点了没反应的
 * 按钮让老师以为坏了。
 */
function renderTunnel(tunnel) {
  if (tunnel) lastTunnel = tunnel;
  const view = lastTunnel;

  dom.tunnel.hidden = !view.available;
  if (!view.available) return;

  const state = view.state ?? TUNNEL_STATE.OFF;
  dom.tunnelState.textContent = TUNNEL_LABEL[state] ?? state;
  dom.tunnelState.dataset.state = state;

  const url = view.publicUrl ?? "";
  dom.tunnelUrl.textContent = url;
  dom.tunnelUrl.hidden = url === "";

  dom.tunnelMsg.textContent = view.message ?? "";

  const toggle = dom.tunnelToggle;
  toggle.disabled = tunnelBusy || state === TUNNEL_STATE.STARTING;
  toggle.textContent =
    {
      [TUNNEL_STATE.ON]: "关公网",
      [TUNNEL_STATE.STARTING]: "正在开启…",
      [TUNNEL_STATE.NO_ACCOUNT]: "绑定花生壳账号",
      [TUNNEL_STATE.ERROR]: "重试",
    }[state] ?? "开公网";
}

/** 停掉轮询。每次开新的之前都先停，免得两个定时器抢着改界面。 */
function stopTunnelPolling() {
  if (tunnelTimer !== null) {
    clearInterval(tunnelTimer);
    tunnelTimer = null;
  }
}

/**
 * 每隔一段时间问一次，直到 `tick()` 说可以停了。
 *
 * 用轮询而不是等推送：建隧道和"老师在浏览器里授权"这两件事都发生在 HTTP
 * 服务之外，服务端没有事件可推；而且它总共也就跑一两分钟。
 *
 * 这里刻意用 `tunnelTimer === id` 判断再清：`tick()` 里可能会接着开下一个
 * 轮询（授权成功 → 接着建隧道），不判断的话外层收尾会把新定时器一起清掉。
 */
function pollEvery(tick, { intervalMs = 1500, tries = 40 } = {}) {
  stopTunnelPolling();
  let left = tries;
  const id = setInterval(async () => {
    left -= 1;
    let done = false;
    try {
      done = await tick();
    } catch (error) {
      console.warn("[host] 轮询公网状态出错", error?.message ?? error);
    }
    if ((done || left <= 0) && tunnelTimer === id) stopTunnelPolling();
  }, intervalMs);
  tunnelTimer = id;
}

/** 建隧道要十几秒，服务端不等它建完就返回了，所以这里自己盯到出结果。 */
function pollTunnelReady() {
  pollEvery(async () => {
    const info = await loadJoinCard();
    return info?.tunnel?.state !== TUNNEL_STATE.STARTING;
  });
}

async function tunnelAction(path) {
  const res = await fetch(path, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`服务端返回了 ${res.status}`);
  return body;
}

/** 只读地看一眼状态，顺便带上账号（`?account=1` 会起子进程，别拿它当心跳）。 */
async function tunnelStatus() {
  const res = await fetch(`${TUNNEL_PATHS.status}?account=1`);
  return res.ok ? res.json() : null;
}

/**
 * 起一次授权，把老师送到花生壳的登录页，回来后自动接着把公网开起来。
 *
 * 老师点「绑定花生壳账号」的本意是"把公网开起来"，所以授权完成后不该让他
 * 回来再点一次「开公网」—— 这里授权一通过就自己往下走。
 */
async function beginTunnelLogin() {
  // 授权链接要等一轮请求才回来，那时候已经不在用户手势里了，再 window.open
  // 会被浏览器当弹窗拦掉。所以先同步开一个空窗口，拿到地址再往里填。
  const win = window.open("", "_blank");
  const body = await tunnelAction(TUNNEL_PATHS.login);
  if (!body.ok || !body.authorizeUrl) {
    win?.close();
    dom.tunnelMsg.textContent = body.message ?? "没能拿到授权链接，过一会儿再试。";
    return;
  }

  // 弹窗被拦掉时的兜底：老师端经常是在手机上打开的，那里 window.open 基本必拦
  dom.tunnelLink.href = body.authorizeUrl;
  dom.tunnelLink.hidden = false;
  if (win) win.location = body.authorizeUrl;
  dom.tunnelMsg.textContent = "在打开的页面里登录花生壳账号，完成后这里会自动继续。";

  pollEvery(
    async () => {
      const status = await tunnelStatus();
      if (!status?.account?.authenticated) return false;
      dom.tunnelLink.hidden = true;
      dom.tunnelMsg.textContent = "账号已绑定，正在开公网…";
      const started = await tunnelAction(TUNNEL_PATHS.start);
      await loadJoinCard();
      if (started.tunnel?.state === TUNNEL_STATE.STARTING) pollTunnelReady();
      return true;
    },
    { intervalMs: 2500, tries: 72 },
  );
}

/**
 * 这次点击要干什么，由**当前状态**决定，而不是按钮上写着什么。
 *
 * 同一条路（"把公网开起来"）上有三种处境：没账号要先去绑、没开、开失败了
 * 要重试。它们长在同一个按钮上，是因为对老师来说这本来就是一件事。
 */
async function onTunnelToggle() {
  const state = dom.tunnelState.dataset.state ?? TUNNEL_STATE.OFF;

  tunnelBusy = true;
  renderTunnel();
  // 走授权流程时，`beginTunnelLogin()` 会把提示改成"去打开的页面里登录"，那句
  // 比 `/api/info` 带回来的"还没绑定账号"更贴近老师此刻该做的事。而 finally 里
  // 的 renderTunnel() 会照着 lastTunnel 把文案盖回去 —— 实测就是这一下把提示
  // 冲掉了，老师看到弹出的登录页、页面上却还写着"还没绑定花生壳账号"。所以这
  // 条路上跳过收尾重绘，等轮询真的拿到新状态时自然会画。
  let keepNotice = false;
  try {
    if (state === TUNNEL_STATE.ON) {
      stopTunnelPolling();
      await tunnelAction(TUNNEL_PATHS.stop);
      await loadJoinCard();
      return;
    }
    if (state === TUNNEL_STATE.NO_ACCOUNT) {
      keepNotice = true;
      await beginTunnelLogin();
      return;
    }
    const body = await tunnelAction(TUNNEL_PATHS.start);
    await loadJoinCard();
    if (body.tunnel?.state === TUNNEL_STATE.STARTING) pollTunnelReady();
  } catch (error) {
    dom.tunnelMsg.textContent = `操作失败：${error?.message ?? error}`;
    keepNotice = true;
  } finally {
    tunnelBusy = false;
    // 跳过重绘时也得把按钮放出来：进这一步之前刚画过一次 `tunnelBusy = true`，
    // 不放的话它会一直灰着，老师连重试都点不动。
    if (keepNotice) dom.tunnelToggle.disabled = false;
    else renderTunnel();
  }
}

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

// 「换一个地址」是纯本地操作，不经过服务端 —— 它只是换一张二维码
dom.joinNext.addEventListener("click", () => {
  joinCard?.next();
  renderJoinCard();
});

// 公网那个按钮是一个"一键"：按钮上写什么由当前状态决定（见 onTunnelToggle）
dom.tunnelToggle.addEventListener("click", () => {
  onTunnelToggle();
});

/**
 * 离开页面时把轮询停掉。
 *
 * 不停的话定时器会跟着 bfcache 一起活下来，老师用返回键回到这一页时会发现
 * 有两个定时器在同时刷界面。
 */
window.addEventListener("pagehide", () => stopTunnelPolling());

function render() {
  renderPool();
}

/**
 * 启动窗的那句"我起来了"（技术方案 §7.4）。
 *
 * 约定是从启动窗打开时带 `?welcome=1`（见 src/main/console-window.js）。
 * 老师自己用浏览器打开这一页时不该看到它 —— 那时候他本来就知道程序在跑。
 *
 * 文案在这里拼、DOM 里那行是空的：写在 HTML 里的占位文字会先闪一下再被覆盖，
 * 而这一页正好是老师盯着看"到底开没开"的那一秒。
 */
function showWelcomeIfFromConsoleWindow() {
  if (new URLSearchParams(location.search).get("welcome") !== "1") return;
  dom.welcome.textContent = "课堂弹幕已启动。关掉这个窗口不影响上课。";
  dom.welcome.hidden = false;
}

showWelcomeIfFromConsoleWindow();
buildSliders();
// 二维码是后台查的，页面不等它（见 loadJoinCard 的说明）
loadJoinCard();

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
