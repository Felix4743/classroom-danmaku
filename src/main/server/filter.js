/**
 * 内容安全第二层：屏蔽词（技术方案 §4.8）。
 *
 * 核心决定：**做归一化，而不是穷举变体**。
 *
 * 穷举变体的路走不通 —— "加微信"能写成 加·微·信 / 加 微 信 / 加薇信 / ｊｉａｗｅｉｘｉｎ，
 * 变体空间是无穷的，词库会被拖成一个永远追不上的清单。归一化把无穷变体
 * 塌缩成一种形态，再拿正常词库去比。
 *
 * 归一化顺序是有讲究的：
 *   1. 先去掉零宽字符与控制字符 —— 它们能在字符之间"塞东西"而不显示
 *   2. 全角转半角 —— 否则 "ｑｑ" 永远匹配不上 "qq"
 *   3. 转小写 —— 让大小写变化失效
 *   4. 谐音替换 —— 字母/异体字映射成常用字（傻b → 傻逼）
 *   5. 去掉所有空白与标点 —— 让 "加·微·信" 塌缩成 "加微信"
 *
 * 链接不走归一化，走单独的 URL 模式，理由见 blocklist.js 里的说明：
 * 计算机课上"HTTP 是无状态的"是正经弹幕，不能因为含有 http 就拦。
 *
 * 命中后拦截的是**原文**：被拦下来的消息老师看不到，但落盘的是学生真正写的东西，
 * 事后追溯时"他到底写了什么"比"他触发了哪条规则"更重要。
 */
import { ALLOWED_WORDS, BLOCKED_WORDS, HOMOPHONES } from "./blocklist.js";

const FULLWIDTH = /[\uFF01-\uFF5E]/g;
const IDEOGRAPHIC_SPACE = /\u3000/g;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
const CONTROL = /[\u0000-\u001F\u007F]/g;
const SPACE_OR_PUNCT = /[\s\p{P}\p{S}]/gu;

/**
 * 链接模式，匹配**原文**。
 * 要求真的像链接（有协议头、有 www.、或有一个像域名的东西），
 * 不做"含 http 就算链接"这种粗判。
 */
export const URL_PATTERNS = Object.freeze([
  /(?:https?:\/\/|www\.)\S/i,
  /(?:^|[^\w.-])[\w-]{1,63}\.(?:com|cn|net|org|top|xyz|vip|shop|club|site)(?![\w-])/i,
]);

/** 免检词被替换成的占位符。选 \u0001 是因为它已被上面清掉，不可能来自输入。 */
export const PLACEHOLDER = "\u0001";

function escapeForClass(char) {
  return char.replace(/[\\\]^-]/g, "\\$&");
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const replacerCache = new Map();

/**
 * 把谐音映射表编译成一个替换函数。
 *
 * 多字符的键必须先于单字符的键尝试（shabi 要先于 sha，sb 要先于 b），
 * 所以用一个按长度倒序排列的分支正则一次扫完，而不是多次 split/join ——
 * 后者的替换顺序在同一长度的键之间是不确定的。
 *
 * 两侧加 `(?<![a-z])` / `(?![a-z])`，是为了不切开更长的英文单词：
 * 没有它，"bilibili" 会被切成"逼libili"。归一化结果只用于匹配、从不显示，
 * 所以切碎本身无害（真正的风险是切出一个本该没有的屏蔽词），
 * 但让 bilibili 保持完整能省掉一整类"为什么这个词也被拦了"的困惑。
 */
function buildHomophoneReplacer(homophones) {
  const keys = Object.keys(homophones).filter((key) => key.length > 0);
  const multi = keys.filter((key) => key.length > 1).sort((a, b) => b.length - a.length);
  const single = keys.filter((key) => key.length === 1);

  const multiRe = multi.length
    ? new RegExp(`(?<![a-z])(?:${multi.map(escapeRegex).join("|")})(?![a-z])`, "g")
    : null;
  const singleRe = single.length
    ? new RegExp(`(?<![a-z])[${single.map(escapeForClass).join("")}](?![a-z])`, "g")
    : null;

  return (text) => {
    let out = text;
    if (multiRe) out = out.replace(multiRe, (match) => homophones[match]);
    if (singleRe) out = out.replace(singleRe, (char) => homophones[char]);
    return out;
  };
}

function replacerFor(homophones) {
  let replacer = replacerCache.get(homophones);
  if (!replacer) {
    replacer = buildHomophoneReplacer(homophones);
    replacerCache.set(homophones, replacer);
  }
  return replacer;
}

/**
 * 归一化。词库和输入必须走同一个函数 —— 两边规则稍有不同，就会出现
 * "词库里明明有这个词却匹配不上"的幽灵 bug。
 *
 * 默认就带谐音替换：它是"归一化"的一部分，不是可选项。要换一套映射表
 * 就传自己的 homophones（过滤器内部就是这么做的）。
 */
export function normalizeText(input, { homophones = HOMOPHONES } = {}) {
  if (typeof input !== "string" || input.length === 0) return "";
  let text = input
    .replace(ZERO_WIDTH, "")
    .replace(CONTROL, "")
    .replace(FULLWIDTH, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(IDEOGRAPHIC_SPACE, " ")
    .toLowerCase();

  text = replacerFor(homophones)(text);

  // 大小写再收一次：谐音替换可能引入大写
  return text.replace(SPACE_OR_PUNCT, "").toLowerCase();
}

/**
 * 建一个过滤器。词库在创建时归一化一次并去重，之后每条消息只归一化输入一次。
 */
export function createContentFilter(options = {}) {
  const words = options.words ?? BLOCKED_WORDS;
  const allowed = options.allowed ?? ALLOWED_WORDS;
  const homophones = options.homophones ?? HOMOPHONES;
  const urlPatterns = options.urlPatterns ?? URL_PATTERNS;
  const normalize = (text) => normalizeText(text, { homophones });

  const normalizedWords = [...new Set(words.map(normalize).filter(Boolean))];
  // 长词优先：先摘 "你妈妈" 再摘 "妈妈"，否则会剩下 "你" 把后面切碎
  const normalizedAllowed = [...new Set(allowed.map(normalize).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );

  function check(text) {
    const raw = typeof text === "string" ? text : "";
    for (const pattern of urlPatterns) {
      const match = raw.match(pattern);
      if (match) {
        return { blocked: true, kind: "url", word: match[0], normalized: "", probe: "" };
      }
    }

    const normalized = normalize(raw);
    if (normalized.length === 0) {
      return { blocked: false, kind: null, word: null, normalized, probe: "" };
    }

    let probe = normalized;
    for (const allow of normalizedAllowed) {
      if (probe.includes(allow)) probe = probe.split(allow).join(PLACEHOLDER);
    }

    for (const word of normalizedWords) {
      if (probe.includes(word)) {
        return { blocked: true, kind: "word", word, normalized, probe };
      }
    }
    return { blocked: false, kind: null, word: null, normalized, probe };
  }

  return {
    normalize,
    check,
    /** 给 /diag 用：确认词库真的装进去了，而不是静默为空。 */
    stats() {
      return { words: normalizedWords.length, allowed: normalizedAllowed.length };
    },
  };
}

/** 一次性检查（每次重建过滤器，仅适合低频调用或测试）。 */
export function checkContent(text, options) {
  return createContentFilter(options).check(text);
}
