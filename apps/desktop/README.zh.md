# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

macOS 桌面应用：一个 Electron 外壳，监管一个内嵌的 `dsh --profile web` 运行时，并在原生窗口中呈现它。它以未签名 `.dmg` 交付，由 [`scripts/package-desktop-app.ts`](../../scripts/package-desktop-app.ts) 构建，且自包含——Electron 运行时、harness 依赖闭包与已构建的前端全部位于包内，因此安装后的应用不需要代码检出、不需要 Node 安装，也不需要包管理器。决策记录见[桌面应用 Agent Note](../../.agents/notes/implemented/architecture/2026-08-13-electron-desktop-application.md)。

外壳不新增任何 harness 能力。它通过运行时的本地回环服务器原样复用已发布的 Web 界面，只拥有浏览器标签页无法承担的部分：进程监管、用户的 shell 环境、原生窗口与菜单行为、提醒信号，以及一套内存策略。

## 运行时进程

[`src/runtime-supervisor.ts`](src/runtime-supervisor.ts) 将 harness 作为子进程运行而非置于主进程内，因此一次 harness 故障的代价是一次重启而不是整个窗口，其堆上限也独立于 Chromium 之外。该子进程就是 Electron 自身的二进制，运行在 `ELECTRON_RUN_AS_NODE` 模式下——这正是包内不携带第二份 Node 运行时的原因。

| 关注点 | 行为 |
|---|---|
| 启动 | [`src/runtime-launch.ts`](src/runtime-launch.ts) 拥有参数列表，其中包含 `--expose-internals`。Electron 无法加载 Cordis 用来触及 Node 内部模块加载器的 `node-addon-require-builtin` 插件，因此缺少该标志时 HMR 服务会拒绝启动并带崩整次引导。 |
| 就绪 | 以 `dsh web: <url>` 这一行为准，而不是端口开始应答。[`src/readiness.ts`](src/readiness.ts) 跨数据块边界拼接该行，且只在整行完整时才上报。 |
| 端口 | `--port 0`，因此外壳绝不会与终端里启动的 `dsh web` 抢占端口。 |
| 重启 | [`src/restart-policy.ts`](src/restart-policy.ts) 对已正常服务过的运行立即重启，对启动期失败按指数退避，连续五次后停止。会话是持久的，因此一次重启的代价仅是一个进行中的回合。 |
| 关闭 | 向运行时发送 `SIGTERM`，由它在自身的五秒上限内释放插件树与子进程；只有在八秒宽限期之后才向进程组发信号，这一步捕获的是卡死运行时未回收的子进程。 |
| 日志 | `~/Library/Logs/DeepSeek Harness/runtime.log`，每次运行清空，达到 4 MiB 时轮转。 |

## 用户环境

从 Finder 启动会继承 launchd 的环境，其 `PATH` 只有四个系统目录。智能体要从该 `PATH` 运行用户的工具，因此 [`src/login-environment.ts`](src/login-environment.ts) 在启动时执行一次 `$SHELL -ilc`，读取配置文件组装出的环境，并用标记包裹载荷，使配置文件打印的横幅无法破坏它。当 `PATH` 已带有配置项时跳过探测；探测以五秒为上限，失败则回退到继承的环境。

## 窗口行为

窗口直接加载运行时的本地回环源，且不携带 preload，因此 harness 界面运行在沙箱与上下文隔离之下。引导界面（[`resources/boot.html`](resources/boot.html)）是一个本地文件，运行时未在服务时外壳即导航至此；其按钮是 `dsh-action:` 方案的链接，由 [`src/windows.ts`](src/windows.ts) 拦截。窗口几何在开窗前先按当前连接的显示器校验（[`src/window-state.ts`](src/window-state.ts)），因此记录在已拔除显示器上的窗口不会开在屏幕之外。

## 提醒与电源

[`src/activity.ts`](src/activity.ts) 折叠运行时自身的帧，这些帧经由 [`AbstractApiClient`](../../packages/host/apiproxy/README.md) 的子类通过 WebSocket 下行通道读取：

- **host 流**在运行时提供服务期间保持打开。它报告哪些会话正在运行，据此在回合运行期间恰好持有防休眠锁，并在没有窗口获得焦点时才发出"任务完成"通知。
- **mux 流**仅在没有窗口获得焦点时打开，承载表示智能体正在等待用户的审批与提问帧。可见窗口本就展示这些请求，因此在用户注视时订阅只会让运行时的帧序列化翻倍而不产生任何新信号。待处理请求呈现为 Dock 角标。

## 内存策略

[`src/resource-governor.ts`](src/resource-governor.ts) 每 30 秒采样一次运行时，并应用一套规则，其首要条款是绝不打断智能体工作：所有回收都只作用于空闲的运行时。空闲且十分钟内没有窗口打开的运行时会被停止，并在下次激活时重启；空闲且占用超过物理内存 35% 的运行时会原地重启。空闲停止在应用菜单中是一个复选项。

## Known Limitations and Deferred Work

- 运行时在本地回环上以操作系统分配的端口提供服务且没有认证，这与 `dsh web` 已有的姿态一致：任何以同一用户身份运行的进程都能触及该 API。Electron IPC 载体可以去掉这个端口，代价是重新实现插件包端点、引导清单注入以及 Web 载体已经提供的下行通道。
- 停止空闲运行时也会停掉调度与作业插件本可在空闲期间运行的工作。菜单复选项可关闭该行为；区分"被调度的工作"与"空闲"的策略暂缓。
- 下行通道的路径名在此重述，因为其常量位于 `packages/client` 包中，而 host 侧 TypeScript 程序有意看不到它。
- 该包是即席（ad-hoc）签名而非公证：拷贝到另一台机器时需要 `xattr -dr com.apple.quarantine <app>`。
- 没有 CI 门禁覆盖该应用。打包需要 macOS，驱动外壳需要窗口会话；打包流水线自身的引导冒烟测试才是它所交付闭包的证明。
