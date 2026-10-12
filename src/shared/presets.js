/**
 * 预置弹幕（技术方案 §4.6）。
 *
 * 聚合计数**强依赖预置按钮**：自由打字的弹幕两两不同，统计不出"23 个人都点了没听懂"。
 * 所以这里是产品的核心机制之一，不是便利功能。
 *
 * 标签是学生页和投影页共用的文案，因此放在 shared —— 两侧各写一份必然会在
 * 某次改文案时只改一边。
 */
export const PRESETS = Object.freeze([
  Object.freeze({ id: "not_understood", label: "没听懂", hint: "老师，这里没跟上" }),
  Object.freeze({ id: "again", label: "再讲一遍", hint: "想再听一次刚才那段" }),
  Object.freeze({ id: "example", label: "举个栗子", hint: "想要一个具体例子" }),
]);

export const PRESET_IDS = Object.freeze(PRESETS.map((preset) => preset.id));

const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

export function isPresetId(value) {
  return typeof value === "string" && BY_ID.has(value);
}

export function presetById(id) {
  return BY_ID.get(id) ?? null;
}

/** 找不到时返回 null，让调用方自己决定兜底文案，不悄悄编一个 id 出来。 */
export function presetLabel(id) {
  return BY_ID.get(id)?.label ?? null;
}
