/**
 * 启动窗的纯逻辑（技术方案 §7.4）。
 *
 * 这个窗口存在的意义是"双击之后老师能看见点什么"，所以这里钉住的正是那两件
 * 最容易和页面那边写岔的事：**打开的是哪个地址**（错一个字符就看不到那条
 * "关掉不影响上课"）和**窗口够不够大**（老师端是竖排页面，太窄会把二维码和
 * 按钮挤出可视区）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONSOLE_WINDOW_SIZE,
  CONSOLE_WINDOW_TITLE,
  consoleWindowOptions,
  consoleWindowUrl,
} from "../../src/main/console-window.js";

test("启动窗：默认打开老师端，welcome 由开关决定", () => {
  assert.equal(consoleWindowUrl("http://192.168.1.5:3000"), "http://192.168.1.5:3000/host/");
  assert.equal(
    consoleWindowUrl("http://192.168.1.5:3000", { welcome: true }),
    "http://192.168.1.5:3000/host/?welcome=1",
  );
});

test("启动窗：老师端地址带不带尾部斜杠都要拼对一个斜杠", () => {
  // `classroom.url` 没有尾斜杠，但这里必须自己吃掉多余的：
  // 拼成 `//host/` 在静态服务里是 404，老师看到的会是一个空白窗口
  assert.equal(consoleWindowUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000/host/");
  assert.equal(
    consoleWindowUrl("http://127.0.0.1:3000///", { welcome: true }),
    "http://127.0.0.1:3000/host/?welcome=1",
  );
});

test("启动窗：没有地址时不能拼出半个 URL", () => {
  assert.equal(consoleWindowUrl(null), "/host/");
  assert.equal(consoleWindowUrl(undefined, { welcome: true }), "/host/?welcome=1");
});

test("启动窗：窗口是竖的，且不该窄到把按钮挤成两行", () => {
  const options = consoleWindowOptions();
  assert.equal(options.width, CONSOLE_WINDOW_SIZE.width);
  assert.equal(options.height, CONSOLE_WINDOW_SIZE.height);
  assert.ok(options.height > options.width, "老师端是竖排页面，窗口得是竖的");
  assert.ok(options.minWidth >= 360, "再窄下去大按钮会挤成两行");
  assert.equal(options.autoHideMenuBar, true, "菜单栏里没有一条是老师用得上的");
  assert.equal(options.title, CONSOLE_WINDOW_TITLE);
});

test("启动窗：居中，别被系统的窗口层叠甩到屏幕角上", () => {
  assert.equal(consoleWindowOptions().center, true);
});

test("启动窗：标题里写着「已启动」—— 它就是那句回应", () => {
  assert.match(CONSOLE_WINDOW_TITLE, /已启动/);
});

test("启动窗：页面跑在隔离的渲染进程里，不接任何桥", () => {
  const { webPreferences } = consoleWindowOptions();
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, true);
});

test("启动窗：背景色跟着页面走，避免第一帧闪白", () => {
  // 和 host.css 的 --bg 是同一个值：窗口先画出来、页面还没渲染完的那一瞬间是它
  assert.equal(consoleWindowOptions().backgroundColor, "#0e1015");
});

test("启动窗：有图标才把图标写进配置", () => {
  assert.equal("icon" in consoleWindowOptions(), false);
  assert.equal(consoleWindowOptions({ icon: "icon-image" }).icon, "icon-image");
});
