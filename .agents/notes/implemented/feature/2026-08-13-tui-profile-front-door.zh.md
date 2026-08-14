# Agent Note: 交互式终端作为 dsh profile

Status: implemented

[English](2026-08-13-tui-profile-front-door.md) | 中文

## Problem

`dsh` 交付了两个可安装表面——`web` 与 `headless`——却没有交互式终端。当 profile 取代旧的 `--config` 启动器时，全屏 TUI 包[随旧入口一并删除](../../archived/feature/2026-07-17-dedicated-full-screen-tui-front-door.md)，当时预期由一个树外应用继续承载它。结果是产品中最常用的编码 agent 形态落在了仓库之外：没有已交付的交互式前端，没有纳入快照门禁的终端 transcript（文本记录），也没有树内消费者来使用 core 为它注册的工具呈现、提问、恢复与模型选择等表面。

原样恢复旧接线并不可行。启动器已不再持有应用 flag、会话身份或各表面的配置：[应用自己持有命令行](../architecture/2026-08-06-app-owned-command-line.md)，[profile 组合 bundle](../architecture/2026-08-05-profile-plugin-bundles.md)。被删除的 CLI 入口自行解析 `--resume`，并在 Loader 运行前通过 `ctx.provide` 把身份推入——这条通道对 bundle 组合出的应用已不复存在。

## Decision

DeepSeek Harness 以 `tui` profile 交付交互式终端：[`@deepseek-ai/dsh-tui`](../../../../packages/tui/tui/README.md) 是前端插件，[`@deepseek-ai/dsh-tui-app`](../../../../packages/bundle/tui-app/README.md) 是把它组合到 `dsh-base` 之上的 bundle。`dsh --profile tui` 会像 `web` 和 `headless` 一样，从交付的模板自动初始化。

前端包保持了最初决策划下的边界：只负责终端输入与呈现，运行在与其他每个表面相同的 agent、session、工具、命令与用户提问服务之上，并强制要求 TTY，而不是静默降级为面向行的模式。它现在位于 [`packages/tui/`](../../../../packages/tui/README.md)，而非已退役的 `ui/` 分组；该分组命名的是 GUI 的终端一半，与 `client/`、`host/` 并列。

### 本次调用的取值以配置而非 host 槽位到达各行

`tui-startup` 注入 `cmdlineArgs`，解析 `--resume [session]`，解析出本次调用确切的 `SessionId`，并提供 `tuiStartup`。每个依赖本次调用的行都注入该服务，并从惰性 `!!js` 表达式读取它：`agent-loop` 把 `main` 绑定到解析出的身份，`session-query-sqlite` 打开进程本地的 `/resume` 索引，`tui` 行渲染同一个 id。因此本组合并不使用 `MAIN_SESSION_ID_KEY` 与 `CONFIGURED_AGENT_IDENTITIES_KEY`——身份是普通的可 patch 配置，后续层可以读取但无法静默丢弃，因为替换 `agent-loop` 行 config 的 patch 同时也替换了提供它的那个表达式。

不带 id 的 `--resume` 以全新会话进入，由 UI 自己的选择器完成切换，因为只有已挂载的前端知道持久化语料。只有显式 id 才会绑定启动身份。这里刻意没有 `--continue`：挑出本工作区最新的会话需要一次语料查询，而 startup 插件运行在任何 session 服务存在之前，因此这个 flag 只能对自己的行为撒谎。

### 唯一的顺序边，表达为依赖

`tui-app` 发布前端通过 `ctx.get` 读取的可选 host 槽位——原地 resume 交接与退出行——而 `tui` 行注入其中最后发布的 `tuiGoodbyeMessage`。Loader 并发挂载同级行，因此没有这条注入，前端可能在交接尚不存在时就接管终端，并静默丢失原地 `/resume`。把真实取值声明为依赖，无需发明标记服务即可为两行定序。

### 启动横幅承载官方标识

横幅在 `DEEPSEEK HARNESS` 上方绘制 DeepSeek 标识，由交付的 `assets/deepseek-color.svg` 栅格化而来——正是 deepseek.com 字标所携带的同一枚图标——共三档固定尺寸，并为不能信任块绘制字符的终端准备了可打印 ASCII 的孪生版本。终端宽度决定档位，视口三分之一的行数预算会降到更小的标识、直至完全不画，这样矮终端打开时仍以对话为主。这些栅格是静态资源：运行时不生成任何内容；在 truecolor 终端上标识取品牌墨色，其他终端取主题的 accent 角色。

## Verification

该包的 240 个直接行为测试及其提交的终端状态快照重新在树内运行，每份预期输出现在都记录了横幅标识。`packages/tui/*/tests/**/*.snapshot.ts` 加入无密钥快照通道，它通过 headless xterm 而非子进程回放。

有三处行为随 core 改变，并连同其测试一并更新而非保留：steering 以普通 `user/message` 进入持久日志，并与任何其他提示词一样渲染 `You` 头；一个轮次的取消原因通过 `turn/end` 的 `aborted` reason 抵达 transcript，而不再是单独的 `disposed` 种类；附带的 session-reference 快照搭乘提示词自身的 `agent/pre-step` 准入，而非已删除的 `agent/prompt-submit` waterfall，因此拒绝准入的监听器会连同提示词一起丢弃该快照。

## Alternatives considered

- **像被删除的启动器那样，在 Loader 运行前通过 `ctx.provide` 推入身份**——已否决：bundle 组合出的应用没有属于自己的 Loader 前钩子，重新引入一个会让每个 profile 的启动器再次携带表面特定知识，而这恰恰是应用自持命令行所移除的。
- **让 TUI 留在树外并依赖已发布的包**——已否决：终端 transcript 是快照门禁必须覆盖的产品表面，而树外消费者无法与它所渲染的 core API 在同一次变更中更新。上述三处行为变化每一处都会成为静默破坏。
- **仅为把 `tui` 行排在其后而给 `tui-app` 一个标记服务**——已否决：定序需求确实存在，但无内容的服务掩盖了真正被依赖的东西。注入退出行点明了那个一旦缺失就会破坏该表面的取值。
- **手工重绘 ASCII 艺术标识**——已否决：重绘的轮廓会成为品牌标识的第二份事实来源。对交付图标做栅格化，可让终端标识与网站标识保持同一份图形。

## Consequences

- `dsh --profile tui` 是一个可安装的交互式编码 agent，具备该包已实现的恢复选择器、模型选择器、斜杠命令、提问对话框、工具卡片、计划条，以及文件/会话 `@` 引用。
- 编辑器边框与定宽提示前缀，正是 `pi-tui` 现在以源码形式 vendored 到 [`vendor/tui/`](../../../../vendor/tui/README.md)、更名为 `@deepseek-ai/tui` 的原因。pnpm 的 `patchedDependencies` 补丁只到达本 workspace，因此打包出的 `@deepseek-ai/dsh-tui` 解析到的是未打补丁的 `0.80.7`，其 `Editor.setPrompt` 为 undefined，首次渲染即抛错——在 vendoring 之前已通过一次真实的打包安装验证。vendored 副本随 harness 一起发布，消费者因此拿得到这些 API；代价是升级 pi-tui 必须重新应用 [`vendor/README.md`](../../../../vendor/README.md) 中的本地修改 19。
- 上述三处 core API 变化现在由树内消费者钉住：未来对收件箱通知、轮次结束原因或步骤准入的改动会让 TUI 套件失败，而不是让外部仓库失败。
- 每份终端状态预期输出都包含横幅标识，因此对栅格档位或其选择逻辑的改动会成为横跨整套快照、可评审的 diff，而不是一次静默的视觉变化。
