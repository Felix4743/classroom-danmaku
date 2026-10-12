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

  /*
   * 只有**明确证明**透明与置顶都成立，才上 L0。
   *
   * 这条规则是踩出来的：早先的写法是"测不出来就照常上 L0"，理由是"自动降级
   * 只会让观感变差"。但代价是不对称的 —— 猜错的两种后果完全不是一个量级：
   *   猜错成 L0：一整块黑屏盖住老师的课件，这节课直接上不下去；
   *   猜错成 L1：弹幕在屏幕底部 25% 的一条带里跑，功能一个不少。
   * 所以"不确定"必须往 L1 倒，并且把"想全屏透明就手动切"交给托盘。
   */
  if (error) {
    return {
      level: "L1",
      reason: `没能探测透明浮层（${error}），先用底部弹幕带；想在 PPT 上飘就在托盘里手动切`,
      unknown: true,
    };
  }
  if (transparent !== true) {
    return {
      level: "L1",
      unknown: transparent === null,
      reason:
        transparent === false
          ? "透明合成没成功（背景被画成了黑色），已切到底部弹幕带"
          : "透明合成没法确认（背后那块本来就是黑的），已切到底部弹幕带",
    };
  }
  if (visible !== true) {
    return {
      level: "L1",
      unknown: visible === null,
      reason:
        visible === false
          ? "弹幕层浮不到 PPT 上面（PPT 很可能是独占全屏），已切到底部弹幕带"
          : "没能确认弹幕层浮在 PPT 之上，已切到底部弹幕带",
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

/**
 * 验透明的那半边取哪几个点。
 *
 * 取多个点不是保险起见，是被现实逼的：判定"透过去了"的唯一依据是
 * 「我们没画的那块，和探测前一模一样」，可如果那块本来就是黑的，
 * "透过去看到黑桌面"和"没透明成功的黑底"在像素上完全一样，什么都证不出来。
 * 单点采样撞上一块黑桌面的概率不低（深色壁纸、黑底的资源管理器窗口），
 * 多点里挑**最亮**的那个，才有可能找到一块能说话的背景。
 */
export const PROBE_CLEAR_POINTS = Object.freeze([
  Object.freeze({ xRatio: 0.1, yRatio: 0.2 }),
  Object.freeze({ xRatio: 0.25, yRatio: 0.5 }),
  Object.freeze({ xRatio: 0.35, yRatio: 0.78 }),
  Object.freeze({ xRatio: 0.42, yRatio: 0.35 }),
]);

/** 抓回来的位图是 BGRA（Electron `nativeImage.toBitmap()` 的排布）。 */
export function samplePixel(bitmap, size, xRatio, yRatio) {
  if (!bitmap || !size || !size.width || !size.height) return null;
  const x = Math.min(size.width - 1, Math.max(0, Math.floor(xRatio * size.width)));
  const y = Math.min(size.height - 1, Math.max(0, Math.floor(yRatio * size.height)));
  return sampleAt(bitmap, size, x, y);
}

/** 按位图坐标取一个像素（BGRA）。越界返回 null，绝不读到别人的内存。 */
export function sampleAt(bitmap, size, x, y) {
  if (!bitmap || !size || !size.width || !size.height) return null;
  if (x < 0 || y < 0 || x >= size.width || y >= size.height) return null;
  const i = (y * size.width + x) * 4;
  if (i + 3 >= bitmap.length) return null;
  return { b: bitmap[i], g: bitmap[i + 1], r: bitmap[i + 2], a: bitmap[i + 3] };
}

/**
 * 多暗算"黑"。
 *
 * **必须 ≥ `compareProbeSamples` 的默认容差（40）**，这两个数是一对：
 * 容差决定了"两个颜色算不算同一个"，那么只要参考色落在容差能碰到纯黑的
 * 范围内，"它和黑一样"与"它和参考一样"就同时成立，结论必然是假的。
 * 之前的 18 配着 40 的容差，于是桌面上 rgb(30,32,38) 和窗口里的
 * rgb(11,13,18) 被判成"一模一样"→ 谎报透明成功 → 全屏黑屏。
 */
export const NEAR_BLACK = 56;

/** 一个像素里最大的那个通道，用来判断"它到底有多亮"。 */
function brightness(pixel) {
  if (!pixel) return -1;
  return Math.max(pixel.r, pixel.g, pixel.b);
}

/** 从几个候选点里挑最亮的那个下标；全空返回 0。 */
function brightestIndex(pixels) {
  let best = 0;
  let bestValue = -1;
  for (let i = 0; i < pixels.length; i++) {
    const value = brightness(pixels[i]);
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

/**
 * 把探测前后各一张整屏画面比对成 `decideLevel` 要的三个输入。
 *
 * 这个逻辑的关键在于**两个半边各自证明一件事**，缺一不可：
 *  - 右半边是我们画的洋红：能看见 → 窗口确实浮在了前台窗口之上（否则被 PPT 盖住）。
 *  - 左半边我们什么都没画：和探测前一样 → 透明合成成功（否则是黑底糊在上面）。
 *
 * 左半边有个死结：如果背后本来就是一片黑，
 * "透明成功"和"黑底失败"看起来**一模一样**，这时候如实返回 `null`（测不出来），
 * 由 `decideLevel` 按"不确定就退 L1"处理，而不是赌一个结果。
 */
export function compareProbeSamples(before, after, tolerance = 40) {
  if (!before || !after) {
    return { visible: null, transparent: null, detail: { error: "探测画面缺失" } };
  }

  const visible = pixelMatches(after.marker, PROBE_COLOR);

  /*
   * 用探测**前**那张图来挑采样点：那时候屏幕上还没有我们任何东西，
   * 挑出来的必定是"能说明问题"的位置（最亮的背景）。
   * 探测后那张图必须取**同一个点**，否则比的是两个不同的地方。
   */
  const beforeClears = Array.isArray(before.clears) && before.clears.length > 0 ? before.clears : [before.clear];
  const afterClears = Array.isArray(after.clears) && after.clears.length > 0 ? after.clears : [after.clear];
  const index = brightestIndex(beforeClears);
  const ref = beforeClears[index] ?? before.clear;
  const now = afterClears[index] ?? after.clear;

  const sameAsBefore = pixelMatches(now, ref, tolerance);
  const backgroundIsBlack = brightness(ref) <= NEAR_BLACK;

  let transparent = null;
  if (!sameAsBefore) transparent = false;
  else if (!backgroundIsBlack) transparent = true;

  return {
    visible,
    transparent,
    detail: { before: ref, after: now, sameAsBefore, backgroundIsBlack, sampleIndex: index },
  };
}

/**
 * 从一张 `{bitmap, size}` 里取采样点：右半边的标志点 + 左半边的几个候选点。
 *
 * **采样位置相对于窗口，不是相对于整块屏。**
 * 这一条是踩出来的：探测窗口先按 L1 建（只占屏幕底部 25%），而采样点原本
 * 按整块屏的 (75%, 50%) 算 —— 那个点落在窗口外面，那里根本没有我们画的东西，
 * 于是"看不见洋红"→ 误判成"浮不到 PPT 上面"→ 永远升不到 L0。
 *
 * @param {{bitmap: Buffer, size: {width: number, height: number}}} frame
 * @param {object} [options]
 * @param {{width: number, height: number}} [options.display] 显示屏的逻辑尺寸（抓屏对应的整块屏）
 * @param {{x: number, y: number, width: number, height: number}} [options.rect] 窗口在**这块屏内**的矩形
 */
export function readProbeSample(frame, options = {}) {
  if (!frame) return null;
  const { bitmap, size } = frame;
  const display = options.display ?? size;
  const rect = options.rect ?? { x: 0, y: 0, width: display.width ?? size.width, height: display.height ?? size.height };
  // 缩略图和整块屏之间的比例：抓屏时按宽度缩过，横竖各算一次更稳
  const scaleX = size.width / Math.max(1, display.width ?? size.width);
  const scaleY = size.height / Math.max(1, display.height ?? size.height);
  const at = (xRatio, yRatio) =>
    sampleAt(
      bitmap,
      size,
      Math.round((rect.x + xRatio * rect.width) * scaleX),
      Math.round((rect.y + yRatio * rect.height) * scaleY),
    );

  const clear = at(PROBE_REGIONS.clear.xRatio, PROBE_REGIONS.clear.yRatio);
  const clears = PROBE_CLEAR_POINTS.map((point) => at(point.xRatio, point.yRatio));
  return { clear, clears, marker: at(PROBE_REGIONS.marker.xRatio, PROBE_REGIONS.marker.yRatio) };
}
