# vendor/hsk —— 内置的花生壳穿透程序

这里是「一键开公网」（《产品技术方案》4.12）要用的那个可执行文件，**不是我们写的**，
是花生壳官方 CLI 的 Go 二进制，随安装包一起发出去。

## 文件

| 文件 | 版本 | 平台 | 大小 | SHA-256 |
| --- | --- | --- | --- | --- |
| `hsk-cli-windows-amd64-v0.7.26.exe` | 0.7.26 | Windows x64 | 8.96 MB | `1137A95B196B3D23CBDD9A501006FB5D08E30A277F311DC9AFC30FD350A36736` |

来源：花生壳官方 npm 包 `@aweray/hsk-cli@latest` 在首次运行时把 Go 二进制装到
`%USERPROFILE%\.hsk\bin\` 下，文件名就长这样。上面这份是从那里原样拷过来的，
没有做任何改动。

## 为什么是"拷一份进仓库"而不是"打包时下载"

老师那台电脑在教室里，装的时候可能连不上外网；打包机也可能断网。8.96 MB 换一个
**离线可复现**的构建，这笔买卖划算。而且二进制本身带版本号，升级就是换一个文件、
改一处 `HSK_VERSION`。

## 怎么被找到（顺序不可乱）

`src/main/tunnel.js` 的 `binaryCandidates()` 按这个顺序找，第一个存在的就用：

1. 环境变量 `HSK_CLI` —— 只给开发和排障用
2. `<resourcesPath>/hsk/<名字>` —— **打包后走这条**（见 package.json 的 `extraResources`）
3. `<appPath>/vendor/hsk/<名字>` —— **开发态走这条**
4. `%USERPROFILE%\.hsk\bin\<名字>` —— 老师自己装过花生壳的话，直接复用他那份

第 4 条是兜底：老师如果本来就在用花生壳，让他的账号和凭据留在原地，别逼他再登一次。

## 注意

- 这个程序**必须由我们的进程来管生命周期**：它是前台常驻进程，没有
  `tunnel stop` 这种子命令，停它只能杀进程（Windows 上 `taskkill /pid <pid> /T /F`）。
  所以 `src/main/server/start.js` 的 `close()` 里会先 `await tunnel.stop()`。
- 它会把凭据写在 `~/.hsk/auth.json`。**`HOME` 为空时它会退而写到当前工作目录**，
  这就是 `hskEnv()` 一定要显式覆盖 `HOME`/`USERPROFILE` 的原因。
- 授权（`auth login`）**一启动就会把 `auth.json` 冲成 `pending_callback`**，
  所以 `beginLogin()` 调用前先备份、拿不到链接就还原。

## 升级步骤

1. 换掉这里的二进制（新版本号写进文件名）
2. 改 `src/main/tunnel.js` 的 `HSK_VERSION`
3. 更新本文件的表格（版本 / 大小 / SHA-256）
4. 跑一遍 `npm test`（`tests/unit/tunnel.test.mjs` 用的是实测抓下来的输出，
   如果新版输出格式变了，那条会红）
