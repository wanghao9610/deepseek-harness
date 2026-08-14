# `@deepseek-ai/dsh-tui-app`

[English](README.md) | 中文

交互式终端 bundle：叠加在 [`dsh-base`](../base/README.md) 之上的 `tui` patch 层，以及 `dsh --profile tui` 背后的运行时粘合插件。[profile 前端 Agent Note](../../../.agents/notes/implemented/feature/2026-08-13-tui-profile-front-door.md) 持有组合决策；[`@deepseek-ai/dsh-tui`](../../tui/tui/README.md) 持有终端呈现与输入。

```sh
dsh --profile tui                          # a fresh session in this directory
dsh --profile tui --resume                 # pick a session to resume from the list
dsh --profile tui --resume <session-id>    # resume that exact session
```

profile 会在首次使用时从交付的模板自动初始化，无需事先安装任何东西。调用所在目录即工作区：会话 `cwd`、相对路径与工作区指令都由它解析。会话本身存放在 Harness home 下，因此 `/resume` 能触达每个工作区，恢复时会进入所选会话自己的目录。

## 这层 patch 加了什么

在共享 base 之上，本层配置终端 persona，把 `agent-loop` 的 `main` agent 绑定到本次调用，把 `fs-sandbox` 钉在进程目录，并打开 `/resume` 搜索索引。它插入 Code Mode 的 worker-thread 运行时、session reference、支撑 `/resume` 标题缓存的存储栈、tmux 与时钟上下文、带提示词取值注册表的终端前端，以及由前端提供键盘 UI 的面向模型的 `ask_user_question` 工具。

逐行取值见生成的[配置目录](../../../docs/config-catalog.md)；`dsh --profile tui --dump-config` 会打印你机器上真正启动的那棵树。

## 命令行

`tui-startup` 持有本应用的 flag（[应用自持命令行](../../../.agents/notes/implemented/architecture/2026-08-06-app-owned-command-line.md)），并把它们作为 `tuiStartup` 服务发布。各行从惰性 `!!js` 表达式读取解析后的调用，因此 `dsh --profile tui --help` 什么都不提供、不启动 agent，也绝不接管终端。

带 id 的 `--resume` 在启动时绑定该确切会话，日志缺失时会响亮失败。不带取值的 `--resume` 开启全新会话，把切换交给前端自己的选择器——那才是知道持久化语料的一半。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `goodbye` | 必填 | 终端释放后退出时打印的一行；返回本会话的命令 |
| `queryIndexPath` | 必填 | 本进程一次性 `/resume` 搜索索引的绝对路径，销毁时删除 |
| `surfaceContext` | `true` | 注册 harness-source 与 terminal-surface 提示词分节 |

## 模型体验

### Harness 源码与终端表面上下文

#### 模型看到什么

当 `surfaceContext` 为 true 且本包从仓库 checkout 运行时，`harness:source` 分节指出磁盘上的 Harness 实现，且不声称它就是工作目录；已安装的副本没有可读的 checkout，因此该分节直接缺席，而不是指向一个不含源码的路径。`app:terminal-surface` 分节（order −98）向模型交代交互式终端：回复以 Markdown 渲染，每次工具调用各渲染为一张卡片并与当前计划并列，用户可以打断一个轮次、在中途 steer 并回答提问——因此当选择权属于用户时，问比猜更好。为 false 时两个分节都不注册；用户不在此终端前的组合必须关闭它，否则那段定位文本就是假的。

#### Token 影响

每个会话一行源码路径加一段提示词，合计约 90 token；每进程恒定。插入的 `ask_user_question` 行会向工具目录添加自己的 schema，由 [`dsh-tool-ask-user`](../../interaction/tool-ask-user/README.md) 持有。

#### KV 缓存影响

两个分节都位于系统提示词头部附近，并在进程生命周期内固定，因此跨轮次绝不会让缓存失效。

## 已知限制与延期工作

- **resume 交接需要 `process.execve`。** 原地 `/resume` 会替换本进程，使恢复的会话运行在它自己的工作区中。在 Node 未暴露 `execve` 的地方（Windows，以及任何不含它的构建），粘合层不提供交接，前端会报告该会话可选中但无法原地恢复。那里的恢复方式是退出后以 `--resume <id>` 重新运行。
- **没有 `--continue`。** 不经挑选就重开本工作区最近一个会话需要一次语料查询，而 startup 插件运行在任何 session 服务存在之前。它诚实的归属地是前端——它本就为自己的选择器扫描候选：给它一个配置开关，让它在挂载时自动选中当前工作区最新的一行。在那之前，用 `--resume` 打开选择器。
