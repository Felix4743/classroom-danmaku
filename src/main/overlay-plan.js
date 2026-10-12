/**
 * 三级降级梯子的决策部分（技术方案 §4.1）。
 *
 * 弹幕层要在 PPT 之上飘，这件事在教室电脑上有三种下场：
 *
 *   L0  透明浮层，弹幕飘在 PPT 之上        ← 目标形态
 *   L1  屏幕底部 25% 的实心弹幕带          ← L0 被 PPT 独占全屏压下去、
 *                                            或透明合成变成黑底时的退路
 *   L2  干脆不用桌面程序，开浏览器全屏      ← U 盘程序根本起不来
 *
 * 这里只放**决策与几何**，不碰 Electron：启动时的探测器拿到的那几个
 * 布尔值怎么解释、L1 的窗口该放在哪儿、多显示器/投影扩展模式下该铺哪块屏，
 * 全是纯函数，所以能在 Node 里把每一条规则钉死。
 *
 * 为什么非要把这部分拆出来：这些判断只有在**教室里**才会走错，而教室里
 * 没有第二次机会 —— 老师不可能为了调这个把课停下。宁可在这里多写十条测试。
 */

/** 降级级别，从好到差。 */
export const LEVELS = Object.freeze(["L0", "L1", "L2"]);

/** L1 弹幕带占屏幕高度的比例（§4.1：「底部 25% 实心弹幕带」）。 */
export const L1_HEIGHT_RATIO = 0.25;

/**
 * 投影/扩展模式下该铺哪块屏（§4.1 的坑 4）。
 *
 * 默认**不铺主显示器**：教室电脑上老师自己要看的那块屏通常是主屏，
 * 弹幕应该出现在学生看的那块（外接投影）上。只有一块屏时别无选择。
 * 多块屏时优先没被标成 internal 的那块 —— 外接投影在系统里几乎总是
 * 被报成非内建显示器。
 */
export function pickDisplay(displays = [], options = {}) {
  const list = Array.isArray(displays) ? displays.filter(Boolean) : [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];

  const { prefer = "external" } = options;
  if (prefer === "primary") return list.find((d) => d.internal) ?? list[0];

  // 非内建的优先；都在同一个标记上时退回"不是主显示器"的那块
  const external = list.filter((d) => d.internal === false);
  if (external.length > 0) return external[0];
  const notPrimary = list.filter((d) => d.internal === true && d !== list[0]);
  return notPrimary[0] ?? list[0];
}

/**
 * 弹幕层的窗口矩形。
 *
 * L0 铺满整块屏；L1 只占底部 25% —— 上方 75% 留给窗口化的 PPT。
 * 用 `workArea`（去掉任务栏的区域）而不是整块屏：L1 的条带贴着任务栏
 * 会有一半被盖住。
 */
export function overlayBounds(display, level) {
  const area = display?.workArea ?? display?.bounds ?? { x: 0, y: 0, width: 1280, height: 720 };
  const { x, y, width, height } = area;
  if (level === "L1") {
    const bandHeight = Math.round(height * L1_HEIGHT_RATIO);
    return { x, y: y + height - bandHeight, width, height: bandHeight };
  }
  return { x, y, width, height };
}

/**
 * 把探测结果翻译成"该用哪一级"。
 *
 * @param {object} probe
 * @param {boolean|null} probe.visible 窗口真的浮在了前台窗口之上吗
 * @param {boolean|null} probe.transparent 透明区域真的透出了背后的桌面吗
 * @param {string|null} [probe.error] 探测本身失败的原因
 * @returns {{level: string, reason: string, unknown: boolean}}
 */
export function decideLevel(probe = {}) {
  const { visible, transparent, error } = probe;

  if (error) {
    // 探测失败**不降级**。自动降级是为了对付"黑屏"这种一眼可见的灾难，
    // 而探测失败说明我们什么都不知道；把 L0 换成一个明确的 L1 只会让
    // 观感变差却解决不了任何问题。真正的做法是照常上 L0，同时把
    // "没测出来，看着不对就手动切" 交给老师。
    return { level: "L0", reason: `没能探测透明窗口：${error}`, unknown: true };
  }
  if (transparent === false) {
    return {
      level: "L1",
      reason: "透明合成没成功（背景被画成了黑色），已切到底部弹幕带",
      unknown: false,
    };
  }
  if (visible === false) {
    return {
      level: "L1",
      reason: "弹幕层浮不到 PPT 上面（PPT 很可能是独占全屏），已切到底部弹幕带",
      unknown: false,
    };
  }
  return { level: "L0", reason: "透明浮层可用", unknown: false };
}

/**
 * 像素比对：屏幕上抓回来的那一块，是不是我们画的那个纯色。
 *
 * 允许容差是因为显示器色彩管理、缩放、截图压缩都会让颜色偏一点点 ——
 * 用严格相等会在某些教室电脑上一直误判成"失败"，然后每次都把老师降到 L1。
 *
 * @param {{r: number, g: number, b: number, a?: number}} pixel
 * @param {{r: number, g: number, b: number}} expected
 */
export function pixelMatches(pixel, expected, tolerance = 24) {
  if (!pixel || !expected) return false;
  if (pixel.a !== undefined && pixel.a < 200) return false;
  return (
    Math.abs(pixel.r - expected.r) <= tolerance &&
    Math.abs(pixel.g - expected.g) <= tolerance &&
    Math.abs(pixel.b - expected.b) <= tolerance
  );
}

/** 探测用的标志色。选洋红是因为它在 PPT 里几乎不会自然出现。 */
export const PROBE_COLOR = Object.freeze({ r: 255, g: 0, b: 255 });

/** 探测页怎么画：**左半边什么都不画**（用来验透明），右半边铺满标志色（用来验浮层）。 */
export const PROBE_REGIONS = Object.freeze({
  clear: Object.freeze({ xRatio: 0.25, yRatio: 0.5 }),
  marker: Object.freeze({ xRatio: 0.75, yRatio: 0.5 }),
});

/** 抓回来的位图是 BGRA（Electron `nativeImage.toBitmap()` 的排布）。 */
export function samplePixel(bitmap, size, xRatio, yRatio) {
  if (!bitmap || !size || !size.width || !size.height) return null;
  const x = Math.min(size.width - 1, Math.max(0, Math.floor(xRatio * size.width)));
  const y = Math.min(size.height - 1, Math.max(0, Math.floor(yRatio * size.height)));
  const i = (y * size.width + x) * 4;
  if (i + 3 >= bitmap.length) return null;
  return { b: bitmap[i], g: bitmap[i + 1], r: bitmap[i + 2], a: bitmap[i + 3] };
}

/** 多暗算"黑"。低于这个亮度就无法区分"透过去看到的黑桌面"和"没透明成功的黑底"。 */
export const NEAR_BLACK = 18;

/**
 * 把探测前后各一张整屏画面比对成 `decideLevel` 要的三个输入。
 *
 * 这个逻辑的关键在于**两个半边各自证明一件事**，缺一不可：
 *  - 右半边是我们画的洋红：能看见 → 窗口确实浮在了前台窗口之上（否则被 PPT 盖住）。
 *  - 左半边我们什么都没画：和探测前一样 → 透明合成成功（否则是黑底糊在上面）。
 *
 * 左半边有个死结：如果 PPT 本来就是一张纯黑幻灯片，
 * "透明成功"和"黑底失败"看起来**一模一样**，这时候如实返回 `null`（测不出来），
 * 交给 `decideLevel` 按"不降级"处理，而不是赌一个结果。
 */
export function compareProbeSamples(before, after, tolerance = 40) {
  if (!before || !after) {
    return { visible: null, transparent: null, detail: { error: "探测画面缺失" } };
  }
  const visible = pixelMatches(after.marker, PROBE_COLOR);
  const sameAsBefore = pixelMatches(after.clear, before.clear, tolerance);
  const backgroundIsBlack =
    !!before.clear && before.clear.r < NEAR_BLACK && before.clear.g < NEAR_BLACK && before.clear.b < NEAR_BLACK;

  let transparent = null;
  if (!sameAsBefore) transparent = false;
  else if (!backgroundIsBlack) transparent = true;

  return {
    visible,
    transparent,
    detail: { before, after, sameAsBefore, backgroundIsBlack },
  };
}

/** 从一张 `{bitmap, size}` 里取两个采样点。 */
export function readProbeSample(frame) {
  if (!frame) return null;
  return {
    clear: samplePixel(frame.bitmap, frame.size, PROBE_REGIONS.clear.xRatio, PROBE_REGIONS.clear.yRatio),
    marker: samplePixel(frame.bitmap, frame.size, PROBE_REGIONS.marker.xRatio, PROBE_REGIONS.marker.yRatio),
  };
}
