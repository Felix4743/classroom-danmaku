/**
 * 手感参数的校验测试。
 *
 * 这一组值有两条外部入口：老师端滑块（将来是 `host:config` 实时下发）和
 * 浏览器 localStorage（V0 调参页刷新后恢复）。两条入口都可能送来脏数据，
 * 而脏数据在 Canvas 里是**静默**的：NaN 坐标不会抛异常，只是什么都画不出来。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_SEND_COOLDOWN_MS,
  CONFIG_LIMITS,
  DANMAKU_COLORS,
  DEFAULT_CONFIG,
  clampConfig,
  sanitizeConfig,
} from "../../src/shared/config.js";
import { RULES } from "../../src/main/server/ratelimit.js";

test("每个手感参数都必须有默认值、取值范围和中文标签", () => {
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    const limit = CONFIG_LIMITS[key];
    assert.ok(limit, `${key} 没有对应的 CONFIG_LIMITS 条目，滑块会生成不出来`);
    assert.ok(limit.min < limit.max, `${key} 的取值范围是空的`);
    assert.ok(limit.step > 0, `${key} 的步长必须是正数，否则 range 控件会退化`);
    assert.ok(limit.label.length > 0, `${key} 缺少中文标签`);
    assert.ok(
      value >= limit.min && value <= limit.max,
      `${key} 的默认值 ${value} 不在 [${limit.min}, ${limit.max}] 内`,
    );
    assert.ok(typeof limit.unit === "string", `${key} 的 unit 必须是字符串（无单位就用空串）`);
  }
});

test("默认配置是冻结的，页面改不动它", () => {
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.throws(() => {
    "use strict";
    DEFAULT_CONFIG.duration = 1;
  }, TypeError);
});

test("clampConfig 只认已知字段，越界夹紧，非数丢弃", () => {
  assert.deepEqual(clampConfig({ duration: 99 }), { duration: CONFIG_LIMITS.duration.max });
  assert.deepEqual(clampConfig({ duration: -5 }), { duration: CONFIG_LIMITS.duration.min });

  // 认不出来的键不能混进 config
  assert.deepEqual(clampConfig({ 我没见过: 1, __proto__: { x: 1 } }), {});
  assert.deepEqual(clampConfig({}), {});
  assert.deepEqual(clampConfig(), {});

  // 非数一律丢掉，绝不写成 NaN
  for (const bad of [NaN, Infinity, -Infinity, "abc", null, undefined, {}, []]) {
    const out = clampConfig({ fontSize: bad });
    assert.ok(
      out.fontSize === undefined || Number.isFinite(out.fontSize),
      `fontSize=${String(bad)} 处理后仍是非法值`,
    );
  }
});

test("clampConfig 接受数字字符串（滑块的 value 本来就是字符串）", () => {
  assert.deepEqual(clampConfig({ duration: "20" }), { duration: 20 });
});

test("sanitizeConfig 永远返回一份完整可用的配置", () => {
  // 正常输入
  assert.deepEqual(sanitizeConfig({ duration: 20 }), { ...DEFAULT_CONFIG, duration: 20 });

  // 各种脏输入都必须退化回默认值，而不是产生 NaN / undefined
  for (const junk of [null, undefined, 0, "", "不是对象", [], true, NaN]) {
    const out = sanitizeConfig(junk);
    assert.deepEqual(out, { ...DEFAULT_CONFIG }, `${String(junk)} 应当整份回落到默认值`);
  }

  // 部分字段坏了，好字段要保住
  const out = sanitizeConfig({ duration: 20, fontSize: "坏掉了", alpha: 5 });
  assert.equal(out.duration, 20, "正常字段不该被连累");
  assert.equal(out.fontSize, DEFAULT_CONFIG.fontSize, "坏字段应当回落默认值");
  assert.equal(out.alpha, CONFIG_LIMITS.alpha.max, "越界字段应当夹紧");

  // 返回的必须是新对象，不能是 DEFAULT_CONFIG 本体
  assert.notEqual(sanitizeConfig(null), DEFAULT_CONFIG);
});

test("sanitizeConfig 的结果喂给引擎不会出现非有限数", () => {
  const out = sanitizeConfig(JSON.parse('{"duration":"12","fontSize":null,"laneGap":999}'));
  for (const [key, value] of Object.entries(out)) {
    assert.ok(Number.isFinite(value), `${key} 变成了 ${value}`);
  }
});

test("弹幕颜色是可直接用的 CSS 颜色字符串，且互不相同", () => {
  assert.ok(DANMAKU_COLORS.length >= 4, "颜色太少会让同屏弹幕看起来像同一个人发的");
  assert.equal(new Set(DANMAKU_COLORS).size, DANMAKU_COLORS.length, "颜色池里有重复");
  for (const color of DANMAKU_COLORS) {
    assert.match(color, /^#[0-9a-f]{6}$/i, `${color} 不是规整的十六进制颜色`);
  }
});

test("学生端发送冷却与服务端的最短间隔是同一个数（§4.5）", () => {
  // 学生页的发送按钮自己禁用 CLIENT_SEND_COOLDOWN_MS，服务端的裁判是
  // RULES.minIntervalMs。两边改岔了的后果很具体：客户端比服务端松，
  // 学生就会频繁看到"发得太快了"；比服务端紧，学生就会觉得"我明明没发几条
  // 却发不出去"。所以这条断言把它钉住 —— 它跨了浏览器代码与服务端代码，
  // 是唯一能拦住这种漂移的地方。
  assert.equal(CLIENT_SEND_COOLDOWN_MS, RULES.minIntervalMs);
});
