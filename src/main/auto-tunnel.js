/**
 * 启动时自动接公网（技术方案 §4.12）。
 *
 * 为什么值得自动做：公网走的是花生壳，账号绑过一次之后 `start()` 自己就把
 * 隧道建起来并认领掉（见 `src/main/tunnel.js` 的 `start()`）—— 老师这边没有任何
 * 要填的东西。既然机器能判断「绑没绑」，就不该让老师在每节课前手动点一次
 * 「开公网」：那是个纯粹的仪式，忘了就掉回局域网，反而不如默认就开着。
 *
 * 但「自动」必须留一个逃生门。老师端那个按钮是手动的，如果他特意关掉、下次
 * 启动又自己开起来，那个按钮就成了摆设。`CLASSROOM_NO_AUTO_TUNNEL=1` 是给
 * 「整个程序都不许自动开」的场景（公开课要在完全离线的环境里演示）用的，
 * 和既有的 `CLASSROOM_*` 环境变量一个路子。
 *
 * 决策与副作用分开：`autoTunnelDecision()` 是纯函数，副作用都在
 * `maybeAutoStartTunnel()` 里 —— Electron 主进程起不来测试环境，但"什么时候该开"
 * 是这个功能里唯一会出错的地方，它必须能测。
 */

import { TUNNEL_STATE } from "./tunnel.js";

/** 关掉自动接公网的环境变量。值必须是字符串 `"1"`（和既有的 `CLASSROOM_*` 一致）。 */
export const NO_AUTO_TUNNEL_ENV = "CLASSROOM_NO_AUTO_TUNNEL";

/**
 * 要不要自动开公网。
 *
 * 注意判断的顺序：**先看逃生门，再看能不能开**。反过来的话，"找不到二进制"
 * 这类环境问题会盖掉老师明确的"别自动开"，日志里就会出现一条他不想看到的重试。
 *
 * @param {{ state?: string }|null} snapshot `tunnel.getState()` 的结果
 * @param {{ hasBinary?: boolean, env?: Record<string,string> }} [options]
 */
export function autoTunnelDecision(snapshot, options = {}) {
  const { hasBinary = false, env = {} } = options;

  if (env[NO_AUTO_TUNNEL_ENV] === "1") {
    return {
      start: false,
      reason: "opted_out",
      message: `${NO_AUTO_TUNNEL_ENV}=1，这次不自动开公网（老师可以自己在控制台里开）`,
    };
  }

  // 装包时漏了 hsk-cli 才会走到这里。不报错 —— 局域网照常用，公网是加餐
  if (!hasBinary) {
    return {
      start: false,
      reason: "no_binary",
      message: "找不到内置的穿透程序，跳过自动开公网（局域网不受影响）",
    };
  }

  const current = snapshot?.state;

  // 已经开着 / 正在开：`start()` 本身是幂等的，但白调一次会让日志多一行噪音
  if (current === TUNNEL_STATE.ON || current === TUNNEL_STATE.STARTING) {
    return { start: false, reason: `already_${current}`, message: null };
  }

  // 查过一次、确认没绑账号。再问一次也还是没绑，只会白白多起一个子进程
  if (current === TUNNEL_STATE.NO_ACCOUNT) {
    return { start: false, reason: "no_account", message: null };
  }

  // `error` 是要重试的：上一次可能只是网络抖了一下，启动时正好该再给一次机会
  return { start: true, reason: "attempt", message: null };
}

/**
 * 按上面的判断真的去开一次。
 *
 * 永远不抛：公网是加餐，它起不来不该挡住上课。`start()` 内部已经先查过账号，
 * 没绑就返回 `no_account` —— 那是一个正常状态（老师端会显示"先绑账号"的按钮），
 * 不是错误，所以这里不往 `logger.error` 里写。
 */
export async function maybeAutoStartTunnel(options = {}) {
  const { tunnel, env = process.env, logger = console } = options;

  if (!tunnel) {
    return autoTunnelDecision(null, { hasBinary: false, env });
  }

  const decision = autoTunnelDecision(tunnel.getState?.(), {
    hasBinary: Boolean(tunnel.resolveBinary?.()),
    env,
  });

  if (decision.message) logger.log?.(`[tunnel] ${decision.message}`);
  if (!decision.start) return decision;

  try {
    const snapshot = await tunnel.start();
    logger.log?.(`[tunnel] 启动时自动接公网 → ${snapshot?.state ?? "unknown"}`);
    return { ...decision, snapshot };
  } catch (err) {
    logger.error?.("[tunnel] 启动时自动接公网失败（不影响局域网）", err);
    return { ...decision, error: err };
  }
}
