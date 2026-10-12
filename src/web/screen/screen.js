/**
 * V0 手感调参页。
 *
 * 目标只有一个：把「弹幕的手感」调出来（产品文档 8.1 / 技术方案 §10）。
 * 所以这个页面上没有服务端、没有学生、没有身份 —— 自己给自己发弹幕，
 * 五个滑块实时生效，右上角盯着帧率。
 */

import { CONFIG_LIMITS, DEFAULT_CONFIG } from "../../shared/config.js";
import { CanvasDanmakuView, DanmakuEngine, FpsMeter, fontOf } from "../../overlay/engine.js";

const canvas = document.getElementById("stage");

// 宽度测量必须用真实的 2D context，且字体要和渲染时完全一致，否则轨道分配会算错
const ruler = document.createElement("canvas").getContext("2d");
function measureText(text, fontSize) {
  ruler.font = fontOf(fontSize);
  return ruler.measureText(text).width;
}

const engine = new DanmakuEngine({ measureText });
const view = new CanvasDanmakuView(canvas, engine);
const fps = new FpsMeter(180);

function resize() {
  const size = view.resize();
  document.getElementById("hud-dpr").textContent = size.dpr.toFixed(2);
  document.getElementById("hud-lanes").textContent = String(engine.laneCount);
}
window.addEventListener("resize", resize);
resize();

// ── 演示文本池 ───────────────────────────────────────────────────────────────

const SAMPLES = [
  "这里没听懂",
  "老师能再讲一遍吗",
  "举个栗子",
  "前面的公式能写慢一点吗",
  "2333333",
  "为什么这里要取极限",
  "这个和上一章有什么关系",
  "后排看不见板书",
  "懂了懂了",
  "考试会考这个吗",
  "这个结论的适用条件是什么",
  "求个例子",
  "老师你话筒没声了",
  "第三行那个等号是怎么来的",
  "刚才那段能再放一次吗",
  "原来如此",
];

function randomText() {
  return SAMPLES[Math.floor(Math.random() * SAMPLES.length)];
}

// ── 主循环（§4.2.1） ─────────────────────────────────────────────────────────

let paused = false;
let demo = false;
let demoTimer = 0;
let lastFrameAt = 0;

function frame(now) {
  fps.tick(now);
  if (!paused) {
    engine.update(now);
    if (demo && now - demoTimer > 350) {
      demoTimer = now;
      engine.push({ text: randomText() }, now);
    }
  }
  view.render();
  if (now - lastFrameAt > 250) {
    lastFrameAt = now;
    updateHud();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function updateHud() {
  const f = fps.stats();
  const s = engine.summary();
  document.getElementById("hud-fps").textContent = f.fps.toFixed(0);
  document.getElementById("hud-p95").textContent = f.p95Ms.toFixed(1);
  document.getElementById("hud-active").textContent = String(s.active);
  document.getElementById("hud-waiting").textContent = String(s.waiting);
  document.getElementById("hud-dropped").textContent = String(s.dropped);
}

// ── 五个手感滑块（§4.2.2） ───────────────────────────────────────────────────

const slidersBox = document.getElementById("sliders");
const sliderInputs = new Map();

for (const [key, limit] of Object.entries(CONFIG_LIMITS)) {
  const wrap = document.createElement("div");
  wrap.className = "slider";
  wrap.innerHTML = `
    <div class="slider-head">
      <span>${limit.label}</span>
      <b><span data-value="${key}">${DEFAULT_CONFIG[key]}</span>${limit.unit}</b>
    </div>
  `;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(limit.min);
  input.max = String(limit.max);
  input.step = String(limit.step);
  input.value = String(DEFAULT_CONFIG[key]);
  input.dataset.configKey = key;
  input.addEventListener("input", () => {
    const patch = { [key]: Number(input.value) };
    engine.setConfig(patch);
    wrap.querySelector(`[data-value="${key}"]`).textContent = input.value;
    document.getElementById("hud-lanes").textContent = String(engine.laneCount);
    if (benchRunning) finishBench("参数已改动，压测作废");
  });
  wrap.appendChild(input);
  slidersBox.appendChild(wrap);
  sliderInputs.set(key, input);
}

function applyDefaults() {
  engine.setConfig({ ...DEFAULT_CONFIG });
  for (const [key, input] of sliderInputs) {
    input.value = String(DEFAULT_CONFIG[key]);
    document.querySelector(`[data-value="${key}"]`).textContent = input.value;
  }
  document.getElementById("hud-lanes").textContent = String(engine.laneCount);
}

// ── 控件 ─────────────────────────────────────────────────────────────────────

const textInput = document.getElementById("text");
const form = document.getElementById("panel");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  send(textInput.value);
  textInput.value = "";
});

document.querySelectorAll(".preset").forEach((button) => {
  button.addEventListener("click", () => send(button.textContent, button.dataset.preset));
});

function send(text, presetId) {
  const value = String(text ?? "").trim();
  if (!value) return;
  engine.push({ text: value, presetId: presetId ?? null }, performance.now());
}

document.getElementById("clear").addEventListener("click", () => engine.clear());

const pauseButton = document.getElementById("pause");
pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.textContent = paused ? "继续" : "暂停";
  pauseButton.classList.toggle("on", paused);
  // 恢复时丢弃暂停期间的时间，否则弹幕会瞬移（§4.2.1 的 dt 夹紧只兜 50ms）
  engine.resetClock();
});

const demoButton = document.getElementById("demo");
demoButton.addEventListener("click", () => {
  demo = !demo;
  demoTimer = 0;
  demoButton.classList.toggle("on", demo);
});

document.getElementById("reset").addEventListener("click", applyDefaults);

const panel = document.getElementById("panel");
const hideButton = document.getElementById("hide");
function togglePanel() {
  panel.hidden = !panel.hidden;
}
hideButton.addEventListener("click", togglePanel);
window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === "h" || event.key === "H") togglePanel();
});

// ── 性能基线：100 条同屏（§8.5） ─────────────────────────────────────────────

const benchButton = document.getElementById("bench");
const banner = document.getElementById("banner");
const verdict = document.getElementById("verdict");
const BENCH_COUNT = 100;
const BENCH_SECONDS = 10;
const FPS_TARGET = 55;
let benchRunning = false;
let benchTimer = 0;

benchButton.addEventListener("click", () => {
  if (benchRunning) {
    finishBench("已手动中止");
    return;
  }
  demo = false;
  demoButton.classList.remove("on");
  engine.setBench(true);
  engine.clear();
  fps.reset();
  banner.hidden = false;
  benchButton.classList.add("on");
  benchButton.textContent = "中止压测";
  verdict.hidden = true;
  benchRunning = true;

  const now = performance.now();
  for (let i = 0; i < BENCH_COUNT; i++) {
    engine.push({ text: randomText() }, now);
  }

  benchTimer = setTimeout(() => {
    const f = fps.stats();
    const target = f.fps >= FPS_TARGET;
    const detail =
      `压测 ${BENCH_COUNT} 条同屏 · 采样 ${BENCH_SECONDS} 秒：` +
      `平均 ${f.fps.toFixed(1)} fps，平均帧时间 ${f.avgMs.toFixed(1)} ms，` +
      `p95 ${f.p95Ms.toFixed(1)} ms → ${target ? "达标" : "未达标"}`;
    finishBench(null, detail, target);
  }, BENCH_SECONDS * 1000);
});

function finishBench(note, detail, pass) {
  if (!benchRunning) return;
  benchRunning = false;
  clearTimeout(benchTimer);
  benchButton.classList.remove("on");
  benchButton.textContent = "压测 100 条";
  banner.hidden = true;
  engine.setBench(false);
  fps.reset();
  verdict.hidden = false;
  verdict.className = `verdict${pass === true ? " pass" : pass === false ? " fail" : ""}`;
  verdict.textContent = note ?? detail;
}
