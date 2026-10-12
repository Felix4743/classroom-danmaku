/**
 * 「学生该扫哪个地址」（技术方案 §4.10）。
 *
 * 这是最容易翻车的一步：教室电脑上装过 VMware / WSL / Docker 之后，
 * `networkInterfaces()` 会返回一堆虚拟网卡地址，随便挑一个生成二维码，
 * 全班扫了都打不开。挑地址的逻辑在 `netinfo.js`（纯函数、有测试），
 * 这个文件负责**把它变成老师手机上能看到的东西**：
 *
 *   GET /api/info
 *
 * 为什么不把地址直接写进页面里 —— 端口在启动时可能因为 3000 被占用而
 * 递增（§7.4），地址本身也会变（老师按下「换一个地址」）。页面必须
 * 每次打开都现问一次，而不是吃一个构建期常量。
 */

import { pageUrl, pickAddress } from "../netinfo.js";
import { sendJson } from "./http.js";

/** 学生扫码后落到哪儿。 */
export const DEFAULT_STUDENT_PATH = "/m";

/** 投影页（也就是弹幕层）的地址，老师要在自己电脑上打开它。 */
export const DEFAULT_OVERLAY_PATH = "/screen/";

/**
 * 组装 `/api/info` 的响应体。纯函数，方便直接把假网卡喂进来测。
 *
 * @param {object} options
 * @param {object} [options.interfaces] `os.networkInterfaces()` 的形状；不传就现取真实网卡
 * @param {number} options.port 服务实际监听的端口（不是配置里的 3000）
 * @param {string} [options.studentPath] 学生页路径
 * @param {string} [options.overlayPath] 弹幕层路径
 * @param {number} [options.online] 当前在线人数，老师要靠它判断"到底有没有人连上"
 * @param {number} [options.now] 服务端毫秒时间戳
 * @param {string[]} [options.extraWarnings] 网卡之外还要提醒老师的事（比如防火墙没放行）
 */
export function infoPayload(options = {}) {
  const {
    interfaces,
    port,
    studentPath = DEFAULT_STUDENT_PATH,
    overlayPath = DEFAULT_OVERLAY_PATH,
    online = 0,
    now = 0,
    extraWarnings = [],
  } = options;

  const { best, candidates, warnings } = pickAddress(interfaces, { port });

  // 每个候选地址都要给出**学生页**的完整 URL：老师按「换一个地址」时，
  // 换的是二维码的内容，所以这里算的必须就是二维码要编的那个串
  const withStudentUrl = (candidate) => ({
    ...candidate,
    studentUrl: pageUrl(candidate.address, port, studentPath),
  });

  return {
    serverTime: now,
    port,
    online,
    studentPath,
    overlayPath,
    best: best ? withStudentUrl(best) : null,
    candidates: candidates.map(withStudentUrl),
    warnings: [...warnings, ...(Array.isArray(extraWarnings) ? extraWarnings : [])],
  };
}

/**
 * 生成 `/api/info` 的处理函数。
 *
 * 端口只能通过 `getPort()` 现问：`startHttpServer` 在 3000 被占用时会
 * 递增重试，路由却是在那之前就注册好的。用一个取值函数而不是一个数字，
 * 是这里唯一能同时满足"先注册路由"和"后知道端口"的写法。
 */
export function createInfoRoute(options = {}) {
  const {
    getPort,
    getOnline = () => 0,
    getExtraWarnings = () => [],
    studentPath = DEFAULT_STUDENT_PATH,
    overlayPath = DEFAULT_OVERLAY_PATH,
    interfaces,
    logger = console,
    clock = () => Date.now(),
  } = options;

  if (typeof getPort !== "function") {
    throw new TypeError("createInfoRoute 需要 getPort()，端口要现问（可能被递增过）");
  }

  return (req, res) => {
    try {
      sendJson(
        res,
        200,
        infoPayload({
          interfaces,
          port: getPort(),
          studentPath,
          overlayPath,
          online: getOnline(),
          now: clock(),
          extraWarnings: getExtraWarnings(),
        }),
      );
    } catch (err) {
      // 挑网卡失败不该让整个服务挂掉：老师至少还能手动填一个地址
      logger.error?.("[info] 计算学生地址失败", err);
      sendJson(res, 500, { error: "地址探测失败", warnings: ["地址探测失败，请手动确认本机 IP"] });
    }
  };
}
