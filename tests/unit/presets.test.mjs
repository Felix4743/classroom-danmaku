import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PRESETS,
  PRESET_IDS,
  isPresetId,
  presetById,
  presetLabel,
} from "../../src/shared/presets.js";

const SCREEN_HTML = new URL("../../src/web/screen/index.html", import.meta.url);

test("预置弹幕的定义", async (t) => {
  await t.test("三个预置项，顺序固定", () => {
    assert.deepEqual(PRESET_IDS, ["not_understood", "again", "example"]);
    assert.equal(PRESETS.length, 3);
    assert.ok(Object.isFrozen(PRESETS));
    for (const preset of PRESETS) assert.ok(Object.isFrozen(preset), `${preset.id} 应该是冻结的`);
  });

  await t.test("每项都有可用的 id、标签和提示", () => {
    for (const preset of PRESETS) {
      assert.match(preset.id, /^[a-z][a-z_]*$/, `${preset.id} 不像一个 id`);
      assert.ok(preset.label.trim().length > 0, `${preset.id} 缺标签`);
      // 标签会显示在手机上，太长会把按钮撑坏
      assert.ok(preset.label.length <= 6, `${preset.id} 的标签太长：${preset.label}`);
      assert.ok(preset.hint.trim().length > 0, `${preset.id} 缺提示`);
    }
  });

  await t.test("id 不重复", () => {
    assert.equal(new Set(PRESET_IDS).size, PRESET_IDS.length);
  });

  await t.test("标签不重复（重复了学生在手机上分不清）", () => {
    const labels = PRESETS.map((preset) => preset.label);
    assert.equal(new Set(labels).size, labels.length);
  });
});

test("预置弹幕的查询接口", async (t) => {
  await t.test("isPresetId", () => {
    assert.equal(isPresetId("not_understood"), true);
    assert.equal(isPresetId("again"), true);
    for (const value of ["nope", "", null, undefined, 42, {}, "NOT_UNDERSTOOD"]) {
      assert.equal(isPresetId(value), false, `${JSON.stringify(value)} 不该算预置 id`);
    }
  });

  await t.test("presetById 返回定义本体，查不到返回 null", () => {
    assert.equal(presetById("again").label, "再讲一遍");
    assert.equal(presetById("nope"), null);
    assert.equal(presetById(undefined), null);
  });

  await t.test("presetLabel 查不到时返回 null，不编一个假标签出来", () => {
    assert.equal(presetLabel("example"), "举个栗子");
    assert.equal(presetLabel("nope"), null);
    assert.equal(presetLabel(null), null);
  });
});

test("V0 调参页的预设按钮与 presets.js 保持一致", async (t) => {
  const html = readFileSync(SCREEN_HTML, "utf8");

  await t.test("data-preset 的集合与 PRESET_IDS 完全相同", () => {
    const found = [...html.matchAll(/data-preset="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(found.length > 0, "没在调参页里找到 data-preset，正则可能失效了");
    assert.deepEqual([...found].sort(), [...PRESET_IDS].sort());
  });

  await t.test("按钮上的文字与定义里的标签一致", () => {
    for (const preset of PRESETS) {
      const pattern = new RegExp(
        `data-preset="${preset.id}"[^>]*>\\s*${preset.label}\\s*<`,
      );
      assert.match(html, pattern, `调参页上 ${preset.id} 的按钮文字与 presets.js 不一致`);
    }
  });
});
