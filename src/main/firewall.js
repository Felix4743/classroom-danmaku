/**
 * 「学生连不上」的自检（技术方案 §4.10、§10 风险表）。
 *
 * ## 为什么需要这个文件
 *
 * 现场真实故障：老师扫了二维码、手机打开了链接，然后**一直转圈**。
 * 查下来二维码本身是对的（截屏回解，解出的就是 `http://10.109.12.63:3000/m`），
 * 问题在 Windows 防火墙根本没放行我们。
 *
 * 而这里有一个**便携版特有的陷阱**，是这次事故的元凶：
 * electron-builder 的 portable 目标默认每次启动都解压到一个**新的随机临时目录**
 * （`%TEMP%\<随机>\课堂弹幕.exe`）。Windows 防火墙的入站规则是**按程序路径**
 * 放行的，所以老师第一次点「允许访问」建出来的那条规则，**下一次启动就指向一个
 * 已经不存在的路径**，从此再也匹配不上。现场那台机器上就躺着 5 条这样的死规则。
 *
 * 两手都要抓：
 *   1. `package.json` 里给 portable 目标钉死 `unpackDirName`，让路径**稳定下来**
 *      —— 这是根治，规则建一次就能一直用；
 *   2. 这个文件在启动时**自检**：当前网络配置文件下，到底有没有一条放行我们的
 *      入站规则。没有就说出来，并且提供一个一键放行的入口。
 *
 * ## 为什么用 PowerShell 而不是 netsh
 *
 * 试过了：`netsh advfirewall firewall show rule name=all dir=in` **不打印程序路径**，
 * 按路径匹配根本无从谈起；而 `Get-NetFirewallRule | Get-NetFirewallApplicationFilter`
 * 拿得到精确的 `Program`。读防火墙**不需要管理员权限**（实测非提权可读），
 * 只有"加规则"才需要提权。
 *
 * 全部解析逻辑都是纯函数，真实的外部调用只集中在 `checkFirewall()` 一个地方。
 */

import { execFile } from "node:child_process";

/** 我们自己建的那条规则的名字。用它来认领，不靠猜。 */
export const RULE_NAME = "课堂弹幕（学生连接）";

/** Windows 防火墙的三个配置文件。`Any` 会展开成这三个。 */
export const ALL_PROFILES = ["Domain", "Private", "Public"];

/** `Get-NetConnectionProfile` 对域网络报的是这个名字，防火墙那边叫 `Domain`。 */
export const DOMAIN_CATEGORY = "DomainAuthenticated";

/** 查一次要一两秒，给足余量，但绝不能把启动卡住 —— 调用方是异步的。 */
export const QUERY_TIMEOUT_MS = 15000;

/**
 * 一次问清三件事：当前网络属于哪个配置文件、这个配置文件下防火墙开没开、
 * 以及所有启用的入站放行规则。前三行是元信息，规则按 `\t` 分隔，
 * 避免被规则名里的空格或冒号带偏。
 *
 * ## 性能：为什么程序名要批量取
 *
 * 最初写的是逐条 `$_ | Get-NetFirewallApplicationFilter`。那是**能写对但跑不动**的
 * 写法：单次 CIM 往返约 205ms，本机 516 条入站放行规则 → **外推 106 秒**，
 * 实测直接把自检跑到超时。改成先整表取一次再按 `InstanceID` 查表，同样的数据
 * **2.6 秒**拿完。
 *
 * 端口过滤器同理（`Get-NetFirewallPortFilter` 一次 0.9 秒）。它有个已知的坑：
 * 一部分规则属于别的包/应用商店，非提权读会报 `Access is denied`，所以这里
 * **允许它取不全** —— 缺了就是空值，空值按"不限端口"处理，宁可漏报也不误报。
 */
export const QUERY_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "$cat=(Get-NetConnectionProfile | Select-Object -First 1).NetworkCategory",
  // 这里**不能**写 `if(-not $cat)`：`NetworkCategory` 是枚举，`Public` 的枚举值是 0，
  // 而 `-not 0` 为真 —— 于是"Public 网络"会被自己改写成 `Unknown`，自检从此永远
  // 不报警。这个坑在 PowerShell 侧和 Node 侧的表现还不一样（交互式 shell 里正常），
  // 是靠 %TEMP% 里的直接对比脚本才揪出来的。只认 null。
  "if($null -eq $cat){$cat='Unknown'}",
  "$name=if($cat -eq 'DomainAuthenticated'){'Domain'}else{$cat}",
  "$prof=Get-NetFirewallProfile | Where-Object { $_.Name -eq $name } | Select-Object -First 1",
  "'PROFILE='+$cat",
  "'ENABLED='+$prof.Enabled",
  "$apps=@{}; Get-NetFirewallApplicationFilter | ForEach-Object { $apps[$_.InstanceID]=$_.Program }",
  "$ports=@{}; Get-NetFirewallPortFilter | ForEach-Object { $ports[$_.InstanceID]=$_ }",
  "Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True | ForEach-Object { $p=$ports[$_.InstanceID]; ($_.DisplayName)+[char]9+($_.Profile)+[char]9+$apps[$_.InstanceID]+[char]9+$p.Protocol+[char]9+$p.LocalPort }",
].join("; ");

export const QUERY_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  QUERY_SCRIPT,
];

/**
 * 真正去跑 PowerShell。
 *
 * `encoding: "utf8"` 必须显式给：脚本开头把控制台输出编码设成了 UTF-8，
 * 默认按系统 ANSI 解会把中文规则名解成乱码。
 *
 * `maxBuffer` 要给大：本机 516 条规则、每条一行，加起来几十 KB，
 * 默认的 1MB 够用，但换一台规则更多的机器就不一定了。
 */
function defaultExec(command, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout ?? "")),
    );
  });
}

/**
 * `Profiles` 那一列可能是 `Public`、`Domain, Private`、`Any`。
 * 返回小写化之前的原始名字数组；`Any` / `All` 展开成三个。
 */
export function parseProfileList(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.some((part) => /^(any|all)$/i.test(part))) return [...ALL_PROFILES];
  return parts;
}

/** 规则里的协议：PowerShell 可能给名字（`TCP`）也可能给号（`6`）。 */
export function protocolIsTcp(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return true; // 没写协议 = 不限制
  if (/^(tcp|6)$/i.test(raw)) return true;
  if (/^(any|all|256)$/i.test(raw)) return true;
  return false;
}

/**
 * 规则覆盖的本地端口是否包含我们要用的那个。
 *
 * `Any` 当然算；具体端口要真的相等 —— 老师电脑上 3000 被占用时服务会
 * 递增到 3001（§7.4），所以**不能**用"3000 被放行了"推断"3001 也被放行"。
 * 逗号分隔的列表与 `a-b` 区间都要认。
 */
export function portMatches(localPort, port) {
  const raw = String(localPort ?? "").trim();
  if (!raw) return true;
  if (/^(any|\*)$/i.test(raw)) return true;
  const want = Number(port);
  if (!Number.isFinite(want)) return true;
  return raw
    .split(",")
    .map((part) => part.trim())
    .some((part) => {
      if (/^\d+$/.test(part)) return Number(part) === want;
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) return want >= Number(range[1]) && want <= Number(range[2]);
      return false;
    });
}

/** 程序路径比对：Windows 路径不分大小写，分隔符两种写法都可能出现。 */
export function programMatches(program, exePath) {
  const rule = String(program ?? "").trim();
  if (!rule) return true; // 规则不限程序
  if (!exePath) return false;
  const norm = (value) => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(rule) === norm(String(exePath));
}

/**
 * 这一条规则能不能替我们挡住"学生连不进来"。
 *
 * 注意 `profile`：老师在家里是 `Private`、在教室是 `Public`，
 * 一条只对 `Public` 生效的规则换个网络就不作数了。
 */
export function ruleCovers(rule, options = {}) {
  const { exePath, port, profile } = options;
  if (!rule) return false;
  if (!protocolIsTcp(rule.protocol)) return false;
  const profiles = parseProfileList(rule.profiles);
  if (profile && profiles.length > 0 && !profiles.some((name) => name.toLowerCase() === String(profile).toLowerCase())) {
    return false;
  }
  if (!portMatches(rule.localPort, port)) return false;
  return programMatches(rule.program, exePath);
}

/**
 * 把 PowerShell 的输出拆成 `{ profile, enabled, rules }`。
 * 认不出来的行一律丢掉 —— 自检失败最多是不提示，绝不能反过来吓唬老师。
 */
export function parseFirewallReport(text) {
  const report = { profile: "Unknown", enabled: null, rules: [] };
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("PROFILE=")) {
      report.profile = trimmed.slice("PROFILE=".length).trim() || "Unknown";
      continue;
    }
    if (trimmed.startsWith("ENABLED=")) {
      const value = trimmed.slice("ENABLED=".length).trim();
      if (/^true$/i.test(value)) report.enabled = true;
      else if (/^false$/i.test(value)) report.enabled = false;
      continue;
    }
    const cells = line.split("\t");
    if (cells.length < 5) continue;
    const [name, profiles, program, protocol, localPort] = cells;
    report.rules.push({
      name: name.trim(),
      profiles: profiles.trim(),
      program: program.trim(),
      protocol: protocol.trim(),
      localPort: localPort.trim(),
    });
  }
  return report;
}

/** 附在人话后面的一句"怎么办"。 */
export const FIREWALL_HINT = "点托盘里的「放行防火墙」，或者手动跑一次 netsh advfirewall firewall add rule。";

/**
 * 结论。`ok === false` 时 `reason` 是给老师看的一句话，
 * `unknown === true` 表示"没查出来"，这种情况**不准报警**。
 */
export function judgeFirewall(options = {}) {
  const { report, exePath, port } = options;
  if (!report) return { ok: true, unknown: true, reason: "没查到防火墙状态" };
  if (report.enabled === false) {
    return { ok: true, unknown: false, reason: "防火墙当前是关的，入站不受限制" };
  }
  if (report.profile === "Unknown" && report.enabled === null) {
    return { ok: true, unknown: true, reason: "没查到防火墙状态" };
  }
  const covering = report.rules.find((rule) => ruleCovers(rule, { exePath, port, profile: report.profile }));
  if (covering) {
    return { ok: true, unknown: false, reason: `防火墙已放行（规则「${covering.name}」）`, rule: covering };
  }
  return {
    ok: false,
    unknown: false,
    reason:
      report.profile === "Unknown"
        ? "没查到放行本程序的入站规则，学生可能连不上"
        : `防火墙没有放行本程序（当前网络配置：${report.profile}），学生连不上`,
    hint: FIREWALL_HINT,
  };
}

/**
 * 建规则用的 netsh 参数。
 *
 * `localport=any` 是刻意的：老师电脑上 3000 被占用时服务会递增到 3001（§7.4），
 * 把端口写死反而会让规则在递增那天失效。改成按**程序**放行 —— 这正是
 * Windows 自己弹那个"允许访问"对话框时会建的规则。
 */
export function allowRuleArgs(options = {}) {
  const { exePath, port, name = RULE_NAME } = options;
  const args = [
    "advfirewall",
    "firewall",
    "add",
    "rule",
    `name=${name}`,
    "dir=in",
    "action=allow",
    "protocol=TCP",
    "localport=any",
    "profile=any",
  ];
  if (exePath) args.push(`program=${exePath}`);
  else if (port) args.push(`localport=${port}`);
  return args;
}

/** 把参数拼成一行，塞进提权进程的命令行。带空格的项要加引号。 */
export function quoteArgs(args) {
  return args.map((arg) => (/[\s"]/.test(arg) ? `"${String(arg).replace(/"/g, '\\"')}"` : String(arg))).join(" ");
}

/**
 * 提权执行一条 netsh 命令。会弹 UAC，所以只在老师**主动点**的时候调，
 * 绝不在启动时自作主张。
 */
export function elevateArgs(args) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Start-Process -FilePath netsh -ArgumentList '${quoteArgs(args).replace(/'/g, "''")}' -Verb RunAs -Wait`,
  ];
}

/**
 * 查一次。**永远不抛** —— 自检失败只是少一条提示，
 * 绝不能让"学生能不能连上"这件事反过来把程序搞崩。
 *
 * `exec` 是唯一的接缝（测试从这里喂假数据），默认走真正的 PowerShell。
 */
export async function checkFirewall(options = {}) {
  const { exePath, port, exec = defaultExec, timeoutMs = QUERY_TIMEOUT_MS } = options;
  if (typeof exec !== "function") return { ok: true, unknown: true, reason: "没有执行器，跳过防火墙自检" };
  try {
    const text = await exec("powershell", QUERY_ARGS, { timeoutMs });
    const report = parseFirewallReport(text);
    return { ...judgeFirewall({ report, exePath, port }), report };
  } catch (error) {
    return { ok: true, unknown: true, reason: `防火墙自检没跑成：${error?.message ?? error}` };
  }
}
