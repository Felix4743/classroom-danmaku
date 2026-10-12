/**
 * 零依赖 QR 码编码器（技术方案 §4.10：老师屏幕上那个"扫码进课堂"的方块）。
 *
 * 为什么自己写而不是装一个包：教室电脑经常处于"没有外网"的状态（§10.1），
 * 装包这件事在开发机上没问题，在现场机器上就是灾难 —— 所以整个仓库的行
 * 约束是零运行时依赖。二维码又必须有，于是只能自己实现。
 *
 * 实现范围刻意收窄到"这个项目真正用得到的那一支"：
 *   · 编码模式只做 byte mode，不做数字/字母数字/汉字/多段混合。
 *     理由见下面 utf8Bytes() 的注释：课堂地址里一定有小写字母，中文和 emoji
 *     也只有 byte mode 放得下，所以"更省位数的模式"在这里一个都用不上。
 *   · 版本 1..40 全支持（会自动升版），纠错级别 L/M/Q/H 全支持。
 *   · 掩码按规范的四条惩罚分规则逐条算分选最优 —— 掩码选错不会让二维码
 *     "看起来不对"，只会让某些手机在某个角度扫不出来，属于必须照做的一步。
 *
 * 正确性不靠"看着能扫"，靠 tests/unit/qrcode.test.mjs 里那批用参考实现
 * （npm 的 qrcode 包）生成的向量逐模块比对。
 */

export const ECC_LEVELS = ["L", "M", "Q", "H"];

/**
 * 纠错级别 → 格式信息里的 2 位编码（规范 Table 25）。
 *
 * 注意 L=01、Q=11 这两项**不是**按强弱顺序排的，写反了会得到一个"能画出来、
 * 但纠错级别和声明不符"的二维码：解码器读到的级别跟实际编码时用的不一致，
 * 于是它按错误的块结构去分块，直接解不出来。所以这张表按规范原样抄，不排序。
 */
const ECC_FORMAT_BITS = Object.freeze({ L: 1, M: 0, Q: 3, H: 2 });

/**
 * 每个纠错块里的纠错码字数，下标是 version（0 号位不用）。
 *
 * 这张表和下面的分块数是二维码规范里唯一没法推导的部分 —— 它们是 RS 码在
 * 每个版本上的工程取值，只能抄。抄错一行，症状是"某个版本、某个级别的二维码
 * 画得漂漂亮亮但扫不出来"，而且很容易在测试没覆盖到的版本上潜伏很久。
 */
const ECC_CODEWORDS_PER_BLOCK = Object.freeze({
  L: [
    0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
    30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  M: [
    0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  Q: [
    0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
    30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  H: [
    0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
});

/** 纠错块数，下标是 version。同一个级别下块数越多、单块越短，抗局部污损越强。 */
const NUM_ECC_BLOCKS = Object.freeze({
  L: [
    0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  M: [
    0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
    26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  Q: [
    0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
    34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  H: [
    0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37,
    40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
});

/** 掩码惩罚分的四个权重（规范 Table 24）。 */
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/**
 * 把字符串编成 UTF-8 字节。
 *
 * **为什么非得先转字节**：QR 的 byte mode 送出去的是一串字节，而"字符计数
 * 指示符"填的是**字节数**，不是 JS 字符串的 length。一个中文字符在 JS 里是
 * 1 个 code unit、在 UTF-8 里是 3 个字节；直接拿 `text.length` 当计数，
 * 得到的二维码在解码器眼里就是"后面还有 2 个字节的内容"，扫出来是乱码。
 *
 * 自己写而不用 `TextEncoder`，是为了让这段代码在浏览器和 Node 里都只依赖
 * 语言本身 —— 而且这里对"落单的代理项"的处理和 TextEncoder 一致（换成
 * U+FFFD），不会因为某一边的实现差异算出不同的二维码。
 */
function utf8Bytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.codePointAt(i);
    if (cp > 0xffff) i++; // 星形平面字符占两个 code unit，要一起吃掉
    // 没有配对的代理项无法编码成合法 UTF-8，统一按替换字符处理
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;

    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return bytes;
}

/**
 * 一个版本总共能放多少 bit（数据 + 纠错 + 剩余位）。
 *
 * 这里是**算**出来的而不是抄一张 40 行的总码字表：总格数减去功能图案占的格数
 * 就能得到，而抄表就多了一个"某一版抄错一位、只有那个版本悄悄坏掉"的机会。
 * 公式本身（16v+128)v+64）来自规范对格数的计数方式：定位/分隔/格式信息按
 * 版本线性增长，校正图案的数量随版本阶跃。
 */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36; // version information 那两块 6x3
  }
  return result;
}

/**
 * 总码字数（数据 + 纠错）。
 *
 * **这里必须向下取整**：上面的格数并不是 8 的整数倍 —— version 2..6 会多出 7 个
 * "剩余位"、v14..20 多 3 个、v21..27 多 4 个、v28..34 多 3 个。这些余数不参与编码，
 * 但如果不取整，后面每一个"容量够不够"的判断都会偏大 1 个字节左右，于是编码器
 * 会挑一个装不下的版本、或者在铺码字时多铺出一截。第一版就是栽在这里。
 */
function totalCodewords(version) {
  return Math.floor(rawDataModules(version) / 8);
}

/** 数据码字数 = 总码字 - 纠错码字。 */
function dataCodewords(version, ecc) {
  return totalCodewords(version) - ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_ECC_BLOCKS[ecc][version];
}

/**
 * 字符计数指示符的位数。byte mode 在 version 1..9 是 8 位，10 及以上是 16 位。
 *
 * 这个跳变是 QR 里少数"同一个文本在跨版本时编码不同"的地方，也是"17 个字符
 * 刚好卡在 version 1 边界上"这类测试用例要盯的东西。
 */
function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}

/** 某个版本 + 纠错级别下，byte mode 最多能放多少个字节。 */
function byteCapacity(version, ecc) {
  return Math.floor((dataCodewords(version, ecc) * 8 - 4 - charCountBits(version)) / 8);
}

function normalizeEcc(ecc) {
  const level = typeof ecc === "string" ? ecc.toUpperCase() : "";
  if (!ECC_LEVELS.includes(level)) {
    throw new RangeError(
      `未知的纠错级别 ${JSON.stringify(ecc)}，只能是 ${ECC_LEVELS.join(" / ")}`,
    );
  }
  return level;
}

/** 起始版本：非法值按 1 处理，写大了（> 40）说明调用方搞错了，直接报出来。 */
function normalizeMinVersion(value) {
  if (value === undefined || value === null) return 1;
  const version = Math.trunc(Number(value));
  if (!Number.isFinite(version) || version < 1) return 1;
  if (version > 40) throw new RangeError(`QR 版本最大是 40，收到 ${value}`);
  return version;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/**
 * 把字节流装成"数据码字"（规范 8.4）。
 *
 * 顺序不能变：模式指示符 → 字符计数 → 数据 → 终止符 → 补到字节边界 →
 * 用 0xEC/0x11 交替填满。少了"补到字节边界"这一步，后面所有的 RS 分块都会
 * 整体错位 —— 二维码画出来一模一样地好看，但一个都扫不出来。
 */
function buildDataCodewords(bytes, version, ecc) {
  const capacityBits = dataCodewords(version, ecc) * 8;
  const bits = [];

  appendBits(bits, 0b0100, 4); // 0100 = byte mode
  appendBits(bits, bytes.length, charCountBits(version));
  for (const byte of bytes) appendBits(bits, byte, 8);

  // 终止符最多 4 位；剩余的位数不够 4 位时只补到装不下为止
  const terminator = Math.max(0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }

  // 两个填充码字交替，纯粹是为了"避免大片同色模块"影响定位和掩码评分
  const pads = [0xec, 0x11];
  for (let i = 0; codewords.length < dataCodewords(version, ecc); i++) {
    codewords.push(pads[i % 2]);
  }
  return codewords;
}

/**
 * GF(256) 的对数/反对数表，本原多项式 x^8+x^4+x^3+x^2+1（0x11D）。
 *
 * 表开在模块作用域只建一次：RS 编码要按块调用很多次，每次重算表在 version 40
 * 那种 81 块的场景下是纯粹的浪费。
 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** RS 生成多项式 (x-a^0)(x-a^1)...(x-a^(degree-1)) 的系数（省略最高次项）。 */
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** 多项式除法取余，余数就是纠错码字。 */
function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

/**
 * 分块 → 每块算纠错 → **交错**拼回一条码字流。
 *
 * 交错（而不是简单地把各块首尾相接）是二维码抗污损的关键：一块被手指挡住时，
 * 它在码字流里被打散成很多段，每一段都还能靠别的块补回来；如果是首尾相接，
 * 挡住的就是连续一整块，直接超出一个块能纠的上限。
 *
 * 数据码字在块之间不是均分的（总长除不尽时会多出一个"长块"），长块排在后面，
 * 交错时对应位置少一个字节 —— 这个 +1/-1 是最容易写错、且只在部分版本上露馅
 * 的地方，测试向量里特意覆盖了多块的版本。
 */
function interleaveWithEcc(data, version, ecc) {
  const numBlocks = NUM_ECC_BLOCKS[ecc][version];
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[ecc][version];
  const rawCodewords = totalCodewords(version);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccPerBlock);

  const blocks = [];
  for (let i = 0, offset = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - eccPerBlock + (i < numShortBlocks ? 0 : 1);
    const blockData = data.slice(offset, offset + dataLen);
    offset += dataLen;
    blocks.push({ data: blockData, ecc: rsRemainder(blockData, divisor) });
  }

  const result = [];
  const maxDataLen = shortBlockLen - eccPerBlock + 1;
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.data.length) result.push(block.data[i]);
    }
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (const block of blocks) result.push(block.ecc[i]);
  }
  return result;
}

/** 校正图案的中心坐标。位置是规范给的一条经验公式，version 32 是唯一的例外。 */
function alignmentPositions(version, size) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

/** 掩码公式（规范 Table 23）。(x, y) 是列、行。 */
function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x * y) % 3) + ((x + y) % 2)) % 2 === 0;
  }
}

/** 掩码只作用在编码区，功能图案和格式信息一个都不能碰。 */
function applyMask(modules, isFunction, size, mask) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && maskBit(mask, x, y)) modules[y][x] ^= 1;
    }
  }
}

/** 惩罚 1：行/列里连续 5 个以上同色。 */
function penaltyN1(modules, size) {
  let points = 0;
  for (let i = 0; i < size; i++) {
    let sameRow = 0;
    let sameCol = 0;
    let lastRow = -1;
    let lastCol = -1;
    for (let j = 0; j < size; j++) {
      let module = modules[i][j];
      if (module === lastRow) sameRow++;
      else {
        if (sameRow >= 5) points += PENALTY_N1 + (sameRow - 5);
        lastRow = module;
        sameRow = 1;
      }

      module = modules[j][i];
      if (module === lastCol) sameCol++;
      else {
        if (sameCol >= 5) points += PENALTY_N1 + (sameCol - 5);
        lastCol = module;
        sameCol = 1;
      }
    }
    if (sameRow >= 5) points += PENALTY_N1 + (sameRow - 5);
    if (sameCol >= 5) points += PENALTY_N1 + (sameCol - 5);
  }
  return points;
}

/** 惩罚 2：2x2 的同色方块（成片色块的密度）。 */
function penaltyN2(modules, size) {
  let points = 0;
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const sum =
        modules[y][x] + modules[y][x + 1] + modules[y + 1][x] + modules[y + 1][x + 1];
      if (sum === 4 || sum === 0) points++;
    }
  }
  return points * PENALTY_N2;
}

/**
 * 惩罚 3：编码区里出现"像定位图案"的 1:1:3:1:1 条纹。
 *
 * 用 11 位滑窗去匹配 10111010000 / 00001011101，等价于"1:1:3:1:1 且一侧有
 * 4 个浅色模块"。这类假图案会让解码器在一个错误的位置开始找定位点，是实际
 * 扫码失败里最常见的成因之一，所以它单独占 40 分（N1 的 13 倍）。
 */
function penaltyN3(modules, size) {
  let points = 0;
  for (let i = 0; i < size; i++) {
    let bitsRow = 0;
    let bitsCol = 0;
    for (let j = 0; j < size; j++) {
      bitsRow = ((bitsRow << 1) & 0x7ff) | modules[i][j];
      if (j >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points++;

      bitsCol = ((bitsCol << 1) & 0x7ff) | modules[j][i];
      if (j >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points++;
    }
  }
  return points * PENALTY_N3;
}

/** 惩罚 4：整体深浅比例偏离 50%。 */
function penaltyN4(modules, size) {
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) dark += modules[y][x];
  }
  const total = size * size;
  const k = Math.abs(Math.ceil(((dark * 100) / total) / 5) - 10);
  return k * PENALTY_N4;
}

function penaltyScore(modules, size) {
  return penaltyN1(modules, size) + penaltyN2(modules, size) + penaltyN3(modules, size) + penaltyN4(modules, size);
}

/**
 * 15 位格式信息：2 位纠错级别 + 3 位掩码，加 10 位 BCH 校验，最后异或 0x5412
 * （规范 8.9）。异或那一步是为了防止"全 0 的格式信息"出现 —— 全 0 在扫描
 * 时看起来像一片空白。
 */
function formatBits(ecc, mask) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18 位版本信息（只有 version >= 7 才有）：6 位版本号 + 12 位 BCH 校验。 */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function createSymbol(version, ecc, codewords) {
  const size = version * 4 + 17;
  const modules = [];
  const isFunction = [];
  for (let y = 0; y < size; y++) {
    modules.push(new Array(size).fill(0));
    isFunction.push(new Array(size).fill(false));
  }

  const setFunction = (x, y, dark) => {
    modules[y][x] = dark ? 1 : 0;
    isFunction[y][x] = true;
  };

  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };

  const drawAlignment = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  const drawFormatBits = (mask) => {
    const bits = formatBits(ecc, mask);
    for (let i = 0; i < 15; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      // 第一份：左上角定位图案的两条边
      if (i < 6) setFunction(8, i, dark);
      else if (i < 8) setFunction(8, i + 1, dark);
      else setFunction(8, size - 15 + i, dark);
      // 第二份：右上角一行 + 左下角一列
      if (i < 8) setFunction(size - 1 - i, 8, dark);
      else if (i < 9) setFunction(7, 8, dark);
      else setFunction(14 - i, 8, dark);
    }
    setFunction(8, size - 8, true); // 固定深色模块，规范要求它永远是深的
  };

  // 定时图案先画，随后三个定位图案会把它两端覆盖掉 —— 顺序反过来会留下断口
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  const alignPositions = alignmentPositions(version, size);
  for (const cy of alignPositions) {
    for (const cx of alignPositions) {
      // 三个角上的位置已经被定位图案占了
      if (cx === 6 && cy === 6) continue;
      if (cx === 6 && cy === size - 7) continue;
      if (cx === size - 7 && cy === 6) continue;
      drawAlignment(cx, cy);
    }
  }

  // 先用占位值把格式信息那块"占住"，掩码才不会写到里面去；真正的值在选完掩码后写
  drawFormatBits(0);

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }

  // 码字按"从右下角出发、两列一组 Z 字形上下走"的顺序铺进编码区
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 第 6 列是定时图案，跳过
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y][x] || bitIndex >= totalBits) continue;
        modules[y][x] = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
        bitIndex++;
      }
    }
  }

  // 逐个掩码试算惩罚分，取最低的那个。掩码选错不影响"能不能解"，但会明显
  // 影响"好不好扫" —— 所以规范把这一步定成了必须做的评分，而不是随便挑一个。
  let bestMask = 0;
  let lowestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    drawFormatBits(mask);
    applyMask(modules, isFunction, size, mask);
    const penalty = penaltyScore(modules, size);
    applyMask(modules, isFunction, size, mask); // 撤销，试下一个
    if (penalty < lowestPenalty) {
      lowestPenalty = penalty;
      bestMask = mask;
    }
  }

  applyMask(modules, isFunction, size, bestMask);
  drawFormatBits(bestMask);

  return { mask: bestMask, modules, size };
}

/**
 * 编码成模块矩阵。
 *
 * @param {string} text 任意文本，内部按 UTF-8 编成 byte mode
 * @param {{ecc?: string, minVersion?: number}} [options] ecc 默认 M；minVersion 用于
 *   "必须至少有这么大"的场景（留在外面贴一圈标题时希望码点大一点）
 * @returns {{version: number, size: number, ecc: string, mask: number, modules: number[][]}}
 *   modules 是 size 行 × size 列，1 = 深色
 */
export function encodeQr(text, { ecc = "M", minVersion = 1 } = {}) {
  const level = normalizeEcc(ecc);
  const start = normalizeMinVersion(minVersion);
  const bytes = utf8Bytes(text === undefined || text === null ? "" : String(text));

  // 容量不够就一路升版。byte mode 只在 version 1..9 和 10..40 之间跳变一次位数，
  // 逐版试探最多 40 次，比推公式更不容易写错
  let version = 0;
  for (let v = start; v <= 40; v++) {
    if (byteCapacity(v, level) <= 0) continue;
    if (byteCapacity(v, level) >= bytes.length) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    throw new RangeError(
      `文本太长：UTF-8 编码后 ${bytes.length} 字节，纠错级别 ${level} 在 version 40 下最多 ${byteCapacity(40, level)} 字节`,
    );
  }

  const codewords = interleaveWithEcc(buildDataCodewords(bytes, version, level), version, level);
  const { mask, modules, size } = createSymbol(version, level, codewords);
  return { version, size, ecc: level, mask, modules };
}

/**
 * 每个模块画几像素。
 *
 * 显式给了 scale 就用它（向下取整成整数像素，否则 canvas 上的方块边界会有
 * 半像素的模糊）；只给了宽度就按"整张图刚好塞得下"取整 —— 取整而不是取精确值，
 * 是为了不让二维码被画在非整数像素上，那样模块边缘会糊，扫描识别率会掉。
 */
function resolveScale(options, total, canvasWidth) {
  const explicit = options.scale;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 1) {
    return Math.floor(explicit);
  }
  const width = options.width ?? options.canvasWidth ?? options.canvas?.width ?? canvasWidth;
  if (typeof width === "number" && Number.isFinite(width) && width > 0) {
    return Math.max(1, Math.floor(width / total));
  }
  return 1;
}

/**
 * 只算几何，不画。
 *
 * 单独拿出来的用途有两个：调用方要先知道"这块画布够不够大、二维码会占多少像素"
 * 才能排版；测试里也可以完全绕开 canvas 验证 scale 的取整规则。
 */
export function qrLayout(text, options = {}) {
  const margin = options.margin ?? 4;
  const { version, size, ecc } = encodeQr(text, {
    ecc: options.ecc,
    minVersion: options.minVersion,
  });
  const total = size + margin * 2;
  return { version, size, total, scale: resolveScale(options, total), margin, ecc };
}

/**
 * 画到 canvas 上。
 *
 * 先把整块画布（含静区）涂成浅色，再只画深色模块：深色模块的数量直接等于矩阵里
 * 1 的个数，测试能一眼对账。反过来"浅色模块也逐个画"会多画上千个方块，投影页面
 * 每次重绘都要多花几毫秒，而这几毫秒本来是留给弹幕的。
 *
 * @returns {object} qrLayout 的那几个字段，外加 qr（完整矩阵，供调用方复用）
 */
export function drawQr(canvas, text, options = {}) {
  const { margin = 4, dark = "#0b0d12", light = "#ffffff" } = options;
  const qr = encodeQr(text, { ecc: options.ecc, minVersion: options.minVersion });
  const total = qr.size + margin * 2;
  // 传进 canvas.width：调用方通常什么都不给，就指望"按画布大小自己撑满"
  const scale = resolveScale(options, total, canvas.width);
  const ctx = canvas.getContext("2d");
  const width = canvas.width || total * scale;

  ctx.fillStyle = light;
  ctx.fillRect(0, 0, width, canvas.height || width);

  ctx.fillStyle = dark;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x] === 1) ctx.fillRect((margin + x) * scale, (margin + y) * scale, scale, scale);
    }
  }

  return { version: qr.version, size: qr.size, total, scale, margin, ecc: qr.ecc, qr };
}
