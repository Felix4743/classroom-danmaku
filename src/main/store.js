/**
 * 落盘与导出（技术方案 §4.11、§5.2）。
 *
 * 三条硬要求，每条都有它对应的现场事故：
 *
 * 1. **原子写**：先写 `.tmp` 再 `rename`。U 盘在课间被拔、教室电脑被强行
 *    关机都发生过；直接往目标文件里写，留下的就是一截解析不了的 JSON，
 *    而这节课的数据只有这一份。
 * 2. **路径基准是程序所在目录，绝不写用户目录**。交付形态是 U 盘上双击
 *    一个 exe，数据必须跟着 U 盘走。写进 `%APPDATA%` 的话，老师换一台
 *    电脑讲课就再也找不到上一节的数据了。
 * 3. **落盘失败不能影响上课**。`store` 里所有方法都不向外抛异常：一节
 *    正在上的课不会因为磁盘满了就中断。失败只写日志。
 *
 * 从第一版就写 `schema` 字段（§5.2）：单节课数据是长期资产，将来必然要
 * 改结构，没有版本号只能靠猜。
 */

import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** 落盘格式版本。改结构时必须 +1，并且要在读取侧同时认识新旧两版。 */
export const SCHEMA_VERSION = 1;

/** 补齐两位。 */
function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * 文件名用本地时间：老师认的是"今天下午三点半那节课"，
 * 不是 UTC 时间戳。同一分钟内重复调用得到同一个名字，正好用来做
 * "整节课一直写同一个文件"，而不是每 30 秒新建一个。
 */
export function sessionFileName(ts) {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}.json`
  );
}

/** 同上，给人看的时间戳（导出摘要的标题用）。 */
export function humanTime(ts) {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** 问题池里的一个"问题"—— 预置项或自由打字的文本。 */
function issueKeyOf(item) {
  return item.presetId ? `preset:${item.presetId}` : `text:${String(item.text ?? "").trim()}`;
}

/**
 * 按问题归并，用于「高频问题 Top 20」。
 *
 * 这里**必须把 count 加起来**而不是取最大值：同一个预置项在每 30 秒一个
 * 聚合窗口里都会产生一条独立记录（§4.6），「没听懂 ×3」和「没听懂 ×5」
 * 是同一个人群在两个窗口里的两次表达，总数是 8。
 */
export function rankIssues(danmaku, limit = 20) {
  const groups = new Map();
  for (const item of danmaku) {
    const text = String(item.text ?? "").trim();
    if (!text) continue;
    const key = issueKeyOf(item);
    let group = groups.get(key);
    if (!group) {
      group = { text, presetId: item.presetId ?? null, count: 0, likes: 0, lastAt: 0 };
      groups.set(key, group);
    }
    group.count += Math.max(1, Number(item.aggregate) || 1);
    group.likes += Number(item.likes) || 0;
    group.lastAt = Math.max(group.lastAt, Number(item.ts) || 0);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || b.likes - a.likes || b.lastAt - a.lastAt)
    .slice(0, limit);
}

/** 学生原话。导出文件是给老师看的，所以这里带昵称；有身份时一并带上。 */
function speakerOf(item) {
  const nickname = item.nickname || "匿名同学";
  const name = item.name ? `（${item.name}${item.studentId ? ` ${item.studentId}` : ""}）` : "";
  return `${nickname}${name}`;
}

/**
 * 人可读摘要（§4.11）。
 *
 * 老师下课后真正会看的是这一份，不是那个 JSON。所以它必须能独立读懂：
 * 时间、规模、最集中的问题、以及老师自己做过动作的那几条。
 */
export function renderMarkdown(data) {
  const danmaku = Array.isArray(data?.danmaku) ? data.danmaku : [];
  const stats = data?.stats ?? {};
  const lines = [];

  const startedAt = Number(data?.startedAt) || Number(data?.exportedAt) || 0;
  lines.push(`# 课堂弹幕 · ${humanTime(startedAt)}`);
  lines.push("");
  lines.push(`- 开始时间：${startedAt ? humanTime(startedAt) : "（未知）"}`);
  lines.push(`- 导出时间：${data?.exportedAt ? humanTime(data.exportedAt) : "（未知）"}`);
  lines.push(`- 弹幕条数：${danmaku.length}`);
  if (stats.total !== undefined) {
    lines.push(
      `- 服务端计数：收到 ${stats.total ?? 0} 条、过滤 ${stats.filtered ?? 0} 条、` +
        `限流 ${stats.rateLimited ?? 0} 条、删除 ${stats.removed ?? 0} 条`,
    );
  }
  if (stats.online !== undefined) lines.push(`- 导出时在线：${stats.online} 人`);

  const top = rankIssues(danmaku, 20);
  lines.push("");
  lines.push("## 高频问题 Top 20");
  if (top.length === 0) {
    lines.push("");
    lines.push("这节课没有收到弹幕。");
  } else {
    lines.push("");
    lines.push("| # | 问题 | 次数 | 点赞 |");
    lines.push("|---|---|---|---|");
    top.forEach((issue, index) => {
      lines.push(`| ${index + 1} | ${issue.text.replace(/\|/g, "\\|")} | ${issue.count} | ${issue.likes} |`);
    });
  }

  const pinned = danmaku.filter((item) => item.pinned);
  lines.push("");
  lines.push("## 被置顶的问题");
  if (pinned.length === 0) {
    lines.push("");
    lines.push("这节课没有置顶任何弹幕。");
  } else {
    for (const item of pinned) {
      const count = Number(item.aggregate) > 1 ? ` ×${item.aggregate}` : "";
      lines.push("");
      lines.push(`### ${item.text}${count}`);
      lines.push(`- 学生：${speakerOf(item)}`);
      lines.push(`- 时间：${humanTime(Number(item.ts) || 0)}`);
      lines.push(`- 点赞：${Number(item.likes) || 0}`);
    }
  }

  const resolved = danmaku.filter((item) => item.resolved && !item.pinned);
  lines.push("");
  lines.push("## 已被回应的问题");
  if (resolved.length === 0) {
    lines.push("");
    lines.push("这节课没有标记已回应的问题。");
  } else {
    for (const item of resolved) {
      const count = Number(item.aggregate) > 1 ? ` ×${item.aggregate}` : "";
      lines.push(`- ${item.text}${count} —— ${speakerOf(item)}`);
    }
  }

  const removed = danmaku.filter((item) => item.removed);
  if (removed.length > 0) {
    lines.push("");
    lines.push("## 被删除的弹幕");
    lines.push("");
    lines.push("这些是老师在本节课里撤下来的内容，保留在文件里以便追溯。");
    for (const item of removed) {
      lines.push(`- ${item.text} —— ${speakerOf(item)}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * 落盘器。
 *
 * @param {object} [options]
 * @param {string} [options.dir] 数据目录。默认 `data`，相对**进程的工作目录**
 *        （打包后就是 exe 所在目录，也就是 U 盘）
 * @param {Console} [options.logger]
 */
export function createStore(options = {}) {
  const { dir = "data", logger = console } = options;
  const root = resolve(dir);
  const sessionsDir = join(root, "sessions");
  const exportsDir = join(root, "exports");

  /**
   * 原子写。整份数据先落到 `.tmp`，再 `rename` 覆盖目标 ——
   * `rename` 在同一分区上是原子的，所以读到的要么是旧版本、要么是新版本，
   * 不会是半截。
   */
  async function writeAtomic(filePath, text) {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, filePath);
    return filePath;
  }

  /** 自动落盘用。失败返回 null，绝不抛。 */
  async function save(data) {
    const ts = Number(data?.startedAt) || Number(data?.exportedAt) || Date.now();
    const filePath = join(sessionsDir, sessionFileName(ts));
    try {
      await writeAtomic(filePath, JSON.stringify(data, null, 2));
      return filePath;
    } catch (err) {
      logger.error?.(`[store] 落盘失败（不影响上课）：${err?.message ?? err}`);
      return null;
    }
  }

  /** 老师主动导出：`.json` 完整数据 + `.md` 人可读摘要。 */
  async function exportTo(data) {
    const ts = Number(data?.exportedAt) || Date.now();
    const base = sessionFileName(ts).replace(/\.json$/, "");
    const out = { json: null, markdown: null, markdownText: "" };
    try {
      out.json = await writeAtomic(
        join(exportsDir, `${base}.json`),
        JSON.stringify(data, null, 2),
      );
    } catch (err) {
      logger.error?.(`[store] 导出 JSON 失败：${err?.message ?? err}`);
    }
    try {
      out.markdownText = renderMarkdown(data);
      out.markdown = await writeAtomic(join(exportsDir, `${base}.md`), out.markdownText);
    } catch (err) {
      logger.error?.(`[store] 导出摘要失败：${err?.message ?? err}`);
    }
    return out;
  }

  /** `/diag` 上要能列出"这节课存到哪儿了"。目录不存在时返回空列表。 */
  async function list(sub = "sessions") {
    try {
      const names = await readdir(join(root, sub));
      return names.sort();
    } catch {
      return [];
    }
  }

  return { dir: root, sessionsDir, exportsDir, save, exportTo, writeAtomic, list };
}
