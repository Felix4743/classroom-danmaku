/**
 * 弹幕引擎单元测试（技术方案 §8.2 的「轨道分配」一行）。
 *
 * 这里测的是引擎的**数学性质**，不是像素：无重叠、总时长恒定、对象池复用、
 * 等待队列超时。V0 的验收标准（100 条同屏 ≥55fps）只能靠浏览器跑，
 * 但「100 条同屏不重叠」必须在这里断言 —— 靠肉眼看是看不出来的。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, ENGINE } from "../../src/shared/config.js";
import {
  computeLanes,
  DanmakuEngine,
  FpsMeter,
  fontOf,
  laneFits,
  speedOf,
} from "../../src/overlay/engine.js";

/** 确定性的假宽度测量：宽度只跟字符数有关，测试不依赖真实字体。 */
const fakeMeasure = (text, fontSize) => text.length * fontSize * 0.6;

function makeEngine(overrides = {}) {
  return new DanmakuEngine({
    measureText: fakeMeasure,
    width: 1920,
    height: 1080,
    ...overrides,
  });
}

/** 断言同一轨道上任意两条弹幕的横向区间不相交。 */
function assertNoOverlap(engine, label) {
  const byLane = new Map();
  for (const item of engine.active) {
    if (!byLane.has(item.lane)) byLane.set(item.lane, []);
    byLane.get(item.lane).push(item);
  }
  for (const [lane, items] of byLane) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const disjoint = a.x >= b.x + b.width || b.x >= a.x + a.width;
        assert.ok(
          disjoint,
          `${label}：轨道 ${lane} 上两条弹幕重叠 —— ` +
            `[${a.text}] x=${a.x.toFixed(1)} w=${a.width} 与 ` +
            `[${b.text}] x=${b.x.toFixed(1)} w=${b.width}`,
        );
      }
    }
  }
}

test("恒定停留时长：长文本速度更快，但进出总时长一致", () => {
  const W = 1920;
  const D = 12;
  const shortSpeed = speedOf(100, W, D);
  const longSpeed = speedOf(600, W, D);

  assert.ok(longSpeed > shortSpeed, "长文本必须更快");
  assert.equal((W + 100) / shortSpeed, D);
  assert.ok(Math.abs((W + 600) / longSpeed - D) < 1e-9);
});

test("轨道布局：行高 = 字号 × 轨道间距，轨道数向下取整", () => {
  const layout = computeLanes({ height: 1080, fontSize: 28, laneGap: 1.6 });
  assert.ok(
    Math.abs(layout.laneHeight - 44.8) < 1e-9,
    `行高应为 44.8，实际 ${layout.laneHeight}`,
  );
  // 可用高度 = 1080 - 12*2 = 1056；1056 / 44.8 = 23.57
  assert.equal(layout.laneCount, 23);
  assert.equal(layout.usable, 1056);
});

test("轨道布局：置顶条会吃掉可用高度", () => {
  const withBar = computeLanes({ height: 1080, fontSize: 28, laneGap: 1.6, topInset: 120 });
  const without = computeLanes({ height: 1080, fontSize: 28, laneGap: 1.6 });
  assert.ok(withBar.laneCount < without.laneCount);
});

test("追尾判定必须按「尾部」而不是「头部」—— 否则会重叠", () => {
  // 构造一组数字，让文档 §4.2.2 原文的条件（b 的左边缘追上 t 的左边缘）
  // 判定为「追不上」，但实际上 b 早就把 t 的宽度吃掉了。
  const params = {
    canvasWidth: 1000,
    entryGapPx: 24,
    prev: { x: 876, width: 100, speed: 90 },
    speed: 95,
  };

  const headCatchSec = (params.canvasWidth - params.prev.x) / (params.speed - params.prev.speed);
  const prevExitSec = (params.prev.x + params.prev.width) / params.prev.speed;
  const tailCatchSec =
    (params.canvasWidth - (params.prev.x + params.prev.width)) / (params.speed - params.prev.speed);

  // 原文条件会说「可以同轨」
  assert.ok(prevExitSec < headCatchSec, "构造失败：原文条件本应放行");
  // 但尾部在 4.8 秒就被追上，而 t 要到 10.8 秒才离开 → 会重叠
  assert.ok(tailCatchSec < prevExitSec, "构造失败：尾部本应更早被追上");

  assert.equal(
    laneFits(params),
    false,
    "实现必须拒绝：b 会追上 t 的尾部，两者会重叠",
  );
});

test("laneFits 判为可同轨时，逐帧模拟确实不重叠", () => {
  // 小规模确定性扫参，验证判定与实际几何一致
  const canvasWidth = 1000;
  const entryGapPx = ENGINE.ENTRY_GAP_PX;
  let accepted = 0;
  for (let prevX = 200; prevX <= 950; prevX += 50) {
    for (let prevSpeed = 40; prevSpeed <= 200; prevSpeed += 40) {
      for (let speed = 40; speed <= 200; speed += 20) {
        const prev = { x: prevX, width: 120, speed: prevSpeed };
        if (!laneFits({ canvasWidth, entryGapPx, prev, speed })) continue;
        accepted += 1;

        // 从 b 进入的瞬间开始模拟，直到 t 完全离开屏幕
        const exitSec = (prev.x + prev.width) / prev.speed;
        for (let t = 0; t <= exitSec; t += 0.05) {
          const px = prev.x - prev.speed * t;
          const bx = canvasWidth - speed * t;
          const overlap = bx < px + prev.width && px < bx + prev.width;
          assert.ok(
            !overlap,
            `判定放行但实际重叠：prevX=${prevX} prevSpeed=${prevSpeed} speed=${speed} t=${t.toFixed(2)}`,
          );
        }
      }
    }
  }
  assert.ok(accepted > 20, `扫参样本太少（${accepted}），测试没有实际覆盖`);
});

test("100 条同屏：全程无重叠，且确实把屏幕铺满了", () => {
  const engine = makeEngine();
  engine.setConfig({ maxDensity: 200 });

  let now = 0;
  engine.update(now);
  const texts = [];
  for (let i = 0; i < 100; i++) texts.push("字".repeat(4 + (i % 18)));
  for (const text of texts) engine.push({ text }, now);

  let peak = 0;
  for (let step = 0; step < 1200; step++) {
    now += 16;
    engine.update(now);
    peak = Math.max(peak, engine.active.length);
    assertNoOverlap(engine, `第 ${step} 帧`);
  }

  assert.ok(peak >= 40, `同屏峰值只有 ${peak} 条，没构成压力`);
  const summary = engine.summary();
  assert.equal(summary.admitted + summary.dropped, 100, "每条弹幕要么上屏要么被丢弃");
});

test("等待队列：没有轨道可用时排队，超过 2 秒丢弃并计数", () => {
  const engine = makeEngine();
  engine.setConfig({ maxDensity: 10 });
  let now = 0;
  engine.update(now);

  for (let i = 0; i < 20; i++) engine.push({ text: `第 ${i} 条` }, now);

  assert.equal(engine.active.length, 10, "同屏上限必须生效");
  assert.equal(engine.waiting.length, 10, "多余的应进入等待队列");

  // 上屏的 10 条要 12 秒才离开，所以排队的 10 条必然全部超时
  for (let step = 0; step < 200; step++) {
    now += 16;
    engine.update(now);
  }

  const summary = engine.summary();
  assert.equal(summary.waiting, 0);
  assert.equal(summary.dropped, 10);
  assert.equal(summary.cleared, 0);
});

test("聚合计数：预置项的宽度按两位后缀预留，数字涨了也不动轨道（§4.6）", () => {
  const engine = makeEngine();
  engine.update(0);

  const preset = engine.push(
    { id: "p1", text: "没听懂", presetId: "not_understood", aggregate: 1 },
    0,
  );
  assert.equal(preset.status, "active");
  const item = engine.active[0];
  // 假测量是 text.length * fontSize * 0.6
  assert.equal(
    item.width,
    fakeMeasure("没听懂 ×88", engine.config.fontSize),
    "预置项要按最大的后缀预留宽度",
  );

  engine.push({ id: "f1", text: "自己打的字" }, 0);
  const free = engine.active.find((entry) => entry.id === "f1");
  assert.equal(
    free.width,
    fakeMeasure("自己打的字", engine.config.fontSize),
    "自由打字不会带计数后缀，不该白占地方",
  );
});

test("聚合计数：只改数字，不动位置和速度", () => {
  const engine = makeEngine();
  engine.update(0);
  engine.push({ id: "p1", text: "没听懂", presetId: "not_understood", aggregate: 1 }, 0);

  engine.update(500);
  const item = engine.active[0];
  const before = { x: item.x, speed: item.speed, width: item.width, lane: item.lane };

  assert.equal(engine.setAggregate("p1", 23), true);
  assert.equal(item.aggregate, 23);
  // §4.7 的同一条原则：别人的反应不该让这条弹幕在滚动流里跳一下
  assert.equal(item.x, before.x);
  assert.equal(item.speed, before.speed);
  assert.equal(item.width, before.width);
  assert.equal(item.lane, before.lane);
});

test("聚合计数：排队中的也找得到，滚出屏幕和非法入参返回 false", () => {
  const engine = makeEngine();
  // maxDensity 的下限就是 10（clampConfig 会夹），所以先塞满 10 条
  engine.setConfig({ maxDensity: 10 });
  engine.update(0);
  for (let i = 0; i < 10; i += 1) engine.push({ id: `a${i}`, text: "占着轨道" }, 0);
  assert.equal(engine.active.length, 10);
  assert.equal(engine.push({ id: "b", text: "没听懂", presetId: "not_understood" }, 0).status, "queued");

  assert.equal(engine.setAggregate("b", 7), true, "排队中的弹幕也要能更新计数");
  assert.equal(engine.waiting[0].aggregate, 7);

  assert.equal(engine.setAggregate("does-not-exist", 3), false);
  assert.equal(engine.setAggregate("a0", Number.NaN), false, "NaN 不能写进去，否则画出来是 ×NaN");
  assert.equal(engine.setAggregate(null, 3), false);
});

test("对象池：回收的对象会被复用，不会无限增长", () => {
  const engine = makeEngine();
  engine.update(0);
  engine.push({ text: "会被回收的一条" }, 0);
  const first = engine.active[0];

  let now = 0;
  while (engine.active.length > 0 && now < 20000) {
    now += 16;
    engine.update(now);
  }
  assert.equal(engine.active.length, 0, "12 秒后应当离开屏幕");
  assert.ok(engine.pool.includes(first), "离开屏幕的对象必须回收到池里");

  engine.push({ text: "复用的新一条" }, now);
  assert.equal(engine.active[0], first, "新弹幕应当复用池里的同一个对象");
});

test("文本宽度缓存有上限，不会无界增长", () => {
  const engine = makeEngine();
  engine.setConfig({ maxDensity: 10 });
  engine.update(0);
  for (let i = 0; i < ENGINE.WIDTH_CACHE_MAX + 300; i++) {
    engine.push({ text: `唯一文本-${i}` }, 0);
  }
  assert.ok(
    engine.summary().widthCacheSize <= ENGINE.WIDTH_CACHE_MAX,
    `宽度缓存涨到了 ${engine.summary().widthCacheSize}`,
  );
});

test("改字号 / 轨道间距会清屏重排，改时长只改速度", () => {
  const engine = makeEngine();
  engine.update(0);
  engine.push({ text: "一条用来观察的弹幕" }, 0);

  const beforeSpeed = engine.active[0].speed;
  engine.setConfig({ duration: 6 });
  assert.equal(engine.active.length, 1, "改时长不该清屏");
  assert.ok(Math.abs(engine.active[0].speed - beforeSpeed * 2) < 1e-9, "时长减半，速度翻倍");

  const lanesBefore = engine.laneCount;
  engine.setConfig({ fontSize: 48 });
  assert.equal(engine.active.length, 0, "改字号必须清屏重排");
  assert.ok(engine.laneCount < lanesBefore);
});

test("dt 被夹在 50ms 以内，暂停恢复不会让弹幕瞬移", () => {
  const engine = makeEngine();
  engine.update(0);
  engine.push({ text: "字".repeat(10) }, 0);
  const item = engine.active[0];
  const speed = item.speed;

  engine.update(100_000); // 假装切到后台 100 秒
  assert.equal(engine.active.length, 1, "夹紧后不应该已经飞出屏幕");
  assert.ok(
    item.x >= engine.width - speed * (ENGINE.MAX_FRAME_MS / 1000) - 1e-6,
    `位移超出了单帧上限：x=${item.x}`,
  );

  engine.resetClock();
  engine.update(200_000); // resetClock 之后的第一帧 dt 视为 0
  assert.ok(item.x >= engine.width - speed * (ENGINE.MAX_FRAME_MS / 1000) - 1e-6);
});

test("单条弹幕的存活时间等于配置的滚动时长", () => {
  const engine = makeEngine();
  engine.setConfig({ duration: 12 });
  let now = 0;
  engine.update(now);
  engine.push({ text: "字".repeat(20) }, now);

  let diedAt = null;
  while (now < 30_000) {
    now += 16;
    engine.update(now);
    if (engine.active.length === 0) {
      diedAt = now;
      break;
    }
  }

  assert.ok(diedAt !== null, "弹幕始终没有离开屏幕");
  assert.ok(
    Math.abs(diedAt - 12_000) <= 64,
    `存活 ${diedAt}ms，与配置的 12000ms 相差超过一帧`,
  );
});

test("resize 改变行高时清屏重排，轨道表长度与轨道数保持一致", () => {
  const engine = makeEngine();
  engine.update(0);
  for (let i = 0; i < 10; i++) engine.push({ text: `第 ${i} 条` }, 0);
  const lanesBefore = engine.laneCount;
  assert.ok(engine.active.length > 0);

  engine.resize(800, 600); // 屏高变小 → 行高不再整除 → 轨道数变化
  assert.ok(engine.laneCount < lanesBefore);
  assert.equal(engine.active.length, 0, "行高变化必须清屏重排");
  assert.equal(engine.lanes.length, engine.laneCount, "轨道表长度必须跟轨道数一致");
  for (const item of engine.active) {
    assert.ok(item.lane >= 0 && item.lane < engine.laneCount, `轨道号 ${item.lane} 越界`);
  }

  assert.equal(engine.push({ text: "重排后的第一条" }, 0).status, "active");
  const placed = engine.active[0];
  assert.ok(placed.lane >= 0 && placed.lane < engine.laneCount);
  assert.ok(placed.y + placed.fontSize <= 600, `y=${placed.y} 跑出了画面`);
});

test("resize 不改变行高时不清屏，画布变宽后速度按新宽度重算", () => {
  const engine = makeEngine();
  engine.update(0);
  engine.push({ text: "一条用来观察的弹幕" }, 0);
  const item = engine.active[0];
  const speedBefore = item.speed;

  engine.resize(2560, 1080); // 宽变、高不变 → 行高与轨道数不变
  assert.equal(engine.active.length, 1, "行高没变就不该清屏");
  assert.equal(engine.laneCount, 23);
  assert.ok(item.speed > speedBefore, "画布变宽后同样的时长要求更快的速度");
  assert.ok(Math.abs((2560 + item.width) / item.speed - 12) < 1e-9, "总时长仍恒定为 12 秒");
});

test("setBench 旁路轨道判定，用于测 100 条同屏的渲染帧率", () => {
  const engine = makeEngine();
  engine.setConfig({ maxDensity: 10 });
  engine.update(0);
  assert.equal(engine.setBench(true), true);
  for (let i = 0; i < 100; i++) engine.push({ text: `压测-${i}` }, 0);
  assert.equal(engine.active.length, 100, "性能模式下不受同屏上限约束");

  engine.setBench(false);
  assert.equal(engine.active.length, 0, "退出性能模式必须清屏");
});

test("字体字符串与字号一致", () => {
  assert.match(fontOf(28), /^28px /);
});

test("FpsMeter 统计稳定帧间隔", () => {
  const meter = new FpsMeter(60);
  let now = 0;
  for (let i = 0; i < 60; i++) {
    meter.tick(now);
    now += 1000 / 60;
  }
  const stats = meter.stats();
  assert.ok(Math.abs(stats.fps - 60) < 1.5, `fps=${stats.fps}`);
  assert.ok(Math.abs(stats.p95Ms - 1000 / 60) < 0.5, `p95=${stats.p95Ms}`);
  assert.ok(stats.avgMs > 0);
});

test("默认配置没有被测试或 UI 意外改动", () => {
  assert.deepEqual({ ...DEFAULT_CONFIG }, {
    duration: 12,
    fontSize: 28,
    alpha: 0.9,
    maxDensity: 60,
    laneGap: 1.6,
  });
});
