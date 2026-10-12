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

import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { Menu, Tray, app, nativeImage, shell } from "electron";

import { dataDirFor, logDirFor, staticRootFor } from "./desktop-paths.js";
import { TRAY_ICON_DATA_URL } from "./icon.js";
import { createOverlay } from "./overlay.js";
import { startClassroom } from "./server/start.js";

// Windows 的"原生窗口遮挡检测"会把不当焦点、又被别的窗口盖住的窗口判成不可见，
// 然后停掉它的渲染。弹幕层永远拿不到焦点，也永远被别人"盖住"（我们才是上面那层），
// 一旦被它判成遮挡，弹幕就会整片停住。这个开关是这块的常规解药。
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const state = { classroom: null, overlay: null, tray: null, quitting: false };

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
function installCrashLog(logDir) {
  const write = (tag, error) => {
    try {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, "crash.log"), `[${new Date().toISOString()}] ${tag} ${error?.stack ?? error}\n`, "utf8");
    } catch {
      // 连日志都写不下去（U 盘拔了/写保护），这时候能做的只有别让程序再崩一次
    }
  };
  process.on("uncaughtException", (error) => {
    write("uncaughtException", error);
    console.error("[main] 未捕获异常", error);
  });
  process.on("unhandledRejection", (reason) => {
    write("unhandledRejection", reason);
    console.error("[main] 未处理的 Promise 拒绝", reason);
  });
}

function quit() {
  state.quitting = true;
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

function buildTray(classroom) {
  const base = `${classroom.url}/`;
  const open = (path) => shell.openExternal(`${base}${path}`);

  const tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
  tray.setToolTip("课堂弹幕");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开老师端（手机也可以）", click: () => open("host/") },
      { label: "打开投影页（浏览器全屏）", click: () => open("screen/") },
      { label: "打开手感调参页", click: () => open("tune/") },
      { type: "separator" },
      {
        label: "弹幕层",
        submenu: [
          {
            label: "透明浮层（叠在 PPT 上）",
            type: "radio",
            checked: state.overlay?.level === "L0",
            click: () => state.overlay?.setLevel("L0"),
          },
          {
            label: "底部弹幕带（占屏幕下方 25%）",
            type: "radio",
            checked: state.overlay?.level === "L1",
            click: () => state.overlay?.setLevel("L1"),
          },
        ],
      },
      { type: "separator" },
      { label: `学生地址：${classroom.studentUrl ?? "见 /api/info"}`, enabled: false },
      { label: "打开数据目录", click: () => shell.openPath(classroom.store?.dir ?? "") },
      { type: "separator" },
      { label: "退出", click: () => quit() },
    ]),
  );
  tray.on("double-click", () => open("host/"));
  return tray;
}

async function main() {
  const { dataDir, logDir, staticRoot } = resolvePaths();
  installCrashLog(logDir);
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

  try {
    state.overlay = await createOverlay({ url: `${classroom.url}/screen/` });
  } catch (error) {
    // 弹幕层起不来不等于课上不了：老师还能用浏览器全屏开 /screen/（§4.1 的 L2）。
    console.error("[main] 弹幕层没起来，退回浏览器全屏方案（L2）", error);
    shell.openExternal(`${classroom.url}/screen/`);
  }

  state.tray = buildTray(classroom);
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
