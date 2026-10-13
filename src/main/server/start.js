/**
 * 把一节课跑起来所需的全部零件接在一起（技术方案 §9 V1）。
 *
 * 这个文件是**唯一**知道"一个完整的课堂服务由哪些部分组成"的地方：
 * 静态页面、WebSocket 端点、零 I/O 的会话、排空队列的胶水层。
 * 上面每一层都可以单独测试，但"拼起来能不能用"只能在这里体现 ——
 * 所以 `tests/unit/start.test.mjs` 会真的起一个服务、真的连上去发弹幕。
 *
 * 刻意不做的事：不打印、不挑网卡、不开窗口。挑地址是 `netinfo.js` 的事，
 * 开窗口是 Electron 的事。这个函数只负责"服务跑起来了，端口是这个"。
 */

import { attachWebSocket } from "./websocket.js";
import { createHub } from "./hub.js";
import { createSession } from "./session.js";
import { homePage, pageMounts } from "./routes.js";
import { redirectTo, startHttpServer } from "./http.js";
import { createInfoRoute, DEFAULT_STUDENT_PATH } from "./info.js";
import { createTunnelRoutes } from "./tunnel-routes.js";
import { createStore, renderMarkdown, sessionFileName } from "../store.js";
import { createTunnelManager } from "../tunnel.js";

/** 连接被踢掉时给对端的关闭码：1008 = policy violation，"你不该在这儿"。 */
export const KICK_CLOSE_CODE = 1008;

/**
 * 老师按下导出（§4.11）。
 *
 * 这个函数**必须同步返回**：会话层是同步的（`drain()` 一次吐出一批消息），
 * 让导出变成异步会把整条链路都染上 Promise，代价远大于收益。所以这里同步
 * 算好摘要、同步推出两个文件名，把真正的写盘丢到后台 —— 老师手机上立刻
 * 就能读到摘要，文件几毫秒后落盘。
 */
function exportNow(store, data, logger) {
  const base = sessionFileName(Number(data?.exportedAt) || Date.now()).replace(/\.json$/, "");
  const markdown = renderMarkdown(data);
  // store.exportTo 自己吞掉所有异常（磁盘满不能中断上课），这里只是兜底
  Promise.resolve(store.exportTo(data)).catch((err) =>
    logger.error?.("[start] 导出失败", err),
  );
  return { markdown, jsonPath: `exports/${base}.json`, mdPath: `exports/${base}.md` };
}

export async function startClassroom(options = {}) {
  const {
    staticRoot,
    port = 3000,
    host = "0.0.0.0",
    attempts = 10,
    wsPath = "/ws",
    logger = console,
    session: sessionOptions = {},
    clock,
    /** 只给测试用：把假网卡喂进来，避免测试结果依赖跑测试的那台机器。 */
    interfaces,
    /**
     * 数据目录。给了才落盘 —— 不给就是纯内存，`npm test` 里跑起来的服务
     * 不会往仓库里写文件。真跑一节课时由入口（Electron / dev-classroom）
     * 传 `data`，相对 exe 所在目录（§4.11）。
     */
    dataDir = null,
    /** 自动落盘间隔（§4.11：每 30 秒）。0 表示关闭。 */
    autosaveMs = 30_000,
    /** 只给测试用：自定义落盘器。 */
    store = null,
    /**
     * 除网卡之外的额外提醒（比如"防火墙没放行，学生连不上"）。
     * 做成取值函数而不是数组：防火墙自检要两三秒，老师打开老师端时它可能还没回来。
     */
    getExtraWarnings = () => [],
    /**
     * 公网隧道。两种给法：
     *   - `tunnel`：一个现成的管理器。Electron 入口用这种，因为只有它知道
     *     安装目录（`process.resourcesPath`），二进制在哪是它的事。
     *   - `tunnelOptions`：只给参数，由这里建。dev 脚本和测试用这种。
     * 两个都不给就是**不开这个功能**：`/api/tunnel/*` 不注册，老师端页面上
     * 那一块整个不显示。
     */
    tunnel = null,
    tunnelOptions = null,
  } = options;

  if (!staticRoot) throw new TypeError("startClassroom 需要 staticRoot（通常是 src/）");

  const { mounts, pages } = pageMounts(staticRoot);

  // 端口要等 listen 成功才知道（3000 被占用时会递增，§7.4），
  // 而路由必须在这之前注册好 —— 所以用一个取值函数把两边接起来
  const state = { port };
  const studentPath = pages.includes(DEFAULT_STUDENT_PATH) ? DEFAULT_STUDENT_PATH : null;

  // 隧道管理器在路由注册之前就要有：`/api/info` 和 `/api/tunnel/*` 都要读它。
  // 端口用取值函数传，理由和 `getPort` 一样 —— 3000 被占用时会递增。
  const tunnelManager =
    tunnel ?? (tunnelOptions ? createTunnelManager({ logger, ...tunnelOptions, getPort: () => state.port }) : null);

  const http = await startHttpServer({
    port,
    host,
    attempts,
    staticRoot,
    mounts,
    // 首页送到调参页。老师真正要用的 /host 和 /m 都挂在各自目录下，
    // 这个跳转只是为了"随手打开根地址时不要看到 404"
    routes: {
      "/": redirectTo(`${homePage(pages)}/`),
      "/api/info": createInfoRoute({
        getPort: () => state.port,
        getOnline: () => session.stats().online,
        studentPath: studentPath ?? DEFAULT_STUDENT_PATH,
        interfaces,
        logger,
        getExtraWarnings,
        getTunnel: () => tunnelManager?.getState() ?? null,
        ...(clock ? { clock } : {}),
      }),
      ...(tunnelManager ? createTunnelRoutes({ manager: tunnelManager, logger }) : {}),
    },
    logger,
  });

  state.port = http.port;

  const persistence = store ?? (dataDir ? createStore({ dir: dataDir, logger }) : null);

  const session = createSession({
    logger,
    ...(clock ? { clock } : {}),
    ...sessionOptions,
    ...(persistence ? { onExport: (data) => exportNow(persistence, data, logger) } : {}),
  });
  const hub = createHub({ session, logger, ...(clock ? { clock } : {}) });

  const ws = attachWebSocket({
    server: http.server,
    path: wsPath,
    logger,
    onConnection(conn) {
      hub.attach(
        conn.id,
        (data) => {
          if (data === null) {
            conn.close(KICK_CLOSE_CODE, "你已被移出本课弹幕");
            return true;
          }
          return conn.send(data);
        },
        // IP 只能从连接本身取。让客户端自报的话，IP 级限流就形同虚设
        { ip: conn.remoteAddress },
      );
      conn.on("message", (raw) => hub.onMessage(conn.id, String(raw)));
      conn.on("close", () => hub.detach(conn.id));
    },
  });

  hub.start();

  // 定时落盘（§4.11）。unref 掉：这个定时器不该让进程活着，
  // 老师在讲完课后点关闭，程序必须能干净退出（§7.4 "不留后台进程"）
  let autosaveTimer = null;
  if (persistence && autosaveMs > 0) {
    autosaveTimer = setInterval(() => {
      persistence.save(session.exportData());
    }, autosaveMs);
    autosaveTimer.unref?.();
  }

  return {
    server: http.server,
    port: http.port,
    /** 只对本机有意义。给学生用的地址必须由 netinfo 挑（§4.10）。 */
    url: http.url,
    session,
    hub,
    ws,
    pages,
    mounts,
    /** 这个地址是学生页，二维码指向的就是它。 */
    studentPath,
    /** 老师页要拿它去问"学生该扫哪个地址"（§4.10）。 */
    infoPath: "/api/info",
    /** 落盘器。没配 dataDir 时为 null（纯内存）。 */
    store: persistence,
    /** 公网隧道管理器。没开这个功能时为 null。 */
    tunnel: tunnelManager,

    async close() {
      if (autosaveTimer) clearInterval(autosaveTimer);
      // 隧道进程必须显式收掉：Windows 上父进程退出不会带走子进程，
      // 留着它就会一直占着老师账号里的那条映射
      if (tunnelManager) await tunnelManager.stop();
      hub.close();
      ws.close();
      http.server.closeAllConnections?.();
      await new Promise((resolve) => http.server.close(resolve));
    },
  };
}
