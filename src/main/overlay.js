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
  pixelMatches,
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
 * 窗口在这块屏**内部**的矩形。
 *
 * 抓屏抓的是整块屏，而窗口坐标是屏幕坐标系的 —— 副屏上 `display.bounds.x`
 * 不是 0，不减掉它就会去屏幕外面采样。采样点必须跟着窗口走：
 * 探测期间窗口只占底部那条带，按整块屏的比例去取点，取到的是带子外面的桌面，
 * 那里没有我们画的任何东西，于是必然误判。
 */
export function localRect(win, display) {
  const box = win?.getBounds?.() ?? { x: 0, y: 0, width: 0, height: 0 };
  const base = display?.bounds ?? { x: 0, y: 0 };
  return { x: box.x - base.x, y: box.y - base.y, width: box.width, height: box.height };
}

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
    const rect = localRect(win, display);
    const beforeFrame = await capture(display);
    const before = readProbeSample(beforeFrame, { display: display?.bounds, rect });

    await win.loadURL(PROBE_URL);
    win.showInactive();
    await sleep(PROBE_SETTLE_MS);

    let after = null;
    let result = null;
    // 抓一次可能刚好抓到还没画上来的那一帧，再给一次机会就够了；
    // 重试太多次会让"冷启动到上屏 < 10 秒"（§7.4）失守。
    for (let attempt = 0; attempt < 2; attempt++) {
      const afterFrame = await capture(display);
      after = readProbeSample(afterFrame, { display: display?.bounds, rect });
      result = compareProbeSamples(before, after);
      if (result.visible) break;
      await sleep(400);
    }
    logger.log?.("[overlay] 探测结果", { ...result, attempt: result.visible ? 1 : 2 });
    // 把探测前那张采样和采样矩形一并带出去：装载真正的弹幕页之后还要再对一次账。
    return { ...result, reference: before, rect };
  } catch (error) {
    return { visible: null, transparent: null, error: error?.message ?? String(error) };
  }
}

/** 装完真正的弹幕页之后，等它画上来再抓一次。 */
export const VERIFY_SETTLE_MS = 700;

/**
 * 装完真正的弹幕页后的**第二次对账**。
 *
 * 探测页是我们自己写的（`html, body { background: transparent }`），
 * 真正上屏的弹幕页是另一份 HTML + CSS。只要那份 CSS 在 `html` 上留了底色，
 * 透明窗口就会变成一块盖住全屏的黑板 —— 而探测全程测的都是探测页，
 * 一点都看不出来。这不是假想的：`screen.css` 里 `html, body` 合并写
 * `background: #0b0d12` 时，`body.mode-overlay { background: transparent }`
 * 完全不起作用，老师看到的就是一块黑板，探测却报告"透明浮层可用"。
 *
 * 所以这里用**探测前那张图**当参照，再看一眼真实的页面有没有把底糊上。
 * 只有在探测已经确认"背后不是黑的"（`transparent === true`）时才做这一步，
 * 因为那时参照点一定是有内容的，比对才有意义。
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export async function verifyOverlayPage({ display, reference, rect, logger = console, capture = captureScreen } = {}) {
  if (!reference) return { ok: true, reason: null };
  try {
    await sleep(VERIFY_SETTLE_MS);
    const frame = await capture(display);
    const sample = readProbeSample(frame, { display: display?.bounds, rect });
    const beforeClears = Array.isArray(reference.clears) && reference.clears.length > 0 ? reference.clears : [reference.clear];
    let index = 0;
    let brightest = -1;
    for (let i = 0; i < beforeClears.length; i++) {
      const pixel = beforeClears[i];
      const value = pixel ? Math.max(pixel.r, pixel.g, pixel.b) : -1;
      if (value > brightest) {
        brightest = value;
        index = i;
      }
    }
    const ref = beforeClears[index] ?? reference.clear;
    const now = (sample.clears ?? [])[index] ?? sample.clear;
    if (!pixelMatches(now, ref)) {
      return { ok: false, reason: "真正的弹幕页把底盖成了不透明" };
    }
    return { ok: true, reason: null };
  } catch (error) {
    // 抓不到屏幕不能当成"页面不透明"，否则在拦屏幕捕获的机器上会把 L0 白白踢掉
    logger.warn?.("[overlay] 复验没能抓到屏幕，按通过处理", error?.message ?? error);
    return { ok: true, reason: null };
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

  /*
   * 窗口**先按 L1 建**（屏幕底部 25% 那条带），确认透明可用之后再撑成全屏。
   *
   * 顺序反过来是最容易被忽略的坑：探测要抓两次屏、等一两秒，这段时间里
   * 窗口是已经存在的。如果它一上来就是全屏，那么只要合成失败，
   * 老师眼前就是一块盖住全屏的黑板 —— 探测再准也来不及救。
   * L1 的窗口最多盖住屏幕下方四分之一，无论出什么事都还能讲课。
   */
  const win = createOverlayWindow({ bounds: overlayBounds(display, forcedLevel ?? "L1"), logger });

  let probe = null;
  let decision;
  if (forcedLevel) {
    decision = { level: forcedLevel, reason: "老师手动指定的级别", unknown: false };
  } else {
    // 第一轮：窗口还只占底部那条带，无论探测出什么事都盖不住老师的屏幕
    probe = await runProbe({ win, display, logger, capture: options.capture });
    decision = decideLevel(probe);

    if (decision.level === "L0") {
      /*
       * 第二轮：撑到全屏之后**再验一次**。
       *
       * 一条 25% 高的带子能透明，不代表一块全屏的窗口也能：
       * 全屏窗口在合成层级、独占全屏的争抢上都不是同一种待遇。
       * 探测期间窗口小而安全，验证必须发生在它真正上屏的那个尺寸上。
       */
      applyLevel(win, display, "L0");
      const full = await runProbe({ win, display, logger, capture: options.capture });
      if (decideLevel(full).level === "L0") {
        probe = full;
      } else {
        decision = {
          level: "L1",
          reason: "撑到全屏之后透明/置顶就不成立了，已退回底部弹幕带",
          unknown: false,
        };
      }
    }
  }

  let bounds = applyLevel(win, display, decision.level);
  await win.loadURL(overlayUrl(url, decision));
  win.showInactive();

  /*
   * 撑到全屏之前最后一道闸：真正上屏的那份页面，是不是也真的透明。
   * 探测验的是探测页，这一关验的是弹幕页 —— 两者是两份 CSS，
   * 而"两份 CSS 不一致"正是全屏黑板事故的真正成因。
   */
  if (decision.level === "L0" && probe?.reference) {
    const check = await verifyOverlayPage({
      display,
      reference: probe.reference,
      rect: probe.rect,
      logger,
      capture: options.capture,
    });
    if (!check.ok) {
      decision = { level: "L1", reason: `${check.reason}，已退回底部弹幕带`, unknown: false };
      bounds = applyLevel(win, display, decision.level);
      await win.loadURL(overlayUrl(url, decision));
      win.showInactive();
      logger.warn?.(`[overlay] ${check.reason}，已退回 L1`);
    }
  }

  logger.log?.(`[overlay] 级别 ${decision.level}：${decision.reason}`);
  return {
    win,
    display,
    probe,
    /*
     * 这几项都走 getter：老师随时能在托盘里换级别，托盘菜单每次重建都要读到
     * **当前**的级别。写成普通属性的话，菜单上那个单选会一直停在上次的值上。
     */
    get level() {
      return decision.level;
    },
    get reason() {
      return decision.reason;
    },
    get unknown() {
      return decision.unknown;
    },
    get bounds() {
      return win.isDestroyed() ? bounds : win.getBounds();
    },
    /** 手动切换级别（托盘里那两个单选就用它）。 */
    async setLevel(level) {
      /*
       * 手动切到全屏透明时也要过同一道闸。
       *
       * 老师会按这个按钮，通常正是因为他觉得现在这级不对。如果这台机器上
       * 全屏透明其实不成立，按下去的结果就是**整块屏变黑** —— 而他此刻
       * 能按的键只剩 Ctrl+Alt+D。所以先按 L0 走一遍，不成立就自己退回来，
       * 并把话说清楚。
       */
      const reached = applyLevel(win, display, level);
      let reason = "老师手动切换";
      let finalLevel = level;

      if (level === "L0") {
        // 参照图必须在窗口隐藏时抓，否则比的是"我们自己"
        win.hide();
        await sleep(150);
        let reference = null;
        try {
          const frame = await capture(display);
          reference = readProbeSample(frame, { display: display?.bounds, rect: reached });
        } catch (error) {
          logger.warn?.("[overlay] 手动切 L0 时抓不到屏幕，跳过复验", error?.message ?? error);
        }
        decision = { level, reason, unknown: false };
        await win.loadURL(overlayUrl(url, decision));
        win.showInactive();
        if (reference) {
          const check = await verifyOverlayPage({ display, reference, rect: reached, logger, capture });
          if (!check.ok) {
            finalLevel = "L1";
            reason = `${check.reason}，已退回底部弹幕带`;
            logger.warn?.(`[overlay] ${reason}`);
          }
        }
      }

      if (finalLevel !== level) {
        applyLevel(win, display, finalLevel);
        decision = { level: finalLevel, reason, unknown: false };
        await win.loadURL(overlayUrl(url, decision));
        win.showInactive();
      } else {
        decision = { level: finalLevel, reason, unknown: false };
      }
      return { level: finalLevel, reason, bounds: win.getBounds() };
    },
    destroy() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
