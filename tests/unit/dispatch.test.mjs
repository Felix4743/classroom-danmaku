import assert from "node:assert/strict";
import test from "node:test";

import {
  BATCH_LIMIT,
  HOST_QUEUE_LIMIT,
  NORMAL_QUEUE_LIMIT,
  QUEUE,
  createDispatcher,
} from "../../src/main/server/dispatch.js";

/** 收集一轮里处理到的消息，形如 "host:H1" —— 顺序本身就是被测对象。 */
function collector() {
  const seen = [];
  return { seen, handler: (item, kind) => seen.push(`${kind}:${item}`) };
}

test("双队列参数与方案一致", () => {
  assert.equal(BATCH_LIMIT, 50, "§4.3.4 规定每轮上限 50 条");
  assert.equal(HOST_QUEUE_LIMIT, 100);
  assert.equal(NORMAL_QUEUE_LIMIT, 2000);
  assert.deepEqual(QUEUE, { HOST: "host", NORMAL: "normal" });
  assert.ok(Object.isFrozen(QUEUE));
});

test("老师的指令永远排在学生前面", async (t) => {
  await t.test("先清空 hostQueue，再处理 normalQueue", () => {
    const d = createDispatcher();
    d.enqueueNormal("学生1");
    d.enqueueHost("暂停");
    d.enqueueNormal("学生2");
    d.enqueueHost("清屏");
    d.enqueueNormal("学生3");

    const { seen, handler } = collector();
    const result = d.drain(handler);
    assert.deepEqual(seen, [
      "host:暂停",
      "host:清屏",
      "normal:学生1",
      "normal:学生2",
      "normal:学生3",
    ]);
    assert.deepEqual(result, { host: 2, normal: 3 });
  });

  await t.test("hostQueue 有多大都不截断，normaQueue 才受每轮上限约束", () => {
    const d = createDispatcher();
    for (let i = 0; i < HOST_QUEUE_LIMIT; i += 1) d.enqueueHost(i);
    for (let i = 0; i < 200; i += 1) d.enqueueNormal(i);

    const result = d.drain(() => {});
    assert.equal(result.host, HOST_QUEUE_LIMIT, "老师的 100 条全部处理完");
    assert.equal(result.normal, BATCH_LIMIT, "学生的先处理 50 条");
    assert.equal(d.pending, 150);
  });

  await t.test("老师连点不会把队列撑爆内存：满 100 条之后丢最新", () => {
    const d = createDispatcher();
    for (let i = 0; i < HOST_QUEUE_LIMIT; i += 1) {
      assert.equal(d.enqueueHost(`cmd-${i}`), true);
    }
    assert.equal(d.enqueueHost("溢出"), false, "满了要明确告诉调用方没进去");

    const { seen, handler } = collector();
    d.drain(handler);
    assert.equal(seen.length, HOST_QUEUE_LIMIT);
    assert.ok(seen.includes("host:cmd-0"), "最旧的必须还在");
    assert.ok(!seen.includes("host:溢出"), "丢的是最新的");
  });
});

test("学生队列的每轮上限", async (t) => {
  await t.test("积压 120 条要分三轮处理完", () => {
    const d = createDispatcher();
    for (let i = 0; i < 120; i += 1) d.enqueueNormal(i);

    assert.deepEqual(d.drain(() => {}), { host: 0, normal: 50 });
    assert.equal(d.pending, 70);
    assert.deepEqual(d.drain(() => {}), { host: 0, normal: 50 });
    assert.equal(d.pending, 20);
    assert.deepEqual(d.drain(() => {}), { host: 0, normal: 20 });
    assert.equal(d.pending, 0);
    assert.deepEqual(d.drain(() => {}), { host: 0, normal: 0 });
  });

  await t.test("每轮上限保证老师最多等一轮", () => {
    // 积压再多，一轮也只跑 50 条，所以老师指令的等待时间不随积压增长
    const d = createDispatcher();
    for (let i = 0; i < NORMAL_QUEUE_LIMIT; i += 1) d.enqueueNormal(i);
    assert.equal(d.drain(() => {}).normal, BATCH_LIMIT);
  });

  await t.test("上限可配置，方便测溢出策略", () => {
    const d = createDispatcher({ normalLimit: 3, batchLimit: 10 });
    assert.equal(d.batchLimit, 10);
    for (const item of ["a", "b", "c"]) assert.equal(d.enqueueNormal(item), true);
    assert.equal(d.enqueueNormal("d"), true, "学生队列永远是「进得去」的");

    const { seen, handler } = collector();
    d.drain(handler);
    assert.deepEqual(seen, ["normal:b", "normal:c", "normal:d"], "丢最旧的");
  });
});

test("溢出时丢谁是想清楚的", async (t) => {
  await t.test("hostQueue 满丢最新的（连点以最后一次为准）", () => {
    const drops = [];
    const d = createDispatcher({ hostLimit: 3, onDrop: (info) => drops.push(info) });
    for (const item of ["p1", "p2", "p3"]) d.enqueueHost(item);
    d.enqueueHost("p4");

    assert.equal(drops.length, 1);
    assert.equal(drops[0].kind, QUEUE.HOST);
    assert.equal(drops[0].item, "p4");
    assert.equal(drops[0].reason, "host_queue_full");

    const { seen, handler } = collector();
    d.drain(handler);
    assert.deepEqual(seen, ["host:p1", "host:p2", "host:p3"]);
  });

  await t.test("normalQueue 满丢最旧的（5 秒前的没听懂发出去没意义）", () => {
    const drops = [];
    const d = createDispatcher({ normalLimit: 3, onDrop: (info) => drops.push(info) });
    for (const item of ["old", "b", "c"]) d.enqueueNormal(item);
    d.enqueueNormal("new");

    assert.equal(drops.length, 1);
    assert.equal(drops[0].kind, QUEUE.NORMAL);
    assert.equal(drops[0].item, "old");
    assert.equal(drops[0].reason, "normal_queue_full");
  });

  await t.test("没有 onDrop 也不报错，只是计数", () => {
    const d = createDispatcher({ hostLimit: 1 });
    d.enqueueHost("a");
    assert.equal(d.enqueueHost("b"), false);
    assert.equal(d.stats().dropped, 1);
  });
});

test("drain 的边界", async (t) => {
  await t.test("处理中继续入队不会造成死循环", () => {
    const d = createDispatcher();
    d.enqueueNormal("第一条");
    const seen = [];
    let injected = false;
    d.drain((item) => {
      seen.push(item);
      if (!injected) {
        injected = true;
        d.enqueueNormal("处理中冒出来的");
      }
    });

    assert.deepEqual(seen, ["第一条"], "这一轮只处理摘走的那批");
    assert.equal(d.pending, 1, "新消息排队等下一轮");

    d.drain((item) => seen.push(item));
    assert.deepEqual(seen, ["第一条", "处理中冒出来的"]);
  });

  await t.test("handler 抛错会冒出去，队列状态不被破坏", () => {
    const d = createDispatcher();
    d.enqueueNormal("a");
    assert.throws(() => d.drain(() => {
      throw new Error("boom");
    }), /boom/);
    // 已经摘走的那条不会再回来 —— 这是有意的：重试一条渲染失败的弹幕没有意义
    assert.equal(d.pending, 0);
  });

  await t.test("empty 状态的一轮是空转", () => {
    const d = createDispatcher();
    assert.deepEqual(d.drain(() => {}), { host: 0, normal: 0 });
    assert.equal(d.pending, 0);
    assert.equal(d.stats().rounds, 1);
  });

  await t.test("drain 必须拿到函数", () => {
    const d = createDispatcher();
    assert.throws(() => d.drain(), /处理函数/);
    assert.throws(() => d.drain("不是函数"), /处理函数/);
  });
});

test("enqueue / sizeOf / clear / stats", async (t) => {
  await t.test("enqueue 按队列名分派", () => {
    const d = createDispatcher();
    assert.equal(d.enqueue(QUEUE.HOST, "h"), true);
    assert.equal(d.enqueue(QUEUE.NORMAL, "n"), true);
    assert.equal(d.sizeOf(QUEUE.HOST), 1);
    assert.equal(d.sizeOf(QUEUE.NORMAL), 1);
    assert.equal(d.pending, 2);
  });

  await t.test("未知队列名直接抛错，不静默丢消息", () => {
    const d = createDispatcher();
    assert.throws(() => d.enqueue("随便写的", "x"), /未知队列/);
    assert.throws(() => d.sizeOf("随便写的"), /未知队列/);
  });

  await t.test("clear 返回被清掉的数量", () => {
    const d = createDispatcher();
    d.enqueueHost("a");
    d.enqueueNormal("b");
    d.enqueueNormal("c");
    assert.equal(d.clear(), 3);
    assert.equal(d.pending, 0);
    assert.equal(d.sizeOf(QUEUE.HOST), 0);
  });

  await t.test("stats 累计每一轮", () => {
    const d = createDispatcher({ batchLimit: 2 });
    d.enqueueHost("h1");
    d.enqueueHost("h2");
    for (const item of ["n1", "n2", "n3"]) d.enqueueNormal(item);

    d.drain(() => {});
    d.drain(() => {});

    const stats = d.stats();
    assert.equal(stats.rounds, 2);
    assert.equal(stats.hostDrained, 2);
    assert.equal(stats.normalDrained, 3);
    assert.equal(stats.drained, 5);
    assert.equal(stats.hostQueued, 0);
    assert.equal(stats.normalQueued, 0);
  });
});
