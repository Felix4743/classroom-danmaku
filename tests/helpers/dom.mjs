/**
 * 极小的 DOM 桩，用来在 Node 里把页面脚本真的跑一遍。
 *
 * 为什么值得写这么一层：页面脚本里有大量"连接是好的、控制台一句错都不报、
 * 但界面就是空的"的 bug —— `/host` 就真的踩过一次（`onEvent` 的参数形状搞错了，
 * 每条消息都从 handlers 里查不到东西，于是列表永远空着而状态显示"已连上"）。
 * 单元测试测不到它，因为 `client.js` 的行为完全正确，错的是页面怎么用它。
 *
 * 这个桩刻意做得很小：元素只有 `dataset / textContent / hidden / children /
 * addEventListener / click` 这些页面真正用到的东西。**不实现 `innerHTML`** ——
 * 页面上所有用户输入的渲染都必须走 `textContent`（XSS 红线），
 * 桩里没有 innerHTML，谁哪天写了它这里就会报错。
 *
 * 元素的来源是**页面自己的 HTML**：`installDom` 把 HTML 里所有 `id="…"` 建成元素。
 * 于是脚本查了一个 HTML 里没有的 id 时会拿到 `null` 并当场抛错 ——
 * 这和 `static-graph.test.mjs` 的静态检查是两回事，它挡的是运行期的用法。
 */

import { readFileSync } from "node:fs";

class StubElement {
  constructor(tagName, id = "") {
    this.tagName = String(tagName).toUpperCase();
    this.id = id;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.type = "";
    this.className = "";
  }

  append(...nodes) {
    for (const node of nodes) this.children.push(node);
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener() {}

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  querySelectorAll() {
    return [];
  }

  /** 测试用：派发一个事件给这个元素上的监听器。 */
  fire(type, event = { type }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** 测试用：模拟一次点击。 */
  click() {
    this.fire("click");
  }

  /** 测试用：这个元素及其所有后代的文字拼起来，用来断言"屏幕上有没有这句话"。 */
  text() {
    return (this.textContent ?? "") + this.children.map((child) => child.text()).join("");
  }

  /** 测试用：递归收集所有后代。 */
  all() {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
}

/** 假的 WebSocket，够 client.js 用。 */
export class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** 模拟握手成功。 */
  connect() {
    this.readyState = 1;
    this.emit("open");
  }

  send(text) {
    if (this.readyState !== 1) throw new Error("还没连上就 send");
    this.sent.push(JSON.parse(text));
  }

  /** 模拟服务端推来一条消息。 */
  deliver(message) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }

  /** 测试用：发出去的最后一个指定事件。 */
  lastSent(event) {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      if (this.sent[i].event === event) return this.sent[i];
    }
    return null;
  }
}

/**
 * 把一份 HTML 里所有 id 建成元素，装上全局对象，返回元素表。
 *
 * @param {string} html 页面 HTML 的全文
 */
export function installDom(html) {
  const elements = new Map();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    elements.set(id, new StubElement("div", id));
  }

  const document = {
    getElementById(id) {
      // 刻意不兜底造一个：查了不存在的 id 就该当场炸，
      // 而不是在浏览器里安静地拿到 null 然后什么都不做
      return elements.get(id) ?? null;
    },
    createElement(tag) {
      return new StubElement(tag);
    },
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
  };

  const define = (name, value) => {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  };

  define("document", document);
  define("location", { protocol: "http:", host: "127.0.0.1:3000", href: "http://127.0.0.1:3000/" });
  define("navigator", { vibrate: () => true, userAgent: "stub" });
  define("window", globalThis);

  const storage = new Map();
  define("localStorage", {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  });

  // 定时器一律不真的排期：这些页面用它们做心跳、倒计时和重渲染，
  // 而测试要的是"消息到了之后界面对不对"，不是等一秒。
  //
  // `setTimeout` 也必须一起换掉，否则 `client.js` 的 90 秒看门狗会真的排期，
  // 于是整个测试进程要多活 90 秒才退出（实测过一次：13 条用例跑了 91 秒）。
  define("setInterval", () => 0);
  define("clearInterval", () => {});
  define("setTimeout", () => 0);
  define("clearTimeout", () => {});
  define("confirm", () => true);

  return elements;
}

/** 装上假的 WebSocket。必须在页面脚本被 import **之前**调用。 */
export function installWebSocket() {
  FakeSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", {
    value: FakeSocket,
    writable: true,
    configurable: true,
  });
  return FakeSocket;
}

let loadCount = 0;

/**
 * import 一份页面脚本。
 *
 * 带一个自增查询串绕开 ESM 的模块缓存：同一个文件 import 两次时，
 * 第二次必须重新执行（否则第二次测试拿到的是上一次的闭包状态）。
 */
export async function loadPageScript(url) {
  loadCount += 1;
  return import(`${url.href}?stub=${loadCount}`);
}

/** 读页面 HTML 并装上 DOM，返回 { elements, html }。 */
export function readPage(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const elements = installDom(html);
  return { elements, html };
}
