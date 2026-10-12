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

/** 连接被踢掉时给对端的关闭码：1008 = policy violation，"你不该在这儿"。 */
export const KICK_CLOSE_CODE = 1008;

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
  } = options;

  if (!staticRoot) throw new TypeError("startClassroom 需要 staticRoot（通常是 src/）");

  const { mounts, pages } = pageMounts(staticRoot);

  const http = await startHttpServer({
    port,
    host,
    attempts,
    staticRoot,
    mounts,
    // 首页送到调参页。老师真正要用的 /host 和 /m 都挂在各自目录下，
    // 这个跳转只是为了"随手打开根地址时不要看到 404"
    routes: { "/": redirectTo(`${homePage(pages)}/`) },
    logger,
  });

  const session = createSession({ logger, ...(clock ? { clock } : {}), ...sessionOptions });
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
    studentPath: pages.includes("/m") ? "/m" : null,

    async close() {
      hub.close();
      ws.close();
      http.server.closeAllConnections?.();
      await new Promise((resolve) => http.server.close(resolve));
    },
  };
}
