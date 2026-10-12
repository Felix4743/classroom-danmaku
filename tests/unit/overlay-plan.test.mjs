import assert from "node:assert/strict";
import test from "node:test";

import {
  L1_HEIGHT_RATIO,
  NEAR_BLACK,
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

test("探测本身失败时不自动降级，只是标记测不出来", () => {
  // 自动降级是给"黑屏"这种一眼可见的灾难用的。探测失败说明我们什么都不知道，
  // 这时候把 L0 换成 L1 只会让观感变差，解决不了任何问题。
  const d = decideLevel({ visible: null, transparent: null, error: "抓不到屏幕画面" });
  assert.equal(d.level, "L0");
  assert.equal(d.unknown, true);
  assert.match(d.reason, /抓不到屏幕画面/);
});

test("桌面本来就是黑的、测不出透明时按 L0 算（不赌）", () => {
  const d = decideLevel({ visible: true, transparent: null });
  assert.equal(d.level, "L0");
  assert.equal(d.unknown, false);
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

test("readProbeSample 对空输入返回 null", () => {
  assert.equal(readProbeSample(null), null);
  assert.equal(readProbeSample(undefined), null);
});
