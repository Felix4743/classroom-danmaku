/**
 * 聚合计数（技术方案 §4.6）。
 *
 * 解决的问题：31 个人都点了"没听懂"，屏幕上该出现一条 `没听懂 ×31`，
 * 而不是 31 条一模一样的弹幕把屏幕刷满。
 *
 * 三个关键设计：
 *
 * 1. **时间窗分桶**：key 是 `${presetId}#${Math.floor(ts / 30000)}`。
 *    同一预置项在同一个 30 秒窗口里的点击合成一条；窗口过期后该条**冻结**，
 *    不再增长，新点击开一个新桶、在屏幕上成为一条新弹幕。
 *    冻结是刻意的：一个永远在涨的数字会让学生觉得"我点不点都一样"。
 *
 * 2. **广播节流 200ms**：没有它，31 个人同时点会产生 31 次广播 ——
 *    聚合省下了屏幕空间，却把压力全推给了网络。注意节流只作用于
 *    `danmaku:update`；第一个点击创建的那条弹幕走 `danmaku:new`，立刻发。
 *
 * 3. **计数挂在第一条弹幕的 id 上**：这样显示时只需更新那一条的
 *    `aggregate` 字段，弹幕在滚动流里的位置完全不受影响（§4.7 的同一条原则）。
 */

export const WINDOW_MS = 30_000;
export const BROADCAST_THROTTLE_MS = 200;

/**
 * 点赞跨过这个数就在弹幕层顶部出现不滚动的热点条（§4.7）。
 * 放这里是因为它和聚合一样属于"计数到多少才升级成另一种可见形态"的策略。
 */
export const HOT_LIKE_THRESHOLD = 8;

export function aggregateKey(presetId, ts, windowMs = WINDOW_MS) {
  return `${presetId}#${Math.floor(ts / windowMs)}`;
}

export function createAggregator(options = {}) {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const throttleMs = options.throttleMs ?? BROADCAST_THROTTLE_MS;
  const now = options.now ?? (() => Date.now());

  /** key -> {key, presetId, window, id, count, firstTs, lastTs} */
  const buckets = new Map();
  /** 自上次广播以来计数变过、还没发出去的桶。 */
  const dirty = new Set();
  let lastFlushTs = Number.NEGATIVE_INFINITY;

  const counts = { created: 0, hits: 0, broadcasts: 0, expired: 0 };

  function windowOf(ts) {
    return Math.floor(ts / windowMs);
  }

  return {
    windowMs,
    throttleMs,

    /**
     * 记一次预置项点击。
     *
     * @param {object} input
     * @param {string} input.presetId
     * @param {string} input.id 本条弹幕的 id。只有窗口内第一次点击会用它，
     *   后续点击复用同一个 id —— 调用方负责为"第一次"生成 id。
     * @returns {{isFirst: boolean, key: string, id: string, presetId: string,
     *            count: number, firstTs: number, lastTs: number, window: number}}
     */
    hit({ presetId, id, ts = now() } = {}) {
      if (typeof presetId !== "string" || presetId.length === 0) {
        throw new TypeError("聚合需要一个 presetId：没有它就只能按文本聚合，而文本两两不同");
      }
      const window = windowOf(ts);
      const key = `${presetId}#${window}`;
      counts.hits += 1;

      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastTs = ts;
        dirty.add(key);
        return { ...existing, isFirst: false };
      }

      const bucket = {
        key,
        presetId,
        window,
        id: id ?? null,
        count: 1,
        firstTs: ts,
        lastTs: ts,
      };
      buckets.set(key, bucket);
      counts.created += 1;
      // 第一条不走节流：它的 danmaku:new 要立刻发出去，
      // 学生点了按钮却要等 200ms 才看到自己的弹幕，这个延迟是能感觉到的。
      //
      // 但节流窗口必须从这一刻起算：新建的桶不进 dirty，第一次 flush 会
      // 因为 dirty 为空直接返回、lastFlushTs 原地不动，于是紧跟着的第二次
      // 点击必然立刻又广播一次 —— 31 个人同时点会变成 31 次广播里的头两次
      // 白送。既然刚刚已经把这个计数发出去了，就当作发过一次。
      lastFlushTs = ts;
      return { ...bucket, isFirst: true };
    },

    /**
     * 取出到期的计数更新。调用方按固定节拍（每轮事件循环）调用。
     * @returns {Array<{key: string, id: string, presetId: string, aggregate: number}>}
     */
    flush(ts = now()) {
      if (dirty.size === 0) return [];
      if (ts - lastFlushTs < throttleMs) return [];

      const currentWindow = windowOf(ts);
      const updates = [];
      for (const key of dirty) {
        const bucket = buckets.get(key);
        dirty.delete(key);
        if (!bucket) continue;
        // 窗口已经过期：这条计数冻结，最后一个数字在过期前就已经发出去了
        if (bucket.window < currentWindow) {
          buckets.delete(key);
          counts.expired += 1;
          continue;
        }
        updates.push({
          key,
          id: bucket.id,
          presetId: bucket.presetId,
          aggregate: bucket.count,
        });
      }

      if (updates.length > 0) {
        lastFlushTs = ts;
        counts.broadcasts += updates.length;
      }
      return updates;
    },

    /** 当前窗口里某个预置项的计数，没有就返回 0。 */
    peek(presetId, ts = now()) {
      return buckets.get(aggregateKey(presetId, ts, windowMs))?.count ?? 0;
    },

    get(key) {
      const bucket = buckets.get(key);
      return bucket ? { ...bucket } : null;
    },

    /** 窗口过期的桶直接销毁。长课上一分钟就是两个新桶，不回收会一直涨。 */
    prune(ts = now()) {
      const currentWindow = windowOf(ts);
      let removed = 0;
      for (const [key, bucket] of buckets) {
        if (bucket.window < currentWindow) {
          buckets.delete(key);
          dirty.delete(key);
          removed += 1;
        }
      }
      counts.expired += removed;
      return removed;
    },

    /** 换新的一节课，或者老师点了"清屏"之后。 */
    reset() {
      buckets.clear();
      dirty.clear();
      lastFlushTs = Number.NEGATIVE_INFINITY;
    },

    get size() {
      return buckets.size;
    },

    get pending() {
      return dirty.size;
    },

    stats() {
      return { ...counts, buckets: buckets.size, pending: dirty.size };
    },
  };
}
