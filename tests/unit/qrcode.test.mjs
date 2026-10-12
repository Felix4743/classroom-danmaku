/**
 * 零依赖二维码编码器（技术方案 §4.10）。
 *
 * 二维码最坑的地方是"看起来能跑"和"扫得出来"之间没有肉眼可见的差别：
 * 掩码选错、交错顺序写反、纠错表抄错一行，画出来都是一张很像二维码的图，
 * 但手机就是识别不了。所以这一组测试不测"函数返回了对象"，而是拿
 * npm 的 qrcode 包（装在仓库外面的临时目录里，只用来生成数据）产出的
 * 每一张矩阵，**逐模块**比对 —— 一个模块不同就报出坐标。
 *
 * 向量固化在 tests/fixtures/qr-vectors.json 里：固化的是数据，不是依赖。
 * 这个文件里没有 qrcode、也不联网。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ECC_LEVELS, drawQr, encodeQr, qrLayout } from "../../src/shared/qrcode.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/qr-vectors.json", import.meta.url), "utf8"));
const vectors = fixture.vectors;

/** 格式信息里纠错级别的 2 位编码（规范 Table 25），独立于实现抄一遍用来对账。 */
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/** 把向量的位打包 base64 还原成 size × size 的模块矩阵。 */
function unpack(vector) {
  const bytes = Buffer.from(vector.bits, "base64");
  const modules = [];
  let index = 0;
  for (let y = 0; y < vector.size; y++) {
    const row = [];
    for (let x = 0; x < vector.size; x++) {
      row.push((bytes[index >> 3] >> (7 - (index & 7))) & 1);
      index++;
    }
    modules.push(row);
  }
  return modules;
}

/** 逐模块比对。不一致时报出第一个不同的坐标，否则调试只能靠猜。 */
function assertSameMatrix(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: 行数不一致`);
  for (let y = 0; y < expected.length; y++) {
    assert.equal(actual[y].length, expected[y].length, `${label}: 第 ${y} 行列数不一致`);
    for (let x = 0; x < expected[y].length; x++) {
      if (actual[y][x] !== expected[y][x]) {
        assert.fail(
          `${label}: 第一个不同的模块在 (x=${x}, y=${y})，本实现 ${actual[y][x]}，参考实现 ${expected[y][x]}`,
        );
      }
    }
  }
}

/** 造一个只记录 fillRect 的假 canvas —— 验证绘制几何不需要真的 DOM。 */
function fakeCanvas(width, height = width) {
  const calls = [];
  const context = {
    fillStyle: "#000000",
    fillRect(x, y, w, h) {
      calls.push({ style: this.fillStyle, x, y, w, h });
    },
  };
  return {
    calls,
    canvas: { width, height, getContext: (kind) => (kind === "2d" ? context : null) },
  };
}

function findVector(name) {
  const vector = vectors.find((item) => item.name === name);
  assert.ok(vector, `向量 ${name} 不见了`);
  return vector;
}

// ---------------------------------------------------------------- 向量本体

test("向量集本身：条数、纠错级别、版本跨度都够用", () => {
  assert.ok(vectors.length >= 10, `至少要有 10 组向量，现在只有 ${vectors.length}`);
  assert.deepEqual([...new Set(vectors.map((v) => v.ecc))].sort(), ["H", "L", "M", "Q"]);
  assert.ok(vectors.some((v) => v.version >= 7), "要有一条覆盖 version information 的向量");
  assert.ok(vectors.some((v) => v.version >= 10), "要有一条覆盖 16 位字符计数的向量");
  assert.ok(vectors.some((v) => v.version >= 32), "要有一条覆盖校正图案间距特例的向量");
  assert.ok(new Set(vectors.map((v) => v.bytes)).size >= 8, "向量的长度要够分散");

  for (const vector of vectors) {
    assert.equal(vector.size, 17 + 4 * vector.version, `${vector.name}: size 与 version 对不上`);
    assert.ok(vector.mask >= 0 && vector.mask <= 7, `${vector.name}: 掩码越界`);
    assert.equal(
      createHash("sha256").update(vector.bits).digest("hex"),
      vector.sha256,
      `${vector.name}: 向量文件里的哈希与数据对不上（文件被改坏了？）`,
    );
    assert.equal(unpack(vector).length, vector.size, `${vector.name}: 解包出来的行数不对`);
  }
});

for (const vector of vectors) {
  test(`与参考实现逐模块一致：${vector.name}`, () => {
    const expected = unpack(vector);
    const qr = encodeQr(vector.text, { ecc: vector.ecc, minVersion: vector.minVersion });

    assert.equal(qr.version, vector.version, `${vector.name}: 版本选错了`);
    assert.equal(qr.size, vector.size, `${vector.name}: 尺寸不对`);
    assert.equal(qr.size, 17 + 4 * qr.version, `${vector.name}: size 必须等于 17 + 4 * version`);
    assert.equal(qr.ecc, vector.ecc, `${vector.name}: 纠错级别被改过`);
    assert.equal(qr.mask, vector.mask, `${vector.name}: 掩码选错了（惩罚分算得不一样？）`);
    assignOnlyBinary(qr.modules, vector.name);
    assertSameMatrix(qr.modules, expected, vector.name);
  });
}

/** 矩阵里只能有 0 和 1，出现别的值说明某处做了算术而不是位运算。 */
function assignOnlyBinary(modules, label) {
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < modules[y].length; x++) {
      assert.ok(modules[y][x] === 0 || modules[y][x] === 1, `${label}: (${x},${y}) 的值是 ${modules[y][x]}`);
    }
  }
}

// ------------------------------------------------------------ 功能图案结构

test("功能图案：定位、分隔、定时、校正、格式信息、深色模块", () => {
  for (const vector of vectors) {
    const { modules, size, mask, version } = encodeQr(vector.text, {
      ecc: vector.ecc,
      minVersion: vector.minVersion,
    });
    const at = (x, y) => modules[y][x];
    const name = vector.name;

    // 三个定位图案：7x7，中心 3x3 深色、外圈深色、中间一圈浅色
    for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          assert.equal(at(ox + dx, oy + dy), ring === 2 ? 0 : 1, `${name}: 定位图案 (${ox + dx},${oy + dy})`);
        }
      }
    }

    // 定位图案外侧的分隔符必须全是浅色，否则解码器定位不到边界
    for (let i = 0; i < 8; i++) {
      assert.equal(at(i, 7), 0, `${name}: 左上分隔符 (${i},7)`);
      assert.equal(at(7, i), 0, `${name}: 左上分隔符 (7,${i})`);
      assert.equal(at(size - 1 - i, 7), 0, `${name}: 右上分隔符 (${size - 1 - i},7)`);
      assert.equal(at(size - 8, i), 0, `${name}: 右上分隔符 (${size - 8},${i})`);
      assert.equal(at(i, size - 8), 0, `${name}: 左下分隔符 (${i},${size - 8})`);
      assert.equal(at(7, size - 1 - i), 0, `${name}: 左下分隔符 (7,${size - 1 - i})`);
    }

    // 定时图案：第 6 行/列从 8 到 size-9 严格深浅交替，且两端都从深色开始
    for (let i = 8; i <= size - 9; i++) {
      const want = i % 2 === 0 ? 1 : 0;
      assert.equal(at(i, 6), want, `${name}: 横向定时图案 (${i},6)`);
      assert.equal(at(6, i), want, `${name}: 纵向定时图案 (6,${i})`);
    }

    // 右下角的校正图案（version >= 2 才有）：5x5，同样是"深-浅-深"
    if (version >= 2) {
      const c = size - 7;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          assert.equal(
            at(c + dx, c + dy),
            Math.max(Math.abs(dx), Math.abs(dy)) === 1 ? 0 : 1,
            `${name}: 右下校正图案 (${c + dx},${c + dy})`,
          );
        }
      }
    }

    // 固定深色模块：规范要求它永远是深的，用来给解码器定方向
    assert.equal(at(8, size - 8), 1, `${name}: 固定深色模块 (8,${size - 8})`);

    // 格式信息两份必须一致，而且能独立读回纠错级别和掩码
    const formatA = [];
    const formatB = [];
    for (let i = 0; i < 15; i++) {
      if (i < 6) formatA.push(at(8, i));
      else if (i < 8) formatA.push(at(8, i + 1));
      else formatA.push(at(8, size - 15 + i));
      if (i < 8) formatB.push(at(size - 1 - i, 8));
      else if (i < 9) formatB.push(at(7, 8));
      else formatB.push(at(14 - i, 8));
    }
    assert.deepEqual(formatA, formatB, `${name}: 格式信息的两份拷贝不一致`);
    let formatValue = 0;
    for (let i = 0; i < 15; i++) formatValue |= formatA[i] << i;
    const payload = (formatValue ^ 0x5412) >> 10; // 去掉固定的掩码 0x5412
    assert.equal(payload >> 3, ECC_FORMAT_BITS[vector.ecc], `${name}: 格式信息里的纠错级别不对`);
    assert.equal(payload & 0x07, mask, `${name}: 格式信息里的掩码与返回值不一致`);

    // version information（version >= 7）：两块必须一致，且能读回版本号
    if (version >= 7) {
      const versionA = [];
      const versionB = [];
      for (let i = 0; i < 18; i++) {
        versionA.push(at(size - 11 + (i % 3), Math.floor(i / 3)));
        versionB.push(at(Math.floor(i / 3), size - 11 + (i % 3)));
      }
      assert.deepEqual(versionA, versionB, `${name}: version information 的两块不一致`);
      // 18 位里高 6 位是版本号、低 12 位是 BCH 校验，位置按低位在前铺进 3x6 的块
      let value = 0;
      for (let i = 0; i < 18; i++) value |= versionA[i] << i;
      assert.equal(value >>> 12, version, `${name}: version information 里读不回版本号`);
    }
  }
});

// ------------------------------------------------------------------ 行为面

test("ECC_LEVELS 就是 L / M / Q / H 这四个", () => {
  assert.deepEqual([...ECC_LEVELS], ["L", "M", "Q", "H"]);
});

test("纠错级别不同，矩阵就一定不同", () => {
  const text = "http://10.0.0.1:3000/m";
  const rendered = ECC_LEVELS.map((ecc) => encodeQr(text, { ecc }).modules.map((row) => row.join("")).join("\n"));
  for (let i = 0; i < rendered.length; i++) {
    for (let j = i + 1; j < rendered.length; j++) {
      assert.notEqual(rendered[i], rendered[j], `${ECC_LEVELS[i]} 和 ${ECC_LEVELS[j]} 画出来一样，纠错级别没生效`);
    }
  }
});

test("确定性：同样的输入调两次，结果必须一模一样", () => {
  const text = "课堂弹幕：同学们好😀";
  const first = encodeQr(text, { ecc: "Q" });
  // 中间插一次别的调用，确认没有跨调用残留的模块状态
  encodeQr("http://10.0.0.1:3000/m", { ecc: "L" });
  const second = encodeQr(text, { ecc: "Q" });
  assert.deepEqual(second, first);
});

test("minVersion：只会往上顶，不会把版本压下来", () => {
  const vector = findVector("bytes-100-M");
  const auto = encodeQr(vector.text, { ecc: "M" });
  assert.equal(auto.version, vector.version);

  // 要求一个更大的版本时必须照办（外面要留标题的位置，希望码点更密）
  const forced = encodeQr(vector.text, { ecc: "M", minVersion: vector.version + 3 });
  assert.equal(forced.version, vector.version + 3);
  assert.equal(forced.size, 17 + 4 * (vector.version + 3));

  // 要求一个更小的版本时，容量说了算
  const raised = encodeQr(vector.text, { ecc: "M", minVersion: 1 });
  assert.equal(raised.version, vector.version);

  assert.throws(() => encodeQr("a", { minVersion: 41 }), RangeError);
  assert.throws(() => encodeQr("a", { ecc: "X" }), RangeError);
});

test("容量不够时抛 RangeError，而不是画出一张错的码", () => {
  assert.throws(() => encodeQr("a".repeat(3000), { ecc: "H" }), RangeError);
  assert.throws(() => encodeQr("a".repeat(5000), { ecc: "L" }), RangeError);

  // 边界：version 40-L 正好装 2953 字节，多一个字节就没救了
  assert.equal(encodeQr("a".repeat(2953), { ecc: "L" }).version, 40);
  assert.throws(() => encodeQr("a".repeat(2954), { ecc: "L" }), /version 40|太长|RangeError/);
});

test("空串、emoji、中文混排都不崩", () => {
  const empty = encodeQr("");
  assert.equal(empty.version, 1);
  assert.equal(empty.size, 21);
  assignOnlyBinary(empty.modules, "空串");
  assert.deepEqual(encodeQr(""), empty);

  const emoji = encodeQr("弹幕😀🚀", { ecc: "M" });
  assert.equal(emoji.version, 1);
  assert.equal(emoji.size, 21);

  // 同一个字符数下，emoji 因为编成 4 字节会更快把 version 顶上去
  const shortText = encodeQr("abc", { ecc: "H" });
  const longEmoji = encodeQr("😀".repeat(30), { ecc: "H" });
  assert.ok(longEmoji.version > shortText.version);

  const mixed = encodeQr("课堂弹幕系统：请用手机扫码发送弹幕。", { ecc: "Q" });
  assert.equal(mixed.size, 17 + 4 * mixed.version);
});

// ------------------------------------------------------------------ 排版

test("qrLayout：total 与 scale 的计算", () => {
  const base = qrLayout("a", { ecc: "M" });
  assert.equal(base.version, 1);
  assert.equal(base.size, 21);
  assert.equal(base.margin, 4);
  assert.equal(base.total, 29);
  assert.equal(base.scale, 1, "没给画布宽度时退回 1 像素");
  assert.equal(base.ecc, "M");

  assert.equal(qrLayout("a", { margin: 0 }).total, 21);
  assert.equal(qrLayout("a", { margin: 1 }).total, 23);
  assert.equal(qrLayout("a", { scale: 7 }).scale, 7);
  assert.equal(qrLayout("a", { scale: 3.9 }).scale, 3, "像素必须是整数，向下取整");
  assert.equal(qrLayout("a", { scale: 0 }).scale, 1, "scale 给 0 视为没给");
  assert.equal(qrLayout("a", { width: 290 }).scale, 10, "290 / 29 刚好整除");
  assert.equal(qrLayout("a", { width: 289 }).scale, 9, "除不尽要向下取整，否则会画出画布");
  assert.equal(qrLayout("a", { width: 28 }).scale, 1, "再小也要留 1 像素");
  assert.equal(qrLayout("a", { scale: 5, width: 290 }).scale, 5, "显式 scale 优先于宽度");

  const url = qrLayout("http://10.0.0.1:3000/m", { ecc: "H" });
  assert.equal(url.version, 3);
  assert.equal(url.size, 29);
  assert.equal(url.total, 37);
  assert.equal(url.ecc, "H");
  assert.equal(url.scale, 1);
});

// ------------------------------------------------------------------ 绘制

test("drawQr：第一笔铺满静区，之后每个深色模块一个 scale×scale 的方块", () => {
  const { canvas, calls } = fakeCanvas(290, 290);
  const layout = drawQr(canvas, "a", { ecc: "M", margin: 4, scale: 10 });
  const qr = encodeQr("a", { ecc: "M" });

  assert.equal(layout.scale, 10);
  assert.equal(layout.total, qr.size + 8);
  assert.equal(layout.version, qr.version);
  assert.equal(layout.ecc, qr.ecc);
  assert.deepEqual(layout.qr.modules, qr.modules, "drawQr 应当把矩阵一并还回来，省得调用方再算一遍");

  const dark = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.modules[y][x] === 1) dark.push([x, y]);
  }

  assert.equal(calls.length, dark.length + 1, "深色方块的数量必须正好等于矩阵里 1 的个数");
  assert.deepEqual(calls[0], { style: "#ffffff", x: 0, y: 0, w: 290, h: 290 }, "第一笔必须是整块浅色底");
  for (let i = 0; i < dark.length; i++) {
    const [x, y] = dark[i];
    assert.deepEqual(
      calls[i + 1],
      { style: "#0b0d12", x: (4 + x) * 10, y: (4 + y) * 10, w: 10, h: 10 },
      `第 ${i + 1} 笔对应的模块 (${x},${y}) 画错了`,
    );
  }
});

test("drawQr：scale 没给就按画布宽度取整，颜色可以覆盖", () => {
  const sized = fakeCanvas(116, 116); // 29 个模块 * 4 像素
  const layout = drawQr(sized.canvas, "a", {});
  assert.equal(layout.total, 29);
  assert.equal(layout.scale, 4);
  assert.equal(sized.calls[0].w, 116);

  const tight = fakeCanvas(20, 20); // 画布比 total 还小
  assert.equal(drawQr(tight.canvas, "a", {}).scale, 1);

  const colored = fakeCanvas(58, 58);
  drawQr(colored.canvas, "a", { scale: 2, dark: "#123456", light: "#fedcba", margin: 0 });
  assert.equal(colored.calls[0].style, "#fedcba");
  assert.equal(colored.calls[1].style, "#123456");
  assert.deepEqual(colored.calls[1].w, 2);
  assert.deepEqual(colored.calls[1].h, 2);
});

test("drawQr：容量不够时同样抛 RangeError", () => {
  const { canvas } = fakeCanvas(200, 200);
  assert.throws(() => drawQr(canvas, "a".repeat(5000), { ecc: "H" }), RangeError);
});

// ------------------------------------------------------------------ 回归钉

/**
 * 这几个哈希是"上一次确认过能扫"的编码结果的指纹。哪天有人"顺手优化"了
 * 掩码评分、交错顺序或者填充码字，这几行会立刻变红 —— 而如果只靠肉眼看图，
 * 这种改动是发现不了的。
 */
const PINS = {
  "http://10.0.0.1:3000/m|M": "9d5aa13fa3826814d7a6fcb1a6c77b06b6d27ac3101e72862b29e5187d35e899",
  "课堂弹幕：同学们好|M": "43eab49511e281c904cfdf05d48fbdf7cb14149d3cdcd4f521b1f8386c8e603c",
};

test("回归钉：编码结果一旦被改动就必须报警", () => {
  for (const [key, expected] of Object.entries(PINS)) {
    const separator = key.lastIndexOf("|");
    const text = key.slice(0, separator);
    const ecc = key.slice(separator + 1);
    const qr = encodeQr(text, { ecc });
    const digest = createHash("sha256")
      .update(qr.modules.map((row) => row.join("")).join("\n"))
      .digest("hex");
    assert.equal(digest, expected, `${JSON.stringify(text)} 在纠错级别 ${ecc} 下的矩阵指纹变了`);
  }
});
