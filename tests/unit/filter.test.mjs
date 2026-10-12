import assert from "node:assert/strict";
import test from "node:test";

import { ALLOWED_WORDS, BLOCKED_WORDS, HOMOPHONES } from "../../src/main/server/blocklist.js";
import { checkContent, createContentFilter, normalizeText } from "../../src/main/server/filter.js";

test("normalizeText：把无穷变体塌缩成一种形态", async (t) => {
  await t.test("全角转半角", () => {
    assert.equal(normalizeText("ＱＱ"), "qq");
    assert.equal(normalizeText("ＡＢＣ１２３"), "abc123");
  });

  await t.test("去掉空白、标点与符号", () => {
    assert.equal(normalizeText("加·微·信"), "加微信");
    assert.equal(normalizeText("加 微 信"), "加微信");
    assert.equal(normalizeText("加\t微\n信"), "加微信");
    assert.equal(normalizeText("加-微-信"), "加微信");
    assert.equal(normalizeText("加_微_信"), "加微信");
    assert.equal(normalizeText("加\u3000微\u3000信"), "加微信");
    assert.equal(normalizeText("加（微）信！"), "加微信");
  });

  await t.test("去掉零宽字符与控制字符", () => {
    assert.equal(normalizeText("加\u200b微\u200d信\ufeff"), "加微信");
    assert.equal(normalizeText("加\u0000微\u001f信"), "加微信");
  });

  await t.test("大小写不敏感", () => {
    assert.equal(normalizeText("FUCK"), "fuck");
    assert.equal(normalizeText("WwW"), "www");
  });

  await t.test("谐音归一：傻b / 傻B / shabi 收敛到 傻逼", () => {
    assert.equal(normalizeText("傻b"), "傻逼");
    assert.equal(normalizeText("傻B"), "傻逼");
    assert.equal(normalizeText("傻bi"), "傻逼");
    assert.equal(normalizeText("傻逼"), "傻逼");
  });

  await t.test("异体字归一", () => {
    assert.equal(normalizeText("傻屌"), "傻吊");
    assert.equal(normalizeText("妳好"), "你好");
  });

  await t.test("非字符串与空输入返回空串而不是抛错", () => {
    for (const value of [null, undefined, 42, {}, []]) {
      assert.equal(normalizeText(value), "");
    }
    assert.equal(normalizeText(""), "");
    assert.equal(normalizeText("   "), "");
    assert.equal(normalizeText("！！！"), "");
  });

  await t.test("正常文本不改变语义字符", () => {
    assert.equal(normalizeText("老师这一步没听懂"), "老师这一步没听懂");
  });
});

test("屏蔽词：命中拦截", async (t) => {
  const filter = createContentFilter();

  await t.test("直接命中", () => {
    const result = filter.check("加微信");
    assert.equal(result.blocked, true);
    assert.equal(result.kind, "word");
    assert.equal(result.word, "加微信");
  });

  await t.test("夹标点、空格、全角、零宽字符都拦得住", () => {
    for (const text of [
      "加·微·信",
      "加 微 信",
      "加\u200b微信",
      "加-微-信",
      "加　微　信",
      "好烦啊 加 微 信 聊",
    ]) {
      assert.equal(filter.check(text).blocked, true, `${JSON.stringify(text)} 应该被拦`);
    }
  });

  await t.test("谐音与大小写变体", () => {
    for (const text of ["傻b", "傻B", "shabi", "傻 bi", "ＦＵＣＫ", "Fuck you"]) {
      assert.equal(filter.check(text).blocked, true, `${JSON.stringify(text)} 应该被拦`);
    }
  });

  await t.test("色情与广告类", () => {
    for (const text of ["代写作业", "刷单日结", "赌博网站", "约炮"]) {
      assert.equal(filter.check(text).blocked, true, `${JSON.stringify(text)} 应该被拦`);
    }
  });
});

test("屏蔽词：正常课堂发言一个字都不许误伤", async (t) => {
  const filter = createContentFilter();

  const legit = [
    "老师这一步没听懂",
    "这个公式的推导看不懂",
    "能再讲一遍吗",
    "举个栗子",
    "作业什么时候交",
    "第三题的答案是多少",
    "JSON 和 XML 有什么区别",
    "这个算法的时间复杂度是 O(n log n)",
    "我妈妈的手机号是多少来着",
    "你妈妈也是老师吗",
    "他妈妈在哪个学校",
    "废物利用的英文怎么说",
    "去死皮的化学原理",
    "这门课讲进群论吗",
    "把溶液缓慢下注入试管",
    "需要办证明才能申请吗",
    "老师你讲的太好了",
    "这个知识点考不考",
    "PPT 能翻回上一页吗",
    "签到二维码在哪里",
  ];

  for (const text of legit) {
    await t.test(text, () => {
      const result = filter.check(text);
      assert.equal(result.blocked, false, `被误伤：${text}（命中 ${result.word}）`);
    });
  }

  await t.test("但对应的脏话本身仍然拦得住", () => {
    for (const text of ["你妈", "他妈的", "废物", "去死", "进群", "下注", "办证"]) {
      assert.equal(filter.check(text).blocked, true, `${text} 应该被拦`);
    }
  });
});

test("链接不走归一化，走单独的 URL 模式", async (t) => {
  const filter = createContentFilter();

  await t.test("像链接的拦", () => {
    for (const text of [
      "详见 https://example.com/x",
      "看我发的 www.baidu.com",
      "http://t.cn/abc",
      "加群 exam.top 领取",
    ]) {
      const result = filter.check(text);
      assert.equal(result.blocked, true, `${text} 应该被拦`);
      assert.equal(result.kind, "url");
    }
  });

  await t.test("只是提到协议名的不拦", () => {
    // 计算机课上"HTTP 是无状态的"是正经弹幕
    for (const text of ["HTTP 是无状态的", "https 和 http 的区别", "讲讲 TCP/IP 协议栈"]) {
      const result = filter.check(text);
      assert.equal(result.blocked, false, `被误伤：${text}（命中 ${result.word}）`);
    }
  });

  await t.test("URL 模式可以关掉", () => {
    const noUrl = createContentFilter({ urlPatterns: [] });
    assert.equal(noUrl.check("详见 https://example.com/x").blocked, false);
    assert.equal(noUrl.check("加微信").blocked, true);
  });
});

test("过滤器行为", async (t) => {
  await t.test("空文本不拦", () => {
    const filter = createContentFilter();
    const result = filter.check("");
    assert.equal(result.blocked, false);
    assert.equal(result.kind, null);
    assert.equal(result.word, null);
  });

  await t.test("同一个输入重复检查结果一致（没有内部状态泄漏）", () => {
    const filter = createContentFilter();
    const first = filter.check("加微信");
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(filter.check("加微信"), first);
    }
    assert.deepEqual(filter.check("老师这一步没听懂").blocked, false);
  });

  await t.test("词库自己也要过同一套归一化", () => {
    // 词库里写 "加 微 信"（带空格）与写 "加微信" 必须等价，否则会出现
    // "词库里明明有这个词却匹配不上"的幽灵 bug
    const filter = createContentFilter({ words: ["加 微 信"], allowed: [] });
    assert.equal(filter.check("加微信").blocked, true);
    assert.equal(filter.check("加·微·信").blocked, true);
  });

  await t.test("可以换一套词库与谐音表", () => {
    const filter = createContentFilter({ words: ["测试词"], allowed: [], homophones: {} });
    assert.equal(filter.check("测试词").blocked, true);
    assert.equal(filter.check("加微信").blocked, false);
  });

  await t.test("stats 反映真实装载量", () => {
    const filter = createContentFilter();
    const stats = filter.stats();
    assert.equal(stats.words, new Set(BLOCKED_WORDS.map(filter.normalize)).size);
    assert.equal(stats.allowed, ALLOWED_WORDS.length);
    assert.ok(stats.words > 30, "词库不该是空的");
  });

  await t.test("checkContent 是一次性便捷入口", () => {
    assert.equal(checkContent("加微信").blocked, true);
    assert.equal(checkContent("老师这一步没听懂").blocked, false);
  });
});

test("词库自身的数据约束", async (t) => {
  await t.test("没有重复词、没有空词", () => {
    assert.equal(new Set(BLOCKED_WORDS).size, BLOCKED_WORDS.length);
    for (const word of BLOCKED_WORDS) {
      assert.equal(typeof word, "string");
      assert.ok(word.trim().length > 0, "词库里有空词");
      assert.equal(word, word.toLowerCase(), `词库里 ${word} 应该写小写`);
    }
  });

  await t.test("每个免检词都必须抵掉某个真实存在的屏蔽词", () => {
    // 免检词如果不对应任何屏蔽词的子串，它就是没用的噪音 ——
    // 要么是写错了，要么该从词库里删掉
    const { normalize } = createContentFilter();
    const normalizedBlocked = BLOCKED_WORDS.map(normalize);
    for (const allow of ALLOWED_WORDS) {
      const normalizedAllow = normalize(allow);
      const covers = normalizedBlocked.some((word) => normalizedAllow.includes(word));
      assert.ok(covers, `免检词 ${allow} 不抵任何屏蔽词，是多余的`);
    }
  });

  await t.test("免检词之间没有互相包含造成的顺序歧义", () => {
    const { normalize } = createContentFilter();
    const normalized = ALLOWED_WORDS.map(normalize);
    for (const a of normalized) {
      for (const b of normalized) {
        if (a === b) continue;
        assert.ok(!a.includes(b) || a.length > b.length, `${a} 与 ${b} 的摘除顺序会影响结果`);
      }
    }
  });

  await t.test("谐音表的键在归一化后是有意义的", () => {
    for (const key of Object.keys(HOMOPHONES)) {
      assert.equal(key, key.toLowerCase(), `谐音键 ${key} 应该小写`);
      assert.ok(HOMOPHONES[key].length > 0);
    }
    // 不能把常用中文映射掉 —— 比、笔、妈 这类字出现在正常词里
    for (const char of ["比", "笔", "妈", "你", "老", "师"]) {
      assert.equal(HOMOPHONES[char], undefined, `${char} 不该进谐音表`);
    }
  });
});

test("性能：一条消息的过滤开销可以忽略", () => {
  const filter = createContentFilter();
  const samples = [
    "老师这一步没听懂",
    "这个公式的推导看不懂，能再讲一遍吗",
    "加·微·信 了解一下",
    "签到二维码在哪里",
  ];
  const started = performance.now();
  let blocked = 0;
  for (let i = 0; i < 5000; i += 1) {
    if (filter.check(samples[i % samples.length]).blocked) blocked += 1;
  }
  const elapsed = performance.now() - started;
  assert.equal(blocked, 1250);
  // 上限给得很松，只用来抓"某天词库被塞到几万条"这种量级问题
  assert.ok(elapsed < 2000, `5000 次过滤用了 ${elapsed.toFixed(0)}ms，太慢了`);
});
