/**
 * 桌面程序入口（技术方案 §4.1、§7.2、§7.4）。
 *
 * 这一个进程要做四件事，顺序不能变：
 *   1. 单实例锁 —— 老师双击两次图标不该起两个服务抢 3000 端口。
 *   2. 起课堂服务（HTTP + WebSocket），端口被占就自动 +1（§7.4）。
 *   3. 把弹幕层窗口挂到投影那块屏上，并探测透明浮层能不能用（§4.1）。
 *   4. 放一个托盘图标。**这是老师唯一能退出弹幕层的地方** ——
 *      窗口全屏、无边框、鼠标穿透、还不进任务栏，没有托盘就只能开任务管理器。
 *
 * 关于 `userData`：技术方案 §4.11 要求"绝不写 userData"，
 * 那说的是**课堂数据**（弹幕、导出文件）必须落在程序旁边的 `data/` 里，
 * 这条已经由 `dataDirFor()` 保证了。Chromium 自己的缓存/GPU 缓存仍然留在
 * 系统默认位置 —— 把它也搬到 U 盘上只会让冷启动变慢（§7.4 要求 < 10 秒）
 * 并且白白磨损 U 盘，换不来任何好处。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Menu, Tray, app, globalShortcut, nativeImage, shell } from "electron";

import { hardenConsole, installCrashLog } from "./crash-log.js";
import { dataDirFor, logDirFor, staticRootFor } from "./desktop-paths.js";
import { TRAY_ICON_DATA_URL } from "./icon.js";
import { createOverlay } from "./overlay.js";
import { startClassroom } from "./server/start.js";

// 第一件事：让 console 永不抛。
// 桌面程序的控制台根本不可靠（双击启动的 exe 压根没有控制台，被脚本拉起来时
// 管道随时会断），而"写日志把自己写崩"会自激成死循环 —— 详见 crash-log.js 顶部。
hardenConsole();

// Windows 的"原生窗口遮挡检测"会把不当焦点、又被别的窗口盖住的窗口判成不可见，
// 然后停掉它的渲染。弹幕层永远拿不到焦点，也永远被别人"盖住"（我们才是上面那层），
// 一旦被它判成遮挡，弹幕就会整片停住。这个开关是这块的常规解药。
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const state = { classroom: null, overlay: null, tray: null, quitting: false, refreshTray: null };

/**
 * 老师手动选的弹幕层级别记在 `data/overlay.json`。
 *
 * 只在**探测没测出来**的时候才用它（见 `main()`）：那次选择是老师在真实机器上
 * 亲眼看过之后做的，比我们的探测可靠。探测有结论时一律听探测的 ——
 * 老师换了电脑、换了投影，记忆里的级别就不成立了。
 */
const OVERLAY_PREF_FILE = "overlay.json";

function readOverlayPref(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, OVERLAY_PREF_FILE), "utf8"));
    return raw?.level === "L0" || raw?.level === "L1" ? raw.level : null;
  } catch {
    return null; // 没存过、或者存坏了：都当作没选过
  }
}

function writeOverlayPref(dataDir, level) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, OVERLAY_PREF_FILE),
      `${JSON.stringify({ level, savedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn("[main] 没能记住弹幕层级别", error?.message ?? error);
  }
}

const isDev = !app.isPackaged;

/**
 * 打包之后"东西在哪儿"全靠这两个环境事实：
 * `PORTABLE_EXECUTABLE_DIR`（真 U 盘目录，`app.getPath("exe")` 在 portable
 * 目标下指向临时解包目录）和 `process.resourcesPath`（`src/` 被塞在它下面）。
 */
function pathOptions() {
  if (isDev) return { cwd: ROOT };
  return {
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    exePath: app.getPath("exe"),
  };
}

function resolvePaths() {
  const options = pathOptions();
  return {
    dataDir: dataDirFor(options),
    logDir: logDirFor(options),
    staticRoot: staticRootFor({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
  };
}

/** 崩溃日志写 U 盘（§7.4）。老师拔着 U 盘来上课，日志必须跟着走。 */
function installCrashHandlers(logDir) {
  // 实现和事故经过在 crash-log.js：日志本身绝不能成为新的故障源
  installCrashLog(process, { logDir });
}

function quit() {
  state.quitting = true;
  globalShortcut.unregisterAll();
  try {
    state.overlay?.destroy();
  } catch {
    /* 已经没了 */
  }
  try {
    state.classroom?.close();
  } catch {
    /* 已经关了 */
  }
  state.tray?.destroy();
  app.quit();
}

/** 弹幕层现在到底显示着没有。窗口被销毁/还没建都算"没有"。 */
function overlayVisible() {
  const win = state.overlay?.win;
  return Boolean(win && !win.isDestroyed() && win.isVisible());
}

/**
 * 隐藏/显示弹幕层。
 *
 * 这是**屏幕被弹幕层糊住时的最后一条出路**：窗口全屏、无边框、鼠标穿透、
 * 还 skipTaskbar，老师点不到也关不掉。托盘菜单是一条路，但黑板盖满屏幕时
 * 连托盘图标都可能看不见，所以还要有一个纯键盘的全局快捷键（Ctrl+Alt+D）。
 */
function toggleOverlayVisible() {
  const win = state.overlay?.win;
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
    console.log("[main] 弹幕层已隐藏（Ctrl+Alt+D 再按一次显示）");
  } else {
    win.showInactive();
    console.log("[main] 弹幕层已显示");
  }
  state.refreshTray?.();
}

/** 老师手动切级别：立刻生效，并记住，下次探测测不出来时沿用。 */
async function setOverlayLevel(level) {
  if (!state.overlay) return;
  try {
    const result = await state.overlay.setLevel(level);
    // 记的是**实际生效**的那一级：手动切 L0 但复验没过时会自己退回 L1，
    // 那就不该把 L0 记下来，否则下次探测没结论时会照着一个不成立的级别走。
    writeOverlayPref(state.dataDir, result?.level ?? level);
    console.log(`[main] 弹幕层切到 ${result?.level ?? level}（老师手动）${result?.reason ? ` — ${result.reason}` : ""}`);
  } catch (error) {
    console.error(`[main] 切到 ${level} 失败`, error);
  }
  state.refreshTray?.();
}

function menuTemplate(classroom) {
  const base = `${classroom.url}/`;
  const open = (path) => shell.openExternal(`${base}${path}`);
  const overlay = state.overlay;
  const levelHint = overlay
    ? `${overlay.level}${overlay.unknown ? "（探测没测出来）" : ""}`
    : "（还没起来）";

  return [
    { label: "打开老师端（手机也可以）", click: () => open("host/") },
    { label: "打开投影页（浏览器全屏）", click: () => open("screen/") },
    { label: "打开手感调参页", click: () => open("tune/") },
    { type: "separator" },
    {
      label: "弹幕层",
      submenu: [
        { label: `当前：${levelHint}`, enabled: false },
        { type: "separator" },
        {
          label: "透明浮层（叠在 PPT 上）",
          type: "radio",
          checked: overlay?.level === "L0",
          click: () => setOverlayLevel("L0"),
        },
        {
          label: "底部弹幕带（占屏幕下方 25%）",
          type: "radio",
          checked: overlay?.level === "L1",
          click: () => setOverlayLevel("L1"),
        },
        { type: "separator" },
        {
          label: overlayVisible() ? "隐藏弹幕层（Ctrl+Alt+D）" : "显示弹幕层（Ctrl+Alt+D）",
          click: () => toggleOverlayVisible(),
        },
      ],
    },
    { type: "separator" },
    { label: `学生地址：${classroom.studentUrl ?? "见 /api/info"}`, enabled: false },
    { label: "打开数据目录", click: () => shell.openPath(classroom.store?.dir ?? "") },
    { type: "separator" },
    { label: "退出（Ctrl+Alt+Q）", click: () => quit() },
  ];
}

function buildTray(classroom) {
  const tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
  tray.setToolTip("课堂弹幕");
  const refresh = () => tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(classroom)));
  refresh();
  state.refreshTray = refresh;
  tray.on("double-click", () => shell.openExternal(`${classroom.url}/host/`));
  return tray;
}

/**
 * 全局快捷键。两条都是**老师被程序坑住时的逃生门**，所以用的是
 * `globalShortcut`（不依赖窗口焦点）而不是页面里的键盘事件。
 */
function registerShortcuts() {
  const bind = (accelerator, handler, what) => {
    const ok = globalShortcut.register(accelerator, handler);
    if (!ok) console.warn(`[main] 全局快捷键 ${accelerator}（${what}）被别的程序占了`);
    return ok;
  };
  bind("Control+Alt+D", toggleOverlayVisible, "隐藏/显示弹幕层");
  bind("Control+Alt+Q", quit, "退出");
}

async function main() {
  const { dataDir, logDir, staticRoot } = resolvePaths();
  state.dataDir = dataDir;
  installCrashHandlers(logDir);
  console.log(`[main] 数据目录：${dataDir}`);
  console.log(`[main] 静态根目录：${staticRoot}`);

  const classroom = await startClassroom({
    staticRoot,
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || "0.0.0.0",
    dataDir,
  });
  state.classroom = classroom;
  console.log(`[main] 课堂服务：${classroom.url}（监听端口 ${classroom.port}）`);

  // 学生地址：给托盘菜单和日志用。取不到也不影响上课（老师页里还能看到）。
  try {
    const info = await fetch(`${classroom.url}/api/info`).then((r) => r.json());
    classroom.studentUrl = info.best?.studentUrl ?? null;
    console.log(`[main] 学生地址：${classroom.studentUrl ?? "（没找到可用的局域网地址）"}`);
  } catch (error) {
    console.warn("[main] 学生地址探测失败", error?.message ?? error);
  }

  // 托盘先于弹幕层建。弹幕层是全屏 + 鼠标穿透 + 不进任务栏的窗口 ——
  // 万一探测卡住或者窗口行为异常，托盘是老师唯一的出口，必须先在那儿。
  state.tray = buildTray(classroom);

  if (process.env.CLASSROOM_SKIP_OVERLAY === "1") {
    // 只想验服务、不想被一层全屏弹幕盖住屏幕时用（调服务端、查网卡都能用得上）
    console.log("[main] CLASSROOM_SKIP_OVERLAY=1，跳过弹幕层窗口");
    return;
  }

  try {
    /*
     * `CLASSROOM_OVERLAY_LEVEL=L0|L1` 直接钉死级别，跳过探测。
     * 排障和"我就要全屏透明"时用得上：探测在某些教室电脑上确实测不出结论，
     * 这时候需要一条绕过它的路。
     */
    const forced = process.env.CLASSROOM_OVERLAY_LEVEL;
    const forcedLevel = forced === "L0" || forced === "L1" ? forced : null;
    if (forcedLevel) console.log(`[main] CLASSROOM_OVERLAY_LEVEL=${forcedLevel}，跳过探测`);

    state.overlay = await createOverlay({
      url: `${classroom.url}/screen/`,
      forcedLevel,
    });

    /*
     * 探测"测不出来"（背后本身就是黑的）时，沿用老师上次手动选的级别。
     *
     * 为什么只在这时候用：探测有结论时它比记忆可靠 —— 老师换了电脑、
     * 换了投影，"上次能用 L0"就不再成立。而探测没结论时，老师在真机上
     * 亲眼看过之后按下的那个选择，是当下唯一的信息。
     */
    const remembered = readOverlayPref(dataDir);
    if (state.overlay.unknown && remembered && remembered !== state.overlay.level) {
      console.log(`[main] 探测没测出来，沿用上次老师手动选的 ${remembered}`);
      await setOverlayLevel(remembered);
    }

    state.refreshTray?.();
    registerShortcuts();
    console.log("[main] 全局快捷键：Ctrl+Alt+D 隐藏/显示弹幕层，Ctrl+Alt+Q 退出");
  } catch (error) {
    // 弹幕层起不来不等于课上不了：老师还能用浏览器全屏开 /screen/（§4.1 的 L2）。
    console.error("[main] 弹幕层没起来，退回浏览器全屏方案（L2）", error);
    shell.openExternal(`${classroom.url}/screen/`);
  }
}

if (!app.requestSingleInstanceLock()) {
  // 已经有一个在跑了。第二个实例直接退出，不抢端口、不叠一层窗口。
  app.quit();
} else {
  app.on("second-instance", () => {
    // 老师又双击了一次图标：把老师端拉出来，而不是抱怨
    shell.openExternal(`${state.classroom?.url ?? ""}/host/`);
  });

  // 托盘还在的时候，"窗口都关了"不等于该退出。这个事件订阅了就取消默认的
  // "关完窗口就退出"行为；真正退出只能由托盘菜单的"退出"触发（§7.4：
  // 不留后台进程 —— 但退出的决定权在老师手里，不在窗口计数上）。
  app.on("window-all-closed", () => {
    if (state.quitting) app.quit();
  });

  app.on("before-quit", () => {
    state.quitting = true;
  });

  app.whenReady().then(main).catch((error) => {
    console.error("[main] 启动失败", error);
    app.exit(1);
  });
}
