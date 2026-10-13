/**
 * 公网隧道（技术方案 §4.12）：把本机的课堂服务通过花生壳暴露到公网，让不在
 * 同一个 Wi-Fi 的学生也能扫码进来。
 *
 * 为什么要有这一层：本产品的前提是"学生和老师连同一个局域网"。热点方案能
 * 解决大部分教室，但一旦教室网络禁止客户端互访（很多学校的 AP 开了隔离），
 * 局域网这条路就是死的。走公网绕开这个限制，代价是要有一个花生壳账号。
 *
 * 这一层只做四件事：找到二进制、跑一次 `auth status`、把 `tunnel` 拉起来并
 * 从它的输出里认出公网地址、以及把进程干净地收掉。所有解析函数都是纯函数，
 * 因为这里最容易出错的地方就是"二进制的输出格式"，而那种 bug 只能靠喂真实
 * 输出喂出来。
 */

import { spawn as nodeSpawn } from "node:child_process";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 内置的 hsk-cli 版本。升级二进制时只改这里。 */
export const HSK_VERSION = "0.7.26";

/** 隧道进程从启动到给出公网地址的等待上限。实测约 16 秒，给三倍余量。 */
export const READY_TIMEOUT_MS = 45000;

/** `auth status` 这种一次性子命令的超时。它只读本地文件，正常是毫秒级。 */
export const STATUS_TIMEOUT_MS = 10000;

/** 授权链接的有效期，同时也是回调监听器的存活时间。 */
export const LOGIN_TIMEOUT_SECONDS = 900;

/** 隧道状态机。老师端页面按这几个值决定显示什么。 */
export const TUNNEL_STATE = Object.freeze({
  OFF: "off",
  STARTING: "starting",
  ON: "on",
  ERROR: "error",
  NO_ACCOUNT: "no_account",
});

/** 二进制文件名。Windows 是唯一在发的平台，其余按同一命名规则拼出来备用。 */
export function binaryFileName(options = {}) {
  const { platform = process.platform, arch = process.arch } = options;
  if (platform === "win32") return `hsk-cli-windows-amd64-v${HSK_VERSION}.exe`;
  const os = platform === "darwin" ? "darwin" : "linux";
  const cpu = arch === "arm64" ? "arm64" : "amd64";
  return `hsk-cli-${os}-${cpu}-v${HSK_VERSION}`;
}

/**
 * 按优先级列出可能的二进制位置，先内置、后用户自己装过的。
 *
 * 顺序有讲究：安装包里带的那份是我们测过的版本，用户机器上 `~/.hsk/bin`
 * 里那份可能是别的版本（甚至是被 npm wrapper 装了一半的），所以内置优先。
 */
export function binaryCandidates(options = {}) {
  const {
    platform = process.platform,
    arch = process.arch,
    resourcesPath,
    appPath,
    homeDir = homedir(),
    env = process.env,
  } = options;

  const name = binaryFileName({ platform, arch });
  const list = [];
  if (env.HSK_CLI) list.push(env.HSK_CLI);
  if (resourcesPath) list.push(join(resourcesPath, "hsk", name));
  if (appPath) list.push(join(appPath, "vendor", "hsk", name));
  list.push(join(homeDir, ".hsk", "bin", name));
  return list;
}

/** 找到第一个真实存在的二进制，找不到返回 null（老师端据此提示"重装"）。 */
export function findBinary(options = {}) {
  const { exists = existsSync } = options;
  for (const candidate of binaryCandidates(options)) {
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}

/**
 * 子进程环境。
 *
 * 必须显式设 HOME/USERPROFILE：实测在 HOME 为空的环境里，hsk-cli 会把资源
 * 登记表写到**当前工作目录**，于是项目根目录里冒出 `.hsk/resources.json`，
 * 里面还带着账号的 public_url 和 pid。打包后 cwd 可能是安装目录，更不能这样。
 */
export function hskEnv(base = process.env, homeDir = homedir()) {
  return { ...base, HOME: homeDir, USERPROFILE: homeDir, NO_COLOR: "1" };
}

/**
 * 从一段输出里挑出那个 JSON 对象。
 *
 * 二进制在 `--format json` 下打的是**单行 JSON**，但它前后还会夹 `[AI_INFO]`
 * 之类的日志行（走 stderr），失败时也可能先打一段人话。所以先试整段，再逐行试。
 */
export function parseHskJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) {
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object") return value;
    } catch {
      // 整段不是 JSON，往下逐行找
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object") return value;
    } catch {
      // 这行不是 JSON，继续
    }
  }
  return null;
}

/** 从非 JSON 输出里捞 `[AI_RESULT] key: value` 或 `key: value` 形式的一行。 */
function pickField(text, key) {
  if (typeof text !== "string") return null;
  const patterns = [
    new RegExp(`^\\[AI_RESULT\\]\\s*${key}\\s*:\\s*(.+)$`, "mi"),
    new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "mi"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, "");
      if (value !== "") return value;
    }
  }
  return null;
}

/** 公网地址统一成不带尾斜杠的 https 串。 */
function normalizeUrl(url) {
  const trimmed = String(url).trim().replace(/\/+$/, "");
  if (trimmed.startsWith("http://")) return `https://${trimmed.slice("http://".length)}`;
  return trimmed;
}

/**
 * 解析 `tunnel` 的输出。返回 null 表示"还没起来"——调用方靠这个判断要不要继续等。
 *
 * JSON 和人类可读两种格式都认，因为这两个格式我们都可能撞上（`--format` 被
 * 环境或参数顺序影响时就会退化）。
 */
export function parseTunnelInfo(text) {
  const json = parseHskJson(text);
  const data = json && typeof json.data === "object" && json.data !== null ? json.data : json;

  const rawUrl = data?.public_url ?? data?.publicUrl ?? pickField(text, "public_url");
  if (typeof rawUrl !== "string" || rawUrl === "") return null;

  return {
    publicUrl: normalizeUrl(rawUrl),
    resourceId: data?.resource_id ?? pickField(text, "resource_id"),
    expiresAt: data?.expires_at ?? pickField(text, "expires_at"),
    target: data?.target ?? pickField(text, "target"),
    claimed: typeof data?.claimed === "boolean" ? data.claimed : null,
    claimVia: data?.claim_via ?? null,
    verifyCode: data?.verify_code ?? null,
  };
}

/** 解析 `auth status --format json`。 */
export function parseAuthStatus(text) {
  const json = parseHskJson(text);
  const data = json && typeof json.data === "object" && json.data !== null ? json.data : json;
  if (!data || typeof data !== "object") return null;
  if (typeof data.authenticated !== "boolean" && typeof data.status !== "string") return null;

  const authenticated = data.authenticated === true || data.status === "authenticated";
  return {
    authenticated,
    status: typeof data.status === "string" ? data.status : authenticated ? "authenticated" : "none",
    accountId: data.account_id ?? null,
    expiresAt: data.expires_at ?? null,
  };
}

/** 解析 `auth login -no-wait` 给的授权链接。 */
export function parseAuthorizeUrl(text) {
  const json = parseHskJson(text);
  const data = json && typeof json.data === "object" && json.data !== null ? json.data : json;
  const direct = data?.authorize_url ?? data?.authorizeUrl;
  if (typeof direct === "string" && direct.startsWith("http")) return direct;
  const match = /https:\/\/[^\s"'<>]*oauth\/authorize[^\s"'<>]*/.exec(text ?? "");
  return match ? match[0] : null;
}

/**
 * 结束一个子进程**及其子进程树**。
 *
 * Windows 上用 taskkill /T：实测隧道会另外挂住一条到中转服务器的连接，
 * 只 kill 顶层 pid 有时会把映射留在服务端，下一次启动就撞"资源已存在"。
 */
export function killProcessTree(child, options = {}) {
  const { platform = process.platform, spawn = nodeSpawn, logger = console } = options;
  if (!child || child.pid === undefined || child.pid === null) return null;

  if (platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on?.("error", (err) => logger.error?.("[tunnel] taskkill 失败", err));
      return killer;
    } catch (err) {
      logger.error?.("[tunnel] 起不了 taskkill，直接 kill", err);
    }
  }

  try {
    child.kill?.("SIGTERM");
  } catch {
    // 进程已经没了，这正是我们想要的结果
  }
  return null;
}

/**
 * 跑一个会自己结束的子命令并把输出收全。
 *
 * 永远 resolve、不 reject：调用方要做的是"拿到输出后判断"，把失败也当成一种
 * 可判断的结果，比到处 try/catch 干净。
 */
export function runOnce(spawn, bin, args, options = {}) {
  const { env, timeoutMs = STATUS_TIMEOUT_MS, platform = process.platform, logger = console } = options;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, code: null, stdout: "", stderr: String(err?.message ?? err) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    };

    const timer = setTimeout(() => {
      if (done) return;
      killProcessTree(child, { platform, spawn, logger });
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", (buf) => {
      stdout += buf.toString("utf8");
    });
    child.stderr?.on("data", (buf) => {
      stderr += buf.toString("utf8");
    });
    child.on?.("error", (err) => {
      stderr += String(err?.message ?? err);
      finish(null);
    });
    child.on?.("exit", (code) => finish(code));
    child.on?.("close", (code) => finish(code));
  });
}

/** 输出只留最后几行给老师看，整段日志塞进界面只会让人更困惑。 */
function tail(text, lines = 8) {
  const kept = String(text ?? "")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-lines);
  return kept.join(" / ");
}

/**
 * 建一个隧道管理器。
 *
 * 它是有状态的（进程 + 状态机），但只有四个动作：`start`、`stop`、
 * `checkAccount`、`beginLogin`。`getPort` 传函数而不是数字，理由和
 * `server/info.js` 里一样：3000 被占用时会递增，端口必须现问。
 */
export function createTunnelManager(options = {}) {
  const {
    getPort,
    homeDir = homedir(),
    env = process.env,
    binary,
    spawn = nodeSpawn,
    logger = console,
    platform = process.platform,
    arch = process.arch,
    resourcesPath,
    appPath,
    exists = existsSync,
    readyTimeoutMs = READY_TIMEOUT_MS,
    statusTimeoutMs = STATUS_TIMEOUT_MS,
    loginTimeoutSeconds = LOGIN_TIMEOUT_SECONDS,
    onChange,
  } = options;

  if (typeof getPort !== "function") {
    throw new TypeError("createTunnelManager 需要 getPort()，端口要现问（可能被递增过）");
  }

  const state = {
    state: TUNNEL_STATE.OFF,
    publicUrl: null,
    expiresAt: null,
    resourceId: null,
    message: null,
    since: null,
  };

  let child = null;
  let cachedBinary;

  function resolveBinary() {
    if (binary) return binary;
    if (cachedBinary && exists(cachedBinary)) return cachedBinary;
    cachedBinary = findBinary({ platform, arch, resourcesPath, appPath, homeDir, env, exists });
    return cachedBinary;
  }

  function snapshot() {
    return { ...state };
  }

  function update(patch) {
    Object.assign(state, patch);
    try {
      onChange?.(snapshot());
    } catch (err) {
      logger.error?.("[tunnel] onChange 回调出错", err);
    }
    return snapshot();
  }

  function reset(patch = {}) {
    return update({
      state: TUNNEL_STATE.OFF,
      publicUrl: null,
      expiresAt: null,
      resourceId: null,
      message: null,
      since: null,
      ...patch,
    });
  }

  /** 把子进程彻底收掉，并把状态推回 off。重复调用是安全的。 */
  async function stop() {
    const running = child;
    child = null;
    if (running) killProcessTree(running, { platform, spawn, logger });
    return reset();
  }

  /**
   * 起隧道。
   *
   * 这个函数**不等公网地址就返回**：等它要 45 秒，而老师端页面本来就在轮询
   * `/api/info`，让状态从 `starting` 自己变成 `on` 比让一个 HTTP 请求挂 45 秒
   * 好得多（中途刷新页面也不会看到"一直转圈"）。
   */
  async function start() {
    if (child && child.exitCode === null) return snapshot();
    if (state.state === TUNNEL_STATE.STARTING) return snapshot();

    const bin = resolveBinary();
    if (!bin) {
      return update({
        state: TUNNEL_STATE.ERROR,
        message: "找不到内置的穿透程序，请重新安装本程序",
      });
    }

    const account = await checkAccount();
    if (!account.authenticated) {
      return update({
        state: TUNNEL_STATE.NO_ACCOUNT,
        message: account.reason === "no_binary" ? "找不到内置的穿透程序" : "还没绑定花生壳账号，绑定后才能开公网地址",
      });
    }

    const args = ["--format", "json", "tunnel", "-ip", "127.0.0.1", "-port", String(getPort())];
    let started;
    try {
      started = spawn(bin, args, {
        env: hskEnv(env, homeDir),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return update({ state: TUNNEL_STATE.ERROR, message: `起不了穿透程序：${err?.message ?? err}` });
    }

    child = started;
    update({ state: TUNNEL_STATE.STARTING, publicUrl: null, expiresAt: null, resourceId: null, message: null, since: Date.now() });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(started, { platform, spawn, logger });
      if (child === started) child = null;
      update({
        state: TUNNEL_STATE.ERROR,
        // 向上取整：对老师说的"等了多久"只能多说不能少说
        message: `穿透程序 ${Math.ceil(readyTimeoutMs / 1000)} 秒内没给出公网地址`,
      });
    }, readyTimeoutMs);

    // 结果行走 stdout，日志走 stderr。两个都留着：既做诊断，也在 stdout 被
    // 别的东西污染时留一条退路（先认 stdout，认不出再认 stderr）
    const onChunk = () => {
      if (settled) return;
      const info = parseTunnelInfo(stdout) ?? parseTunnelInfo(stderr);
      if (!info?.publicUrl) return;
      settled = true;
      clearTimeout(timer);
      update({
        state: TUNNEL_STATE.ON,
        publicUrl: info.publicUrl,
        expiresAt: info.expiresAt,
        resourceId: info.resourceId,
        message: null,
        since: Date.now(),
      });
      logger.info?.(`[tunnel] 公网地址已就绪：${info.publicUrl}`);
    };

    started.stdout?.on("data", (buf) => {
      stdout += buf.toString("utf8");
      onChunk();
    });
    started.stderr?.on("data", (buf) => {
      stderr += buf.toString("utf8");
      onChunk();
    });

    started.on?.("error", (err) => {
      clearTimeout(timer);
      if (child === started) child = null;
      if (settled) return;
      settled = true;
      update({ state: TUNNEL_STATE.ERROR, message: `穿透程序启动失败：${err?.message ?? err}` });
    });

    started.on?.("exit", (code) => {
      clearTimeout(timer);
      if (child === started) child = null;
      if (settled) {
        // 跑起来之后才死的——通常是网络断了或者服务端把资源回收了
        if (state.state === TUNNEL_STATE.ON) {
          reset({ message: "公网地址已断开，需要的话重新开一次" });
        }
        return;
      }
      settled = true;
      update({
        state: TUNNEL_STATE.ERROR,
        message: tail(stderr || stdout) || `穿透程序退出了（代码 ${code}）`,
      });
    });

    return snapshot();
  }

  /** 问一次账号状态。这是所有"要不要先弹授权"的分支依据。 */
  async function checkAccount() {
    const bin = resolveBinary();
    if (!bin) return { authenticated: false, reason: "no_binary" };
    const result = await runOnce(spawn, bin, ["--format", "json", "auth", "status"], {
      env: hskEnv(env, homeDir),
      timeoutMs: statusTimeoutMs,
      platform,
      logger,
    });
    const status = parseAuthStatus(result.stdout || result.stderr);
    if (!status) {
      return { authenticated: false, reason: "unreadable", raw: tail(result.stdout || result.stderr) };
    }
    return { ...status, reason: status.authenticated ? "ok" : "not_logged_in" };
  }

  /**
   * 起一次授权流程，把要老师在浏览器里打开的链接给出来。
   *
   * 这里有一次备份/还原。实测 `auth login` **一启动就会把 `~/.hsk/auth.json`
   * 改写成 `status:"pending_callback"`**，哪怕这次登录最后没走完，原来那份好
   * 好的凭据也已经被冲掉了。所以：拿到链接说明流程真的在跑，保留；没拿到链接
   * 说明什么都没发生，立刻把备份还原回去。
   */
  async function beginLogin() {
    const bin = resolveBinary();
    if (!bin) return { ok: false, error: "no_binary", message: "找不到内置的穿透程序" };

    const authPath = join(homeDir, ".hsk", "auth.json");
    const backupPath = `${authPath}.dshbak`;
    let backedUp = false;
    try {
      if (exists(authPath)) {
        copyFileSync(authPath, backupPath);
        backedUp = true;
      }
    } catch (err) {
      logger.error?.("[tunnel] 备份凭据失败，仍继续", err);
    }

    const result = await runOnce(
      spawn,
      bin,
      ["--format", "json", "auth", "login", "-method", "loopback", "-no-wait", "-timeout", String(loginTimeoutSeconds)],
      { env: hskEnv(env, homeDir), timeoutMs: 20000, platform, logger },
    );

    const authorizeUrl = parseAuthorizeUrl(result.stdout || result.stderr);
    if (!authorizeUrl) {
      if (backedUp) {
        try {
          copyFileSync(backupPath, authPath);
          unlinkSync(backupPath);
        } catch (err) {
          logger.error?.("[tunnel] 还原凭据失败", err);
        }
      }
      return {
        ok: false,
        error: "no_authorize_url",
        message: tail(result.stdout || result.stderr) || "授权流程没起来，请重试",
      };
    }

    return { ok: true, authorizeUrl, timeoutSeconds: loginTimeoutSeconds };
  }

  return {
    getState: snapshot,
    start,
    stop,
    checkAccount,
    beginLogin,
    resolveBinary,
  };
}
