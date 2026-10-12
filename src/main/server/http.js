/**
 * 零依赖静态服务（技术方案 §2.1、§7.4）。
 *
 * 为什么不用 express / serve-static：交付形态是 U 盘上双击一个 exe，
 * 依赖越少越好；而且这里需要的功能（静态托管 + 少量路由 + 端口递增）
 * 四十行就能写完，比读一个框架的文档便宜。
 *
 * 安全要点：教室电脑上的这个服务对局域网开放，但**路径穿越必须挡住** ——
 * 否则学生在浏览器里敲 `/../../` 就能把老师机器上的任意文件读走。
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import { extname, join, resolve, sep } from "node:path";

export const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
});

export function contentTypeOf(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 找出 URL 命中的挂载点。前缀按**路径段**匹配：`/screenx` 不会命中 `/screen`。
 * 同时命中多个时取最长前缀。
 * @returns {{prefix: string, rest: string}|null}
 */
export function findMount(urlPath, mounts) {
  let best = null;
  for (const prefix of Object.keys(mounts)) {
    let rest = null;
    if (urlPath === prefix) rest = "";
    else if (urlPath.startsWith(prefix + "/")) rest = urlPath.slice(prefix.length + 1);
    if (rest === null) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, rest };
  }
  return best;
}

/** 302 跳转。目录缺少尾斜杠时用它兜底。 */
export function redirectTo(location) {
  return (req, res) => {
    res.writeHead(302, {
      Location: location,
      "Content-Length": 0,
      "Cache-Control": "no-store",
    });
    res.end();
  };
}

async function statOf(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

/**
 * 把 URL 路径安全地解析到 root 之内。
 * @returns {string|null} 越界、含空字节、编码非法时返回 null
 */
export function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // 非法百分号编码
  }
  if (decoded.includes("\0")) return null;

  const rootAbs = resolve(root);
  // 去掉前导斜杠后再 resolve：Windows 上 "C:/x" 这类绝对路径仍会逃逸，
  // 所以必须靠下面的前缀检查兜底
  const target = resolve(rootAbs, decoded.replace(/^[/\\]+/, ""));
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null;
  return target;
}

function sendText(res, status, body, headers = {}) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": MIME_TYPES[".txt"],
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

async function sendFile(req, res, filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (info.isDirectory()) return false;

  res.writeHead(200, {
    "Content-Type": contentTypeOf(filePath),
    "Content-Length": info.size,
    // 开发期与课堂现场都不希望浏览器缓存旧版本
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise((done) => {
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      res.destroy();
      done();
    });
    stream.on("close", done);
    stream.pipe(res);
  });
  return true;
}

/**
 * @param {object} options
 * @param {string} [options.staticRoot] 静态文件根目录
 * @param {Record<string, string|((req, res) => void|Promise<void>)>} [options.routes]
 *        精确路径路由；值可以是文件路径（相对 staticRoot）或处理函数
 * @param {Record<string, string>} [options.mounts]
 *        URL 前缀 → 目录。目录相对 staticRoot 解析。
 *        这是页面能被正确托管的关键：把 `src/web/screen/` 挂到 `/screen`，
 *        浏览器请求 `/screen/` 时 URL 末段是目录，页面里 `./screen.js`
 *        才会解析成 `/screen/screen.js` 而不是 `/screen.js`。
 * @param {Console} [options.logger]
 */
export function createHttpServer(options = {}) {
  const { staticRoot, routes = {}, mounts = {}, logger = console } = options;
  const rootAbs = staticRoot ? resolve(staticRoot) : null;

  // 挂载点目录一次性解析好：URL 前缀 → 绝对目录
  const mountTable = {};
  for (const [prefix, dir] of Object.entries(mounts)) {
    const base = rootAbs ?? process.cwd();
    mountTable[prefix.replace(/\/+$/, "") || "/"] = resolve(base, dir);
  }

  const handle = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "405 Method Not Allowed", { Allow: "GET, HEAD" });
      return;
    }

    const raw = req.url ?? "/";
    const hashAt = raw.indexOf("#");
    const withoutHash = hashAt === -1 ? raw : raw.slice(0, hashAt);
    const queryAt = withoutHash.indexOf("?");
    const urlPath = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
    const search = queryAt === -1 ? "" : withoutHash.slice(queryAt);

    const route = routes[urlPath] ?? routes[urlPath.replace(/\/+$/, "") || "/"];

    if (typeof route === "function") {
      await route(req, res);
      return;
    }

    let filePath = null;
    if (typeof route === "string") {
      filePath = rootAbs ? safeJoin(rootAbs, route) : null;
    } else {
      const mount = findMount(urlPath, mountTable);
      if (mount) {
        filePath = safeJoin(mountTable[mount.prefix], mount.rest);
      } else if (rootAbs) {
        filePath = safeJoin(rootAbs, urlPath);
      }
    }

    if (!filePath) {
      if (!rootAbs) {
        sendText(res, 404, "404 Not Found");
        return;
      }
      logger.warn?.(`[http] 拒绝越界路径：${urlPath}`);
      sendText(res, 403, "403 Forbidden");
      return;
    }

    const info = await statOf(filePath);
    if (info?.isDirectory()) {
      // 目录少了尾斜杠，页面里的相对引用会整体错位到上一层 —— 必须补上
      if (!urlPath.endsWith("/")) {
        res.writeHead(302, {
          Location: urlPath + "/" + search,
          "Content-Length": 0,
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }
      if (await sendFile(req, res, join(filePath, "index.html"))) return;
    } else if (await sendFile(req, res, filePath)) {
      return;
    }

    // 目录或"无扩展名"的路径 → 试 index.html
    if (!extname(filePath) && (await sendFile(req, res, join(filePath, "index.html")))) {
      return;
    }

    sendText(res, 404, "404 Not Found");
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error?.("[http] 处理请求异常", err);
      if (!res.headersSent) sendText(res, 500, "500 Internal Server Error");
      else res.destroy();
    });
  });
}

/**
 * 监听端口，被占用时自动递增（§7.4）。教室电脑上 3000 端口不一定是空的。
 * @returns {Promise<{server: http.Server, port: number, url: string}>}
 */
export function startHttpServer(options = {}) {
  const { port = 3000, host = "0.0.0.0", attempts = 10, ...rest } = options;
  const server = createHttpServer(rest);

  return new Promise((resolvePromise, reject) => {
    let candidate = port;
    let left = attempts;

    const onError = (err) => {
      if (err.code === "EADDRINUSE" && left > 1) {
        left -= 1;
        candidate += 1;
        server.listen(candidate, host);
        return;
      }
      server.removeListener("error", onError);
      reject(err);
    };

    server.on("error", onError);
    server.once("listening", () => {
      server.removeListener("error", onError);
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : candidate;
      resolvePromise({
        server,
        port: actual,
        url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actual}`,
      });
    });
    server.listen(candidate, host);
  });
}
