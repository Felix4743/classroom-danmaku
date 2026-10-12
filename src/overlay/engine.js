/**
 * Canvas 弹幕引擎（技术方案 §4.2）。
 *
 * 拆成两半，是为了让核心逻辑能在 node:test 里裸跑：
 *   - `DanmakuEngine` —— 纯逻辑：轨道分配、物理、对象池、宽度缓存。不碰 DOM，
 *     文本宽度由外部注入的 `measureText(text, fontSize)` 提供。
 *   - `CanvasDanmakuView` —— 只负责把 engine 的当前状态画到画布上（含高 DPI）。
 *
 * 于是 V0 的验收（100 条同屏无重叠、总时长恒定）可以用单元测试断言，
 * 而不是靠肉眼看屏幕。
 */

import { clampConfig, DANMAKU_COLORS, DEFAULT_CONFIG, ENGINE } from "../shared/config.js";

const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

/**
 * 给预置项预留的计数后缀宽度（§4.6）。
 *
 * 用 `×88` 而不是 `×1`：两位数是绝大多数课堂会到的量级，按它预留之后，
 * 计数从 1 涨到 99 都不需要重新量宽度、也不需要动已经排好的轨道。
 * 真到了三位数，文字会稍微超出预留宽度几像素 —— 比整条轨道重排轻微得多。
 */
const AGGREGATE_RESERVE = " ×88";

/**
 * 置顶条最多钉几条。和 `session.js` 的 MAX_PINNED 是同一个数字：
 * 服务端不允许多钉，投影这一侧也不该显出第四条。
 *
 * 钉太多等于没钉 —— 屏幕顶上就又成了一条滚动流，而老师置顶恰恰是因为
 * "这条不能滑走"。
 */
export const MAX_PINNED = 3;

/** 置顶条上下各留的空白（CSS px）。 */
export const PINNED_BAR_PADDING = 8;

/** 置顶条底色。它必须把 PPT 压暗，否则白底幻灯片上的白字看不见。 */
export const PINNED_BAR_BG = "rgba(12, 14, 18, 0.78)";

/** 置顶条里文字的左边缘：色块宽度 + 中间的空隙。 */
export const PINNED_TEXT_LEFT = PINNED_BAR_PADDING * 2 + 6;

/**
 * 把文字截到 maxWidth 以内，末尾加省略号。
 *
 * 置顶条只有一行高，超出屏幕的部分会被直接裁掉 —— 老师看到的是"这条问题
 * 说到一半没了"，而不是"太长放不下"。二分而不是逐字减：每次只要 7 次测量，
 * 且测量结果都在宽度缓存里。
 */
function fitText(engine, text, fontSize, maxWidth) {
  if (maxWidth <= 0) return "";
  if (engine.measure(text, fontSize) <= maxWidth) return text;

  const ellipsis = "…";
  const ellipsisWidth = engine.measure(ellipsis, fontSize);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (engine.measure(text.slice(0, mid), fontSize) + ellipsisWidth <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low > 0 ? `${text.slice(0, low)}${ellipsis}` : ellipsis;
}

/** 字号 → CSS font 字符串。每帧不重新拼，缓存在弹幕对象上。 */
export function fontOf(fontSize) {
  return `${fontSize}px ${FONT_STACK}`;
}

/**
 * 行高 = 字号 × 轨道间距（§4.2.2）。
 *
 * 抽成函数是因为置顶条的高度也要用它，而置顶条高度又反过来决定轨道布局 ——
 * 如果两处各写一遍公式，改了其中一处就会得到"置顶条和第一条轨道差几个像素"
 * 这种谁都说不清的错位。
 */
export function laneHeightOf(config) {
  return Math.max(1, config.fontSize * config.laneGap);
}

/**
 * 恒定停留时长策略（§4.2.2）：v = (W + textWidth) / D。
 * 长弹幕速度更快，但「进入 → 离开」的总时长一致，视觉上更整齐，
 * 且天然降低追尾概率。
 */
export function speedOf(textWidth, canvasWidth, durationSec) {
  return (canvasWidth + textWidth) / durationSec;
}

/**
 * 轨道布局（§4.2.2）：
 *   可用高度 H' = 屏幕高 - 置顶条高 - 上下安全边距
 *   行高 h      = 字号 × 轨道间距
 *   轨道数 N    = floor(H' / h)
 */
export function computeLanes({ height, fontSize, laneGap, topInset = 0 }) {
  const usable = Math.max(
    0,
    height - topInset - ENGINE.SAFE_MARGIN_PX * 2,
  );
  const laneHeight = laneHeightOf({ fontSize, laneGap });
  const laneCount = Math.max(1, Math.floor(usable / laneHeight));
  return { usable, laneHeight, laneCount, topInset };
}

/** 同一轨道上，新弹幕 b 能不能跟在已有弹幕 t 后面（§4.2.2）。 */
export function laneFits({ canvasWidth, entryGapPx, prev, speed }) {
  if (!prev) return true;

  // 条件 1（入口让开）：上一条的右边缘必须已经离开入口 GAP 像素
  const gap = canvasWidth - (prev.x + prev.width);
  if (gap < entryGapPx) return false;

  // 条件 2（不会追尾）：
  //   技术方案 §4.2.2 原文写的是「t 离开屏幕所需时间 < b 追上 t 所需时间」，
  //   但「追上 t」如果理解成「b 的左边缘越过 t 的左边缘」，两者在追上之前
  //   早就重叠了（t 的宽度被吃掉了）。实现按「追尾 = b 的左边缘追上 t 的
  //   右边缘」判定：
  //     t 完全离开屏幕所需时间 = (t.x + t.width) / t.speed
  //     b 追到 t 尾部所需时间   = gap / (b.speed - t.speed)
  //   只要前者不大于后者，b 就永远碰不到 t 的尾部。
  if (speed <= prev.speed) return true; // 更快的是前者，永远追不上
  const prevExitSec = (prev.x + prev.width) / prev.speed;
  const catchUpSec = gap / (speed - prev.speed);
  return prevExitSec <= catchUpSec;
}

let autoId = 0;

export class DanmakuEngine {
  /**
   * @param {object} options
   * @param {(text: string, fontSize: number) => number} options.measureText 必须注入
   * @param {number} [options.width]  画布逻辑宽（CSS px）
   * @param {number} [options.height] 画布逻辑高（CSS px）
   * @param {number} [options.topInset] 置顶条 / 热点条占据的顶部高度
   * @param {() => number} [options.pickColor] 颜色选择，测试可注入确定性实现
   */
  constructor(options = {}) {
    const { measureText, width = 1280, height = 720, topInset = 0, pickColor } = options;
    if (typeof measureText !== "function") {
      throw new TypeError("DanmakuEngine 需要注入 measureText(text, fontSize)");
    }

    this.measureText = measureText;
    this.pickColor =
      pickColor ?? ((index) => DANMAKU_COLORS[index % DANMAKU_COLORS.length]);

    this.config = { ...DEFAULT_CONFIG };
    this.width = width;
    this.height = height;
    this.topInset = topInset;

    /** @type {Array<object>} 同屏活跃弹幕，顺序不保证 */
    this.active = [];
    /** 每条轨道上最新（最靠右）的一条弹幕；新弹幕只需跟它比 */
    this.lanes = [];
    /** 等待队列：暂时没有轨道可用的弹幕，下一帧重试 */
    this.waiting = [];
    /**
     * 置顶条（§4.2.1 的 drawPinned）。这些弹幕**不在滚动流里**，
     * 它们钉在屏幕顶部直到老师取消置顶、删除或清屏。
     */
    this.pinned = [];

    this.pool = [];
    this.widthCache = new Map();
    this.colorIndex = 0;
    this.seq = 0;
    this.stats = { admitted: 0, queued: 0, dropped: 0, recycled: 0, cleared: 0 };

    this._lastNowMs = null;
    /** 性能基线旁路：跳过轨道判定与同屏上限，只用于测「100 条同屏」的渲染帧率 */
    this._bench = options.bench === true;
    this._layout = computeLanes({
      height,
      fontSize: this.config.fontSize,
      laneGap: this.config.laneGap,
      topInset: this._inset(),
    });
    this.lanes = new Array(this._layout.laneCount).fill(null);
  }

  get laneCount() {
    return this._layout.laneCount;
  }

  get laneHeight() {
    return this._layout.laneHeight;
  }

  /** 文本宽度测量 + 缓存（§4.2.3）。缓存溢出时整体清空，而不是 LRU —— 便宜且够用。 */
  measure(text, fontSize) {
    const key = `${fontSize}\u0000${text}`;
    let width = this.widthCache.get(key);
    if (width === undefined) {
      width = this.measureText(text, fontSize);
      if (this.widthCache.size >= ENGINE.WIDTH_CACHE_MAX) this.widthCache.clear();
      this.widthCache.set(key, width);
    }
    return width;
  }

  /**
   * 投递一条弹幕。有轨道就立即上屏，没有就排队（超时后丢弃并计数）。
   * @returns {{id: string, status: "active"|"queued"|"dropped"}}
   */
  push(payload, nowMs) {
    const text = String(payload.text ?? "").slice(0, 100);
    const fontSize = this.config.fontSize;
    const item = this.pool.pop() ?? {};
    item.id = payload.id ?? `d${++autoId}`;
    item.seq = ++this.seq;
    item.text = text;
    item.nickname = payload.nickname ?? "";
    item.color = payload.color ?? this.pickColor(this.colorIndex++);
    item.presetId = payload.presetId ?? null;
    item.ts = payload.ts ?? nowMs;
    item.fontSize = fontSize;
    item.font = fontOf(fontSize);
    /*
     * 预置项的宽度按"带上两位数的计数后缀"来量（§4.6：屏幕上要显示
     * `没听懂 ×23`）。计数是会涨的，而**宽度一变，轨道几何就跟着变** ——
     * 已经在后面那条轨道里的弹幕是按老宽度算出来的位置，会突然被压上。
     * 所以宁可一开始就按最大的后缀预留：数字怎么涨，占的地方都不变。
     */
    item.width = this.measure(payload.presetId ? `${text}${AGGREGATE_RESERVE}` : text, fontSize);
    item.speed = speedOf(item.width, this.width, this.config.duration);
    item.lane = -1;
    item.x = this.width;
    item.y = 0;
    item.aggregate = payload.aggregate ?? null;
    item.pinned = false;

    const lane = this._findLane(item);
    if (lane >= 0) {
      this._place(item, lane);
      this.stats.admitted += 1;
      return { id: item.id, status: "active" };
    }

    if (this.waiting.length >= ENGINE.WAIT_QUEUE_MAX) {
      this._recycle(item);
      this.stats.dropped += 1;
      return { id: item.id, status: "dropped" };
    }
    item.enqueuedAt = nowMs;
    this.waiting.push(item);
    this.stats.queued += 1;
    return { id: item.id, status: "queued" };
  }

  /**
   * 改一条弹幕的聚合计数（§4.6：`没听懂 ×23` 里的数字是会长大的）。
   *
   * 只改数字，**不动宽度、速度、轨道和位置** —— 和 §4.7 对点赞的处理同一条
   * 原则：计数是别人的反应，不该让这条弹幕在滚动流里跳一下。
   * 宽度已经在 push 时按两位数后缀预留好了，所以这里改数字是安全的。
   *
   * @returns {boolean} 找到了并改掉返回 true；它已经滚出屏幕则返回 false。
   */
  setAggregate(id, count) {
    if (!id || !Number.isFinite(count)) return false;
    for (const list of [this.active, this.waiting]) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          list[i].aggregate = count;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 让一条弹幕立刻从屏幕上消失（协议 `host:remove`）。
   *
   * 这是老师"把课件抢回来"的手段之一：屏幕上出现了一条不该出现的东西，
   * 它必须**现在**就没了 —— 等它自己滚出去（默认 12 秒）不叫删除。
   *
   * 置顶条里的也一起删：老师点了删除，投影上却还钉着那条，是最糟的表现。
   *
   * @returns {boolean} 删掉了返回 true；它本来就滚出屏幕了则返回 false。
   */
  remove(id) {
    if (!id) return false;

    const pinIndex = this.pinned.findIndex((item) => item.id === id);
    if (pinIndex >= 0) {
      const [item] = this.pinned.splice(pinIndex, 1);
      this._recycle(item);
      this._relayout();
      return true;
    }

    for (const list of [this.active, this.waiting]) {
      const index = list.findIndex((item) => item.id === id);
      if (index < 0) continue;
      const [item] = list.splice(index, 1);
      const lane = item.lane;
      /*
       * 删掉的正好是这条轨道上最靠右的一条时，轨道记录会变空 ——
       * 但这条轨道里很可能还有更靠左的弹幕在飞。不重算的话，下一条弹幕
       * 会以为轨道是空的，直接从右边进来压在前一条身上。
       */
      const wasNewest = lane >= 0 && this.lanes[lane] === item;
      this._recycle(item);
      if (wasNewest) this._recomputeLane(lane);
      return true;
    }
    return false;
  }

  /**
   * 把一条弹幕钉到屏幕顶部（协议 `host:pin`）。
   *
   * 它不再滚动 —— 这正是置顶的意义。如果它还在滚动流里，就把它摘出来：
   * 同一条弹幕既在飞又钉在上面，看起来像出了故障。
   *
   * @returns {boolean} 钉上去了（或本来就在上面）返回 true。
   */
  pin(payload = {}) {
    const id = payload.id;
    if (!id) return false;
    if (this.pinned.some((item) => item.id === id)) return true;

    const text = String(payload.text ?? "").slice(0, 100);
    if (text.length === 0) return false;

    this.remove(id);

    const fontSize = this.config.fontSize;
    const item = this.pool.pop() ?? {};
    item.id = id;
    item.seq = ++this.seq;
    item.text = text;
    item.nickname = payload.nickname ?? "";
    item.color = payload.color ?? DANMAKU_COLORS[0];
    item.presetId = payload.presetId ?? null;
    item.ts = payload.ts ?? 0;
    item.fontSize = fontSize;
    item.font = fontOf(fontSize);
    item.aggregate = payload.aggregate ?? null;
    item.pinned = true;
    item.lane = -1;
    item.x = 0;
    item.speed = 0;
    // 置顶条不滚动，但要按文字宽度决定要不要截断（见 render）
    item.width = this.measure(this.labelOf(item), fontSize);

    this.pinned.push(item);
    while (this.pinned.length > MAX_PINNED) {
      const oldest = this.pinned.shift();
      oldest.pinned = false;
      this._recycle(oldest);
    }
    this._relayout();
    return true;
  }

  /** 取消置顶（协议 `host:pin {pinned:false}`）。它不会回到滚动流里。 */
  unpin(id) {
    const index = this.pinned.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [item] = this.pinned.splice(index, 1);
    item.pinned = false;
    this._recycle(item);
    this._relayout();
    return true;
  }

  /** 屏幕上要显示的完整文字：带上聚合计数（§4.6）。 */
  labelOf(item) {
    // 计数只有到 2 才有信息量：一个人点「没听懂」写成 ×1 是噪音
    return item.aggregate > 1 ? `${item.text} ×${item.aggregate}` : item.text;
  }

  /** 置顶条占的高度。没钉东西时是 0，轨道从屏幕最上面开始排。 */
  pinnedBarHeight() {
    if (this.pinned.length === 0) return 0;
    return this.pinned.length * laneHeightOf(this.config) + PINNED_BAR_PADDING * 2;
  }

  /**
   * 轨道布局要避开的顶部高度 = 外部 inset（热点条）+ 置顶条。
   *
   * 置顶条高矮随"钉了几条"变化，所以它不能像 topInset 那样一次性传进来，
   * 每次重排都得重新算。
   */
  _inset() {
    return this.topInset + this.pinnedBarHeight();
  }

  /** 找出这条轨道上最靠右的一条弹幕。删除中间那条之后用它修正轨道记录。 */
  _recomputeLane(lane) {
    let newest = null;
    for (const item of this.active) {
      if (item.lane !== lane) continue;
      if (newest === null || item.x > newest.x) newest = item;
    }
    this.lanes[lane] = newest;
  }

  /** 推进一帧。dt 由调用方给出（浏览器用 rAF 时间戳），内部夹住上限。 */
  update(nowMs) {
    const last = this._lastNowMs;
    this._lastNowMs = nowMs;
    let dtMs = last === null ? 0 : nowMs - last;
    if (!Number.isFinite(dtMs) || dtMs < 0) dtMs = 0;
    if (dtMs > ENGINE.MAX_FRAME_MS) dtMs = ENGINE.MAX_FRAME_MS;
    const dt = dtMs / 1000;

    if (dt > 0) {
      // 倒序遍历 + splice：移出屏幕的条目是少数，代价可忽略
      for (let i = this.active.length - 1; i >= 0; i--) {
        const item = this.active[i];
        item.x -= item.speed * dt;
        if (item.x + item.width <= 0) {
          this.active.splice(i, 1);
          this._recycle(item);
        }
      }
    }

    this._admitWaiting(nowMs);
  }

  /**
   * 丢弃上一帧的时间基准。暂停后恢复时必须调用，否则弹幕会按暂停时长瞬移
   * （update 里的 dt 夹紧只兜 50ms，兜不住 30 秒的暂停）。
   */
  resetClock() {
    this._lastNowMs = null;
  }

  /**
   * 清屏：只清视图，不删数据（协议 host:clear 的语义）。
   *
   * **置顶条默认不清**：老师钉住一条，是因为这条不能被滑走。按一次清屏就把它
   * 一起抹掉，等于清屏顺手废掉了他刚才的操作，而他不会觉得这是自己的错。
   *
   * `keepPinned: false` 是给断线重连用的（§4.3.2 的全量重建）：连接断过之后，
   * 本地记着的置顶未必还作数（老师可能正是在断线那几秒里取消的），
   * 全部丢掉、等服务端重发才是对的。
   */
  clear({ keepPinned = true } = {}) {
    for (const item of this.active) this._recycle(item);
    for (const item of this.waiting) this._recycle(item);
    this.active.length = 0;
    this.waiting.length = 0;
    this.lanes.fill(null);
    if (!keepPinned) {
      for (const item of this.pinned) this._recycle(item);
      this.pinned.length = 0;
      this._relayout();
    }
    this.stats.cleared += 1;
  }

  /** 实时改手感参数（协议 host:config）。字号 / 轨道间距变了会导致重排。 */
  setConfig(patch = {}) {
    const before = { ...this.config };
    // 统一按 CONFIG_LIMITS 夹紧，避免 UI 之外的调用方（服务端下发 / URL 参数）绕过范围
    Object.assign(this.config, clampConfig(patch));
    const relayout =
      this.config.fontSize !== before.fontSize || this.config.laneGap !== before.laneGap;
    if (relayout) {
      this._relayout();
    } else if (this.config.duration !== before.duration) {
      this._refreshSpeeds();
    }
    return { ...this.config };
  }

  _refreshSpeeds() {
    for (const item of this.active) {
      item.speed = speedOf(item.width, this.width, this.config.duration);
    }
  }

  /** 画面尺寸变化（窗口拉伸 / 换投影分辨率）。 */
  resize(width, height, topInset = this.topInset) {
    const widthChanged = width !== this.width;
    const sizeChanged = widthChanged || height !== this.height || topInset !== this.topInset;
    this.width = width;
    this.height = height;
    this.topInset = topInset;
    if (!sizeChanged) return;
    // 画布宽度变了，恒定停留时长的速度公式也要跟着变，否则总时长漂移
    if (widthChanged) this._refreshSpeeds();
    this._relayout();
  }

  /** 给 UI / 测试看的只读快照。 */
  summary() {
    return {
      active: this.active.length,
      waiting: this.waiting.length,
      pinned: this.pinned.length,
      laneCount: this._layout.laneCount,
      laneHeight: this._layout.laneHeight,
      admitted: this.stats.admitted,
      queued: this.stats.queued,
      dropped: this.stats.dropped,
      cleared: this.stats.cleared,
      poolSize: this.pool.length,
      widthCacheSize: this.widthCache.size,
    };
  }

  /**
   * 开关性能基线旁路。开启后弹幕随机落到轨道与横向位置，忽略入口间隔与
   * 追尾判定（会重叠），但绘制开销与真实情况一致 —— 这是唯一能在没有
   * 100 个学生的情况下量出「100 条同屏」帧率的办法（§8.5）。
   */
  setBench(on) {
    this._bench = on === true;
    if (!this._bench) this.clear();
    return this._bench;
  }

  // ── 内部实现 ─────────────────────────────────────────────────────────────

  _relayout() {
    const next = computeLanes({
      height: this.height,
      fontSize: this.config.fontSize,
      laneGap: this.config.laneGap,
      topInset: this._inset(),
    });
    const changed =
      next.laneCount !== this._layout.laneCount ||
      next.laneHeight !== this._layout.laneHeight ||
      next.topInset !== this._layout.topInset;
    this._layout = next;
    if (changed) {
      // 重排时已上屏的弹幕无法保持轨道与间距，直接清屏重新开始。
      // 调参页上这个行为反而有用：改一次参数，立刻看到干净的效果。
      this.clear();
      this.lanes = new Array(next.laneCount).fill(null);
    }
  }

  _findLane(item) {
    if (this._bench) return Math.floor(Math.random() * this._layout.laneCount);
    if (this.active.length >= this.config.maxDensity) return -1;
    for (let i = 0; i < this._layout.laneCount; i++) {
      if (
        laneFits({
          canvasWidth: this.width,
          entryGapPx: ENGINE.ENTRY_GAP_PX,
          prev: this.lanes[i],
          speed: item.speed,
        })
      ) {
        return i;
      }
    }
    return -1;
  }

  _place(item, lane) {
    item.lane = lane;
    item.x = this._bench ? Math.random() * this.width : this.width;
    item.y = this._layout.topInset + lane * this._layout.laneHeight +
      (this._layout.laneHeight - item.fontSize) / 2;
    this.lanes[lane] = item;
    this.active.push(item);
  }

  _admitWaiting(nowMs) {
    for (let i = 0; i < this.waiting.length; ) {
      const item = this.waiting[i];
      if (nowMs - item.enqueuedAt > ENGINE.WAIT_TIMEOUT_MS) {
        this.waiting.splice(i, 1);
        this._recycle(item);
        this.stats.dropped += 1;
        continue;
      }
      const lane = this._findLane(item);
      if (lane < 0) {
        i += 1;
        continue;
      }
      this.waiting.splice(i, 1);
      this._place(item, lane);
      this.stats.admitted += 1;
    }
  }

  _recycle(item) {
    if (item.lane >= 0 && this.lanes[item.lane] === item) this.lanes[item.lane] = null;
    this.stats.recycled += 1;
    if (this.pool.length < ENGINE.POOL_SIZE) {
      // 清空字段，避免池里的对象持有文本引用（内存泄漏的经典形态）
      item.id = null;
      item.text = null;
      item.nickname = null;
      item.color = null;
      item.font = null;
      item.lane = -1;
      this.pool.push(item);
    }
  }
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/**
 * 把 engine 的状态画到画布上。只做绘制，不改任何状态。
 * 高 DPI 处理见 §4.2.4 —— 不处理会导致投影上文字发虚（教室投影常见 125%/150% 缩放）。
 */
export class CanvasDanmakuView {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.engine = engine;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.dpr = 1;
    this._font = "";
    /** 是否给文字描边。投影上的可读性靠它，性能不够时第一个关掉的就是它。 */
    this.outline = true;
  }

  /** 按 CSS 尺寸 × devicePixelRatio 重设画布，并把画布尺寸同步给 engine。 */
  resize() {
    const dpr = globalThis.devicePixelRatio || 1;
    const width = this.canvas.clientWidth || this.canvas.width || this.engine.width;
    const height = this.canvas.clientHeight || this.canvas.height || this.engine.height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.engine.resize(width, height);
    return { width, height, dpr };
  }

  render() {
    const ctx = this.ctx;
    const engine = this.engine;
    ctx.clearRect(0, 0, engine.width, engine.height);
    ctx.textBaseline = "top";

    const fontSize = engine.config.fontSize;
    const font = fontOf(fontSize);
    if (font !== this._font) {
      ctx.font = font;
      this._font = font;
    }

    // §4.2.1 的绘制顺序：drawPinned 在最前面
    this._drawPinned(ctx);

    ctx.globalAlpha = engine.config.alpha;
    if (this.outline) {
      // 投影上的弹幕是盖在 PPT 上的，PPT 底色不可预测 —— 纯色文字在浅色
      // 幻灯片上会直接消失。描边让它在任何底色上都读得出来（§4.2.5 的
      // 第一把刀就是砍这里，所以它是可关的）。
      ctx.lineWidth = Math.max(2, Math.round(fontSize / 10));
      ctx.strokeStyle = "rgba(0, 0, 0, 0.72)";
      ctx.lineJoin = "round";
    }

    const list = engine.active;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const label = engine.labelOf(item);
      if (this.outline) ctx.strokeText(label, item.x, item.y);
      ctx.fillStyle = item.color;
      ctx.fillText(label, item.x, item.y);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * 置顶条：顶部一条压暗的带子，每行左边一个色块 + 一条不动的弹幕。
   *
   * 它**不跟着 globalAlpha 走**：置顶是老师明确选出来的重点，如果投影上
   * 同屏几十条弹幕时它跟着淡下去，那就白钉了。
   */
  _drawPinned(ctx) {
    const engine = this.engine;
    const list = engine.pinned;
    if (list.length === 0) return null;

    const laneHeight = laneHeightOf(engine.config);
    const fontSize = engine.config.fontSize;
    const barHeight = engine.pinnedBarHeight();

    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = 1;
    ctx.fillStyle = PINNED_BAR_BG;
    ctx.fillRect(0, 0, engine.width, barHeight);

    const maxWidth = Math.max(0, engine.width - PINNED_TEXT_LEFT - PINNED_BAR_PADDING);
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const y = PINNED_BAR_PADDING + i * laneHeight + (laneHeight - fontSize) / 2;
      const markerWidth = Math.max(3, Math.round(fontSize / 8));
      ctx.fillStyle = item.color;
      ctx.fillRect(PINNED_BAR_PADDING, y, markerWidth, fontSize);

      ctx.fillStyle = "#ffffff";
      ctx.fillText(
        fitText(engine, engine.labelOf(item), fontSize, maxWidth),
        PINNED_TEXT_LEFT,
        y,
      );
    }
    ctx.globalAlpha = alpha;
    return barHeight;
  }
}

/** 帧率采样：均值 + p95 帧时间。V0 的验收标准要靠它说话。 */
export class FpsMeter {
  constructor(size = 120) {
    this.samples = new Float64Array(size);
    this.capacity = size;
    this.count = 0;
    this.cursor = 0;
    this.lastMs = null;
  }

  tick(nowMs) {
    if (this.lastMs !== null) {
      const dt = nowMs - this.lastMs;
      if (dt > 0 && dt < 1000) {
        this.samples[this.cursor] = dt;
        this.cursor = (this.cursor + 1) % this.capacity;
        if (this.count < this.capacity) this.count += 1;
      }
    }
    this.lastMs = nowMs;
  }

  reset() {
    this.count = 0;
    this.cursor = 0;
    this.lastMs = null;
  }

  stats() {
    if (this.count === 0) return { fps: 0, avgMs: 0, p95Ms: 0 };
    let sum = 0;
    const values = Array.from(this.samples.subarray(0, this.count));
    for (const value of values) sum += value;
    const avgMs = sum / this.count;
    values.sort((a, b) => a - b);
    const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
    return { fps: avgMs > 0 ? 1000 / avgMs : 0, avgMs, p95Ms: p95 };
  }
}
