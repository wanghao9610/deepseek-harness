# Agent Note: 桌面应用——覆盖本地回环 Web 运行时的 Electron 外壳

Status: implemented

[English](2026-08-13-electron-desktop-application.md) | 中文

## Problem

harness 有 Web 界面，在 macOS 上还有一个[启动器包](../process/2026-08-13-macos-app-bundle-packaging.md)，用于启动 `dsh web` 并打开浏览器标签页；Windows 上则是对应的[检出快捷方式](../process/2026-08-13-windows-app-window-launcher.md)。两者都是覆盖单一代码检出的开发便利设施：它们把该检出的 `apps/cli/lib/bin.js` 与构建时解析出的 Node 二进制的绝对路径烧录进去，因此其中任何一个移动，它们就不再工作；也无法交给尚未拥有该仓库的人。

桌面应用是另一种产品。它必须能从磁盘镜像或安装程序安装到一台没有代码检出、没有 Node、没有包管理器的机器上；在 harness 进程崩溃后存活；运行用户自己的工具，而 Finder 或 Explorer 启动找不到这些工具；不必为一次会话的整个生命周期扣住一个浏览器标签页；在用户身处其他应用时告诉他们一次长时间的智能体运行已完成或正卡在他们身上；并且在无事发生时不长期占用数百 MB 常驻内存。

## Decision

`apps/desktop` 是一个 Electron 应用：它监管一个内嵌的 `dsh --profile web` 运行时，并在原生窗口中通过运行时的本地回环源呈现它。`pnpm run package:desktop` 在 macOS 上构建 `dist-desktop/DeepSeek-Harness-<version>-<arch>.dmg`，并为 Windows 构建 `dist-desktop/DeepSeek-Harness-<version>-<arch>-setup.exe`（NSIS）。磁盘镜像经过即席签名；Windows 安装程序未签名。Windows 即使在 Apple 芯片打包机上也默认 x64，并且可以从 macOS 交叉打包。

外壳不新增任何 harness 能力，而这正是该设计的要点：用户交互的一切都是已发布的 Web 组合，原封不动。外壳只拥有浏览器标签页无法承担的部分。

### 复用 Web 载体，而非替换它

[GUI 分层](2026-07-19-gui-layering-and-rpc-protocol.md)曾预设一个 Electron 客户端：经 `file://` 加载已构建文件，并通过 IPC fetch 桥承载 `/api`。实际交付的不是它。窗口加载 `http://127.0.0.1:<port>`，因为 `dsh-host-webserver` 承载着浏览器客户端所需的四样东西——`/api`、插件包端点、`__DSH_BOOT__` 清单注入，以及 WebSocket 下行通道——而 IPC 载体必须在第一个窗口渲染出任何内容之前把这四样全部提供出来。复用 HTTP 载体意味着桌面界面在构造上就是 Web 界面，一处 Web 修复即是一处桌面修复，不存在需要同步维护的第二个载体。

代价被写在它该在的地方：运行时在本地回环上以操作系统分配的端口提供服务且没有认证，这与 `dsh web` 已有的姿态一致。当有人确实需要去掉这个端口时，IPC 载体仍然是那条路。

外壳依然是一等的协议客户端，而不是屏幕抓取器。`DesktopApiClient` 继承已发布的 `AbstractApiClient`，因此信封解析、帧校验与 rpcId 纪律都是浏览器所运行的同一份代码；只有两处平台切面不同——`doFetch`，以及下行通道：Web 载体以 WebSocket 提供它，对任何普通请求都回答 `426 Upgrade Required`。

### 运行时是子进程，而 Electron 就是它的 Node

harness 作为主进程的子进程运行，而不在其内部。这样一次 harness 故障的代价是一次重启而不是整个窗口；它的 V8 老生代按物理内存独立于 Chromium 定尺；卡死的工具也无法阻塞 UI 线程。

该子进程就是 Electron 二进制自身，运行在 `ELECTRON_RUN_AS_NODE` 模式下，因此包内只携带一份 JavaScript 运行时而非两份。这行得通，是因为 `node-pty` 发布的是 Node-API 预构建产物，在 Electron 的 ABI 下可原样加载。但它对 `node-addon-require-builtin` **不**成立——Cordis 用这个插件在不加标志的情况下触及 Node 内部 ES 模块加载器：它读取的 V8 embedder data 布局 Electron 并不共享，因此加载失败。`--expose-internals` 是剩下的那条路，运行时即以它启动——缺少它，HMR 服务会拒绝启动并带崩整次引导。该标志、堆上限以及参数列表的其余部分位于同一个模块（`src/runtime-launch.ts`），外壳与打包冒烟测试共用它，因为以不同方式启动运行时的冒烟测试，对真正交付的启动方式什么也证明不了。

就绪以 `dsh web: <url>` 这一行为准而非端口开始应答，且扫描器要求该行的结尾换行：输出以可在任意位置切分的数据块到达，一个恰好停在 URL 中间的数据块否则会上报一个被截断的地址。

### 登录 shell 在启动时恢复一次

Finder 启动继承 launchd 的环境，其 `PATH` 是 `/usr/bin:/bin:/usr/sbin:/sbin`。智能体要从该 `PATH` 运行 `git`、`rg` 以及用户的各种语言工具链，因此外壳执行一次 `$SHELL -ilc`，读回用户配置文件组装出的环境。探测从一个 Node 子进程打印其载荷，使取值是精确的 JSON 而非按行解析的 `env` 输出；用标记包裹它，使配置文件横幅无法破坏它；以五秒为上限；并在 `PATH` 已带有非 launchd 条目时直接跳过。Windows Explorer 与 Linux 桌面会话已经把用户环境交给 GUI 应用，因此它们从不探测。

### 菜单就是外壳的全部键盘映射

窗口展示的是外壳并不扩展的网页内容，外壳没有拿走的每一个键都归 harness 界面所有。因此应用菜单是唯一能在不猜测该界面意图的前提下绑定组合键的地方，而所有组合键都在那里：`src/menu.ts` 是一个纯模板构造器，整份映射是单元测试可读的一个对象，`main.ts` 才是把它交给 Electron 的地方。

外壳自有的组合键分为三层——单 `CmdOrCtrl` 用于标准窗口操作，`Shift` 用于外壳的界面或目的地，`Alt` 用于运行时进程——而所有标准操作仍是菜单 role，由 role 按各自平台的习惯拼写。分层正是让两组键彼此分开的东西，而且它是承重的：Electron 会接受一个与某个 role 已有加速键重复的加速键，把它交给模板中排在前面的那一项，让另一项没有键，而这是类型检查与 lint 都看不见的。菜单测试携带本模板所用 role 的默认键，并拒绝与它们重叠。它同样持有 harness 界面自行绑定的组合键——`CmdOrCtrl+,` 打开 Settings、`CmdOrCtrl+K` 新建会话（见[客户端快捷键 Note](../feature/2026-08-13-client-keyboard-shortcuts.md)）——并拒绝任何要占用它们的菜单项，因为菜单加速键会在页面看到之前拿走该键，而外壳对这两个操作都没有通路。

有两处键盘界面留在菜单之外，因为菜单项无法表达它们。一项只持有一个加速键，因此 Windows 与 Linux 的功能键一行——`F5`、`Shift+F5`、`Ctrl+F5`、`F12`——由 `src/window-keys.ts` 在 `before-input-event` 处理器中解析；macOS 对这些操作没有第二种拼法，其映射为空。引导界面在自己的页面上应答 `Escape`，以及在表单字段或启动失败时按下的 `Enter`，因为这些键只有在窗口正显示它时才有含义；每一个都驱动它所指的那个控件，因此指针与键盘走同一条路径。

### Windows 进程生命周期

关闭最后一个窗口即退出应用——这是该平台的惯例——并停止运行时。常驻大小取自 PowerShell `WorkingSet64`。Windows 没有 `SIGTERM`：Node 把该信号映射为 `TerminateProcess`，因此运行时不会执行其释放程序，会话能留下是因为它们是持久的。卡死的进程树用 `taskkill /T` 杀掉。

### 回收绝不打断智能体工作

资源策略每 30 秒采样一次运行时，其首要条款是正在运行的会话高于其他一切规则。只有空闲的运行时才会被触碰：十分钟内没有窗口打开的会被停止并在下次激活时重启；占用超过物理内存 35% 的会被原地重启。运行时的常驻大小在 Unix 上取自 `ps`，在 Windows 上取自 PowerShell `WorkingSet64`，因为它不是 Electron 的子进程，`app.getAppMetrics()` 覆盖不到它。

同一个运行状态信号驱动原生界面的其余部分：恰好在回合运行期间持有的防休眠锁，以及仅在没有窗口获得焦点时才发出的"任务完成"通知。

### mux 流是仅后台的订阅

审批与提问帧——表示智能体正卡在用户身上的那两种——走 mux 流，而该流同时承载每一个助手 token。外壳**仅在没有窗口获得焦点时**订阅它。可见窗口本就展示这些请求，因此前台订阅只会让运行时的帧序列化翻倍，却给不出用户尚未看见的任何信号。打开该流会在 subscribed 帧之后重放仍待处理的 requested 帧，因此切到后台会立即浮现任何已在等待的请求。

### 打包部署闭包并证明它能启动

该包自包含：`apps/desktop/runtime/package.json` 是生成的、仅含依赖的部署根，列出从 `@deepseek-ai/dsh` 可达的每一个工作区包，由 `pnpm deploy` 将其物化进包内。列出整个可达集合而不仅是应用本身，正是闭包完整的原因：在关闭自动 peer 安装后，peer 不会被安装；而仅通过 `pnpm-workspace.yaml` 中 `link:` 覆盖可达的包，除非部署根点名，否则会被跳过。`scripts/gen-desktop-runtime-closure.ts` 写出该列表，`--check` 在 `pnpm run hygiene` 中守住它的新鲜度。

目标不是本机时，流水线在 `pnpm deploy` 之后把该操作系统与 CPU 的可选原生包（`koffi`、`sharp`、`node-addon-require-builtin`）**用 npm pack 装进闭包**，因为即使设置了 `supportedArchitectures`，deploy 仍安装主机的可选包。`node-pty` 在一个包里带齐各平台预构建产物，因此剪除即可留下目标平台。流水线随后在打包前检查这些目录存在。

在打包任何东西之前，流水线会**以交付外壳所用的同一条命令行启动已部署的闭包**并读取所服务的页面，**前提是目标能在本机运行**。这是静态检查无法替代的门禁：缺失的 peer、被覆盖规则遗留的 vendored 包、未构建的前端 dist，以及 `--expose-internals` 的要求，全都在这里浮现，而不是在已交付的应用里。Windows 的 Electron 二进制无法在 macOS 上执行，因此交叉编译的 Windows 闭包未经冒烟；原生目录检查是那次运行能证明的部分。

流水线其余部分由两条机械事实支配。该包**不是** asar 归档：harness 是带动态导入的 ES 模块并含原生插件，而 Electron 的加载器两者都无法从归档内部导入。已打包的 macOS 应用由**本流水线即席签名**，因为打包会重写 Electron 二进制的身份与布局——这会使它原本携带的签名失效——而 Apple 芯片会杀掉签名无效的包。Windows NSIS 安装程序在闭包暂存之后，通过 electron-builder `--prepackaged` 从已解包目录构建，原因与磁盘镜像不使用 electron-builder 的 `dmg` 目标相同。

## Alternatives considered

- **分层 Note 所预设的 IPC fetch 载体。** 作为第一步被否决，而非因其本身不好：它需要在第一个窗口渲染之前具备插件包端点、引导清单注入与下行通道，而每一样都是 Web 载体已交付之物的第二份实现。复用 HTTP 载体现在就能得到可用的应用，并且只需维护一个载体；端口是代价，而这正是 `dsh web` 已在付的代价。
- **在 Electron 主进程内运行 harness。** 它省下一个进程与一次启动，代价是崩溃隔离、独立的堆上限，以及一条任何工具都无法阻塞的 UI 线程。一个窗口随智能体一同死去的桌面应用，比一个会重启它的更糟。
- **在 Electron 旁再带一个 Node 二进制。** 规避 ABI 问题的直接办法，代价约 100 MB 以及第二份需要持续打补丁的运行时。在确认 `node-pty` 的 Node-API 预构建产物可在 Electron 下加载后即无必要；唯一确实无法在那里加载的插件由一个标志替代，而不是由一份运行时替代。
- **改为扩展启动器包。** 启动器的整体形态就是"一个启动服务器并打开标签页的脚本"；窗口管理、通知、Dock 角标与内存策略并不是它的延伸。两件产物拥有不同的 bundle id 并共存。
- **给 harness 窗口挂 preload 脚本。** 它能让外壳与界面对话，且 ES 模块 preload 需要 `sandbox: false`——为这个外壳并不需要的能力，削弱那个展示模型输出的渲染器。引导界面改为通过被拦截的 `dsh-action:` 方案触及外壳，而 harness 窗口完全不带 preload。
- **用 `globalShortcut` 承载外壳的操作。** 否决：这些组合键是系统级的，在别的应用获得焦点时也会触发，对于作用于本窗口的操作而言生命周期不对；而且它们是不可见的——菜单加速键才是用户唯一读得到的键盘映射。
- **在窗口层做一份覆盖字母键、而不只是功能键一行的映射。** `before-input-event` 能看到窗口收到的每一个键，外壳在那里想绑什么都行。它只绑 `F5` 与 `F12`：在那一层拿走的字母，就是 harness 界面永远无法绑定的字母，而外壳看不见该界面已经占用了什么。
- **始终订阅 mux 流。** 更简单，并且能让 Dock 角标在窗口获得焦点时也正确——而那恰恰是用户已经在界面里看着同一份信息的时刻。
- **手工维护闭包清单**，如[单可执行文件流水线](2026-07-10-single-file-executable-sdk-runtime-distribution.md)所做。它的列表是关于"可执行文件交付哪些插件"的产品决策；桌面的列表是"CLI 能达到的一切"，那是一个推导，而推导它可以在无人记得的情况下保持正确。
- **electron-builder 的 `dmg` / extraResources 拷贝。** 磁盘镜像通过启动器包所用的同一个助手以 `hdiutil` 构建，Windows 安装程序在同样的暂存之后用 `--prepackaged` 构建，闭包直接拷进已打包的应用，因为 electron-builder 自身的资源拷贝会悄悄丢弃闭包的 `node_modules`。
- **只在 Windows 机器上构建 Windows。** 否决：可选原生包是预构建 tarball，electron-builder 的 NSIS 目标不需要 Wine。Windows 机器独有的是一次引导冒烟，而流水线在目标无法运行时本来就会跳过它。
- **用 zip 或便携 exe 代替 NSIS。** 作为分发形态被否决：安装程序才是不会去解压一棵目录树的用户所预期的，而 NSIS 是 electron-builder 能在 macOS 上不靠 Wine 产出的目标。
- **改为扩展 Windows checkout 快捷方式。** 那是覆盖单一检出的启动器，对应 macOS 的 `.app` 启动器，不是自包含应用。

## Consequences

- 桌面应用与 Web 界面无法漂移：只有一个载体、一个客户端基类、一份前端构建。新的 Web 特性无需任何桌面改动即可抵达桌面。
- 任何以同一用户身份运行的本地进程都能触及运行时的 API，与 `dsh web` 完全一致。要消除这一点需要 IPC 载体。
- `pnpm deploy` 会把它运行时所用的标志记录进工作区安装状态，而 pnpm 会在下一次 `pnpm run` 之前协调该状态——那会把检出重装成仅生产依赖，并删除构建其余部分所需的开发依赖。现在每次闭包部署之后都会恢复工作区安装状态，这同时也修复了单可执行文件流水线中同样潜伏的隐患。
- 磁盘镜像约 240 MB，安装后的应用约 430 MB，其中大部分是 harness 闭包及其各家提供方 SDK。剪除仅构建所需的材料与非本平台预构建产物，在打包前移除了闭包约 40% 的体积。
- 向 CLI 的依赖图新增一个包，现在需要重新生成桌面闭包清单并重装，这与 Python 运行时清单已承担的维护相同。`pnpm run hygiene` 会报告清单陈旧。
- 没有 CI 门禁覆盖该应用：打包需要 macOS 或 Windows，驱动外壳需要窗口会话。CI 确实覆盖的是外壳的逻辑，它在 Electron 之外做了单元测试；本机打包运行覆盖的是它即将交付的那个闭包。在 macOS 上构建的 Windows 安装程序未经冒烟。
- 键盘映射是脱离 Electron 检查的，因此冲突测试手工携带本模板所用 role 的默认键。若某个 Electron 版本改写了其中之一，发现它靠的是读菜单，而不是这道关卡。
- 在 Windows 上关闭最后一个窗口会停止运行时；在 macOS 上不会。
- Windows 安装程序未签名；SmartScreen 会警告。
