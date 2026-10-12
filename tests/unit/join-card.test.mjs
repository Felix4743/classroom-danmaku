/**
 * 扫码卡片（§4.10）。
 *
 * 这一层是"服务端算好的地址"和"页面 DOM"之间的胶水，所以两边都要钉住：
 * 地址挑错了，老师按「换一个地址」永远换不到能连的那条；DOM 写错了，
 * 投影上会出现一个扫不出来的空白方块 —— 而它在教室里看起来和"程序坏了"一模一样。
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  AUTO_HIDE_MS,
  LAN_NOTICE,
  NO_ADDRESS_HINT,
  addressChoices,
  createAddressPicker,
  describeChoice,
  joinCardVisible,
  loadServerInfo,
  paintJoinCard,
  parseQrParam,
} from "../../src/shared/join-card.js";

/** 记录调用的假画布。真实的 qrcode.js 只要 ctx.fillStyle / fillRect 就够。 */
function fakeCanvas(width = 176, height = 176) {
  const calls = [];
  const ctx = {
    fillStyle: "",
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    clearRect: (...args) => calls.push(["clearRect", ...args]),
  };
  return { canvas: { width, height, getContext: () => ctx }, calls, ctx };
}

/** 一条服务端候选地址（形状见 src/main/netinfo.js 的 collectCandidates）。 */
function lanCandidate(address, name = "WLAN", extra = {}) {
  return { name, address, scope: "lan", score: 30, url: `http://${address}:3000/`, studentUrl: `http://${address}:3000/m`, ...extra };
}

describe("loadServerInfo", () => {
  test("成功时返回服务端的 JSON，并且不吃缓存", async () => {
    let seen = null;
    const info = await loadServerInfo({
      fetchImpl: async (path, options) => {
        seen = { path, options };
        return { ok: true, status: 200, json: async () => ({ best: { address: "10.0.0.5" } }) };
      },
    });

    assert.equal(seen.path, "/api/info");
    // 地址会变（换个教室、插拔网线），缓存住的二维码会指向上一节课的地址
    assert.equal(seen.options.cache, "no-store");
    assert.deepEqual(info, { best: { address: "10.0.0.5" } });
  });

  test("服务端回 4xx/5xx 就抛，不把错误对象当数据用", async () => {
    await assert.rejects(
      loadServerInfo({ fetchImpl: async () => ({ ok: false, status: 503 }) }),
      /503/,
    );
  });

  test("没有 fetch 实现时当场抛 TypeError", async () => {
    await assert.rejects(loadServerInfo({ fetchImpl: null }), TypeError);
  });

  test("超时会中断这次请求，而不是让页面一直等", async () => {
    let aborted = false;
    await assert.rejects(
      loadServerInfo({
        timeoutMs: 5,
        fetchImpl: (_path, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("请求被中断"));
            });
          }),
      }),
      /请求被中断/,
    );
    assert.equal(aborted, true);
  });

  test("没给 AbortController 也能跑（只是没有超时保护）", async () => {
    const info = await loadServerInfo({
      AbortImpl: null,
      fetchImpl: async () => ({ ok: true, json: async () => ({ port: 3000 }) }),
    });
    assert.equal(info.port, 3000);
  });
});

describe("地址候选", () => {
  test("首选排第一，即使它同时也在 candidates 里也不重复", () => {
    const best = lanCandidate("10.0.0.5");
    const other = lanCandidate("192.168.1.9", "以太网");
    const choices = addressChoices({ best, candidates: [best, other] });

    assert.equal(choices.length, 2);
    assert.equal(choices[0].address, "10.0.0.5");
    assert.equal(choices[1].address, "192.168.1.9");
  });

  test("没有 studentUrl 的候选直接丢掉：画不出网址的候选画出来也没用", () => {
    const choices = addressChoices({
      best: { name: "WLAN", address: "10.0.0.5" },
      candidates: [{ address: "10.0.0.9", url: "http://10.0.0.9:3000/" }],
    });
    assert.deepEqual(choices, []);
  });

  test("没有 best 时按 candidates 的原顺序给", () => {
    const a = lanCandidate("10.0.0.5");
    const b = lanCandidate("10.0.0.6");
    assert.deepEqual(addressChoices({ best: null, candidates: [a, b] }), [a, b]);
  });

  test("什么都没有时给空数组，不抛", () => {
    assert.deepEqual(addressChoices(null), []);
    assert.deepEqual(addressChoices({}), []);
    assert.deepEqual(addressChoices({ candidates: "不是数组" }), []);
  });
});

describe("createAddressPicker", () => {
  test("默认停在首选上，并报出「不止一条」", () => {
    const picker = createAddressPicker({
      best: lanCandidate("10.0.0.5"),
      candidates: [lanCandidate("10.0.0.5"), lanCandidate("192.168.1.9", "以太网")],
    });

    assert.equal(picker.index, 0);
    assert.equal(picker.current.address, "10.0.0.5");
    assert.equal(picker.multiple, true);
  });

  test("next 循环，不会走出数组", () => {
    const picker = createAddressPicker({
      best: lanCandidate("10.0.0.5"),
      candidates: [lanCandidate("10.0.0.5"), lanCandidate("192.168.1.9")],
    });

    assert.equal(picker.next().address, "192.168.1.9");
    assert.equal(picker.next().address, "10.0.0.5");
    assert.equal(picker.index, 0);
  });

  test("只有一条时 next 原地不动 —— 按钮会被藏起来（multiple 为 false）", () => {
    const picker = createAddressPicker({ best: lanCandidate("10.0.0.5"), candidates: [] });
    assert.equal(picker.multiple, false);
    assert.equal(picker.next().address, "10.0.0.5");
    assert.equal(picker.index, 0);
  });

  test("一条都没有时 current 为 null，next 不炸", () => {
    const picker = createAddressPicker({ best: null, candidates: [] });
    assert.equal(picker.current, null);
    assert.equal(picker.next(), null);
    assert.equal(picker.multiple, false);
  });
});

describe("describeChoice", () => {
  test("首选标「推荐」，并带上网卡名和地址", () => {
    const best = lanCandidate("10.0.0.5", "WLAN");
    assert.equal(describeChoice(best, { best }), "推荐 · WLAN · 10.0.0.5");
  });

  test("非首选不标推荐", () => {
    const text = describeChoice(lanCandidate("192.168.1.9", "以太网"), { best: lanCandidate("10.0.0.5") });
    assert.equal(text, "以太网 · 192.168.1.9");
  });

  test("不是局域网的地址必须明说 —— 教室电脑插着 VPN 时首选地址可能扫了也没用", () => {
    const text = describeChoice({ name: "VPN", address: "10.8.0.2", scope: "other" }, {});
    assert.match(text, /不是局域网地址/);
  });

  test("空输入给空串", () => {
    assert.equal(describeChoice(null), "");
    assert.equal(describeChoice({}), "");
  });
});

describe("paintJoinCard", () => {
  test("有地址时：画二维码、写网址、写说明、写「同一个 Wi-Fi」", () => {
    const qr = fakeCanvas();
    const target = {
      canvas: qr.canvas,
      urlText: { textContent: "" },
      hintText: { textContent: "" },
      noticeText: { textContent: "" },
    };
    const best = lanCandidate("10.0.0.5", "WLAN");

    const painted = paintJoinCard(target, best, { best });

    assert.equal(painted, best);
    assert.equal(target.urlText.textContent, "http://10.0.0.5:3000/m");
    assert.equal(target.hintText.textContent, "推荐 · WLAN · 10.0.0.5");
    assert.equal(target.noticeText.textContent, LAN_NOTICE);
    // 整块静区一笔 + 每个深色模块一笔，远多于 1
    assert.ok(qr.calls.length > 100, `只画了 ${qr.calls.length} 笔`);
    assert.equal(qr.calls[0][0], "fillRect");
  });

  test("没有地址时：清空画布、只留一句解释，返回 null，但「同一个 Wi-Fi」照样写", () => {
    const qr = fakeCanvas();
    const target = {
      canvas: qr.canvas,
      urlText: { textContent: "旧网址" },
      hintText: { textContent: "" },
      noticeText: { textContent: "" },
    };

    assert.equal(paintJoinCard(target, null), null);
    assert.deepEqual(qr.calls, [["clearRect", 0, 0, 176, 176]]);
    assert.equal(target.urlText.textContent, "");
    assert.equal(target.hintText.textContent, NO_ADDRESS_HINT);
    // 一个地址都查不到的时候，学生更得知道是"网不一样"，而不是"我手机有问题"
    assert.equal(target.noticeText.textContent, LAN_NOTICE);
  });

  test("只给了一部分节点也不炸（老师端和投影页挂的东西不一样）", () => {
    assert.doesNotThrow(() => paintJoinCard({}, lanCandidate("10.0.0.5")));
    assert.doesNotThrow(() => paintJoinCard(undefined, null));
    assert.doesNotThrow(() => paintJoinCard({ canvas: { width: 8, height: 8 } }, null));
  });
});

describe("局域网前提那句话", () => {
  // 现场实测（老师报「二维码完全不能用」）之后钉的钉子：二维码里装的是内网地址，
  // 学生手机在移动数据上时公网路由不到，码解得再准也打不开。
  // 这句话是唯一能防住这件事的东西 —— 服务端无从知道手机连在哪个网上。
  test("必须同时点出「同一个 Wi-Fi」和「流量不行」", () => {
    assert.match(LAN_NOTICE, /Wi-?Fi/i);
    assert.match(LAN_NOTICE, /流量/);
  });

  test("不能是空串，也不能是默认隐藏的那种提示", () => {
    assert.ok(LAN_NOTICE.length >= 12, "太短了，讲台上没人看得懂");
  });
});

describe("显隐", () => {
  test("?qr=1 永远钉住，?qr=0 永远不要", () => {
    const late = { force: true, openedAt: 0, now: AUTO_HIDE_MS * 10 };
    assert.equal(joinCardVisible(late), true);
    assert.equal(joinCardVisible({ force: false, openedAt: 0, now: 0 }), false);
  });

  test("默认头两分钟显示，之后就收起来", () => {
    assert.equal(joinCardVisible({ openedAt: 1000, now: 1000 }), true);
    assert.equal(joinCardVisible({ openedAt: 1000, now: 1000 + AUTO_HIDE_MS - 1 }), true);
    assert.equal(joinCardVisible({ openedAt: 1000, now: 1000 + AUTO_HIDE_MS }), false);
  });

  test("parseQrParam 认三种写法，认不出来当没写", () => {
    for (const raw of ["1", "true", "yes"]) assert.equal(parseQrParam(raw), true);
    for (const raw of ["0", "false", "no"]) assert.equal(parseQrParam(raw), false);
    for (const raw of ["", null, undefined, "可能"]) assert.equal(parseQrParam(raw), null);
  });
});
