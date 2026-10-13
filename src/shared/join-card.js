/**
 * 「扫码进来」这张卡片（§4.10）。
 *
 * 二维码现在**只有老师端有**（`/host/`）。投影上曾经也挂一张，两分钟后再自己
 * 收起来，想法是"上课开头把学生放进来"；现场的结论是它挡课件 —— 投影是给
 * 一屋子人看的那块屏，上面多一个方块就少一块板书。所以投影页现在一个字的
 * 扫码信息都没有，这件事整个收在老师端。
 *
 * 为什么老师端必须有：投影是给学生的，老师自己看不见。真出现"学生连不上"
 * 的时候，老师得能对着自己的手机念出那个 IP，或者换一个地址再试。
 *
 * 数据来自服务端的 `GET /api/info`（`src/main/server/info.js`）。地址探测的
 * 判断都在那边做完了，这里只负责"挑一条、画出来、说清楚它是什么"。
 */

import { drawQr } from "./qrcode.js";

export const INFO_PATH = "/api/info";

/** 二维码四周的静区，单位是模块。少了它有些扫码 App 会读不出来。 */
export const QR_MARGIN = 4;

/**
 * 取服务端信息。
 *
 * 设了超时是因为它跑在页面加载的关键路径上：网卡枚举偶尔会卡住（虚拟机、
 * 断线的 VPN 都见过），而"二维码晚两秒出现"和"投影上一片空白"完全是两回事。
 */
export async function loadServerInfo(options = {}) {
  const {
    path = INFO_PATH,
    fetchImpl = globalThis.fetch,
    timeoutMs = 4000,
    AbortImpl = globalThis.AbortController,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("loadServerInfo 需要 fetch，浏览器里应该自己就有");
  }

  const controller = typeof AbortImpl === "function" ? new AbortImpl() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(path, {
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response?.ok) throw new Error(`服务端回了 ${response?.status ?? "?"}`);
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 老师能选的地址，首选排最前面。
 *
 * 服务端已经排好序了，这里只做两件事：把首选提到第一个（它可能同时也在
 * candidates 里），以及丢掉没有 `studentUrl` 的残次项 —— 画不出网址的
 * 候选画出来也没用。
 */
export function addressChoices(info) {
  const list = Array.isArray(info?.candidates)
    ? info.candidates.filter((c) => c?.studentUrl)
    : [];
  const best = info?.best;
  if (!best?.studentUrl) return list;
  return [best, ...list.filter((c) => c.address !== best.address)];
}

/**
 * 「换一个地址」按钮背后的东西。
 *
 * `next()` 是循环的：教室电脑上最常见的两三个地址里总有一个能连，
 * 老师按两下就找齐了，不需要它走到头就禁用。
 */
export function createAddressPicker(info) {
  const choices = addressChoices(info);
  let index = 0;
  return {
    choices,
    get index() {
      return index;
    },
    get current() {
      return choices[index] ?? null;
    },
    get multiple() {
      return choices.length > 1;
    },
    next() {
      if (choices.length > 1) index = (index + 1) % choices.length;
      return choices[index] ?? null;
    },
  };
}

/**
 * 一条候选地址的人话说明（§4.10）。
 *
 * 「不是局域网地址」这句话必须说出来：教室电脑插着 VPN 或者 VMware 的时候，
 * 首选地址可能是一个学生根本连不上的地址，而二维码看起来完全正常。
 */
export function describeChoice(choice, options = {}) {
  if (!choice?.address) return "";
  const { best = null, showAddress = true } = options;
  const bits = [];
  if (best && choice.address === best.address) bits.push("推荐");
  // 热点网卡的真名是「本地连接* 10」这种，对老师来说等于没写，所以换个说法
  if (choice.hotspot) bits.push("电脑热点");
  else if (choice.name) bits.push(choice.name);
  if (showAddress) bits.push(choice.address);
  // 公网地址恰好是上面那句话的反面：它是**唯一**一个手机在流量上也能连的地址，
  // 说它"学生多半连不上"会把老师往错的方向推（他会去关掉公网找内网地址）。
  if (choice.public) bits.push("手机用流量也能连");
  else if (choice.scope && choice.scope !== "lan") bits.push("不是局域网地址，学生多半连不上");
  return bits.join(" · ");
}

/** 没查到可用地址时说的话。 */
export const NO_ADDRESS_HINT = "没查到能给学生用的地址，请在电脑上看一眼网络连接";

/**
 * 二维码下面那句必须一直挂着的话。
 *
 * 二维码里装的是 `10.x` / `192.168.x` 这种内网地址，只有"和这台电脑在同一个
 * 局域网里"的手机才路由得到 —— 用手机流量的话，码扫得再准也是转圈打不开。
 * 这句话是现场实测（老师报「二维码完全不能用」）之后补的：当时二维码本身
 * 没有任何问题，手机在流量上，地址压根到不了。
 *
 * 服务端无从知道学生的手机连在哪个网上，所以这句只能无条件常驻，不能靠检测。
 */
export const LAN_NOTICE = "学生手机要连和这台电脑同一个 Wi-Fi（手机流量打不开这个地址）";

/**
 * 二维码里装的**是公网地址**时改说这句（§4.12）。
 *
 * 这时候「要连同一个 Wi-Fi」不但没必要，还会误导：老师刚花了一次授权把公网
 * 开起来，图的就是"学生用流量也能进来"。所以换一句把这件好处说出来，顺带
 * 提一句它比内网慢 —— 现场卡顿的时候老师能立刻对上原因。
 */
export const WAN_NOTICE = "手机用流量也能连（走公网中转，比内网直连慢一点）";

/**
 * 二维码和地址要有地方画、有地方写。用户节点一律"给就给、没给就跳过"，
 * 这样调用方可以只挂自己需要的部分（老师端就没挂 `urlText` 之外的一些）。
 *
 * @param {{canvas?: object, urlText?: object, hintText?: object, noticeText?: object}} target
 */
export function paintJoinCard(target, choice, options = {}) {
  const { canvas, urlText, hintText, noticeText } = target ?? {};
  const { best = null } = options;

  // 联络方式那句和有没有二维码无关：一个地址都没查到的时候，学生更得知道
  // "要连同一个网"，否则他们会一直怀疑是自己手机的问题。
  // 挂的是公网地址时反过来 —— 那句"要连同一个 Wi-Fi"会跟老师刚开好的公网打架。
  if (noticeText) noticeText.textContent = choice?.public ? WAN_NOTICE : LAN_NOTICE;

  if (!choice?.studentUrl) {
    if (canvas) clearCanvas(canvas);
    if (urlText) urlText.textContent = "";
    if (hintText) hintText.textContent = NO_ADDRESS_HINT;
    return null;
  }

  if (canvas) {
    drawQr(canvas, choice.studentUrl, {
      ecc: "M",
      margin: QR_MARGIN,
      // 深色写死而不是跟着主题走：二维码的对比度不够时扫不出来，
      // 而"扫不出来"在教室里表现为"这程序坏了"
      dark: "#0b0d12",
      light: "#ffffff",
    });
  }
  if (urlText) urlText.textContent = choice.studentUrl;
  if (hintText) hintText.textContent = describeChoice(choice, { best });
  return choice;
}

function clearCanvas(canvas) {
  const ctx = canvas?.getContext?.("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

