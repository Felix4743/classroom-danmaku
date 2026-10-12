/**
 * URL 与磁盘目录的对应关系（技术方案 §6）。
 *
 * 为什么需要这一层 —— V0 的第一版把 `index.html` 直接挂在 `/screen`（不带尾斜杠）上，
 * 页面能打开，但**白屏**：浏览器把 `./screen.js` 解析成了 `/screen.js`（404）。
 * 相对引用是按当前 URL 解析的，所以任何一个页面目录都必须在 URL 上表现为
 * 一个真正的"目录"：`/screen/`、`/m/`、`/host/`。
 *
 * 这样约定之后：
 *   /screen/            → src/web/screen/index.html
 *   /screen/screen.js   → src/web/screen/screen.js
 *   /shared/config.js   → src/shared/config.js
 *   /overlay/engine.js  → src/overlay/engine.js
 * 而页面里写的还是普通相对路径 `./screen.js`、`../../shared/config.js`，
 * 既能被服务托管，又不需要构建步骤。
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** 被页面反向引用的公共资源目录，它们不是页面本身。 */
const ASSET_MOUNTS = Object.freeze({
  "/shared": "shared",
  "/overlay": "overlay",
});

/**
 * 扫描 src/web/<name>/，每个目录挂到 `/<name>`。
 * @param {string} staticRoot 通常就是 src/
 * @returns {{mounts: Record<string, string>, pages: string[]}}
 */
export function pageMounts(staticRoot) {
  const mounts = { ...ASSET_MOUNTS };
  const pages = [];

  for (const entry of readdirSync(join(staticRoot, "web"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const prefix = `/${entry.name}`;
    mounts[prefix] = join("web", entry.name);
    pages.push(prefix);
  }

  pages.sort();
  return { mounts, pages };
}

/** 首页：V0 阶段唯一的页面就是手感调参页。 */
export function homePage(pages) {
  return pages.includes("/screen") ? "/screen" : (pages[0] ?? "/screen");
}
