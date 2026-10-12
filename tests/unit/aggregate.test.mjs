import assert from "node:assert/strict";
import test from "node:test";

import {
  BROADCAST_THROTTLE_MS,
  HOT_LIKE_THRESHOLD,
  WINDOW_MS,
  aggregateKey,
  createAggregator,
} from "../../src/main/server/aggregate.js";

/** 30 秒窗口下，这些时间戳分别落在第几个窗口里，用例里反复用到。 */
const W0 = 1_000;
const W0_LATE = 29_999;
const W1 = 30_000;
const W1_LATE = 59_999;

test("聚合参数与方案一致", () => {
  assert.equal(WINDOW_MS, 30_000);
  assert.equal(BROADCAST_THROTTLE_MS, 200);
  assert.equal(HOT_LIKE_THRESHOLD, 8);
});

test("聚合 key 的形状", () => {
  assert.equal(aggregateKey("not_understood", 0), "not_understood#0");
  assert.equal(aggregateKey("not_understood", W0), "not_understood#0");
  assert.equal(aggregateKey("not_understood", W0_LATE), "not_understood#0");
  assert.equal(aggregateKey("not_understood", W1), "not_understood#1");
  assert.equal(aggregateKey("again", W1), "again#1");
  // 自定义窗口
  assert.equal(aggregateKey("again", 5000, 1000), "again#5");
});

test("同一个窗口里反复点，合成一条计数", async (t) => {
  await t.test("第一次点击用调用方给的 id，并且立刻可用", () => {
    const agg = createAggregator();
    const result = agg.hit({ presetId: "not_understood", id: "abc", ts: W0 });
    assert.equal(result.isFirst, true);
    assert.equal(result.id, "abc");
    assert.equal(result.count, 1);
    assert.equal(result.key, "not_understood#0");
    assert.equal(result.presetId, "not_understood");
    assert.equal(result.window, 0);
    assert.equal(result.firstTs, W0);
    assert.equal(result.lastTs, W0);
  });

  await t.test("后续点击复用同一个 id，只涨计数", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "not_understood", id: "abc", ts: W0 });
    const second = agg.hit({ presetId: "not_understood", id: "zzz", ts: W0 + 10 });
    assert.equal(second.isFirst, false);
    assert.equal(second.id, "abc", "id 必须是第一条的，否则屏幕上会多出一条弹幕");
    assert.equal(second.count, 2);
    assert.equal(second.lastTs, W0 + 10);
    assert.equal(agg.size, 1, "两次点击只能有一个桶");
  });

  await t.test("31 个人都点「没听懂」只产生一条更新 —— 这正是聚合存在的理由", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "not_understood", id: "first", ts: W0 });
    for (let i = 0; i < 30; i += 1) {
      agg.hit({ presetId: "not_understood", id: "first", ts: W0 + i });
    }
    const updates = agg.flush(W0 + BROADCAST_THROTTLE_MS);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], {
      key: "not_understood#0",
      id: "first",
      presetId: "not_understood",
      aggregate: 31,
    });
  });

  await t.test("不同预置项各自成桶，一次 flush 各出一条", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "not_understood", id: "a", ts: W0 });
    agg.hit({ presetId: "again", id: "b", ts: W0 });
    agg.hit({ presetId: "not_understood", id: "a", ts: W0 + 1 });
    agg.hit({ presetId: "again", id: "b", ts: W0 + 1 });

    const updates = agg.flush(W0 + BROADCAST_THROTTLE_MS);
    assert.equal(updates.length, 2);
    const byId = new Map(updates.map((u) => [u.id, u.aggregate]));
    assert.equal(byId.get("a"), 2);
    assert.equal(byId.get("b"), 2);
  });

  await t.test("没有 id 时也能聚合，只是 id 是 null", () => {
    const agg = createAggregator();
    const result = agg.hit({ presetId: "example", ts: W0 });
    assert.equal(result.id, null);
  });

  await t.test("缺 presetId 直接抛错，不退化成按文本聚合", () => {
    const agg = createAggregator();
    assert.throws(() => agg.hit({ id: "a", ts: W0 }), /presetId/);
    assert.throws(() => agg.hit({ presetId: "", id: "a", ts: W0 }), /presetId/);
    assert.throws(() => agg.hit(), /presetId/);
  });
});

test("窗口切换：过期即冻结，新窗口是新的一条", async (t) => {
  await t.test("跨过 30 秒边界就开新桶", () => {
    const agg = createAggregator();
    const before = agg.hit({ presetId: "not_understood", id: "old", ts: W0_LATE });
    assert.equal(before.window, 0);
    const after = agg.hit({ presetId: "not_understood", id: "new", ts: W1 });
    assert.equal(after.window, 1);
    assert.equal(after.isFirst, true);
    assert.equal(after.count, 1);
    assert.equal(after.id, "new");
    assert.equal(agg.size, 2, "旧桶留着，它上面的数字不该被改写");
  });

  await t.test("窗口过期后 flush 会丢弃它，而不是发一个过期的数字", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "not_understood", id: "old", ts: W0 });
    agg.hit({ presetId: "not_understood", id: "old", ts: W0 + 1 });

    // 这时已经进入第 2 个窗口，第 1 个窗口的计数冻结在上次广播的值上
    const updates = agg.flush(W1_LATE);
    assert.deepEqual(updates, []);
    assert.equal(agg.size, 0, "过期桶要被销毁，不能一直攒着");
    assert.equal(agg.stats().expired, 1);
  });

  await t.test("flush 之后新增的计数才算数", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "again", id: "x", ts: W0 });
    agg.hit({ presetId: "again", id: "x", ts: W0 + 1 });
    assert.equal(agg.flush(W0 + BROADCAST_THROTTLE_MS)[0].aggregate, 2);
    // 再点一次
    agg.hit({ presetId: "again", id: "x", ts: W0 + BROADCAST_THROTTLE_MS });
    assert.equal(agg.flush(W0 + BROADCAST_THROTTLE_MS * 2)[0].aggregate, 3);
  });
});

test("广播节流 200ms", async (t) => {
  await t.test("第一次点击不走节流通道", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "not_understood", id: "a", ts: W0 });
    // 第一条的 danmaku:new 由调用方直接发，flush 里没有它的份
    assert.deepEqual(agg.flush(W0), []);
    assert.equal(agg.pending, 0);
  });

  await t.test("200ms 内的第二次 flush 拿不到东西", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "not_understood", id: "a", ts: W0 });
    agg.hit({ presetId: "not_understood", id: "a", ts: W0 + 10 });
    assert.deepEqual(agg.flush(W0 + 10), [], "第一次点击刚广播过，窗口从那一刻起算");
    assert.equal(agg.pending, 1, "拿不到不代表丢了，它还在队列里");

    agg.hit({ presetId: "not_understood", id: "a", ts: W0 + 50 });
    assert.deepEqual(agg.flush(W0 + 100), [], "才过 100ms");
    assert.deepEqual(agg.flush(W0 + 199), [], "才过 199ms");
    assert.equal(agg.pending, 1, "还是那一条，没被冲掉");
    const updates = agg.flush(W0 + BROADCAST_THROTTLE_MS);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].aggregate, 3);
    assert.equal(agg.pending, 0);
  });

  await t.test("节流是窗口级的：31 次点击只产生一次广播", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "not_understood", id: "a", ts: W0 });
    for (let i = 0; i < 30; i += 1) agg.hit({ presetId: "not_understood", id: "a", ts: W0 + i });
    agg.flush(W0 + BROADCAST_THROTTLE_MS);
    assert.equal(agg.stats().broadcasts, 1);
  });
});

test("查询与回收", async (t) => {
  await t.test("peek 只看当前窗口的计数", () => {
    const agg = createAggregator();
    assert.equal(agg.peek("not_understood", W0), 0);
    agg.hit({ presetId: "not_understood", id: "a", ts: W0 });
    agg.hit({ presetId: "not_understood", id: "a", ts: W0 + 1 });
    assert.equal(agg.peek("not_understood", W0 + 2), 2);
    assert.equal(agg.peek("not_understood", W1), 0, "新窗口还没人点");
    assert.equal(agg.peek("again", W0), 0, "这个预置项没人点过");
  });

  await t.test("get 返回桶的副本，改它不影响内部状态", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "again", id: "a", ts: W0 });
    const bucket = agg.get("again#0");
    assert.equal(bucket.count, 1);
    bucket.count = 999;
    assert.equal(agg.get("again#0").count, 1);
    assert.equal(agg.get("不存在的 key"), null);
  });

  await t.test("prune 回收过期桶，返回回收数量", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "not_understood", id: "a", ts: W0 });
    agg.hit({ presetId: "again", id: "b", ts: W0 });
    agg.hit({ presetId: "example", id: "c", ts: W1 });

    assert.equal(agg.prune(W1), 2, "第 0 窗口的两个桶");
    assert.equal(agg.size, 1);
    assert.equal(agg.get("example#1").count, 1);
    assert.equal(agg.prune(W1), 0, "再 prune 一次没东西可回收");
  });

  await t.test("prune 也清掉待广播队列，不会发出过期数字", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "again", id: "a", ts: W0 });
    agg.hit({ presetId: "again", id: "a", ts: W0 + 1 });
    assert.equal(agg.pending, 1);
    agg.prune(W1_LATE);
    assert.equal(agg.pending, 0);
    assert.deepEqual(agg.flush(W1_LATE), []);
  });

  await t.test("reset 用于清屏/换课", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "again", id: "a", ts: W0 });
    agg.hit({ presetId: "again", id: "a", ts: W0 + 1 });
    agg.reset();
    assert.equal(agg.size, 0);
    assert.equal(agg.pending, 0);
    assert.equal(agg.peek("again", W0 + 2), 0);
    // reset 之后第一次 flush 不该被上一节课的节流时间挡住
    agg.hit({ presetId: "again", id: "b", ts: W1 });
    agg.hit({ presetId: "again", id: "b", ts: W1 + 1 });
    assert.equal(agg.flush(W1 + BROADCAST_THROTTLE_MS).length, 1);
  });

  await t.test("stats 反映真实计数", () => {
    const agg = createAggregator();
    agg.hit({ presetId: "again", id: "a", ts: W0 });
    agg.hit({ presetId: "again", id: "a", ts: W0 + 1 });
    agg.hit({ presetId: "example", id: "b", ts: W0 + 2 });
    agg.hit({ presetId: "example", id: "b", ts: W0 + 3 });
    // 两个桶各自"第一次点击"都立刻广播过，节流窗口从最后一次算起
    agg.flush(W0 + BROADCAST_THROTTLE_MS * 2);

    const stats = agg.stats();
    assert.equal(stats.hits, 4);
    assert.equal(stats.created, 2);
    assert.equal(stats.broadcasts, 2, "两个桶各广播一次");
    assert.equal(stats.buckets, 2);
    assert.equal(stats.pending, 0);
  });
});
