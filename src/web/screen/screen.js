/**
 * 弹幕层（`/screen`）—— 投影上那层盖住 PPT 的东西。
 *
 * 它和学生页、老师页最大的区别是：**它一句话都不发**。它只是把服务端广播
 * 过来的弹幕画出来，所以它永远不进 host 房间，也永远拿不到任何学生身份
 * （§4.4 的红线）。老师按「清屏」「暂停」「删除」「置顶」时，投影这边是被动
 * 跟着变的 —— 这也是"老师手机上按一下，投影上立刻见效"那条验收标准的落点。
 *
 * 两个 URL 开关：
 *   `?mode=overlay` —— 去掉底色，给 Electron 的透明窗口用（§4.1 的 L0）。
 *   `?diag`        —— 显示右上角的帧率角标。投影上默认不显示任何字。
 */

import { createClassroomClient, STATUS } from "../../shared/client.js";
import { clampConfig, DEFAULT_CONFIG } from "../../shared/config.js";
import { ROLE, S2C } from "../../shared/protocol.js";
import {
  CanvasDanmakuView,
  DanmakuEngine,
  FpsMeter,
  fontOf,
} from "../../overlay/engine.js";

/** 一台服务只上一节课（和学生页、老师页同一个约定）。 */
const CLASS_ID = "default";

const params = new URLSearchParams(location.search);
const OVERLAY_MODE = params.get("mode") === "overlay";

/*
 * 所有 id 都写成字面量，不用 `el(id)` 这类小工具。
 * `tests/unit/static-graph.test.mjs` 靠正则抓 getElementById 后面的字符串
 * 字面量，再断言这些 id 在 HTML 里都找得到 —— 包一层函数它一个也抓不到。
 */
const dom = {
  stage: document.getElementById("stage"),
  hud: document.getElementById("hud"),
  hudFps: document.getElementById("hud-fps"),
  hudActive: document.getElementById("hud-active"),
  hudPinned: document.getElementById("hud-pinned"),
  hudLanes: document.getElementById("hud-lanes"),
  hudDpr: document.getElementById("hud-dpr"),
  hudDropped: document.getElementById("hud-dropped"),
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
};

if (OVERLAY_MODE) document.body.classList.add("mode-overlay");
dom.hud.hidden = !params.has("diag");

// ── 引擎 ────────────────────────────────────────────────────────────────────

// 宽度测量必须用真实的 2D context，且字体要和渲染时完全一致，否则轨道会算错
const ruler = document.createElement("canvas").getContext("2d");
function measureText(text, fontSize) {
  ruler.font = fontOf(fontSize);
  return ruler.measureText(text).width;
}

const engine = new DanmakuEngine({ measureText });
const view = new CanvasDanmakuView(dom.stage, engine);
const fps = new FpsMeter(180);

function resize() {
  const size = view.resize();
  dom.hudDpr.textContent = size.dpr.toFixed(2);
  dom.hudLanes.textContent = String(engine.laneCount);
}
window.addEventListener("resize", resize);
resize();

// ── 状态 ────────────────────────────────────────────────────────────────────

let config = { ...DEFAULT_CONFIG };
let serverState = { paused: false, mutedUntil: 0, clearedAt: 0 };
let connection = STATUS.IDLE;
let lastClearedAt = 0;

function applyConfig(patch) {
  /*
   * 先夹紧、再盖到当前配置上 —— 顺序很重要。
   *
   * 不能写成 `sanitizeConfig({...config, ...patch})`：sanitizeConfig 对每个
   * 认不出来的字段都退回**默认值**，于是服务端发来一个坏的字号，投影上的字
   * 会从 36 莫名其妙跳回 28。退回"当前值"才是对的。
   *
   * 「绝不让引擎拿到 NaN」这件事仍然成立：clampConfig 把所有非有限数都丢掉，
   * 而 config 一开始就是 DEFAULT_CONFIG 的副本，所以它永远不会被污染。
   * （引擎里只要有一处拿到 NaN，Canvas 就会安静地什么都不画 ——
   *   表现为"一片空白但控制台干净"，最难查的一类故障。）
   */
  config = { ...config, ...clampConfig(patch ?? {}) };
  engine.setConfig(config);
}

// ── 协议 ────────────────────────────────────────────────────────────────────

const handlers = {
  [S2C.JOINED](payload) {
    applyConfig(payload.config);
  },

  [S2C.CONFIG](payload) {
    applyConfig(payload);
  },

  [S2C.STATE](payload) {
    serverState = { ...serverState, ...payload };
    /*
     * 老师按了「清屏」，投影上的东西必须立刻没了。
     *
     * 判据是 `clearedAt` 变没变，而不是"收到 state 就清" —— state 还会因为
     * 暂停、静音、有人上下线而发过来，那些时候清屏会把正在飞的弹幕全抹掉，
     * 表现为"教室里明明有人在发，投影上却总是空的"。
     */
    if (payload.clearedAt && payload.clearedAt !== lastClearedAt) {
      lastClearedAt = payload.clearedAt;
      engine.clear();
    }
    renderStatus();
  },

  [S2C.NEW](payload) {
    engine.push(payload, performance.now());
  },

  [S2C.UPDATE](payload) {
    // 只有聚合计数要在投影上体现（§4.6）。点赞数、已回应是老师手机上的事
    if (payload.aggregate !== undefined) engine.setAggregate(payload.id, payload.aggregate);
  },

  [S2C.REMOVE](payload) {
    engine.remove(payload.id);
  },

  [S2C.PIN](payload) {
    // 置顶的消息里带着完整内容，所以"老师置顶一条早就滚过去的弹幕"也能钉上
    if (payload.pinned) engine.pin(payload);
    else engine.unpin(payload.id);
  },
};

// ── 提示条 ──────────────────────────────────────────────────────────────────

/**
 * 投影上唯一会出现的字。
 *
 * 老师站在讲台上，除了投影什么都看不到。所以"断线了""被暂停了""静音了"
 * 必须直接写在投影上 —— 否则学生发不出弹幕，老师只会觉得是学生不积极。
 */
function renderStatus() {
  const now = Date.now();
  let text = null;
  let tone = "alert";

  if (connection === STATUS.RECONNECTING || connection === STATUS.CLOSED) {
    text = "投影和服务器断开了，正在重连…";
  } else if (serverState.paused) {
    text = "弹幕已暂停";
    tone = "calm";
  } else if (serverState.mutedUntil > now) {
    text = "已静音，学生暂时发不了";
    tone = "calm";
  }

  dom.status.hidden = text === null;
  if (text !== null) {
    dom.statusText.textContent = text;
    dom.status.dataset.tone = tone;
  }
}

// ── 主循环（§4.2.1） ─────────────────────────────────────────────────────────

let lastHudAt = 0;

function frame(now) {
  fps.tick(now);
  engine.update(now);
  view.render();

  if (!dom.hud.hidden && now - lastHudAt > 250) {
    lastHudAt = now;
    const stats = fps.stats();
    const summary = engine.summary();
    dom.hudFps.textContent = stats.fps.toFixed(0);
    dom.hudActive.textContent = String(summary.active);
    dom.hudPinned.textContent = String(summary.pinned);
    dom.hudLanes.textContent = String(summary.laneCount);
    dom.hudDropped.textContent = String(summary.dropped);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── 连接 ────────────────────────────────────────────────────────────────────

const client = createClassroomClient({
  url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
  // 浏览器里的降级形态是 screen，盖在 PPT 上的透明窗口是 overlay（§4.1）
  join: { role: OVERLAY_MODE ? ROLE.OVERLAY : ROLE.SCREEN, classId: CLASS_ID },
  // 参数是**整条消息** `{event, payload}`，不是 (event, payload)
  onEvent: (message) => {
    const handler = handlers[message?.event];
    if (handler) handler(message.payload ?? {});
  },
  // §4.3.2：重连必须清空本地重建。置顶条也一起清 —— 服务端在 join 之后会
  // 把当前钉着的重发一遍，留着旧的反而会出现"老师已经取消置顶，投影上还钉着"
  onReset: () => {
    engine.clear({ keepPinned: false });
    lastClearedAt = 0;
  },
  onStatus: (next) => {
    connection = next;
    renderStatus();
  },
});

client.open();

// 静音是有时限的，到点了提示条要自己消失，没有别的时钟
setInterval(renderStatus, 1000);
