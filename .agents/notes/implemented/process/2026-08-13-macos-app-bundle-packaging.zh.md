# Agent Note: 面向 dsh web 的 macOS 应用包

Status: implemented

[English](2026-08-13-macos-app-bundle-packaging.md) | 中文

## 问题

`dsh web` 从终端启动并打印一个 URL，因此使用 GUI（图形界面）意味着要在服务运行期间一直开着终端，并去点击那行打印出来的地址。在 macOS 上，与之相称的入口是一个可双击的应用，而此前没有任何东西能产出它。可分发的应用则远超这一需求：需要 Developer ID 签名、公证、为 harness 派生的每一条 shell、子进程与工作线程路径逐一厘清 hardened runtime 授权项，还需要按架构分别提供 `node-pty` 预构建产物——而在构建它的那台机器上启动 harness，这些一样都不需要。

## 决策

`pnpm run package:mac`（[scripts/package-macos-app.ts](../../../../scripts/package-macos-app.ts)）构建未签名的 `dist-macos/DSH.app`，以及承载它并附带 `/Applications` 符号链接的 `dist-macos/DSH.dmg`。该应用包是覆盖单个 checkout 的启动器，而不是一份分发物：它以构建时解析出的绝对 Node 路径运行该 checkout 构建出的 `apps/cli/lib/bin.js`，两者都在构建时确定并写入启动脚本。它只在 macOS 上构建，并在 `pnpm run build` 尚未产出 CLI 入口与前端 dist 时明确失败，因为缺少该 dist 时 web bundle 会拒绝激活。

应用包内部的任何东西都不通过绝对路径寻址，因此构建出的应用被拖到 `/Applications` 之后依然可用；固定下来的只有那两条指向包外的路径。

### 可执行文件是编译出的 shim，而非脚本

在应用包的可执行文件向窗口服务器完成签到之前，LaunchServices 会一直弹跳 Dock 图标，并最终报告启动超时——而只有启动了 `NSApplication` 的进程才能完成签到，shell 脚本永远做不到。因此可执行文件是打包时由 `swiftc` 编译的一个小型 Swift Cocoa shim，bash 启动脚本作为它的子进程运行。shim 在两个方向上掌管应用的生命周期：退出应用会触及脚本的 `SIGTERM` trap，从而在应用退出前停止服务；而脚本退出则会终止应用，不会留下一个空转的 Dock 图标。在没有 Swift 编译器的环境中，脚本本身成为可执行文件，应用包被标记为 `LSUIElement`——既没有可供弹跳的 Dock 图标，也没有 Dock 图标可言。

### 重新触及应用即调起其标签页

一个没有自己窗口的应用，在用户触及它时无物可呈现，因此每一条进入路径——点击 Dock 图标、Command-Tab、以及任何其他激活方式——都会以「仅聚焦」模式运行启动脚本，把浏览器标签页调至前台。该模式不启动任何东西：激活会在启动后极短时间内到来，若在其中启动服务就会与启动流程争抢端口。

该模式等待的是启动流程在打开标签页之后写下的就绪标记，而不是端口。端口开始响应的时刻，比那个标签页存在的时刻早约一秒半——足以让一次激活落在这段间隔内，发现没有标签页并再开一个。标记检查之后仍会执行一次探测，因为被强杀的那次运行会留下自己的标记，而其对应的 URL 已无任何服务。一次 Dock 点击会同时送达 reopen 与激活两个回调，因此当前一次仍在运行时 shim 会抑制后一次，理由相同：两次并发且都发现没有标签页的运行会各开一个。

### 浏览器按 bundle id 寻址

浏览器一律按 bundle id 而非显示名指定：指定一个未安装的应用会让 AppleScript 去搜索它并阻塞在选择对话框上，这曾在列表中某个浏览器缺席时直接把启动器挂死，而不存在的 bundle id 会立即失败。只有已经在运行的浏览器才会被询问，因此点击 Dock 图标绝不会启动用户已关闭的浏览器。Chromium 系浏览器共用一个在 `using terms from application "Google Chrome"` 下编译的脚本；Safari 有自己的词典和自己的脚本。

### 写入的 Node 路径是 PATH 条目

`process.execPath` 已经过符号链接解析，因此在 Homebrew 或版本管理器下，它指向的是一个带版本号的目录，而下一次升级就会删除该目录——留下一个还来不及报告原因就死掉的应用包。构建改为写入一条解析到同一二进制的 `PATH` 条目。此后若某次升级改变了 Node 的主版本，会产生一个响亮的 `node-pty` ABI 错误，`pnpm install` 即可修复——这比一条悄无声息消失的路径是更好的失败方式。不接受这一取舍时，`--node` 可钉死某个具体二进制。

## 曾考虑的替代方案

- **复用单文件可执行流水线。**[single-exe 分发](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md)已经能物化出无符号链接的部署闭包并构建 macOS 二进制，因此它可以承载一个自包含的应用包。在这一步被否决：它的闭包是 JSON-RPC 运行时，而不是带前端 dist 的 web 界面；而且只有当签名与公证使其可分发时，组装一个自包含应用包才值得。当目标转为分发时，它仍是应当在其上构建的基础。
- **Electron 外壳。**[GUI 分层](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md)已经为此预留了设计，可经 IPC fetch 载体复用 web client 各包。此处否决是因为代价不成比例：`dsh-host-webserver` 还承载着 `/api`、插件 bundle 端点、重载事件流以及 boot manifest 注入，在 Electron 下每一项都需要新的载体。启动器无需触碰已发布的源码即可满足当下需求。
- **所有构建一律使用 `LSUIElement`。** 这能在不依赖编译器的前提下消除 Dock 弹跳，但同时也失去 Dock 图标及其退出菜单项，只能靠「活动监视器」来停止服务。它仅作为没有 `swiftc` 时的回退方案保留。
- **签名与公证。** 在应用包仅面向构建它的那台机器时，这超出范围：本机构建的应用包不带隔离标记，Gatekeeper 根本不会检查它。引入签名意味着要按子进程路径逐一推敲授权项、准备 Developer ID 凭证并新增发布任务——这些工作属于自包含产物，而不属于启动器。
- **打包时从 SVG 生成图标。** 否决，因为 `sips` 与 `iconutil` 读取的是 PNG，而 macOS 没有任何系统工具能栅格化 SVG，这样做会引入一项贡献者未必具备的渲染器依赖。渲染出的 PNG 与其来源 SVG 一并提交。

## 后果

- 当 checkout 被移动、或其 Node 安装被移除时，应用包即失效。它是一项开发者便利设施，[docs/development.md](../../../../docs/development.md#macos-application-bundle) 在说明重新构建规则的同时也写明了这一限制。
- LaunchServices 按 bundle id 解析应用，因此安装在 `/Applications` 下的副本会响应 `open dist-macos/DSH.app`。重新构建后必须重新安装到那里，否则运行的仍是先前那份副本。
- 调起浏览器标签页需要按浏览器逐个授予「自动化」权限，而未签名可执行文件的身份随每次重新构建而变化，因此重新打包后 macOS 会再次索要这些授权。
- 没有 CI 门禁覆盖该脚本：它需要 macOS、Swift 编译器、窗口会话和一个浏览器，因此其行为由人工在开发机上确认。仓库级的 lint 与 typecheck 门禁只把它当作 TypeScript 源码来覆盖，仅此而已。
