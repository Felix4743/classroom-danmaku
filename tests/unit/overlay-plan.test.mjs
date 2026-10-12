import assert from "node:assert/strict";
import test from "node:test";

import {
  L1_HEIGHT_RATIO,
  NEAR_BLACK,
  PROBE_CLEAR_POINTS,
  PROBE_COLOR,
  PROBE_REGIONS,
  compareProbeSamples,
  decideLevel,
  overlayBounds,
  pickDisplay,
  pixelMatches,
  readProbeSample,
  samplePixel,
} from "../../src/main/overlay-plan.js";

/** 造一块整屏同色的假画面（BGRA，和 Electron `nativeImage.toBitmap()` 一样）。 */
function frame(width, height, pixel) {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = pixel.b;
    bitmap[i + 1] = pixel.g;
    bitmap[i + 2] = pixel.r;
    bitmap[i + 3] = pixel.a ?? 255;
  }
  return { bitmap, size: { width, height } };
}

const MAGENTA = { r: 255, g: 0, b: 255 };
const DESKTOP = { r: 240, g: 240, b: 235 };
const BLACK = { r: 4, g: 4, b: 6 };

/** 往假画面上的某个比例位置涂一个像素。 */
function paint(frame, width, xRatio, yRatio, pixel) {
  const x = Math.min(frame.size.width - 1, Math.floor(xRatio * frame.size.width));
  const y = Math.min(frame.size.height - 1, Math.floor(yRatio * frame.size.height));
  const i = (y * width + x) * 4;
  frame.bitmap[i] = pixel.b;
  frame.bitmap[i + 1] = pixel.g;
  frame.bitmap[i + 2] = pixel.r;
  frame.bitmap[i + 3] = pixel.a ?? 255;
}

// ---------------------------------------------------------------- 选屏

test("只有一块屏时没得选，就用它", () => {
  const only = { id: 1, internal: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  assert.equal(pickDisplay([only]), only);
});

test("多块屏时默认挑外接那块（学生看投影，老师看自己的屏）", () => {
  const laptop = { id: 1, internal: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const projector = { id: 2, internal: false, bounds: { x: 1920, y: 0, width: 1280, height: 720 } };
  assert.equal(pickDisplay([laptop, projector]), projector);
  assert.equal(pickDisplay([projector, laptop]), projector);
});

test("老师要求主屏时就给主屏", () => {
  const laptop = { id: 1, internal: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const projector = { id: 2, internal: false, bounds: { x: 1920, y: 0, width: 1280, height: 720 } };
  assert.equal(pickDisplay([laptop, projector], { prefer: "primary" }), laptop);
});

test("两块屏都标成内建时也不返回 null，退回不是第一块的那块", () => {
  const a = { id: 1, internal: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const b = { id: 2, internal: true, bounds: { x: 800, y: 0, width: 800, height: 600 } };
  assert.equal(pickDisplay([a, b]), b);
});

test("一块屏都没有时返回 null（调用方要处理，不能当成有屏）", () => {
  assert.equal(pickDisplay([]), null);
  assert.equal(pickDisplay(undefined), null);
});

// ---------------------------------------------------------------- 窗口矩形

test("L0 铺满整块屏的可用区域", () => {
  const display = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  assert.deepEqual(overlayBounds(display, "L0"), { x: 0, y: 0, width: 1920, height: 1040 });
});

test("L1 只占底部 25%，且贴着工作区下沿（不钻到任务栏底下）", () => {
  const display = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  const box = overlayBounds(display, "L1");
  const band = Math.round(1040 * L1_HEIGHT_RATIO);
  assert.deepEqual(box, { x: 0, y: 1040 - band, width: 1920, height: band });
  assert.equal(box.y + box.height, 1040);
});

test("显示器只有 bounds 没有 workArea 时也不炸", () => {
  const display = { bounds: { x: -1280, y: 0, width: 1280, height: 720 } };
  assert.deepEqual(overlayBounds(display, "L0"), { x: -1280, y: 0, width: 1280, height: 720 });
  assert.equal(overlayBounds(display, "L1").height, Math.round(720 * L1_HEIGHT_RATIO));
});

// ---------------------------------------------------------------- 定级

test("透明与置顶都成立 → L0", () => {
  const d = decideLevel({ visible: true, transparent: true });
  assert.equal(d.level, "L0");
  assert.equal(d.unknown, false);
});

test("透明合成失败（背景被画成黑）→ L1", () => {
  const d = decideLevel({ visible: true, transparent: false });
  assert.equal(d.level, "L1");
  assert.match(d.reason, /透明/);
});

test("浮不到 PPT 上面 → L1", () => {
  const d = decideLevel({ visible: false, transparent: true });
  assert.equal(d.level, "L1");
  assert.match(d.reason, /PPT|全屏/);
});

test("探测本身失败时退到 L1，并标记测不出来", () => {
  /*
   * 这条规则改过，理由值得留在测试里：早先的写法是"探测失败就照常上 L0，
   * 因为自动降级只会让观感变差"。但猜错的两种后果完全不对称 ——
   * 猜错成 L0 是一整块黑板盖住老师的课件（这节课上不下去），
   * 猜错成 L1 只是弹幕在底部 25% 里跑（功能一个不少）。
   * 所以"不确定"一律往 L1 倒，想全屏透明可以在托盘里手动切。
   */
  const d = decideLevel({ visible: null, transparent: null, error: "抓不到屏幕画面" });
  assert.equal(d.level, "L1");
  assert.equal(d.unknown, true);
  assert.match(d.reason, /抓不到屏幕画面/);
});

test("桌面本来就是黑的、测不出透明时也退到 L1（不赌）", () => {
  const d = decideLevel({ visible: true, transparent: null });
  assert.equal(d.level, "L1");
  assert.equal(d.unknown, true);
  assert.match(d.reason, /没法确认|黑/);
});

test("浮层是否置顶没测出来时同样退到 L1", () => {
  const d = decideLevel({ visible: null, transparent: true });
  assert.equal(d.level, "L1");
  assert.equal(d.unknown, true);
});

// ---------------------------------------------------------------- 像素比对

test("容差内的颜色算命中，超出算没命中", () => {
  assert.equal(pixelMatches({ r: 250, g: 5, b: 250 }, PROBE_COLOR), true);
  assert.equal(pixelMatches({ r: 255, g: 0, b: 200 }, PROBE_COLOR), false);
  assert.equal(pixelMatches({ r: 255, g: 0, b: 200 }, PROBE_COLOR, 60), true);
});

test("半透明的像素一律不算命中（合成没上去时抓回来的常常是半透明）", () => {
  assert.equal(pixelMatches({ r: 255, g: 0, b: 255, a: 120 }, PROBE_COLOR), false);
  assert.equal(pixelMatches({ r: 255, g: 0, b: 255, a: 255 }, PROBE_COLOR), true);
  assert.equal(pixelMatches(null, PROBE_COLOR), false);
});

test("采样点是按比例取中心，不是取角落", () => {
  const bitmap = Buffer.alloc(100 * 100 * 4);
  // 在 (75, 50) 涂一个洋红像素，其余全黑
  const i = (50 * 100 + 75) * 4;
  bitmap[i] = 255;
  bitmap[i + 1] = 0;
  bitmap[i + 2] = 255;
  bitmap[i + 3] = 255;

  const size = { width: 100, height: 100 };
  const marker = samplePixel(bitmap, size, PROBE_REGIONS.marker.xRatio, PROBE_REGIONS.marker.yRatio);
  assert.deepEqual(marker, { b: 255, g: 0, r: 255, a: 255 });

  const clear = samplePixel(bitmap, size, PROBE_REGIONS.clear.xRatio, PROBE_REGIONS.clear.yRatio);
  assert.deepEqual(clear, { b: 0, g: 0, r: 0, a: 0 });
});

test("采样越界时返回 null 而不是读到别人的内存", () => {
  assert.equal(samplePixel(null, { width: 10, height: 10 }, 0.5, 0.5), null);
  assert.equal(samplePixel(Buffer.alloc(4), { width: 100, height: 100 }, 0.5, 0.5), null);
});

// ---------------------------------------------------------------- 探测结论

test("右半边是洋红、左半边和探测前一模一样 → 透明浮层可用", () => {
  const before = frame(200, 100, DESKTOP);
  const after = frame(200, 100, DESKTOP);
  // 右半边改成洋红
  for (let y = 0; y < 100; y++) {
    for (let x = 100; x < 200; x++) {
      const i = (y * 200 + x) * 4;
      after.bitmap[i] = 255;
      after.bitmap[i + 1] = 0;
      after.bitmap[i + 2] = 255;
    }
  }
  const result = compareProbeSamples(readProbeSample(before), readProbeSample(after));
  assert.equal(result.visible, true);
  assert.equal(result.transparent, true);
});

test("右半边不是洋红 → 说明窗口被 PPT 盖住了", () => {
  const before = frame(200, 100, DESKTOP);
  const after = frame(200, 100, DESKTOP);
  const result = compareProbeSamples(readProbeSample(before), readProbeSample(after));
  assert.equal(result.visible, false);
});

test("左半边被涂黑了 → 透明合成失败", () => {
  const before = frame(200, 100, DESKTOP);
  const after = frame(200, 100, BLACK);
  for (let y = 0; y < 100; y++) {
    for (let x = 100; x < 200; x++) {
      const i = (y * 200 + x) * 4;
      after.bitmap[i] = 255;
      after.bitmap[i + 1] = 0;
      after.bitmap[i + 2] = 255;
    }
  }
  const result = compareProbeSamples(readProbeSample(before), readProbeSample(after));
  assert.equal(result.visible, true);
  assert.equal(result.transparent, false);
});

test("PPT 本来就是纯黑时，透明与否看不出来 —— 如实返回 null", () => {
  // 这个死结是真的："透过去看到黑桌面"和"没透明成功的黑底"在像素上一模一样。
  // 宁可说"测不出来"，也不要赌一个结果把老师坑进黑屏。
  const before = frame(200, 100, BLACK);
  const after = frame(200, 100, BLACK);
  for (let y = 0; y < 100; y++) {
    for (let x = 100; x < 200; x++) {
      const i = (y * 200 + x) * 4;
      after.bitmap[i] = 255;
      after.bitmap[i + 1] = 0;
      after.bitmap[i + 2] = 255;
    }
  }
  const result = compareProbeSamples(readProbeSample(before), readProbeSample(after));
  assert.equal(result.visible, true);
  assert.equal(result.transparent, null);
  assert.equal(result.detail.backgroundIsBlack, true);
  assert.ok(NEAR_BLACK > BLACK.r);
});

test("画面缺失时三个结论都是 null，不让上层误判", () => {
  const result = compareProbeSamples(null, null);
  assert.equal(result.visible, null);
  assert.equal(result.transparent, null);
});

// ------------------------------------------------- 这次"全屏黑板"事故的回归钉子

test("NEAR_BLACK 必须不小于默认容差，否则两个暗色会被同时判成'和黑一样'和'和参考一样'", () => {
  // 这两个数是成对的：容差决定"两个颜色算不算同一个"。只要参考色落在容差
  // 能碰到纯黑的范围内，两条结论就同时成立，于是必然谎报透明成功。
  assert.ok(NEAR_BLACK >= 40, `NEAR_BLACK=${NEAR_BLACK} 小于默认容差 40`);
});

test("回归：桌面的深灰和窗口的黑底只差 19，绝不能被当成'一模一样'", () => {
  /*
   * 这是现场抓到的真实数字：桌面采样点 rgb(30,32,38)，窗口不透明的黑底
   * rgb(11,13,18)，每个通道只差 19。旧的判定是 tolerance=40 配 NEAR_BLACK=18，
   * 于是"差 19 ≤ 40"判成一样、"30 > 18"判成背景不黑 → 报告透明成功 →
   * 老师眼前是一块盖住全屏的黑板（探测还写着"透明浮层可用"）。
   * 现在它必须落在"测不出来"里。
   */
  const before = frame(200, 100, { r: 30, g: 32, b: 38 });
  const after = frame(200, 100, { r: 11, g: 13, b: 18 });
  const result = compareProbeSamples(readProbeSample(before), readProbeSample(after));
  assert.equal(result.transparent, null);
  assert.equal(result.detail.backgroundIsBlack, true);
  // 而且它绝不能变成 L0
  assert.equal(decideLevel({ visible: true, transparent: result.transparent }).level, "L1");
});

test("左半边多点采样会挑最亮的那块当参照，而不是死盯主采样点", () => {
  // 主采样点 (0.25, 0.5) 是黑的，但角落里那块背景是亮的 —— 那才是能说话的参照
  const before = frame(200, 100, BLACK);
  const after = frame(200, 100, BLACK);
  paint(before, 200, 0.1, 0.2, DESKTOP);

  const result = compareProbeSamples(readProbeSample(before), readProbeSample(after));
  // 亮的那块在探测后被黑底糊上了 → 透明失败
  assert.equal(result.transparent, false);
  assert.equal(result.detail.backgroundIsBlack, false);
});

test("同一块亮点探测前后没变 → 透明成功", () => {
  const before = frame(200, 100, BLACK);
  const after = frame(200, 100, BLACK);
  paint(before, 200, 0.1, 0.2, DESKTOP);
  paint(after, 200, 0.1, 0.2, DESKTOP);

  const result = compareProbeSamples(readProbeSample(before), readProbeSample(after));
  assert.equal(result.transparent, true);
});

test("readProbeSample 带回左半边的全部候选点", () => {
  const sample = readProbeSample(frame(200, 100, DESKTOP));
  assert.equal(sample.clears.length, PROBE_CLEAR_POINTS.length);
  assert.ok(PROBE_CLEAR_POINTS.length >= 3, "只取一个点的时候，撞上黑背景就只能干瞪眼");
  for (const pixel of sample.clears) assert.deepEqual(pixel, { b: 235, g: 240, r: 240, a: 255 });
});

test("readProbeSample 对空输入返回 null", () => {
  assert.equal(readProbeSample(null), null);
  assert.equal(readProbeSample(undefined), null);
});
