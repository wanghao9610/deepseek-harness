# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

macOS 与 Windows 桌面应用：一个 Electron 外壳，监管一个内嵌的 `dsh --profile web` 运行时，并在原生窗口中呈现它。它以未签名 `.dmg`（macOS）或 NSIS `.exe`（Windows）交付，由 [`scripts/package-desktop-app.ts`](../../scripts/package-desktop-app.ts) 构建，且自包含——Electron 运行时、harness 依赖闭包与已构建的前端全部位于包内，因此安装后的应用不需要代码检出、不需要 Node 安装，也不需要包管理器。决策记录见[桌面应用 Agent Note](../../.agents/notes/implemented/architecture/2026-08-13-electron-desktop-application.md)。

外壳不新增任何 harness 能力。它通过运行时的本地回环服务器原样复用已发布的 Web 界面，只拥有浏览器标签页无法承担的部分：进程监管、用户的 shell 环境、原生窗口与菜单行为、提醒信号、一套内存策略，以及运行时在哪台主机上运行的选择。

## 远程主机

运行时既可以由本机提供，也可以由一台经 SSH 访问的主机提供；是哪一种，是交给 supervisor 的那次启动的属性，而不是监管本身的属性。远程运行时是远端的一整套 harness：文件、命令、终端与语言服务器都属于那台主机，而本应用只保留窗口与连接列表。

[`@deepseek-ai/dsh-ssh-launch`](../../packages/boot/ssh-launch/README.md) 持有一条连接可以包含什么、`ssh` 命令行，以及失败意味着什么；[`src/runtime-launch.ts`](src/runtime-launch.ts) 把两种选择都变成一次已备好的启动。同一次 `ssh` 会话既启动远端运行时，又把它的回环端口转发回来，因此窗口加载的是一个普通的回环 origin，API 客户端、引导界面与提醒流都无需改动。

**连接属于窗口，而不属于整个应用。** 每个窗口从一条连接提供服务，并只显示那条连接的运行时正在做什么；把某个窗口指向另一台主机，其他窗口原地不动，各自仍由自己的运行时提供服务。正在使用的每条连接各有一个运行时，在某个窗口首次请求它时创建，而最后一个窗口离开后，停掉它的是空闲规则。

连接在引导界面上编辑，可从 **View › Connections** 或一次失败的启动进入，并与外壳的其他偏好一起存储。已存的选择是**之后新开窗口**的默认值，而不是对已经打开的窗口的更改。

每个等待中的界面都带有自己的操作——Stop、Connections…、Reveal Log、Quit——按 Escape 等同于 Stop。首次连接会在主机上安装启动器，这要花上几分钟，因此一个没有任何出口的窗口会让强制退出成为唯一选择。停止同样能触及进程存在之前的工作：负载传输与归档读取会随之取消。

主机上不必事先有 `dsh`。默认情况下，外壳会在首次连接时装一份——从 npm 装到那台主机的 `~/.dsh-remote/<version>`，与启动运行时用的是同一次 `ssh` 会话——而连接也可以改为指明主机自带的启动器。安装要花上几分钟，因此远端脚本会播报自己的步骤、引导界面把它显示出来；此后启动器存在就是全部检查，所以之后的连接不需要网络，也没有任何东西会自行升级。改变某条连接所请求的版本，才是移动那台主机的动作。

转发带来的两个后果值得知道。运行时会把这次连接识别为 SSH 启动，于是它的目录选择器提供应用内浏览器，而不是试图在一台无人值守的机器上弹出系统选择器。以及，请求是从 `127.0.0.1` 到达远端 `/api` 的——这正是那些特权方法（目录选择、设置、凭据、preset 授权）仍然可用的原因；在真正的认证层出现之前，它们只对回环开放。

## 运行时进程

[`src/runtime-supervisor.ts`](src/runtime-supervisor.ts) 将 harness 作为子进程运行而非置于主进程内，因此一次 harness 故障的代价是一次重启而不是整个窗口，其堆上限也独立于 Chromium 之外。该子进程就是 Electron 自身的二进制，运行在 `ELECTRON_RUN_AS_NODE` 模式下——这正是包内不携带第二份 Node 运行时的原因。

| 关注点 | 行为 |
|---|---|
| 启动 | [`src/runtime-launch.ts`](src/runtime-launch.ts) 拥有两条命令行。本地那条包含 `--expose-internals`：Electron 无法加载 Cordis 用来触及 Node 内部模块加载器的 `node-addon-require-builtin` 插件，因此缺少该标志时 HMR 服务会拒绝启动并带崩整次引导。启动是按每次 start 而非每个 supervisor 备好的，因为远程启动每次都占用一对新端口。 |
| 就绪 | 以 `dsh web: <url>` 这一行为准，而不是端口开始应答。[`src/readiness.ts`](src/readiness.ts) 跨数据块边界拼接该行，且只在整行完整时才上报。远程运行时报告的是它在自己主机上绑定的地址，因此该次启动会把它映射到转发端口，并拒绝其他任何地址，而不是把窗口指向别的东西。 |
| 端口 | 本地为 `--port 0`，因此外壳绝不会与终端里启动的 `dsh web` 抢占端口。转发型启动必须在运行时选定端口之前就写死远端端口，因此它抽取一个，并把冲突当作可重试的失败。 |
| 重启 | [`src/restart-policy.ts`](src/restart-policy.ts) 对已正常服务过的运行立即重启，对启动期失败按指数退避，连续五次后停止。会话是持久的，因此一次重启的代价仅是一个进行中的回合。放弃重试的远程启动会报告 `ssh` 实际撞上的问题——被拒绝的密钥、无法解析的主机、缺失的远端启动器——因为仅凭退出码无法区分它们。 |
| 关闭 | 本地运行时收到 `SIGTERM`，由它在自身的五秒上限内释放插件树与子进程；Windows 没有 `SIGTERM`，改为终止该进程。远程运行时则通过关闭 `ssh` 会话的 stdin 来请求停止，其远端脚本会在对面把它转成同样的 `SIGTERM`；改为向 `ssh` 发信号会让那个运行时变成孤儿。只有在阶梯的宽限期之后才向进程树发信号（Windows 上为 `taskkill /T`），这一步捕获的是卡死运行时未回收的子进程。 |
| 日志 | Electron 的日志目录：macOS 上为 `~/Library/Logs/DeepSeek Harness/runtime.log`，Windows 上为 `%APPDATA%\DeepSeek Harness\logs\runtime.log`；每次运行清空，达到 4 MiB 时轮转。 |

## 用户环境

从 Finder 启动会继承 launchd 的环境，其 `PATH` 只有四个系统目录。智能体要从该 `PATH` 运行用户的工具，因此 [`src/login-environment.ts`](src/login-environment.ts) 在启动时执行一次 `$SHELL -ilc`，读取配置文件组装出的环境，并用标记包裹载荷，使配置文件打印的横幅无法破坏它。当 `PATH` 已带有配置项时跳过探测；探测以五秒为上限，失败则回退到继承的环境。Windows Explorer 与 Linux 桌面会话已经把用户 `PATH` 交给 GUI 应用，因此它们从不探测。

## 窗口行为

窗口直接加载运行时的本地回环源，且不携带 preload，因此 harness 界面运行在沙箱与上下文隔离之下。引导界面（[`resources/boot.html`](resources/boot.html)）是一个本地文件，运行时未在服务时外壳即导航至此；其按钮是 `dsh-action:` 方案的链接，由 [`src/windows.ts`](src/windows.ts) 拦截。窗口几何在开窗前先按当前连接的显示器校验（[`src/window-state.ts`](src/window-state.ts)），因此记录在已拔除显示器上的窗口不会开在屏幕之外。

每个窗口都是同一个源的网页内容，而 harness 界面把窗口所显示的会话按窗口而非按源保存，因此外壳的职责就是说明哪些窗口是新窗口。**新建窗口**加载运行时地址时带上界面的 `new` 参数，窗口即落在属于自己的会话上；首个窗口与 Dock 激活则加载不带参数的地址，恢复上次的会话。该请求在首次加载时即被消耗，因为运行时重启会重新路由已经打开的窗口，而这些都是同一个窗口，并非又一个新窗口。

## 键盘

菜单就是外壳的键盘映射。harness 窗口是外壳并不扩展的网页内容，因此菜单未占用的每一个键都属于窗口内的界面——这也是该映射避开可打印字符的原因。剪贴板、撤销、缩放、重新加载、开发者工具、全屏、最小化与关闭这些标准操作都是 Electron 的菜单 role，而 role 会按各自平台的习惯拼写自己的组合键。

| 操作 | macOS | Windows |
|---|---|---|
| 新建窗口（落在自己的会话上） | ⌘N | Ctrl+N |
| 关闭窗口 | ⌘W | Ctrl+W |
| 退出 | ⌘Q | Ctrl+Q |
| 重启 harness 运行时 | ⌥⌘R | Ctrl+Alt+R |
| 空闲时释放内存 | ⌥⌘M | Ctrl+Alt+M |
| 连接… | ⇧⌘H | Ctrl+Shift+H |
| 在浏览器中打开 | ⇧⌘O | Ctrl+Shift+O |
| 显示运行时日志 | ⇧⌘L | Ctrl+Shift+L |
| 重新加载 | ⌘R | Ctrl+R、F5 |
| 越过缓存重新加载 | ⇧⌘R | Ctrl+Shift+R、Shift+F5 |
| 开发者工具 | ⌥⌘I | Ctrl+Shift+I、F12 |
| 全屏 | ⌃⌘F | F11 |
| 粘贴并匹配样式 | ⌥⇧⌘V | Ctrl+Shift+V |

三个层级把外壳自有的组合键与 role 的组合键分开：单修饰键是标准窗口操作，`Shift` 通向外壳的界面或目的地，`Alt` 通向运行时进程——Electron 自己也把 macOS 的开发者工具放在这一层。[`src/menu.ts`](src/menu.ts) 持有整份映射，其单元测试会拒绝某个 role 已占用的组合键，因为这种冲突本来是无声的：Electron 会把重复的组合键交给模板中排在前面的那一项，另一项则没有键。

同一个测试也会拒绝占用 `⌘,`（Settings）、`⌘K`（新建会话）、`⌘O`（添加工作区）、`⌘B`（侧边栏）或 `⇧⌘F`（搜索）的菜单项：它们属于 harness 界面自身，由 [ui-primitives](../../packages/client/ui-primitives/README.md) 的 `useShortcut` 在页面内绑定，而菜单加速键会在页面看到之前拿走该键。

Windows 与 Linux 的功能键一行是菜单项无法承载的：一项只持有一个加速键，而 `Ctrl` 拼法已经占用了它。[`src/window-keys.ts`](src/window-keys.ts) 在窗口自身上应答 `F5`、`Shift+F5`、`Ctrl+F5` 与 `F12`；macOS 则把这一行留给系统。引导界面应答 `Escape` 离开连接列表、在表单字段中按 `Enter` 保存主机、在启动失败时按 `Enter` 重试——这些键只有在窗口正显示该页面时才有含义。

## 提醒与电源

[`src/activity.ts`](src/activity.ts) 折叠运行时自身的帧，这些帧经由 [`AbstractApiClient`](../../packages/host/apiproxy/README.md) 的子类通过 WebSocket 下行通道读取：

- **host 流**在运行时提供服务期间保持打开。它报告哪些会话正在运行，据此在回合运行期间恰好持有防休眠锁，并在没有窗口获得焦点时才发出"任务完成"通知。
- **mux 流**仅在没有窗口获得焦点时打开，承载表示智能体正在等待用户的审批与提问帧。可见窗口本就展示这些请求，因此在用户注视时订阅只会让运行时的帧序列化翻倍而不产生任何新信号。待处理请求呈现为 Dock 角标。

## 内存策略

[`src/resource-governor.ts`](src/resource-governor.ts) 每 30 秒采样一次运行时，并应用一套规则，其首要条款是绝不打断智能体工作：所有回收都只作用于空闲的运行时。空闲且十分钟内没有窗口打开的运行时会被停止，并在下次激活时重启；空闲且占用超过物理内存 35% 的运行时会原地重启。空闲停止在应用菜单中是一个复选项。

## Known Limitations and Deferred Work

- 运行时在本地回环上以操作系统分配的端口提供服务且没有认证，这与 `dsh web` 已有的姿态一致：任何以同一用户身份运行的进程都能触及该 API。Electron IPC 载体可以去掉这个端口，代价是重新实现插件包端点、引导清单注入以及 Web 载体已经提供的下行通道。被转发的远程运行时在隧道两端都是同样的姿态。
- 每台主机都需要 Node 22.19 或更新版本；从 registry 安装还需要主机上有 npm。两者都没有的主机会被带着诊断拒绝，而不是改用别的方式供给。
- 服务端负载锁定平台，而桌面应用本身不构建负载：它只携带面向自身平台的 closure，也没有包管理器去产出另一份。请在与主机匹配的机器上从代码检出运行 `pnpm run package:remote-server` 构建。
- 外壳无法回答 SSH 的口令或密钥短语提示：它没有终端，而一个无处可去的提示只会把连接挂住而不是让它失败。远程主机需要 ssh-agent 身份或未加密的密钥文件。
- 内存策略不度量远程运行时。这里的子进程是 `ssh` 会话，其常驻内存说明不了 harness 的任何情况，因此只有空闲规则适用于它。
- 停止空闲运行时也会停掉调度与作业插件本可在空闲期间运行的工作。菜单复选项可关闭该行为；区分"被调度的工作"与"空闲"的策略暂缓。
- 下行通道的路径名在此重述，因为其常量位于 `packages/client` 包中，而 host 侧 TypeScript 程序有意看不到它。
- 该 macOS 包是即席（ad-hoc）签名而非公证：拷贝到另一台机器时需要 `xattr -dr com.apple.quarantine <app>`。Windows 安装程序未签名；SmartScreen 会警告。
- 没有 CI 门禁覆盖该应用。打包需要 macOS 或 Windows，驱动外壳需要窗口会话；本机打包运行自身的引导冒烟测试才是它所交付闭包的证明。在 macOS 上构建的 Windows 安装程序未经冒烟。
- NSIS 安装程序用 [`build/close-app-processes.nsh`](build/close-app-processes.nsh) 替换 electron-builder 对"应用是否在运行"的检测，因为运行时与外壳共用可执行文件，且它重启自身的速度快过默认检测放弃的速度。macOS 构建主机只能证明该脚本可以编译；关闭路径需要在 Windows 上对一个正在运行的应用做一次覆盖安装来验证。
- 在 Windows 上关闭最后一个窗口会退出应用并停止运行时；在 macOS 上不会。
