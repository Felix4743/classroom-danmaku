import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import { dataDirFor, logDirFor, staticRootFor } from "../../src/main/desktop-paths.js";

test("数据目录优先落在 portable 目标给的真 U 盘目录上", () => {
  // electron-builder 的 portable 目标下 app.getPath("exe") 指向 %TEMP% 里的
  // 临时解包目录，真 U 盘目录只在 PORTABLE_EXECUTABLE_DIR 里。这条要是搞错，
  // 这节课的数据会被写进 C 盘临时目录，下课拔盘即丢。
  const dir = dataDirFor({
    portableDir: join("E:", "课堂弹幕"),
    exePath: join("C:", "Users", "teacher", "AppData", "Local", "Temp", "abc123", "课堂弹幕.exe"),
    cwd: join("D:", "somewhere", "else"),
  });
  assert.equal(dir, join("E:", "课堂弹幕", "data"));
});

test("没有 portable 目录时退回 exe 所在目录", () => {
  const dir = dataDirFor({ exePath: join("E:", "u盘", "课堂弹幕-0.1.0.exe") });
  assert.equal(dir, join("E:", "u盘", "data"));
});

test("开发期退回工作目录（exe 是 node_modules 里的 electron.exe，不能用）", () => {
  const dir = dataDirFor({ cwd: join("D:", "1ai", "1Project", "课堂弹幕") });
  assert.equal(dir, join("D:", "1ai", "1Project", "课堂弹幕", "data"));
});

test("什么都不知道时也不要抛，退回当前工作目录", () => {
  const dir = dataDirFor();
  assert.equal(dir, join(resolve(process.cwd()), "data"));
});

test("日志目录就是数据目录旁边的 logs", () => {
  const dir = logDirFor({ portableDir: join("E:", "课堂弹幕") });
  assert.equal(dir, join("E:", "课堂弹幕", "data", "logs"));
});

test("打包后静态根目录在 resources/src 下", () => {
  const root = staticRootFor({ isPackaged: true, resourcesPath: join("E:", "app", "resources") });
  assert.equal(root, join("E:", "app", "resources", "src"));
});

test("开发期静态根目录在仓库的 src 下", () => {
  const root = staticRootFor({ isPackaged: false, appPath: join("D:", "1ai", "课堂弹幕") });
  assert.equal(root, join("D:", "1ai", "课堂弹幕", "src"));
});

test("没给 isPackaged 但给了 resourcesPath 时不当作打包（按 appPath 算）", () => {
  const root = staticRootFor({ resourcesPath: join("E:", "app", "resources"), appPath: join("D:", "repo") });
  assert.equal(root, join("D:", "repo", "src"));
});
