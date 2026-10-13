/**
 * 测试用的 HTTP 小工具。
 * 故意不复用仓库里的任何服务端代码 —— 测试要独立地"像浏览器那样"发请求。
 */

import http from "node:http";

import { startHttpServer } from "../../src/main/server/http.js";

/**
 * 发一个请求，把响应体收全。
 *
 * 故意**不**经过 `new URL()` 拼接 path —— URL 会把 `/../` 规范化掉，
 * 那样路径穿越的用例就永远测不到了。
 */
export function request(base, path = "/", { method = "GET", headers } = {}) {
  const origin = new URL(base);
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      // agent: false —— 每条请求单开连接并主动关闭。
      // Node 19+ 默认 keep-alive，连接会挂 5 秒，测试结束时收服务要空等很久。
      { host: origin.hostname, port: origin.port, path, method, agent: false, ...(headers ? { headers } : {}) },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 起一个临时服务，并在测试结束后收掉。 */
export async function serve(t, options = {}) {
  const started = await startHttpServer({ port: 0, host: "127.0.0.1", ...options });
  t.after(() => new Promise((done) => started.server.close(done)));
  return started;
}
