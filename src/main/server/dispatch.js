/**
 * 双队列优先级（技术方案 §4.3.4）。
 *
 * 老师按一下"暂停"，这个动作必须在几十毫秒内生效，而不是排在 80 条学生弹幕后面。
 * 所以入站消息分两条队列：`hostQueue` 装 host:* 指令，`normalQueue` 装学生消息。
 * 每轮处理时**先把 hostQueue 清空**，再处理 normalQueue，且后者每轮最多 50 条。
 *
 * 为什么 normalQueue 要有每轮上限：如果某一轮把积压的几千条一次处理完，
 * 这一轮就要跑几十毫秒，老师在这期间的指令会被卡在队列里 —— 上限保证了
 * 无论积压多少，每一轮都是短平快的，hostQueue 最坏也只等一轮。
 *
 * 队列有上限。满了两条路都通向"丢消息"，区别只是丢谁：
 *   - hostQueue 满了丢**最新的**：老师的连点在语义上本来就是"以最后一次为准"
 *     （连续按暂停五次，学生只关心最终是暂停还是继续）
 *   - normalQueue 满了丢**最旧的**：学生弹幕的价值随时间迅速衰减，
 *     一条 5 秒前的"没听懂"发出去也没意义了，不如保住刚发的
 * 两种丢法都是刻意的，不是随手写的。
 */

export const BATCH_LIMIT = 50;
export const HOST_QUEUE_LIMIT = 100;
export const NORMAL_QUEUE_LIMIT = 2000;

export const QUEUE = Object.freeze({ HOST: "host", NORMAL: "normal" });

export function createDispatcher(options = {}) {
  const batchLimit = options.batchLimit ?? BATCH_LIMIT;
  const hostLimit = options.hostLimit ?? HOST_QUEUE_LIMIT;
  const normalLimit = options.normalLimit ?? NORMAL_QUEUE_LIMIT;
  const onDrop = options.onDrop ?? null;

  let hostQueue = [];
  let normalQueue = [];

  const counts = { drained: 0, hostDrained: 0, normalDrained: 0, dropped: 0, rounds: 0 };

  function reportDrop(kind, item, reason) {
    counts.dropped += 1;
    if (onDrop) onDrop({ kind, item, reason });
  }

  return {
    batchLimit,

    enqueueHost(item) {
      if (hostQueue.length >= hostLimit) {
        reportDrop(QUEUE.HOST, item, "host_queue_full");
        return false;
      }
      hostQueue.push(item);
      return true;
    },

    enqueueNormal(item) {
      if (normalQueue.length >= normalLimit) {
        const dropped = normalQueue.shift();
        reportDrop(QUEUE.NORMAL, dropped, "normal_queue_full");
      }
      normalQueue.push(item);
      return true;
    },

    enqueue(kind, item) {
      if (kind === QUEUE.HOST) return this.enqueueHost(item);
      if (kind === QUEUE.NORMAL) return this.enqueueNormal(item);
      throw new TypeError(`未知队列 ${String(kind)}`);
    },

    /**
     * 跑一轮。
     * @param {(item: any, kind: string) => void} handler
     * @returns {{host: number, normal: number}} 本轮实际处理的数量
     */
    drain(handler) {
      if (typeof handler !== "function") throw new TypeError("drain 需要一个处理函数");
      counts.rounds += 1;

      // 先整体摘走再处理：handler 在处理过程中继续入队也不会造成死循环，
      // 那些新消息排到下一轮 —— 下一轮通常就在几十毫秒之后
      const hosts = hostQueue;
      hostQueue = [];
      for (const item of hosts) handler(item, QUEUE.HOST);

      const normals = normalQueue.splice(0, batchLimit);
      for (const item of normals) handler(item, QUEUE.NORMAL);

      counts.hostDrained += hosts.length;
      counts.normalDrained += normals.length;
      counts.drained += hosts.length + normals.length;
      return { host: hosts.length, normal: normals.length };
    },

    /** 是否还有活干。事件循环据此决定要不要立刻再跑一轮。 */
    get pending() {
      return hostQueue.length + normalQueue.length;
    },

    sizeOf(kind) {
      if (kind === QUEUE.HOST) return hostQueue.length;
      if (kind === QUEUE.NORMAL) return normalQueue.length;
      throw new TypeError(`未知队列 ${String(kind)}`);
    },

    clear() {
      const dropped = hostQueue.length + normalQueue.length;
      hostQueue = [];
      normalQueue = [];
      return dropped;
    },

    stats() {
      return {
        ...counts,
        hostQueued: hostQueue.length,
        normalQueued: normalQueue.length,
      };
    },
  };
}
