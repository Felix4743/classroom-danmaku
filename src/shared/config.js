/**
 * 手感参数与引擎阈值（技术方案 §4.2.2、§4.2.3）。
 *
 * 这一组默认值直接决定产品成败（产品文档 8.1），所以它们集中放在这里、
 * 由老师端滑块实时下发，前端任何地方都不得再硬编码一份。
 */

/** 五个手感滑块 + 它们的默认值。字段名与协议 §4.3.1 的 host:config 一致。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 滚动时长（秒）：单条弹幕从进入到离开的总时长，恒定不随长度变化 */
  duration: 12,
  /** 字号（px）。投影上后排可见性的下限 */
  fontSize: 28,
  /** 不透明度。太高显脏、太低看不清 */
  alpha: 0.9,
  /** 同屏最大条数。性能与可读性的共同上限 */
  maxDensity: 60,
  /** 轨道间距 = 字号 × 该系数（行高） */
  laneGap: 1.6,
});

/** 每个滑块的取值范围，UI 与校验共用。 */
export const CONFIG_LIMITS = Object.freeze({
  duration: Object.freeze({ min: 4, max: 30, step: 1, label: "滚动时长", unit: "秒" }),
  fontSize: Object.freeze({ min: 16, max: 64, step: 2, label: "字号", unit: "px" }),
  alpha: Object.freeze({ min: 0.2, max: 1, step: 0.05, label: "不透明度", unit: "" }),
  maxDensity: Object.freeze({ min: 10, max: 200, step: 5, label: "同屏上限", unit: "条" }),
  laneGap: Object.freeze({ min: 1, max: 2.5, step: 0.1, label: "轨道间距", unit: "×字号" }),
});

/** 引擎阈值。不是手感参数，不给老师看。 */
export const ENGINE = Object.freeze({
  /** 预分配对象池大小（§4.2.3） */
  POOL_SIZE: 200,
  /** 文本宽度测量缓存上限，超出后整体清空（§4.2.3） */
  WIDTH_CACHE_MAX: 2000,
  /** 同一轨道上，新弹幕入口与上一条尾部的最小间隔（px） */
  ENTRY_GAP_PX: 24,
  /** 找不到轨道时的最长排队时间，超时丢弃并计数（§4.2.2） */
  WAIT_TIMEOUT_MS: 2000,
  /** 单帧 dt 上限。切回前台时夹住，防止弹幕瞬移（§4.2.1） */
  MAX_FRAME_MS: 50,
  /** 屏幕上下安全边距（px） */
  SAFE_MARGIN_PX: 12,
  /** 等待队列长度上限，超过直接丢弃，防止内存无界增长 */
  WAIT_QUEUE_MAX: 500,
});

/** 弹幕颜色池。用预解析的字符串，不在每帧拼字符串（§4.2.3）。 */
export const DANMAKU_COLORS = Object.freeze([
  "#ffffff",
  "#ffe066",
  "#8ce99a",
  "#74c0fc",
  "#ffa8a8",
  "#e5c1ff",
]);

export function clampConfig(patch = {}) {
  const next = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (patch[key] === undefined) continue;
    const limit = CONFIG_LIMITS[key];
    const value = Number(patch[key]);
    if (!Number.isFinite(value)) continue;
    next[key] = Math.min(limit.max, Math.max(limit.min, value));
  }
  return next;
}

/**
 * 把外部来源（localStorage、URL 参数、将来服务端下发的 config）整理成一份**完整**
 * 的可用配置：缺的补默认值，越界的夹紧，认不出来的直接丢掉。
 *
 * 为什么不敢省这一步：引擎里只要有一处拿到 `NaN` 或 `undefined`，弹幕的坐标就会
 * 变成 NaN —— 而 Canvas 收到 NaN 坐标时**不报任何错**，只是什么都不画。
 * 那会表现为"页面白屏但控制台干净"，正是最难查的一类故障。
 */
export function sanitizeConfig(value) {
  if (!value || typeof value !== "object") return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...clampConfig(value) };
}
