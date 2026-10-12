/**
 * 打包之后"东西都在哪儿"（技术方案 §4.11、§7.3）。
 *
 * 这一段必须单独拎出来，因为它有两个**非常容易搞错、而且错了以后
 * 只有在 U 盘上才会暴露**的点：
 *
 * 1. `app.getPath("exe")` 在 electron-builder 的 `portable` 目标下指向的是
 *    一个**临时解包目录**（`%TEMP%\xxxx`），不是 U 盘。照着它算数据目录，
 *    这节课的数据会落在 C 盘的临时目录里，拔盘即丢。真正的 U 盘目录在
 *    `PORTABLE_EXECUTABLE_DIR` 环境变量里。
 * 2. 开发期与打包后的目录结构完全不同（打包后 `src/` 被塞进 `resources/`），
 *    所以静态根目录不能靠写死的相对路径。
 *
 * 这里全是纯函数，就是为了能在 Node 里直接测（Electron 起不来也能测）。
 */

import { dirname, join, resolve } from "node:path";

/**
 * 数据目录 = 程序所在目录下的 `data/`（§4.11：绝不写用户目录，数据跟着 U 盘走）。
 *
 * @param {object} [options]
 * @param {string} [options.portableDir] electron-builder portable 目标给的 `PORTABLE_EXECUTABLE_DIR`
 * @param {string} [options.exePath] 可执行文件路径
 * @param {string} [options.cwd] 兜底用的工作目录（开发期）
 */
export function dataDirFor(options = {}) {
  const { portableDir, exePath, cwd = process.cwd() } = options;
  if (portableDir) return join(resolve(portableDir), "data");
  if (exePath) return join(dirname(resolve(exePath)), "data");
  return join(resolve(cwd), "data");
}

/** 崩溃日志与本次运行的日志放这儿：数据目录旁边，老师能一起拷走。 */
export function logDirFor(options = {}) {
  return join(dataDirFor(options), "logs");
}

/**
 * 浏览器页面（`src/`）在哪儿。
 *
 * - 开发期：仓库里的 `src/`
 * - 打包后：`resources/src/`（由 electron-builder 的 `extraResources` 放进去）
 *
 * 两个都试一遍、取存在的那个，而不是只看 `isPackaged` —— 打包配置写错时，
 * "按标志位猜"会安静地给出一个不存在的路径，程序起来就是一堆 404。
 */
export function staticRootFor(options = {}) {
  const { isPackaged, resourcesPath, appPath } = options;
  if (isPackaged && resourcesPath) return join(resourcesPath, "src");
  if (appPath) return join(appPath, "src");
  return resolve("src");
}
