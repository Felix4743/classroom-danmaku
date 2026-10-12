/**
 * 弹幕层的窗口本体，以及 §4.1 要求的"透明浮层到底能不能用"的自动探测。
 *
 * 这是整个项目**唯一一块没法在 Node 里跑测试的代码**（它必须有个真的
 * Electron 和一个真的桌面），所以这里刻意写得又薄又笨：
 * 所有判断都推给 `./overlay-plan.js` 里的纯函数，测试打在那儿；
 * 这个文件只负责"建窗、抓屏、切级别"这三件手脚活。
 *
 * 探测为什么要抓整屏，而不是 `webContents.capturePage()`：
 * `capturePage()` 抓的是我们这个窗口**自己渲染出来的内容**，它当然是
 * 透明的 —— 无论操作系统有没有把这份透明合成上去。想验证"真的透过去了"，
 * 只能从外面看：抓一张**整个屏幕**的截图，看看我们窗口盖住的那块地方
 * 到底是洋红、是黑的、还是后面的 PPT。
 */

import { BrowserWindow, desktopCapturer, screen } from "electron";

import {
  compareProbeSamples,
  decideLevel,
  overlayBounds,
  pickDisplay,
  readProbeSample,
} from "./overlay-plan.js";

/** 探测页：左半边什么都不画，右半边铺满洋红。 */
const PROBE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: transparent; }
  #marker { position: fixed; left: 50%; top: 0; right: 0; bottom: 0; background: rgb(255, 0, 255); }
</style></head>
<body><div id="marker"></div></body></html>`;

const PROBE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PROBE_HTML)}`;

/** 显示探测页之后等多久再抓屏。太短会抓到还没画上来的那一帧。 */
export const PROBE_SETTLE_MS = 900;

/** 抓屏缩略图宽度。够定位"哪半边"就行，太大了慢。 */
export const PROBE_THUMB_WIDTH = 480;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 抓一张整屏画面。
 *
 * 返回 `{bitmap, size}`；`bitmap` 是 BGRA 排列的原始像素
 * （Electron `nativeImage.toBitmap()` 就是这么排的，不是 RGBA，取反了会得到
 * 一张红蓝互换的图，然后洋红的判定永远不成立）。
 */
export async function captureScreen(display, options = {}) {
  const { thumbWidth = PROBE_THUMB_WIDTH } = options;
  const bounds = display?.bounds ?? { width: 1280, height: 720 };
  const height = Math.max(1, Math.round((thumbWidth * bounds.height) / Math.max(1, bounds.width)));

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: thumbWidth, height },
  });
  if (!sources || sources.length === 0) {
    throw new Error("系统没有返回任何屏幕画面");
  }

  const wanted = sources.find((s) => String(s.display_id) === String(display?.id));
  const source = wanted ?? sources[0];
  const image = source?.thumbnail;
  if (!image || image.isEmpty()) {
    throw new Error("抓到的屏幕画面是空的（Windows 可能拦了屏幕捕获）");
  }
  return { bitmap: image.toBitmap(), size: image.getSize() };
}

/**
 * 建弹幕层窗口。
 *
 * 注释里每一条 `webPreferences` 都不是随手写的：
 *  - `backgroundThrottling: false`：**这条漏了弹幕就会变成 1fps**。
 *    这个窗口永远拿不到焦点（`focusable: false` + 鼠标穿透），
 *    Chromium 会把没焦点窗口的 rAF 节流到每秒一帧。老师会觉得"卡住了"，
 *    而在开发机上（窗口有焦点）永远复现不出来。
 *  - `sandbox: true` + 不挂 preload：弹幕页除了 HTTP 和 WebSocket 什么都不需要，
 *    那就什么都别给它。
 */
export function createOverlayWindow({ bounds, logger = console } = {}) {
  const box = bounds ?? { x: 0, y: 0, width: 1280, height: 720 };
  const win = new BrowserWindow({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      devTools: false,
    },
  });

  // "screen-saver" 这一级高于普通置顶窗口。默认的 "floating" 会被
  // 一些播放器/PPT 放映窗口盖住。
  win.setAlwaysOnTop(true, "screen-saver");
  // 鼠标穿透。`forward: true` 让渲染进程仍然收到 mousemove ——
  // 部分输入法/触控驱动下不加这个参数会让"置顶"失效（§4.1 的坑 3）。
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setMenuBarVisibility(false);
  logger.log?.("[overlay] 已建窗", box);
  return win;
}

/**
 * 跑一次透明浮层探测。
 *
 * 步骤（顺序不能换）：
 *   1. 窗口先不显示，抓一张参考图 —— 这就是"背后本来长什么样"。
 *   2. 显示探测页，等它画上来。
 *   3. 再抓一张。
 *   4. 右半边应该是洋红（浮在上面），左半边应该和参考图一样（透明成功）。
 */
export async function runProbe({ win, display, logger = console, capture = captureScreen } = {}) {
  try {
    win.hide();
    await sleep(150);
    const beforeFrame = await capture(display);
    const before = readProbeSample(beforeFrame);

    await win.loadURL(PROBE_URL);
    win.showInactive();
    await sleep(PROBE_SETTLE_MS);

    let after = null;
    let result = null;
    // 抓一次可能刚好抓到还没画上来的那一帧，再给一次机会就够了；
    // 重试太多次会让"冷启动到上屏 < 10 秒"（§7.4）失守。
    for (let attempt = 0; attempt < 2; attempt++) {
      const afterFrame = await capture(display);
      after = readProbeSample(afterFrame);
      result = compareProbeSamples(before, after);
      if (result.visible) break;
      await sleep(400);
    }
    logger.log?.("[overlay] 探测结果", { ...result, attempt: result.visible ? 1 : 2 });
    return result;
  } catch (error) {
    return { visible: null, transparent: null, error: error?.message ?? String(error) };
  }
}

/** 按级别把窗口摆到该在的位置。 */
export function applyLevel(win, display, level) {
  const bounds = overlayBounds(display, level);
  win.setBounds(bounds);
  return bounds;
}

/** 弹幕页地址（带上探测结论，页面据此决定要不要给老师一条提示）。 */
export function overlayUrl(base, decision) {
  const url = new URL(base);
  url.searchParams.set("mode", "overlay");
  url.searchParams.set("level", decision.level);
  if (decision.reason) url.searchParams.set("notice", decision.reason);
  if (decision.unknown) url.searchParams.set("probe", "unknown");
  return url.toString();
}

/**
 * 完整流程：选屏 → 建窗 → 探测 → 定级 → 装载真正的弹幕页。
 *
 * @param {object} options
 * @param {string} options.url 弹幕页地址（不带查询串）
 * @param {string} [options.forcedLevel] 老师手动指定级别时跳过探测
 * @param {Array} [options.displays] 注入显示器列表（测试/自检页用）
 */
export async function createOverlay(options = {}) {
  const { url, forcedLevel = null, displays, prefer = "external", logger = console } = options;
  const list = displays ?? screen.getAllDisplays();
  const display = pickDisplay(list, { prefer });
  if (!display) throw new Error("找不到任何显示器，没法放弹幕层");

  const win = createOverlayWindow({ bounds: overlayBounds(display, forcedLevel ?? "L0"), logger });

  let probe = null;
  let decision;
  if (forcedLevel) {
    decision = { level: forcedLevel, reason: "老师手动指定的级别", unknown: false };
  } else {
    probe = await runProbe({ win, display, logger });
    decision = decideLevel(probe);
  }

  const bounds = applyLevel(win, display, decision.level);
  await win.loadURL(overlayUrl(url, decision));
  win.showInactive();

  logger.log?.(`[overlay] 级别 ${decision.level}：${decision.reason}`);
  return {
    win,
    display,
    level: decision.level,
    reason: decision.reason,
    unknown: decision.unknown,
    probe,
    bounds,
    /** 手动切换级别（托盘里那个"切到底部弹幕带"就用它）。 */
    async setLevel(level) {
      const next = applyLevel(win, display, level);
      decision = { level, reason: "老师手动切换", unknown: false };
      await win.loadURL(overlayUrl(url, decision));
      win.showInactive();
      return next;
    },
    destroy() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
