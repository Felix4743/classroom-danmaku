/**
 * 网卡优选（技术方案 §4.10）。
 *
 * 这一组测试守的是一件很具体的事：**老师屏幕上的那个地址，学生真的要能连上。**
 * 教室电脑上通常同时有物理网卡和虚拟网卡（VMware / WSL / Docker / VPN），
 * 而虚拟网卡也经常拿着 192.168.x.x —— 光看地址根本分不出来。
 * 所以每一条排除规则都单独钉一遍，而不是只测"最后挑出来的那个是对的"。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SCORE,
  collectCandidates,
  inRange,
  ipv4ToInt,
  isApipaIPv4,
  isHotspotInterface,
  isPrivateIPv4,
  isVirtualInterface,
  pageUrl,
  pickAddress,
} from "../../src/main/netinfo.js";

/** 造一张网卡的条目。 */
function nic(address, { family = "IPv4", internal = false } = {}) {
  return { address, family, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null };
}

test("ipv4ToInt：只认合法的点分十进制", () => {
  assert.equal(ipv4ToInt("0.0.0.0"), 0);
  assert.equal(ipv4ToInt("255.255.255.255"), 4294967295);
  assert.equal(ipv4ToInt("192.168.1.1"), 3232235777);
  assert.equal(ipv4ToInt("256.1.1.1"), null);
  assert.equal(ipv4ToInt("1.2.3"), null);
  assert.equal(ipv4ToInt("1.2.3.4.5"), null);
  assert.equal(ipv4ToInt("a.b.c.d"), null);
  assert.equal(ipv4ToInt(""), null);
  assert.equal(ipv4ToInt(null), null);
});

test("inRange：网段的边界值决定一切", () => {
  // 10.0.0.0/8
  assert.equal(inRange("10.0.0.1", "10.0.0.0", 8), true);
  assert.equal(inRange("10.255.255.255", "10.0.0.0", 8), true);
  assert.equal(inRange("11.0.0.1", "10.0.0.0", 8), false);
  // 172.16.0.0/12 是最容易写错的一段：172.16 ~ 172.31
  assert.equal(inRange("172.16.0.0", "172.16.0.0", 12), true);
  assert.equal(inRange("172.31.255.255", "172.16.0.0", 12), true);
  assert.equal(inRange("172.15.255.255", "172.16.0.0", 12), false);
  assert.equal(inRange("172.32.0.0", "172.16.0.0", 12), false);
  // 192.168.0.0/16
  assert.equal(inRange("192.168.1.1", "192.168.0.0", 16), true);
  assert.equal(inRange("192.169.1.1", "192.168.0.0", 16), false);
  assert.equal(inRange("不是地址", "192.168.0.0", 16), false);
});

test("私有地址与 APIPA 的判定", () => {
  for (const address of ["10.1.2.3", "172.16.0.1", "172.31.0.1", "192.168.1.1", "192.168.255.254"]) {
    assert.equal(isPrivateIPv4(address), true, `${address} 该是私有地址`);
  }
  for (const address of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "169.253.0.1"]) {
    assert.equal(isPrivateIPv4(address), false, `${address} 不该是私有地址`);
  }
  assert.equal(isApipaIPv4("169.254.0.1"), true);
  assert.equal(isApipaIPv4("169.254.255.255"), true);
  assert.equal(isApipaIPv4("169.255.0.1"), false);
});

test("虚拟网卡按名字排除", () => {
  for (const name of [
    "VMware Network Adapter VMnet1",
    "VirtualBox Host-Only Network",
    "vEthernet (WSL)",
    "vEthernet (Default Switch)",
    "Hyper-V Virtual Ethernet Adapter",
    "Docker Desktop",
    "Tailscale",
    "ZeroTier One",
    "WireGuard Tunnel",
    "TAP-Windows Adapter V9",
  ]) {
    assert.equal(isVirtualInterface(name), true, `${name} 该被排除`);
  }
  for (const name of ["WLAN", "以太网", "Ethernet", "Wi-Fi", "en0", "wlan0"]) {
    assert.equal(isVirtualInterface(name), false, `${name} 不该被排除`);
  }
});

test("物理网卡 + 私有地址得 100 分，其它地址 60 分", () => {
  const { candidates } = collectCandidates(
    {
      WLAN: [nic("192.168.1.7")],
      "以太网": [nic("202.114.1.9")],
    },
    { port: 3000 },
  );

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].address, "192.168.1.7");
  assert.equal(candidates[0].score, SCORE.PRIVATE);
  assert.equal(candidates[0].scope, "lan");
  assert.equal(candidates[1].address, "202.114.1.9");
  assert.equal(candidates[1].score, SCORE.OTHER);
  assert.equal(candidates[1].scope, "other");
});

test("虚拟网卡即使拿着 192.168 也不要", () => {
  const { candidates } = collectCandidates(
    {
      "VMware Network Adapter VMnet1": [nic("192.168.190.1")],
      WLAN: [nic("192.168.1.7")],
    },
    { port: 3000 },
  );

  assert.deepEqual(candidates.map((c) => c.address), ["192.168.1.7"]);
});

test("电脑热点排在以太网前面：学生几乎一定在热点那一侧", () => {
  // 这是真机上踩到的顺序：老师开着移动热点给学生连，但以太网也在，
  // 而「以太网」按码位比「本地连接* 10」小，于是二维码指向了以太网 ——
  // 学生连的是热点，路由不保证通。热点是老师**主动开出来**的，
  // 它存在的唯一理由就是"让别的设备连上我"。
  const { candidates } = collectCandidates(
    {
      以太网: [nic("10.109.12.63")],
      "本地连接* 10": [nic("192.168.137.1")],
    },
    { port: 3000 },
  );

  assert.equal(candidates[0].address, "192.168.137.1");
  assert.equal(candidates[0].hotspot, true);
  assert.equal(candidates[0].score, SCORE.HOTSPOT);
  assert.ok(candidates[0].score > candidates[1].score);
  assert.equal(candidates[1].hotspot, false);
  // 热点地址本身是私有的，所以 scope 仍然是 lan —— 界面不该说它"不是局域网"
  assert.equal(candidates[0].scope, "lan");
});

test("热点靠地址认出：192.168.137.1 就是共享网络的主机地址", () => {
  const { candidates } = collectCandidates(
    {
      以太网: [nic("10.0.0.5")],
      "Local Area Connection* 3": [nic("192.168.137.1")],
    },
    { port: 3000 },
  );

  assert.equal(candidates[0].address, "192.168.137.1");
  assert.equal(candidates[0].hotspot, true);
});

test("家用路由器发 192.168.137.x 不算热点：必须精确到 .1", () => {
  // 普通无线网卡拿到 192.168.137.23 是路由器随手发的地址，
  // 把它当热点会凭空抬高它的优先级，压过真正该推荐的网卡。
  const { candidates } = collectCandidates(
    {
      WLAN: [nic("192.168.137.23")],
      以太网: [nic("10.0.0.5")],
    },
    { port: 3000 },
  );

  const wlan = candidates.find((c) => c.address === "192.168.137.23");
  assert.equal(wlan.hotspot, false);
  assert.equal(wlan.score, SCORE.PRIVATE);
  assert.equal(wlan.score, candidates.find((c) => c.address === "10.0.0.5").score);
});

test("isHotspotInterface：名字和地址任一命中即算", () => {
  assert.equal(isHotspotInterface("本地连接* 10", "192.168.1.5"), true);
  assert.equal(isHotspotInterface("Local Area Connection* 3", "10.0.0.9"), true);
  assert.equal(isHotspotInterface("WLAN", "192.168.137.1"), true);
  assert.equal(isHotspotInterface("WLAN", "192.168.1.5"), false);
  assert.equal(isHotspotInterface(null, "192.168.1.5"), false);
  assert.equal(isHotspotInterface(undefined, undefined), false);
});

test("热点和别的网卡同时在时，必须把「换一个地址」这个出口说出来", () => {
  // 程序没法知道学生连的是热点还是以太网，所以不能沉默 ——
  // 沉默的结果是老师盯着一个扫了打不开的二维码，而按钮就在旁边
  const { warnings } = collectCandidates(
    {
      以太网: [nic("10.109.12.63")],
      "本地连接* 10": [nic("192.168.137.1")],
    },
    { port: 3000 },
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /换一个地址/);
});

test("只有一张网卡时不要提「换一个地址」：那个按钮根本不会出现", () => {
  const { warnings } = collectCandidates({ 以太网: [nic("10.109.12.63")] }, { port: 3000 });
  assert.deepEqual(warnings, []);
});

test("两块普通网卡同时在，也不提「换一个地址」—— 那不是需要老师做判断的场合", () => {
  const { warnings } = collectCandidates(
    {
      以太网: [nic("10.109.12.63")],
      WLAN: [nic("192.168.1.7")],
    },
    { port: 3000 },
  );
  assert.deepEqual(warnings, []);
});

test("APIPA 要报警而不是静默跳过", () => {
  const { candidates, warnings } = collectCandidates(
    { "以太网": [nic("169.254.13.9")], WLAN: [nic("192.168.1.7")] },
    { port: 3000 },
  );

  assert.deepEqual(candidates.map((c) => c.address), ["192.168.1.7"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /169\.254\.13\.9/);
  assert.match(warnings[0], /没从路由器拿到 IP/);
});

test("回环地址永远不当候选：给学生看 127.0.0.1 等于什么都没给", () => {
  const { candidates } = collectCandidates(
    { Loopback: [nic("127.0.0.1", { internal: true })] },
    { port: 3000 },
  );

  assert.deepEqual(candidates, []);
});

test("只有 IPv6 的机器不算有可用地址", () => {
  const { candidates } = collectCandidates(
    { WLAN: [{ address: "fe80::1", family: "IPv6", internal: false }] },
    { port: 3000 },
  );

  assert.deepEqual(candidates, []);
});

test("一张网卡都没有时，要说清楚是为什么", () => {
  const { best, candidates, warnings } = pickAddress({}, { port: 3000 });

  assert.equal(best, null, "没有可用地址时必须是 null，界面才知道该报警");
  assert.deepEqual(candidates, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /一张网卡都没找到/);
});

test("有网卡但全是虚拟的，也要报警（否则老师会盯着一个空二维码）", () => {
  const { best, warnings } = pickAddress(
    { "VirtualBox Host-Only Network": [nic("192.168.56.1")] },
    { port: 3000 },
  );

  assert.equal(best, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /虚拟网卡|回环/);
});

test("排序不依赖这台机器的语言设置", () => {
  // `localeCompare` 会让"中文 Windows"和"英文 Windows"挑出不同的首选地址，
  // 于是现场问题无法复现。这里钉死码位顺序：'W'(0x57) 在 '以'(0x4EE5) 前面。
  const { candidates } = collectCandidates(
    { "以太网": [nic("10.1.2.3")], WLAN: [nic("192.168.1.7")] },
    { port: 3000 },
  );

  assert.deepEqual(candidates.map((c) => c.name), ["WLAN", "以太网"]);
});

test("排序是确定的：同样的输入必须给出同样的顺序", () => {
  const interfaces = {
    WLAN: [nic("192.168.1.5"), nic("192.168.1.4")],
    "以太网": [nic("10.0.0.9")],
    "Wi-Fi2": [nic("10.0.0.8")],
  };

  const first = collectCandidates(interfaces, { port: 3000 });
  const second = collectCandidates(interfaces, { port: 3000 });
  assert.deepEqual(
    first.candidates.map((c) => `${c.name}/${c.address}`),
    second.candidates.map((c) => `${c.name}/${c.address}`),
    "同样的输入必须给出同样的顺序 —— '换一个地址'按钮要靠它",
  );
  // 四张网卡都是私有地址，于是都是 100 分
  assert.deepEqual(new Set(first.candidates.map((c) => c.score)), new Set([SCORE.PRIVATE]));
  // 同一张网卡的两个地址都要在，不能只留一个
  assert.deepEqual(
    first.candidates.filter((c) => c.name === "WLAN").map((c) => c.address).sort(),
    ["192.168.1.4", "192.168.1.5"],
  );
});

test("换一个地址：备选列表长度足够，且都给到学生页那个地址", () => {
  const { best, candidates } = pickAddress(
    { WLAN: [nic("192.168.1.7")], "以太网": [nic("10.1.2.3")] },
    { port: 3000 },
  );

  assert.equal(candidates.length, 2, "只有一张网卡的话，'换一个地址'就没得换");
  assert.equal(best.url, pageUrl("192.168.1.7", 3000));
  assert.equal(best.url, "http://192.168.1.7:3000/");
});

test("pageUrl：端口和路径都要在", () => {
  assert.equal(pageUrl("10.0.0.2", 3001), "http://10.0.0.2:3001/");
  assert.equal(pageUrl("10.0.0.2", 3001, "/m"), "http://10.0.0.2:3001/m");
});

test("真机器上跑一次：不抛错，且挑出来的地址确实是私有的", () => {
  // 这条不是断言这台机器有几张网卡（那会随环境变），
  // 而是确保真数据的形状不会把 collectCandidates 弄崩。
  const { best, candidates, warnings } = pickAddress();
  assert.ok(Array.isArray(candidates));
  assert.ok(Array.isArray(warnings));
  if (best) {
    assert.equal(best.scope, "lan", "首选地址必须是私有地址");
    assert.equal(isPrivateIPv4(best.address), true);
    assert.ok(!isApipaIPv4(best.address));
    assert.ok(best.url.includes(best.address));
  }
});
