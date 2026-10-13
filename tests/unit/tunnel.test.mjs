/**
 * 公网隧道（技术方案 §4.11 的"一键开公网"）。
 *
 * 这一层最容易坏的地方不是逻辑而是**解析**：所有信息都来自那个 Go 二进制
 * 打出来的字符串，格式一变（`--format` 被忽略、日志跑到 stdout、失败时打
 * 人话）解析就静默返回 null，现场表现是"按钮点了没反应"。所以这里的用例
 * 全部喂**实测抓到的真实输出**，一个字段一个字段钉住。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HSK_VERSION,
  TUNNEL_STATE,
  binaryCandidates,
  binaryFileName,
  createTunnelManager,
  findBinary,
  hskEnv,
  killProcessTree,
  parseAuthStatus,
  parseAuthorizeUrl,
  parseHskJson,
  parseTunnelInfo,
} from "../../src/main/tunnel.js";

/** 实测抓到的成功输出（`hsk.exe --format json tunnel -ip 127.0.0.1 -port 3000`）。 */
const TUNNEL_JSON =
  '{"success":true,"code":0,"message":"mapping established","data":{"claim_via":"auth","claimed":true,' +
  '"expires_at":"2026-10-14T09:59:40+08:00","public_url":"https://5db4e2ac62dc.hz-1.aicp.space",' +
  '"resource_id":"1791856780097301531","target":"127.0.0.1:3000","verify_code":""},"guide":"..."}';

/** 同一次启动、非 JSON 格式下的样子（`[AI_INFO]` 走 stderr）。 */
const TUNNEL_PRETTY = [
  "[AI_INFO] starting tunnel",
  "[AI_RESULT] public_url:     https://5013e90bb28f.hz-1.aicp.space",
  "[AI_RESULT] resource_id:    1791856780097301531",
  "[AI_RESULT] target:         127.0.0.1:3000",
  "[AI_IMPORTANT] This process MUST keep running...",
].join("\n");

const AUTH_STATUS_JSON =
  '{"authenticated":true,"status":"authenticated","account_id":"10550217544316677916",' +
  '"expires_at":"2026-10-13T03:59:05Z","environment":{"desktop":"yes"}}';

const LOGIN_JSON =
  '{"success":true,"code":0,"message":"auth login started in background","data":{"authorize_url":' +
  '"https://console-hsk-ng.oray.com/oauth/authorize?client_id=abc&code_challenge=xyz","method":"loopback",' +
  '"no_wait":true,"session_id":"s1","status":"pending_callback"}}';

const silent = { info() {}, error() {} };

/** 一个够像 ChildProcess 的替身：有 pid / stdout / stderr / on / kill。 */
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0);
  };
  return child;
}

/** 按命令分派的 spawn 替身。`plan(child, args)` 决定这个子进程会打什么、何时退。 */
function fakeSpawn(plan) {
  const calls = [];
  const fn = (bin, args, opts) => {
    const child = fakeChild(100 + calls.length);
    calls.push({ bin, args, opts, child });
    // 让调用方先把监听器挂上，再喂输出
    setImmediate(() => plan(child, args, calls.length));
    return child;
  };
  fn.calls = calls;
  return fn;
}

/** 等某个条件成立，用来等状态机自己走完。 */
async function until(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), "dsh-tunnel-"));
}

test("二进制定位", async (t) => {
  await t.test("Windows 上的文件名带版本号，换版本只改 HSK_VERSION", () => {
    assert.equal(binaryFileName({ platform: "win32" }), `hsk-cli-windows-amd64-v${HSK_VERSION}.exe`);
  });

  await t.test("候选顺序：环境变量 → 安装包内置 → 开发态 vendor → 用户自己装的", () => {
    const list = binaryCandidates({
      platform: "win32",
      resourcesPath: "C:\\app\\resources",
      appPath: "D:\\src\\课堂弹幕",
      homeDir: "C:\\Users\\t",
      env: { HSK_CLI: "D:\\tools\\hsk.exe" },
    });
    assert.deepEqual(list, [
      "D:\\tools\\hsk.exe",
      join("C:\\app\\resources", "hsk", `hsk-cli-windows-amd64-v${HSK_VERSION}.exe`),
      join("D:\\src\\课堂弹幕", "vendor", "hsk", `hsk-cli-windows-amd64-v${HSK_VERSION}.exe`),
      join("C:\\Users\\t", ".hsk", "bin", `hsk-cli-windows-amd64-v${HSK_VERSION}.exe`),
    ]);
  });

  await t.test("findBinary 取第一个真实存在的", () => {
    const target = join("C:\\app\\resources", "hsk", `hsk-cli-windows-amd64-v${HSK_VERSION}.exe`);
    const found = findBinary({
      platform: "win32",
      resourcesPath: "C:\\app\\resources",
      homeDir: "C:\\Users\\t",
      env: {},
      exists: (p) => p === target,
    });
    assert.equal(found, target);
  });

  await t.test("一个都没有时返回 null，而不是抛", () => {
    assert.equal(findBinary({ platform: "win32", env: {}, exists: () => false }), null);
  });

  await t.test("hskEnv 覆盖 HOME 和 USERPROFILE —— 否则资源表会落到 cwd", () => {
    const env = hskEnv({ PATH: "x", HOME: "" }, "C:\\Users\\t");
    assert.equal(env.HOME, "C:\\Users\\t");
    assert.equal(env.USERPROFILE, "C:\\Users\\t");
    assert.equal(env.PATH, "x");
    assert.equal(env.NO_COLOR, "1");
  });
});

test("解析二进制的输出", async (t) => {
  await t.test("整段就是一个 JSON 的时候直接吃", () => {
    assert.equal(parseHskJson(TUNNEL_JSON)?.code, 0);
  });

  await t.test("JSON 前后夹着日志行也能捞出来", () => {
    const mixed = `[AI_INFO] hi\n${TUNNEL_JSON}\n[AI_INFO] bye`;
    assert.equal(parseHskJson(mixed)?.data?.public_url, "https://5db4e2ac62dc.hz-1.aicp.space");
  });

  await t.test("全是人话就返回 null，不抛", () => {
    assert.equal(parseHskJson("[AI_WARN] 认领未完成"), null);
    assert.equal(parseHskJson(""), null);
    assert.equal(parseHskJson(undefined), null);
  });

  await t.test("tunnel 成功：公网地址、资源号、到期时间、认领方式都认出来", () => {
    const info = parseTunnelInfo(TUNNEL_JSON);
    assert.equal(info.publicUrl, "https://5db4e2ac62dc.hz-1.aicp.space");
    assert.equal(info.resourceId, "1791856780097301531");
    assert.equal(info.expiresAt, "2026-10-14T09:59:40+08:00");
    assert.equal(info.target, "127.0.0.1:3000");
    assert.equal(info.claimed, true);
    assert.equal(info.claimVia, "auth");
  });

  await t.test("tunnel 成功但打的是人类可读格式，一样认出来", () => {
    const info = parseTunnelInfo(TUNNEL_PRETTY);
    assert.equal(info.publicUrl, "https://5013e90bb28f.hz-1.aicp.space");
    assert.equal(info.resourceId, "1791856780097301531");
  });

  await t.test("还没起来的时候返回 null，调用方靠它继续等", () => {
    assert.equal(parseTunnelInfo("[AI_INFO] connecting to mux server"), null);
    assert.equal(parseTunnelInfo(""), null);
  });

  await t.test("http 一律升成 https，尾斜杠去掉 —— 学生页 URL 是拼出来的", () => {
    const info = parseTunnelInfo('{"data":{"public_url":"http://a.hz-1.aicp.space/"}}');
    assert.equal(info.publicUrl, "https://a.hz-1.aicp.space");
  });

  await t.test("auth status：已登录", () => {
    const status = parseAuthStatus(AUTH_STATUS_JSON);
    assert.equal(status.authenticated, true);
    assert.equal(status.accountId, "10550217544316677916");
    assert.equal(status.expiresAt, "2026-10-13T03:59:05Z");
  });

  await t.test("auth status：没登录（status 是 none 而不是 authenticated）", () => {
    const status = parseAuthStatus('{"authenticated":false,"status":"none","environment":{}}');
    assert.equal(status.authenticated, false);
    assert.equal(status.status, "none");
  });

  await t.test("auth status：读不懂就返回 null，由调用方当成没登录", () => {
    assert.equal(parseAuthStatus("command not found"), null);
  });

  await t.test("授权链接从 JSON 里取", () => {
    const url = parseAuthorizeUrl(LOGIN_JSON);
    assert.match(url, /^https:\/\/console-hsk-ng\.oray\.com\/oauth\/authorize\?/);
    assert.match(url, /code_challenge=xyz/);
  });

  await t.test("授权链接只出现在人话里也能取到", () => {
    const url = parseAuthorizeUrl("请打开 https://console-hsk-ng.oray.com/oauth/authorize?a=1 完成授权");
    assert.equal(url, "https://console-hsk-ng.oray.com/oauth/authorize?a=1");
  });
});

test("隧道管理器的状态机", async (t) => {
  await t.test("没绑账号时只走到 no_account，绝不拉起隧道进程", async () => {
    const spawn = fakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from('{"authenticated":false,"status":"none"}'));
      child.exitCode = 0;
      child.emit("exit", 0);
    });
    const manager = createTunnelManager({ getPort: () => 3000, binary: "hsk.exe", spawn, logger: silent });

    const state = await manager.start();
    assert.equal(state.state, TUNNEL_STATE.NO_ACCOUNT);
    assert.match(state.message, /花生壳账号/);
    // 只跑了一次 auth status，没有起 tunnel
    assert.equal(spawn.calls.length, 1);
    assert.deepEqual(spawn.calls[0].args, ["--format", "json", "auth", "status"]);
  });

  await t.test("已绑账号：先 starting，拿到公网地址后变 on，端口是现问的", async () => {
    let tunnelPort = null;
    const spawn = fakeSpawn((child, args) => {
      if (args.includes("auth")) {
        child.stdout.emit("data", Buffer.from(AUTH_STATUS_JSON));
        child.exitCode = 0;
        child.emit("exit", 0);
        return;
      }
      tunnelPort = args[args.indexOf("-port") + 1];
      child.stdout.emit("data", Buffer.from(TUNNEL_JSON));
      // 起好之后**不退出**，这正是真实行为
    });

    let port = 3000;
    const manager = createTunnelManager({ getPort: () => port, binary: "hsk.exe", spawn, logger: silent });
    port = 3210; // 端口被递增过了：管理器必须现问，不能用建对象时的值

    const first = await manager.start();
    assert.equal(first.state, TUNNEL_STATE.STARTING);
    assert.equal(first.publicUrl, null);

    assert.ok(await until(() => manager.getState().state === TUNNEL_STATE.ON));
    const state = manager.getState();
    assert.equal(state.publicUrl, "https://5db4e2ac62dc.hz-1.aicp.space");
    assert.equal(state.expiresAt, "2026-10-14T09:59:40+08:00");
    assert.equal(state.resourceId, "1791856780097301531");
    assert.equal(tunnelPort, "3210");
  });

  await t.test("start 不等地址就返回 —— HTTP 请求不能挂 45 秒", async () => {
    const spawn = fakeSpawn((child, args) => {
      if (args.includes("auth")) {
        child.stdout.emit("data", Buffer.from(AUTH_STATUS_JSON));
        child.emit("exit", 0);
        return;
      }
      // 隧道进程一直不说话
    });
    const manager = createTunnelManager({
      getPort: () => 3000,
      binary: "hsk.exe",
      spawn,
      logger: silent,
      readyTimeoutMs: 5000,
    });
    const started = Date.now();
    const state = await manager.start();
    assert.equal(state.state, TUNNEL_STATE.STARTING);
    assert.ok(Date.now() - started < 1000);
  });

  await t.test("反复点「开公网」不会起第二个进程", async () => {
    const spawn = fakeSpawn((child, args) => {
      if (args.includes("auth")) {
        child.stdout.emit("data", Buffer.from(AUTH_STATUS_JSON));
        child.emit("exit", 0);
        return;
      }
      child.stdout.emit("data", Buffer.from(TUNNEL_JSON));
    });
    const manager = createTunnelManager({ getPort: () => 3000, binary: "hsk.exe", spawn, logger: silent });

    await manager.start();
    await until(() => manager.getState().state === TUNNEL_STATE.ON);
    await manager.start();
    await manager.start();

    const tunnelCalls = spawn.calls.filter((c) => !c.args.includes("auth"));
    assert.equal(tunnelCalls.length, 1);
  });

  await t.test("跑起来之后进程死了 → 回到 off，并告诉老师要重开", async () => {
    const spawn = fakeSpawn((child, args) => {
      if (args.includes("auth")) {
        child.stdout.emit("data", Buffer.from(AUTH_STATUS_JSON));
        child.emit("exit", 0);
        return;
      }
      child.stdout.emit("data", Buffer.from(TUNNEL_JSON));
      setTimeout(() => {
        child.exitCode = 1;
        child.emit("exit", 1);
      }, 10);
    });
    const manager = createTunnelManager({ getPort: () => 3000, binary: "hsk.exe", spawn, logger: silent });

    await manager.start();
    assert.ok(await until(() => manager.getState().state === TUNNEL_STATE.ON));
    assert.ok(await until(() => manager.getState().state === TUNNEL_STATE.OFF));
    const state = manager.getState();
    assert.equal(state.publicUrl, null);
    assert.match(state.message, /断开/);
  });

  await t.test("起不来（进程直接报错退出）→ error 里带上二进制的原话", async () => {
    const spawn = fakeSpawn((child, args) => {
      if (args.includes("auth")) {
        child.stdout.emit("data", Buffer.from(AUTH_STATUS_JSON));
        child.emit("exit", 0);
        return;
      }
      child.stderr.emit("data", Buffer.from("[AI_ERROR] 资源创建失败：已达到并发上限\n"));
      child.exitCode = 1;
      child.emit("exit", 1);
    });
    const manager = createTunnelManager({ getPort: () => 3000, binary: "hsk.exe", spawn, logger: silent });

    await manager.start();
    assert.ok(await until(() => manager.getState().state === TUNNEL_STATE.ERROR));
    assert.match(manager.getState().message, /并发上限/);
  });

  await t.test("一直不给地址 → 超时报错，并把进程收掉", async () => {
    const spawn = fakeSpawn((child, args) => {
      if (args.includes("auth")) {
        child.stdout.emit("data", Buffer.from(AUTH_STATUS_JSON));
        child.emit("exit", 0);
        return;
      }
    });
    const manager = createTunnelManager({
      getPort: () => 3000,
      binary: "hsk.exe",
      spawn,
      logger: silent,
      readyTimeoutMs: 20,
    });

    await manager.start();
    assert.ok(await until(() => manager.getState().state === TUNNEL_STATE.ERROR));
    assert.match(manager.getState().message, /1 秒/);
    // taskkill 被叫过一次（用的是同一个注入的 spawn）
    assert.ok(spawn.calls.some((c) => c.bin === "taskkill"));
  });

  await t.test("stop 收掉进程并把状态推回 off", async () => {
    const spawn = fakeSpawn((child, args) => {
      if (args.includes("auth")) {
        child.stdout.emit("data", Buffer.from(AUTH_STATUS_JSON));
        child.emit("exit", 0);
        return;
      }
      child.stdout.emit("data", Buffer.from(TUNNEL_JSON));
    });
    const manager = createTunnelManager({ getPort: () => 3000, binary: "hsk.exe", spawn, logger: silent });

    await manager.start();
    assert.ok(await until(() => manager.getState().state === TUNNEL_STATE.ON));

    const state = await manager.stop();
    assert.equal(state.state, TUNNEL_STATE.OFF);
    assert.equal(state.publicUrl, null);
    assert.ok(spawn.calls.some((c) => c.bin === "taskkill"));
  });

  await t.test("没在跑的时候 stop 是安全的（老师可以连点）", async () => {
    const spawn = fakeSpawn(() => {});
    const manager = createTunnelManager({ getPort: () => 3000, binary: "hsk.exe", spawn, logger: silent });
    const state = await manager.stop();
    assert.equal(state.state, TUNNEL_STATE.OFF);
    assert.equal(spawn.calls.length, 0);
  });

  await t.test("找不到二进制 → error，别让按钮静默失败", async () => {
    const manager = createTunnelManager({ getPort: () => 3000, binary: null, spawn: fakeSpawn(() => {}), logger: silent, exists: () => false, env: {}, homeDir: "C:\\nope" });
    const state = await manager.start();
    assert.equal(state.state, TUNNEL_STATE.ERROR);
    assert.match(state.message, /重新安装/);
  });
});

test("授权流程", async (t) => {
  await t.test("beginLogin 给回授权链接，并带上回调等待时长", async () => {
    const spawn = fakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from(LOGIN_JSON));
      child.emit("exit", 0);
    });
    const manager = createTunnelManager({ getPort: () => 3000, binary: "hsk.exe", spawn, logger: silent });
    const result = await manager.beginLogin();
    assert.equal(result.ok, true);
    assert.match(result.authorizeUrl, /oauth\/authorize/);
    assert.deepEqual(spawn.calls[0].args, [
      "--format",
      "json",
      "auth",
      "login",
      "-method",
      "loopback",
      "-no-wait",
      "-timeout",
      "900",
    ]);
  });

  await t.test("没拿到链接就把凭据还原回去 —— auth login 会先把 auth.json 冲成 pending_callback", async () => {
    const home = tempHome();
    mkdirSync(join(home, ".hsk"), { recursive: true });
    const authPath = join(home, ".hsk", "auth.json");
    const good = '{"status":"authenticated","token":"keep-me"}';
    writeFileSync(authPath, good, "utf8");

    const spawn = fakeSpawn((child) => {
      // 模拟真实行为：先把文件改坏，然后这次登录失败
      writeFileSync(authPath, '{"status":"pending_callback"}', "utf8");
      child.stderr.emit("data", Buffer.from("[AI_ERROR] 授权流程没起来"));
      child.emit("exit", 1);
    });

    const manager = createTunnelManager({
      getPort: () => 3000,
      binary: "hsk.exe",
      spawn,
      logger: silent,
      homeDir: home,
    });
    const result = await manager.beginLogin();

    assert.equal(result.ok, false);
    assert.equal(result.error, "no_authorize_url");
    assert.equal(readFileSync(authPath, "utf8"), good);
  });

  await t.test("拿到链接就不还原 —— 这次登录可能正等着老师在浏览器里点", async () => {
    const home = tempHome();
    mkdirSync(join(home, ".hsk"), { recursive: true });
    const authPath = join(home, ".hsk", "auth.json");
    writeFileSync(authPath, '{"status":"authenticated","token":"old"}', "utf8");

    const spawn = fakeSpawn((child) => {
      writeFileSync(authPath, '{"status":"pending_callback"}', "utf8");
      child.stdout.emit("data", Buffer.from(LOGIN_JSON));
      child.emit("exit", 0);
    });

    const manager = createTunnelManager({
      getPort: () => 3000,
      binary: "hsk.exe",
      spawn,
      logger: silent,
      homeDir: home,
    });
    const result = await manager.beginLogin();
    assert.equal(result.ok, true);
    assert.equal(readFileSync(authPath, "utf8"), '{"status":"pending_callback"}');
  });
});

test("killProcessTree", async (t) => {
  await t.test("Windows 上用 taskkill /T /F 收整棵树", () => {
    const calls = [];
    const spawn = (bin, args) => {
      calls.push({ bin, args });
      return new EventEmitter();
    };
    const child = fakeChild(777);
    killProcessTree(child, { platform: "win32", spawn, logger: silent });
    assert.deepEqual(calls, [{ bin: "taskkill", args: ["/pid", "777", "/T", "/F"] }]);
  });

  await t.test("非 Windows 上退回 SIGTERM", () => {
    const child = fakeChild(777);
    let killed = null;
    child.kill = (signal) => {
      killed = signal;
    };
    killProcessTree(child, { platform: "linux", spawn: () => new EventEmitter(), logger: silent });
    assert.equal(killed, "SIGTERM");
  });

  await t.test("没有 pid 时什么都不做", () => {
    assert.equal(killProcessTree({ pid: null }, { platform: "win32", logger: silent }), null);
    assert.equal(killProcessTree(null, { platform: "win32", logger: silent }), null);
  });
});
