/**
 * 挑一个"学生手机能连上"的地址（技术方案 §4.10）。
 *
 * 这件事听起来是 `gethostname()` 一行的事，实际上是 V1 里最容易翻车的
 * 地方：教室电脑上通常同时存在好几张网卡，其中至少一张是虚拟的
 * （装了 VMware、WSL、Docker、VPN 客户端都会多出来一张），而它们
 * **恰好**也经常拿着 192.168.x.x 的地址。按名字随便挑一张，就会出现
 * "老师屏幕上的二维码指向一张根本不存在的网卡"，学生扫了半天连不上，
 * 而老师完全不知道为什么。
 *
 * 所以这里的做法是**打分 + 排序**，而不是"取第一个"：
 *   · 物理网卡 + 私有地址      100 分 ← 想找的就是它
 *   · 物理网卡 + 其它 IPv4      60 分 ← 能用，但很可能是校园网公网地址段
 *   · 虚拟网卡                   0 分，直接排除
 *   · 169.254.x.x（APIPA）      排除，并且要**报警**
 *
 * 这个模块不碰网络、不碰 UI，只吃一个 `networkInterfaces()` 形状的对象，
 * 所以可以在测试里拿假数据把每一条规则钉死。
 */

import { networkInterfaces } from "node:os";

/**
 * 虚拟网卡的名字特征。命中就整张网卡不要 —— 这些名字都是实际装过
 * 才出现的，宁可少列一张网卡，也不要给老师一个连不上的地址。
 */
export const VIRTUAL_PATTERNS = [
  /vmware/i,
  /virtualbox/i,
  /\bvbox\b/i,
  /hyper-?v/i,
  /vethernet/i,
  /\bwsl\b/i,
  /docker/i,
  /loopback/i,
  /tailscale/i,
  /zerotier/i,
  /radmin/i,
  /\bvpn\b/i,
  /tunnel/i,
  /\btap\b/i,
  /\btun\b/i,
];

/** 169.254.0.0/16：网卡没能从路由器拿到地址时给自己编的地址。 */
const APIPA = ["169.254.0.0", 16];

/** 私有地址段（RFC 1918）。 */
const PRIVATE_RANGES = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

export const SCORE = Object.freeze({ PRIVATE: 100, OTHER: 60, EXCLUDED: 0 });

/** 把点分十进制转成 32 位整数。不是合法 IPv4 就返回 null。 */
export function ipv4ToInt(address) {
  if (typeof address !== "string") return null;
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/** address 是否落在 base/bits 这个网段里。 */
export function inRange(address, base, bits) {
  const value = ipv4ToInt(address);
  const baseValue = ipv4ToInt(base);
  if (value === null || baseValue === null) return false;
  // 用 >>> 0 保持在 32 位无符号里，避免 << 之后的符号位把比较搞坏
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

export function isApipaIPv4(address) {
  return inRange(address, APIPA[0], APIPA[1]);
}

export function isPrivateIPv4(address) {
  return PRIVATE_RANGES.some(([base, bits]) => inRange(address, base, bits));
}

/** 网卡名看起来是不是虚拟的。 */
export function isVirtualInterface(name) {
  if (typeof name !== "string") return false;
  return VIRTUAL_PATTERNS.some((pattern) => pattern.test(name));
}

/** `http://<地址>:<端口><路径>`。刻意用模板串拼，避免仓库里出现写死的外部地址。 */
export function pageUrl(address, port, path = "/") {
  return `http://${address}:${port}${path}`;
}

/**
 * 按码位比较，不用 `localeCompare`。
 *
 * `localeCompare` 的结果依赖这台机器上的区域设置：同一份网卡列表，
 * 中文 Windows 和英文 Windows 可能给出不同的首选地址。首选地址决定了
 * 老师屏幕上那个二维码指向哪儿，这种"换台机器结果就变了"的行为会让
 * 现场问题完全无法复现。码位比较难看，但它到哪儿都一样。
 */
function byCodeUnit(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 列出所有能给学生用的地址，按"最可能连得上"排序。
 *
 * 排序是**确定的**（同分时按网卡名、再按地址），因为老师界面上的
 * "换一个地址"按钮要靠这个顺序 —— 每次刷新都换一个顺序，那个按钮就没法用了。
 */
export function collectCandidates(interfaces, { port = 3000 } = {}) {
  const candidates = [];
  const warnings = [];
  const entries = Object.entries(interfaces ?? {});

  if (entries.length === 0) {
    warnings.push("这块机器上一张网卡都没找到，学生不可能连上来");
  }

  for (const [name, list] of entries) {
    const virtual = isVirtualInterface(name);
    for (const info of list ?? []) {
      const family = info?.family;
      if (family !== "IPv4" && family !== 4) continue;
      if (info.internal) continue;

      const address = info.address;
      if (isApipaIPv4(address)) {
        // APIPA 单独报警而不是静默跳过：它是"网卡没拿到 IP"的唯一外部症状，
        // 而老师看到的只是"学生连不上"，中间差着这一条信息
        warnings.push(
          `网卡「${name}」只有 ${address}（自动私有地址），说明它没从路由器拿到 IP，` +
            "这条线索通常意味着教室的网线或 WiFi 认证有问题",
        );
        continue;
      }
      if (virtual) continue;

      const priv = isPrivateIPv4(address);
      candidates.push({
        name,
        address,
        scope: priv ? "lan" : "other",
        score: priv ? SCORE.PRIVATE : SCORE.OTHER,
        url: pageUrl(address, port),
      });
    }
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      byCodeUnit(a.name, b.name) ||
      byCodeUnit(a.address, b.address),
  );

  if (candidates.length === 0 && warnings.length === 0) {
    warnings.push(
      "没有找到可用的局域网地址（剩下的都是虚拟网卡或回环地址），" +
        "先确认教室电脑真的连上了网络",
    );
  }

  return { candidates, warnings };
}

/**
 * 一次拿全：首选地址、全部备选、以及要显示给老师的提醒。
 *
 * `best` 是 null 就代表**这台机器现在没法开课**，界面必须明确说出来，
 * 而不是显示一个 127.0.0.1 的二维码让学生去扫。
 */
export function pickAddress(interfaces = networkInterfaces(), { port = 3000 } = {}) {
  const { candidates, warnings } = collectCandidates(interfaces, { port });
  return { best: candidates[0] ?? null, candidates, warnings };
}
