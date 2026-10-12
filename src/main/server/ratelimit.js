/**
 * 限流：内容安全的第一层，也是唯一"不让人说话"的一层（技术方案 §4.5）。
 *
 * 两层结构，主次分明：
 *   - **设备级**（主）：deviceId 由服务端下发并存在 localStorage，改不了。
 *     这是真正生效的那一层。
 *   - **IP 级**（辅）：防止"清掉 localStorage 换一个设备号"绕过设备级限流。
 *     它只做兜底，阈值必须比设备级松一个数量级 —— 教室网络一旦有 NAT，
 *     全班会共用同一个源 IP，把 IP 阈值收紧等同于把整班限死。
 *     宁可漏掉一个刷屏的，也不能误伤一整间教室。
 *
 * 还有一个容易被忽略的点：**惩罚要能自然消退**。如果违规次数只增不减，
 * 一学期下来所有活跃学生都会攒够 3 次而被静音 —— 限流器慢慢变成了全员禁言。
 * 所以超过 strikeDecayMs 没有新违规就清零（见 strikeDecayMs 的注释）。
 */
import { REJECT } from "../../shared/protocol.js";

export const RULES = Object.freeze({
  /** 两条消息之间的最小间隔。 */
  minIntervalMs: 3000,
  /** 每分钟上限。 */
  perMinute: 10,
  /** 单节课上限。 */
  perSession: 200,
  /** 触发 strikeThreshold 次后静音多久。 */
  strikeMuteMs: 60_000,
  /** 累积多少次违规后被静音。 */
  strikeThreshold: 3,

  /**
   * IP 级每分钟上限。定在设备级的 6 倍：正常教室人人有独立 IP 时它永远碰不到，
   * 只有"同一 IP 冒出一堆设备"这种异常才会触发。
   */
  ipPerMinute: 60,

  /**
   * 违规计数的清零窗口：距上次违规超过这么久，就从 0 重新数。
   *
   * 没有这个窗口的话，一个学生这学期每次手快都记一笔，攒到 3 次就被静音 60 秒，
   * 而他可能根本不记得前两次是什么时候。有了它，"偶尔手快"永远没事，
   * "一分钟内连着刷"才会被静音 —— 这正是我们想区分的两种人。
   */
  strikeDecayMs: 30_000,

  /** 多久没活动的设备/IP 记录可以被回收，避免长课上内存一直涨。 */
  idleMs: 10 * 60_000,
});

function seconds(ms) {
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] 注入时钟，测试用
 */
export function createRateLimiter(options = {}) {
  const rules = { ...RULES, ...(options.rules ?? {}) };
  const now = options.now ?? (() => Date.now());

  /** deviceId -> { lastTs, stamps: number[], total, strikes, lastStrikeTs, mutedUntil, banned, seenTs } */
  const devices = new Map();
  /** ip -> { stamps: number[], seenTs } */
  const ips = new Map();

  const counts = { allowed: 0, blocked: 0, mutes: 0 };

  function deviceRecord(deviceId) {
    let record = devices.get(deviceId);
    if (!record) {
      record = {
        lastTs: Number.NEGATIVE_INFINITY,
        stamps: [],
        total: 0,
        strikes: 0,
        lastStrikeTs: Number.NEGATIVE_INFINITY,
        mutedUntil: 0,
        banned: false,
        seenTs: 0,
      };
      devices.set(deviceId, record);
    }
    return record;
  }

  function ipRecord(ip) {
    let record = ips.get(ip);
    if (!record) {
      record = { stamps: [], seenTs: 0 };
      ips.set(ip, record);
    }
    return record;
  }

  function dropExpired(stamps, ts, windowMs) {
    const cutoff = ts - windowMs;
    let index = 0;
    while (index < stamps.length && stamps[index] <= cutoff) index += 1;
    if (index > 0) stamps.splice(0, index);
  }

  /** 记一次违规，返回是否因此被静音。 */
  function strike(record, ts) {
    if (ts - record.lastStrikeTs > rules.strikeDecayMs) record.strikes = 0;
    record.strikes += 1;
    record.lastStrikeTs = ts;
    if (record.strikes >= rules.strikeThreshold) {
      record.strikes = 0;
      record.mutedUntil = ts + rules.strikeMuteMs;
      counts.mutes += 1;
      return true;
    }
    return false;
  }

  function reject(reason, retryAfterMs, message) {
    counts.blocked += 1;
    return { allowed: false, reason, retryAfterMs, message };
  }

  return {
    rules,

    /**
     * 检查并记录一次发言。
     * @returns {{allowed: true, total: number, strikes: number, muted: boolean}
     *          | {allowed: false, reason: string, retryAfterMs: number, message: string}}
     */
    check({ deviceId, ip, ts = now() } = {}) {
      if (typeof deviceId !== "string" || deviceId.length === 0) {
        throw new TypeError("限流需要 deviceId：没有它就只能按 IP 限，而教室网络里 IP 不可靠");
      }
      const record = deviceRecord(deviceId);
      record.seenTs = ts;

      if (record.banned) {
        return reject(REJECT.BANNED, 0, "你已被移出本课弹幕");
      }

      if (record.mutedUntil > ts) {
        strike(record, ts);
        return reject(
          REJECT.MUTED,
          record.mutedUntil - ts,
          `你被静音了，还有 ${seconds(record.mutedUntil - ts)} 秒`,
        );
      }

      const sinceLast = ts - record.lastTs;
      if (sinceLast < rules.minIntervalMs) {
        const retryAfterMs = rules.minIntervalMs - sinceLast;
        const muted = strike(record, ts);
        return reject(
          muted ? REJECT.MUTED : REJECT.RATE_LIMITED,
          muted ? rules.strikeMuteMs : retryAfterMs,
          muted
            ? `发得太快了，静音 ${seconds(rules.strikeMuteMs)} 秒`
            : `发太快了，${seconds(retryAfterMs)} 秒后再试`,
        );
      }

      dropExpired(record.stamps, ts, 60_000);
      if (record.stamps.length >= rules.perMinute) {
        const retryAfterMs = record.stamps[0] + 60_000 - ts;
        const muted = strike(record, ts);
        return reject(
          muted ? REJECT.MUTED : REJECT.RATE_LIMITED,
          muted ? rules.strikeMuteMs : retryAfterMs,
          muted
            ? `发得太密了，静音 ${seconds(rules.strikeMuteMs)} 秒`
            : `一分钟最多 ${rules.perMinute} 条，${seconds(retryAfterMs)} 秒后再试`,
        );
      }

      if (record.total >= rules.perSession) {
        // 单节课上限是终局状态，没有"等一会儿就好"，所以不给 retryAfterMs
        return reject(REJECT.RATE_LIMITED, 0, `这节课的发言已达 ${rules.perSession} 条上限`);
      }

      if (typeof ip === "string" && ip.length > 0) {
        const ipEntry = ipRecord(ip);
        ipEntry.seenTs = ts;
        dropExpired(ipEntry.stamps, ts, 60_000);
        if (ipEntry.stamps.length >= rules.ipPerMinute) {
          const retryAfterMs = ipEntry.stamps[0] + 60_000 - ts;
          return reject(REJECT.RATE_LIMITED, retryAfterMs, "网络有点忙，稍后再试");
        }
        ipEntry.stamps.push(ts);
      }

      record.lastTs = ts;
      record.stamps.push(ts);
      record.total += 1;
      // 成功发言不清零 strike —— 清零只由 strikeDecayMs 的时间窗口负责，
      // 否则"违规、成功后马上再违规"永远攒不够次数
      counts.allowed += 1;
      return { allowed: true, total: record.total, strikes: record.strikes, muted: false };
    },

    /** 老师拉黑/解禁。返回是否真的改动了状态。 */
    setBanned(deviceId, banned = true) {
      const record = deviceRecord(deviceId);
      const changed = record.banned !== banned;
      record.banned = banned;
      if (banned) record.mutedUntil = 0;
      return changed;
    },

    isBanned(deviceId) {
      return devices.get(deviceId)?.banned ?? false;
    },

    isMuted(deviceId, ts = now()) {
      return (devices.get(deviceId)?.mutedUntil ?? 0) > ts;
    },

    /** 老师的"清屏/暂停"之外，老师自己也该能解除静音（学生被误伤时）。 */
    unmute(deviceId) {
      const record = devices.get(deviceId);
      if (!record) return false;
      const was = record.mutedUntil > 0;
      record.mutedUntil = 0;
      record.strikes = 0;
      return was;
    },

    /** 回收长时间没动静的记录。 */
    prune(ts = now()) {
      let removed = 0;
      for (const [deviceId, record] of devices) {
        if (record.banned) continue; // 拉黑是终局状态，不能因为"安静了十分钟"就忘了
        if (ts - record.seenTs > rules.idleMs) {
          devices.delete(deviceId);
          removed += 1;
        }
      }
      for (const [ip, record] of ips) {
        if (ts - record.seenTs > rules.idleMs) {
          ips.delete(ip);
          removed += 1;
        }
      }
      return removed;
    },

    stats() {
      let muted = 0;
      let banned = 0;
      for (const record of devices.values()) {
        if (record.mutedUntil > now()) muted += 1;
        if (record.banned) banned += 1;
      }
      return { ...counts, devices: devices.size, ips: ips.size, muted, banned };
    },

    /** 测试与 /diag 用：看某个设备当前的违规计数。 */
    strikesOf(deviceId) {
      return devices.get(deviceId)?.strikes ?? 0;
    },

    /** 测试用：直接看某个设备的累计发言数。 */
    totalOf(deviceId) {
      return devices.get(deviceId)?.total ?? 0;
    },
  };
}
