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
  MAX_PINNED,
  PINNED_BAR_PADDING,
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

// ── 置顶条与删除（§4.8 的老师撤回、§4.2.2 的置顶条） ─────────────────────────

/** 造一条置顶用的弹幕载荷。 */
function pinnedPayload(id, overrides = {}) {
  return {
    id,
    text: `钉住的${id}`,
    nickname: "小明",
    color: "#7fd1ff",
    presetId: "not_understood",
    ts: 1,
    ...overrides,
  };
}

test("置顶条会把滚动区挤下去，取消置顶后轨道数还回来", () => {
  const engine = makeEngine();
  const lanesBefore = engine.laneCount;
  assert.equal(engine.pinnedBarHeight(), 0, "没钉东西时置顶条不占高度");
  assert.equal(engine.summary().pinned, 0);

  assert.equal(engine.pin(pinnedPayload("p1", { aggregate: 3 })), true);
  assert.equal(engine.pinned.length, 1);
  assert.equal(engine.summary().pinned, 1);
  assert.ok(engine.pinnedBarHeight() > 0);
  assert.ok(
    engine.laneCount < lanesBefore,
    "置顶条占掉的高度必须从滚动区里扣，否则第一条弹幕会压在置顶条上",
  );
  // 置顶条的高度是按轨道行高算的，所以它和滚动区之间不会差几像素
  assert.equal(engine.pinnedBarHeight() % engine.laneHeight, PINNED_BAR_PADDING * 2);

  assert.equal(engine.unpin("p1"), true);
  assert.equal(engine.pinned.length, 0);
  assert.equal(engine.pinnedBarHeight(), 0);
  assert.equal(engine.laneCount, lanesBefore, "取消置顶后轨道数必须还原");
  assert.equal(engine.unpin("p1"), false, "取消一条没钉的不该返回 true");
});

test("钉得越多置顶条越高，超过上限挤掉最老的一条", () => {
  const engine = makeEngine();
  engine.pin(pinnedPayload("p1"));
  const one = engine.pinnedBarHeight();
  engine.pin(pinnedPayload("p2"));
  assert.ok(engine.pinnedBarHeight() > one, "两条必须比一条高");
  engine.pin(pinnedPayload("p3"));
  assert.equal(engine.pinned.length, 3);

  engine.pin(pinnedPayload("p4"));
  assert.equal(engine.pinned.length, MAX_PINNED, "置顶上限和老师端的 MAX_PINNED 是同一个数");
  assert.deepEqual(
    engine.pinned.map((item) => item.id),
    ["p2", "p3", "p4"],
    "挤掉的应该是最老的那条",
  );
});

test("同一个 id 置顶两次不会变成两条", () => {
  const engine = makeEngine();
  assert.equal(engine.pin(pinnedPayload("p1")), true);
  assert.equal(engine.pin(pinnedPayload("p1")), true, "重复置顶要当作成功，不能重复插");
  assert.equal(engine.pinned.length, 1);
});

test("没有文字的置顶请求被拒绝", () => {
  const engine = makeEngine();
  assert.equal(engine.pin({ id: "p1" }), false);
  assert.equal(engine.pin({ id: "p1", text: "" }), false);
  assert.equal(engine.pin({ id: "p1", text: null }), false);
  assert.equal(engine.pin({ text: "没有 id" }), false);
  assert.equal(engine.pin(), false);
  assert.equal(engine.pinned.length, 0);
});

test("正在飞的弹幕被置顶后就从滚动流里摘出去了", () => {
  const engine = makeEngine();
  engine.push({ id: "d1", text: "一条普通弹幕", color: "#fff", ts: 1 }, 0);
  assert.equal(engine.active.length, 1);

  engine.pin(pinnedPayload("d1", { text: "一条普通弹幕" }));
  assert.equal(engine.active.length, 0, "同一条不能既在飞又钉在上面，看起来像故障");
  assert.equal(engine.pinned.length, 1);
});

test("删除会连置顶条上的那条一起删掉", () => {
  const engine = makeEngine();
  engine.pin(pinnedPayload("p1"));
  const lanesWithPin = engine.laneCount;

  assert.equal(engine.remove("p1"), true);
  assert.equal(engine.pinned.length, 0);
  assert.equal(engine.laneCount, lanesWithPin + 1, "置顶条空了，轨道数要还原");
  assert.equal(engine.remove("p1"), false, "删一条已经没了的返回 false");
  assert.equal(engine.remove(""), false);
});

test("删掉轨道上最靠右的一条后，下一条不会压上还在飞的那条", () => {
  // 单轨道引擎：高度只够放一行，两条弹幕必然同轨
  const engine = makeEngine({ height: 60 });
  assert.equal(engine.laneCount, 1);

  engine.push({ id: "a", text: "AAAA", color: "#fff", ts: 1 }, 0);
  for (let i = 0; i < 60; i++) engine.update((i + 1) * 50); // 前进 3 秒
  engine.push({ id: "b", text: "BBBB", color: "#fff", ts: 2 }, 3000);

  assert.equal(engine.active.length, 2);
  const lane = engine.lanes[0];
  assert.equal(lane.id, "b", "轨道记录的是最后进来的那条");
  assert.equal(lane.lane, 0);

  // 老师删掉了后进来的 b。如果不重算轨道记录，下一条会以为轨道空着
  assert.equal(engine.remove("b"), true);
  assert.equal(engine.active.length, 1);
  assert.equal(
    engine.lanes[0].id,
    "a",
    "轨道记录必须回退到还在飞的那条，否则下一条会从右边进来压在它身上",
  );
});

test("清屏默认保留置顶，断线重连用的那种才连置顶一起清", () => {
  const engine = makeEngine();
  engine.pin(pinnedPayload("p1"));
  engine.push({ id: "d1", text: "一条普通弹幕", color: "#fff", ts: 1 }, 0);
  assert.equal(engine.active.length, 1);
  assert.equal(engine.pinned.length, 1);

  // 老师按「清屏」：他钉住的那条必须还在 —— 钉住就是因为不能让它滑走
  engine.clear();
  assert.equal(engine.active.length, 0);
  assert.equal(engine.pinned.length, 1, "清屏顺手抹掉置顶等于废掉老师刚才的操作");

  // 重连时的全量重建（§4.3.2）：本地记的置顶未必还作数，全丢掉等服务端重发
  engine.clear({ keepPinned: false });
  assert.equal(engine.pinned.length, 0);
  assert.equal(engine.pinnedBarHeight(), 0);
});

test("计数只有到 2 才写在弹幕后面", () => {
  const engine = makeEngine();
  engine.push({ id: "a", text: "没听懂", presetId: "not_understood", color: "#fff", ts: 1 }, 0);
  assert.equal(engine.labelOf(engine.active[0]), "没听懂", "一个人点写成 ×1 是噪音");

  engine.setAggregate("a", 3);
  assert.equal(engine.labelOf(engine.active[0]), "没听懂 ×3");
});

test("钉在顶上的那条，计数也还得继续涨", () => {
  const engine = makeEngine();
  engine.pin(pinnedPayload("p1", { text: "没听懂", aggregate: 3 }));
  assert.equal(engine.labelOf(engine.pinned[0]), "没听懂 ×3");

  assert.equal(engine.setAggregate("p1", 24), true, "置顶的经常正是「×N 个没听懂」那条");
  assert.equal(engine.labelOf(engine.pinned[0]), "没听懂 ×24");
});

test("置顶请求里带着聚合计数，钉上去不会把数字弄丢", () => {
  const engine = makeEngine();
  // 服务端在 host:pin 的广播里带完整内容（见 session.js 的 pinPayload）
  assert.equal(engine.pin(pinnedPayload("p1", { text: "没听懂", aggregate: 23 })), true);
  assert.equal(engine.labelOf(engine.pinned[0]), "没听懂 ×23");

  // 0 或者没带的时候不能写成 ×0 / ×undefined
  assert.equal(engine.pin(pinnedPayload("p2", { text: "举个栗子", aggregate: 0 })), true);
  assert.equal(engine.labelOf(engine.pinned[1]), "举个栗子");
  assert.equal(engine.pin(pinnedPayload("p3", { text: "再讲一遍" })), true);
  assert.equal(engine.labelOf(engine.pinned[2]), "再讲一遍");
});

