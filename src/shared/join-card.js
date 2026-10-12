/**
 * 「扫码进来」这张卡片（§4.10）。
 *
 * 投影上要有一个二维码，老师手机上也要有一个 —— 同一个二维码、同一个网址，
 * 所以两边的取数、选地址、画码、写说明都放在这里，页面只管把它挂到 DOM 上。
 *
 * 为什么老师手机上也要有：投影是给学生的，老师自己看不见。真出现"学生连不上"
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
 * 卡片自己消失的时间。
 *
 * 一节课开始两分钟以后，人都进来了，二维码就只是盖在课件上的一个方块。
 * 老师想再看一眼的话，老师端一直在「更多」里挂着它。
 */
export const AUTO_HIDE_MS = 120_000;

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
  if (choice.name) bits.push(choice.name);
  if (showAddress) bits.push(choice.address);
  if (choice.scope && choice.scope !== "lan") bits.push("不是局域网地址，学生多半连不上");
  return bits.join(" · ");
}

/** 没查到可用地址时，投影和老师端要说同一句话。 */
export const NO_ADDRESS_HINT = "没查到能给学生用的地址，请在电脑上看一眼网络连接";

/**
 * 二维码和地址要有地方画、有地方写。用户节点一律"给就给、没给就跳过"，
 * 这样老师端和投影页可以只挂自己需要的部分。
 *
 * @param {{canvas?: object, urlText?: object, hintText?: object}} target
 */
export function paintJoinCard(target, choice, options = {}) {
  const { canvas, urlText, hintText } = target ?? {};
  const { best = null } = options;

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

/**
 * 卡片该不该显示（见 AUTO_HIDE_MS 的说明）。
 *
 * `force` 来自 URL：`?qr=1` 永远钉着（调参页和老师演示的时候用），
 * `?qr=0` 永远不要。没有 `force` 就按时间自动收起来。
 */
export function joinCardVisible({ force = null, openedAt, now }) {
  if (force === true) return true;
  if (force === false) return false;
  return Number(now) - Number(openedAt) < AUTO_HIDE_MS;
}

/** 把 `?qr=` 的原文读成 true / false / null。 */
export function parseQrParam(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return null;
}
