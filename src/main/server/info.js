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

import { pageUrl, pickAddress, publicCandidate } from "../netinfo.js";
import { methodNotAllowed, sendJson } from "./http.js";

/** 学生扫码后落到哪儿。 */
export const DEFAULT_STUDENT_PATH = "/m";

/** 投影页（也就是弹幕层）的地址，老师要在自己电脑上打开它。 */
export const DEFAULT_OVERLAY_PATH = "/screen/";

/**
 * 隧道状态的规范形状。老师端永远拿到这几个字段，不用自己判 undefined。
 *
 * `available` 单独存在，是因为"功能被关掉了"和"功能在、但现在是关的"在界面上
 * 完全不同：前者整块不显示，后者要显示一个「开公网」按钮。
 */
export const TUNNEL_OFF = Object.freeze({
  state: "off",
  publicUrl: null,
  expiresAt: null,
  message: null,
  available: false,
});

/**
 * 把隧道管理器给的状态收进一个固定形状。
 *
 * 为什么要在服务端做这件事而不是让页面自己判：老师端是**每次刷新都重新
 * 现问一次** `/api/info` 的（端口和地址都会变），它每次拿到的 JSON 必须
 * 长得一模一样，否则页面里到处是 `?.` 和 `?? "off"`，漏一处就是白屏。
 */
export function tunnelView(tunnel) {
  if (!tunnel || typeof tunnel !== "object") return { ...TUNNEL_OFF };
  const publicUrl = typeof tunnel.publicUrl === "string" && tunnel.publicUrl !== "" ? tunnel.publicUrl : null;
  return {
    state: typeof tunnel.state === "string" && tunnel.state !== "" ? tunnel.state : "off",
    publicUrl,
    expiresAt: tunnel.expiresAt ?? null,
    message: tunnel.message ?? null,
    available: true,
  };
}

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
 * @param {object} [options.tunnel] 公网隧道的当前状态；开了就把公网地址排到第一位
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
    tunnel,
  } = options;

  const { best, candidates, warnings } = pickAddress(interfaces, { port });
  const view = tunnelView(tunnel);

  // 每个候选地址都要给出**学生页**的完整 URL：老师按「换一个地址」时，
  // 换的是二维码的内容，所以这里算的必须就是二维码要编的那个串
  const withStudentUrl = (candidate) => ({
    ...candidate,
    studentUrl: pageUrl(candidate.address, port, studentPath),
  });

  // 公网地址**自带** studentUrl（https、不带端口），不能再套 pageUrl，
  // 所以它单独构造，然后插到最前面 —— 老师的二维码默认就指向它
  const published = publicCandidate({ publicUrl: view.publicUrl, studentPath });
  const all = published ? [published, ...candidates.map(withStudentUrl)] : candidates.map(withStudentUrl);

  const tunnelWarnings = [];
  if (view.state === "error" && view.message) tunnelWarnings.push(`公网地址没开起来：${view.message}`);
  if (view.state === "no_account" && view.message) tunnelWarnings.push(view.message);

  return {
    serverTime: now,
    port,
    online,
    studentPath,
    overlayPath,
    tunnel: view,
    // best 就是二维码要编的那个串。公网开着的时候它就是公网地址
    best: all[0] ?? null,
    candidates: all,
    warnings: [...warnings, ...tunnelWarnings, ...(Array.isArray(extraWarnings) ? extraWarnings : [])],
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
    getTunnel = () => null,
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
    // 只读接口，别的动词一律 405 —— 闸门在 http.js 里已经不再统一拦了
    if (req.method !== "GET" && req.method !== "HEAD") {
      methodNotAllowed(res);
      return;
    }
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
          tunnel: getTunnel(),
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
