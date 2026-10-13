/**
 * 公网隧道那几条 HTTP 接口的路径。
 *
 * 单独放一份是因为**服务端和老师端页面都要用同一个字符串**：页面是通过
 * `/shared/` 挂载点直接引用 `src/shared/` 下的文件的（和 `join-card.js`
 * 一样），没有构建步骤，所以两边 `import` 的就是同一个模块。写两遍迟早
 * 会有一边改了另一边没改，表现是"按钮点了 404"。
 */

export const TUNNEL_PATHS = Object.freeze({
  /** 读当前状态。加 `?account=1` 才会去问花生壳账号（要起子进程，别轮询）。 */
  status: "/api/tunnel/status",
  /** 开公网。POST。 */
  start: "/api/tunnel/start",
  /** 关公网。POST。 */
  stop: "/api/tunnel/stop",
  /** 起一次账号授权，返回要老师打开的链接。POST。 */
  login: "/api/tunnel/login",
});

/** 隧道状态机的取值，和 `src/main/tunnel.js` 的 `TUNNEL_STATE` 一一对应。 */
export const TUNNEL_STATE = Object.freeze({
  OFF: "off",
  STARTING: "starting",
  ON: "on",
  ERROR: "error",
  NO_ACCOUNT: "no_account",
});

/** 状态 → 老师能看懂的一句话。页面和日志共用，避免两边说法不一样。 */
export const TUNNEL_LABEL = Object.freeze({
  [TUNNEL_STATE.OFF]: "未开启",
  [TUNNEL_STATE.STARTING]: "正在开启…",
  [TUNNEL_STATE.ON]: "已开启",
  [TUNNEL_STATE.ERROR]: "开启失败",
  [TUNNEL_STATE.NO_ACCOUNT]: "需要先绑定账号",
});
