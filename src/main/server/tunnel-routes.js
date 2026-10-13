/**
 * 「一键开公网」的 HTTP 接口（技术方案 §4.12）。
 *
 * 老师端页面是**系统浏览器**里的一个普通网页（Electron 那边只负责
 * `shell.openExternal`），所以它没有任何 IPC 通道，所有操作只能走 HTTP。
 *
 * 这几个接口干的事有副作用：会花掉老师花生壳账号的配额、会把课堂服务推到
 * 公网上。所以除了不用工具函数，还额外加了一道同源检查 —— 否则学生只要在
 * 自己手机页面上放一个 src 指向 `/api/tunnel/start` 的图片标签，就能让老师的
 * 电脑开一条公网隧道出去。静态文件仍然是只读的 GET/HEAD，
 * 放开方法只针对这几个函数路由（见 `http.js`）。
 */

import { methodNotAllowed, sendJson } from "./http.js";
import { TUNNEL_PATHS } from "../../shared/tunnel-api.js";

// 路径本身住在 shared 里：老师端页面（系统浏览器里的普通网页，见 `src/web/host/host.js`）
// 要 import 同一份。测试也从这里取，避免三处各写一遍字符串。
export { TUNNEL_PATHS };

/**
 * 判断这次请求是不是"老师自己那个页面"发出来的。
 *
 * 三道检查，任意一道不过就拒：
 *   1. `Sec-Fetch-Site` 必须是 `same-origin` 或 `none`（老浏览器没有这个头）
 *   2. 有 `Origin`/`Referer` 时，它的 host 必须等于 `Host`
 *   3. 三者都没有 —— 那是本机脚本（curl、测试、健康检查），放行
 */
export function isSameOrigin(req) {
  const headers = req?.headers ?? {};
  const host = headers.host;
  if (!host) return false;

  const site = headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;

  const source = headers.origin ?? headers.referer;
  if (source === undefined || source === null || source === "") return true;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

/**
 * 生成隧道相关的路由表，直接展开进 `createHttpServer` 的 `routes`。
 *
 * @param {object} options
 * @param {object} options.manager `createTunnelManager()` 的返回值
 */
export function createTunnelRoutes(options = {}) {
  const { manager, logger = console } = options;
  if (!manager || typeof manager.getState !== "function") {
    throw new TypeError("createTunnelRoutes 需要一个隧道管理器");
  }

  /** 统一的"动词检查 + 守卫 + 兜底"外壳：每个处理函数只写自己的正常路径。 */
  const route = (handler, methods = ["GET", "HEAD"]) => async (req, res) => {
    if (!methods.includes(req.method)) {
      methodNotAllowed(res, methods.join(", "));
      return;
    }
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "拒绝跨站操作" });
      return;
    }
    try {
      await handler(req, res);
    } catch (err) {
      logger.error?.("[tunnel] 接口出错", err);
      sendJson(res, 500, { ok: false, error: "隧道操作失败", message: String(err?.message ?? err) });
    }
  };

  // 改状态的三条一律 POST：GET 能被学生用一个 <img> 触发，POST 不能
  const POST_ONLY = ["POST"];

  return {
    [TUNNEL_PATHS.status]: route(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // 账号状态要起一个子进程去问，所以只在老师**主动打开面板**时才查
      // （`?account=1`），平时轮询 `/api/info` 不会碰它
      const wantAccount = url.searchParams.get("account") === "1";
      const payload = { ok: true, tunnel: manager.getState() };
      if (wantAccount) payload.account = await manager.checkAccount();
      sendJson(res, 200, payload);
    }),

    [TUNNEL_PATHS.start]: route(async (req, res) => {
      const state = await manager.start();
      const ok = state.state !== "error" && state.state !== "no_account";
      sendJson(res, ok ? 200 : 502, { ok, tunnel: state });
    }, POST_ONLY),

    [TUNNEL_PATHS.stop]: route(async (req, res) => {
      const state = await manager.stop();
      sendJson(res, 200, { ok: true, tunnel: state });
    }, POST_ONLY),

    [TUNNEL_PATHS.login]: route(async (req, res) => {
      const result = await manager.beginLogin();
      if (!result.ok) {
        sendJson(res, 502, { ok: false, error: result.error, message: result.message ?? null });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        authorizeUrl: result.authorizeUrl,
        timeoutSeconds: result.timeoutSeconds ?? null,
      });
    }, POST_ONLY),
  };
}
