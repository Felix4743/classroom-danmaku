/**
 * 防火墙自检（`src/main/firewall.js`）。
 *
 * 这个文件的全部价值，是让「学生连不上」这件事**在老师看到二维码之前**就说出来。
 * 所以测试盯的是两件相反的事：
 *   - 真的没放行时，必须认出来（漏报 = 老师又一次对着一堆扫了打不开的二维码）；
 *   - 只是没查出来时，**不许**报警（误报 = 老师被吓一跳，然后学会无视提示）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_PROFILES,
  QUERY_ARGS,
  RULE_NAME,
  allowRuleArgs,
  checkFirewall,
  elevateArgs,
  judgeFirewall,
  parseFirewallReport,
  parseProfileList,
  portMatches,
  programMatches,
  protocolIsTcp,
  quoteArgs,
  ruleCovers,
} from "../../src/main/firewall.js";

/** 一次真实查询的形状：两行元信息 + 一堆 tab 分隔的规则。 */
const REPORT_TEXT = [
  "PROFILE=Public",
  "ENABLED=True",
  "远程桌面 - 用户模式(TCP-In)\tDomain, Private\t%SystemRoot%\\system32\\svchost.exe\tTCP\t3389",
  "课堂弹幕（学生连接）\tAny\tD:\\课堂弹幕\\课堂弹幕.exe\tTCP\tAny",
  "课堂弹幕.exe\tPublic\tC:\\Users\\35145\\AppData\\Local\\Temp\\3kaml9fkdtde4ppzoqpem9v0njn\\课堂弹幕.exe\tUDP\tAny",
  "课堂弹幕.exe\tPublic\tC:\\Users\\35145\\AppData\\Local\\Temp\\3kanmj7q9ytjz4lrshewczr19zj\\课堂弹幕.exe\tTCP\tAny",
  "",
].join("\r\n");

test("parseProfileList：单个、多个、以及 Any 展开", () => {
  assert.deepEqual(parseProfileList("Public"), ["Public"]);
  assert.deepEqual(parseProfileList("Domain, Private"), ["Domain", "Private"]);
  assert.deepEqual(parseProfileList("Any"), ALL_PROFILES);
  assert.deepEqual(parseProfileList(""), []);
});

test("protocolIsTcp：UDP 不算放行，TCP/6/Any/空都算", () => {
  assert.equal(protocolIsTcp("TCP"), true);
  assert.equal(protocolIsTcp("6"), true);
  assert.equal(protocolIsTcp("Any"), true);
  assert.equal(protocolIsTcp("256"), true);
  assert.equal(protocolIsTcp(""), true);
  // 现场那台机器上就有两条 UDP 规则指向死路径 —— 它们挡不住任何东西
  assert.equal(protocolIsTcp("UDP"), false);
  assert.equal(protocolIsTcp("17"), false);
});

test("portMatches：Any 算，写死的端口必须真的相等", () => {
  assert.equal(portMatches("Any", 3000), true);
  assert.equal(portMatches("", 3000), true);
  assert.equal(portMatches("3000", 3000), true);
  // 3000 被占用时服务会递增到 3001（§7.4），不能拿"3000 放行了"当"3001 也放行"
  assert.equal(portMatches("3000", 3001), false);
  assert.equal(portMatches("3000,3001", 3001), true);
  assert.equal(portMatches("3000-3012", 3007), true);
  assert.equal(portMatches("3000-3012", 3020), false);
});

test("programMatches：Windows 路径不分大小写，斜杠两种写法等价", () => {
  assert.equal(programMatches("D:\\A\\B.exe", "d:/a/b.exe"), true);
  assert.equal(programMatches("D:\\A\\B.exe", "D:\\A\\C.exe"), false);
  assert.equal(programMatches("", "D:\\A\\B.exe"), true, "不写程序 = 不限程序");
  assert.equal(programMatches("D:\\A\\B.exe", ""), false);
});

test("ruleCovers：协议、配置文件、端口、程序四道都要过", () => {
  const rule = { name: "x", profiles: "Public", program: "C:\\app\\a.exe", protocol: "TCP", localPort: "Any" };
  assert.equal(ruleCovers(rule, { exePath: "C:\\app\\a.exe", port: 3000, profile: "Public" }), true);
  // 家里是 Private，教室里是 Public —— 只对 Public 生效的规则换个网络就不作数
  assert.equal(ruleCovers(rule, { exePath: "C:\\app\\a.exe", port: 3000, profile: "Private" }), false);
  assert.equal(ruleCovers({ ...rule, protocol: "UDP" }, { exePath: "C:\\app\\a.exe", profile: "Public" }), false);
  assert.equal(ruleCovers({ ...rule, program: "C:\\app\\b.exe" }, { exePath: "C:\\app\\a.exe", profile: "Public" }), false);
  assert.equal(ruleCovers({ ...rule, localPort: "8080" }, { exePath: "C:\\app\\a.exe", port: 3000, profile: "Public" }), false);
});

test("parseFirewallReport：元信息与规则都认，认不出的行丢掉", () => {
  const report = parseFirewallReport(REPORT_TEXT);
  assert.equal(report.profile, "Public");
  assert.equal(report.enabled, true);
  assert.equal(report.rules.length, 4);
  assert.equal(report.rules[1].name, RULE_NAME);
  assert.equal(report.rules[1].program, "D:\\课堂弹幕\\课堂弹幕.exe");
  assert.equal(report.rules[2].protocol, "UDP");
});

test("parseFirewallReport：空输入 / 垃圾输入都不炸", () => {
  assert.deepEqual(parseFirewallReport(""), { profile: "Unknown", enabled: null, rules: [] });
  assert.deepEqual(parseFirewallReport(undefined).rules, []);
  assert.equal(parseFirewallReport("随便写点什么\r\n没有冒号也没有 tab").rules.length, 0);
});

test("judgeFirewall：查到覆盖规则 -> ok", () => {
  const report = parseFirewallReport(REPORT_TEXT);
  const verdict = judgeFirewall({ report, exePath: "D:\\课堂弹幕\\课堂弹幕.exe", port: 3000 });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.unknown, false);
  assert.equal(verdict.rule.name, RULE_NAME);
});

test("judgeFirewall：只有指向死路径的规则 -> 必须报出来（这就是现场那个 bug）", () => {
  // 现场的 5 条规则全都指向已经不存在的随机临时目录，而真正在跑的是新解出来的那一个
  const report = parseFirewallReport(REPORT_TEXT);
  const verdict = judgeFirewall({
    report,
    exePath: "C:\\Users\\35145\\AppData\\Local\\Temp\\3kbrandnew\\课堂弹幕.exe",
    port: 3000,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.unknown, false);
  assert.match(verdict.reason, /没有放行本程序/);
  assert.match(verdict.reason, /Public/);
  assert.equal(verdict.hint, "点托盘里的「放行防火墙」，或者手动跑一次 netsh advfirewall firewall add rule。");
});

test("judgeFirewall：防火墙关着就一定 ok（关着就没有入站拦截）", () => {
  const verdict = judgeFirewall({
    report: parseFirewallReport("PROFILE=Private\r\nENABLED=False"),
    exePath: "D:\\a.exe",
    port: 3000,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.unknown, false);
});

test("judgeFirewall：查不出来时不许报警，只能标 unknown", () => {
  // 误报会让老师学会无视提示，那这个功能就白做了
  for (const report of [null, undefined, parseFirewallReport(""), parseFirewallReport("PROFILE=Unknown")]) {
    const verdict = judgeFirewall({ report, exePath: "D:\\a.exe", port: 3000 });
    assert.equal(verdict.ok, true, `不该报警：${JSON.stringify(report)}`);
    assert.equal(verdict.unknown, true);
  }
});

test("allowRuleArgs：按程序放行、端口不写死、三个配置文件都覆盖", () => {
  const args = allowRuleArgs({ exePath: "D:\\课堂弹幕\\课堂弹幕.exe", port: 3000 });
  assert.deepEqual(args.slice(0, 4), ["advfirewall", "firewall", "add", "rule"]);
  assert.ok(args.includes(`name=${RULE_NAME}`));
  assert.ok(args.includes("dir=in"));
  assert.ok(args.includes("action=allow"));
  assert.ok(args.includes("protocol=TCP"));
  assert.ok(args.includes("profile=any"));
  // 端口写死的话，服务递增到 3001 的那天规则就失效了（§7.4）
  assert.ok(args.includes("localport=any"), "不能把端口钉死在规则里");
  assert.ok(args.some((arg) => arg.startsWith("program=")));
});

test("quoteArgs / elevateArgs：带空格的路径要能活着穿过命令行", () => {
  assert.equal(quoteArgs(["a", "b c"]), 'a "b c"');
  const elevated = elevateArgs(allowRuleArgs({ exePath: "D:\\我的 课堂\\课堂弹幕.exe" }));
  assert.equal(elevated[0], "-NoProfile");
  assert.match(elevated[3], /Start-Process/);
  assert.match(elevated[3], /-Verb RunAs/);
  assert.match(elevated[3], /netsh/);
});

test("QUERY_ARGS：必须是非交互的 powershell，且脚本里问了三件事", () => {
  assert.equal(QUERY_ARGS[0], "-NoProfile");
  assert.ok(QUERY_ARGS.includes("-NonInteractive"));
  const script = QUERY_ARGS[QUERY_ARGS.length - 1];
  assert.match(script, /Get-NetConnectionProfile/);
  assert.match(script, /Get-NetFirewallProfile/);
  assert.match(script, /Get-NetFirewallRule/);
  // netsh 的 show rule 不打印程序路径，所以必须走 PowerShell 这条路
  assert.match(script, /Get-NetFirewallApplicationFilter/);
});

test("QUERY_SCRIPT：程序名必须批量取，不能逐条 CIM 往返", () => {
  const script = QUERY_ARGS[QUERY_ARGS.length - 1];
  // 逐条 `$_ | Get-NetFirewallApplicationFilter` 单次约 205ms，本机 516 条规则
  // 外推 106 秒 —— 实测把自检直接跑到超时。这个钉子防止有人"顺手改回直观写法"。
  assert.doesNotMatch(script, /\$_ \| Get-NetFirewallApplicationFilter/);
  assert.doesNotMatch(script, /\$_ \| Get-NetFirewallPortFilter/);
  assert.match(script, /\$apps=@\{\}/);
  assert.match(script, /\$ports=@\{\}/);
  assert.match(script, /\$apps\[\$_\.InstanceID\]/);
});

test("QUERY_SCRIPT：判空只认 null，不能对枚举做 -not（Public 的枚举值是 0）", () => {
  const script = QUERY_ARGS[QUERY_ARGS.length - 1];
  // `if(-not $cat)` 会把 Public 网络误判成"查不到"，自检永远不报警 ——
  // 而 Public 恰恰是教室/咖啡馆网络的默认分类，也就是最需要报警的那一种。
  assert.doesNotMatch(script, /-not \$cat/);
  assert.match(script, /if\(\$null -eq \$cat\)\{\$cat='Unknown'\}/);
});

test("允许端口信息缺失：读不到就按「不限端口」处理，宁可漏报不误报", () => {
  // 非提权读 Get-NetFirewallPortFilter 会对一部分规则报 Access is denied，
  // 所以解析端必须容忍空协议/空端口
  const report = parseFirewallReport(
    ["PROFILE=Private", "ENABLED=True", "某规则\tPrivate\tD:\\a.exe\t\t"].join("\r\n"),
  );
  const verdict = judgeFirewall({ report, exePath: "D:\\a.exe", port: 3000 });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.unknown, false);
});

test("checkFirewall：接到 exec 的输出就能给结论", async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    return REPORT_TEXT.replace("D:\\课堂弹幕\\课堂弹幕.exe", "D:\\live\\课堂弹幕.exe");
  };
  const verdict = await checkFirewall({ exePath: "D:\\live\\课堂弹幕.exe", port: 3000, exec });
  assert.equal(verdict.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "powershell");
});

test("checkFirewall：exec 抛异常也要咽掉（自检不能反过来搞崩程序）", async () => {
  const exec = async () => {
    throw new Error("拒绝访问");
  };
  const verdict = await checkFirewall({ exePath: "D:\\a.exe", port: 3000, exec });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.unknown, true);
  assert.match(verdict.reason, /拒绝访问/);
});

test("checkFirewall：exec 被显式置空时跳过，而不是偷偷真去跑 PowerShell", async () => {
  // 单元测试里绝不能出现"不小心真的调了 powershell"这种事：
  // 结果会跟着跑测试的那台机器变，还会拖慢整套测试。
  const verdict = await checkFirewall({ exePath: "D:\\a.exe", port: 3000, exec: null });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.unknown, true);
  assert.match(verdict.reason, /跳过防火墙自检/);
});
