/**
 * 启动窗（技术方案 §7.4）—— 双击之后老师第一眼看到的东西。
 *
 * 为什么必须有它：双击 exe 之后，程序干的两件事**都看不见** ——
 * 起了一个本机服务（没有窗口），挂了一层全屏透明窗口（本来就是透明的，
 * 为的是叠在 PPT 上）。剩下的唯一线索是托盘图标，而 Windows 默认把新图标
 * 收进折叠区里。于是"双击了没反应"成了必然的第一印象，哪怕服务其实已经起来了。
 *
 * 这个窗口就是那句"我起来了"。它顺带就是老师端控制台：二维码在最上面，
 * 老师一眼就能开始扫码，不用再去托盘里找。
 *
 * 关掉它**不退出程序**（托盘里能再打开），所以页面上要带一条说明，
 * 否则老师会以为关掉等于退出 —— 这就是 `?welcome=1` 的用途。
 *
 * 这里只放纯函数。Electron 的窗口对象在 `node --test` 里造不出来，但
 * "窗口该去哪儿、该长什么样"能钉住，而这两样正是最容易和页面那边写岔的地方。
 */

/** 窗口尺寸。老师端是竖排页面（提醒器 → 控制台），窄一点比宽了合适。 */
export const CONSOLE_WINDOW_SIZE = Object.freeze({
  width: 520,
  height: 820,
  minWidth: 400,
  minHeight: 560,
});

/** 启动窗标题。页面自己的 `<title>` 会被 `page-title-updated` 挡掉，留住这一条。 */
export const CONSOLE_WINDOW_TITLE = "课堂弹幕 · 已启动";

/**
 * 启动窗要打开的地址。
 *
 * `welcome=1` 是启动窗和老师端页面之间的约定：只有从启动窗进来才显示那条
 * "关掉不影响上课"。老师自己用浏览器打开 `/host/` 时不该看到它 —— 那时候
 * 他本来就知道自己在干什么，多一行字只是噪音。
 */
export function consoleWindowUrl(classroomUrl, options = {}) {
  const { welcome = false } = options;
  const base = String(classroomUrl ?? "").replace(/\/+$/, "");
  return `${base}/host/${welcome ? "?welcome=1" : ""}`;
}

/** 启动窗的 `BrowserWindow` 配置。 */
export function consoleWindowOptions(options = {}) {
  const { icon } = options;
  return {
    width: CONSOLE_WINDOW_SIZE.width,
    height: CONSOLE_WINDOW_SIZE.height,
    minWidth: CONSOLE_WINDOW_SIZE.minWidth,
    minHeight: CONSOLE_WINDOW_SIZE.minHeight,
    title: CONSOLE_WINDOW_TITLE,
    // 居中，别让系统按"层叠偏移"把它甩到屏幕右下角去
    center: true,
    // 菜单栏里没有一条是老师用得上的，留着只是多一条误点的路
    autoHideMenuBar: true,
    // 和 host.css 的 --bg 一致：窗口先画出来、页面还没渲染完的那一瞬间是它
    backgroundColor: "#0e1015",
    ...(icon ? { icon } : {}),
    // 页面是从本机 HTTP 服务来的，和主进程之间不需要任何桥
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
