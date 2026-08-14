# `@deepseek-ai/dsh-ssh-launch`

[English](README.md) | 中文

为经 SSH 由另一台主机提供服务的 harness runtime 做启动规划。这是一个纯库：不在 Cordis context 上注册任何东西，也不启动任何进程。持有 runtime 生命周期的外壳——目前是 [`apps/desktop`](../../../apps/desktop/README.md)——负责派生该计划、分配本地回环端口，并施加自己的重启策略。

本包持有三个决策：

| 决策 | 导出 |
|---|---|
| 一条已存连接可以包含什么 | `SshTarget`、`RemoteLauncher`、`validateSshTarget`、`readSshTargets`、`resolveSshTarget` |
| 要求 `ssh` 用它做什么 | `planSshLaunch`、`planPayloadProbe`、`planPayloadTransfer`、`remoteCommandLine`、`quoteRemoteArgument`、`pickRemotePort` |
| 结果意味着什么 | `verifyForwardedUrl`、`readHostProbe`、`describePayloadMismatch`、`readProgress`、`diagnoseSshFailure` |

## 校验就是执行点

`SshTarget` 的每个字段最终都会到达 `ssh` 参数或远端登录 shell，而设置文件与表单都是人可以书写的边界。因此 `validateSshTarget` 拒绝的是那些会改变命令**含义**而非参数的取值：以 `-` 开头的 host、user 或跳板机——`ssh` 会把它读成选项，其中包括在外壳自己机器上执行命令的 `ProxyCommand`——以及出现在任何位置的控制字符。`readSshTargets` 在恢复已存列表时套用同一规则，丢弃本构建无法使用的条目，而不是让整个列表失败。

通过校验的取值仍要引用：`remoteCommandLine` 会把每个已配置的词交给 `quoteRemoteArgument`，因为 sshd 交给账户 shell 的是一个字符串，而不是参数向量。

## `ssh` 命令行

`planSshLaunch(target, ports)` 为同时启动 runtime 并把其回环端口转发回来的这一次会话返回 `{command, args, localOrigin}`：

| 选项 | 为什么 |
|---|---|
| `BatchMode=yes` | 桌面外壳没有可用来回答提示的终端。需要提示的连接会带着诊断失败，而不是无限等待；这也意味着主机必须接受 ssh-agent 身份或未加密的密钥文件。 |
| `ExitOnForwardFailure=yes` | 否则一个没有绑定成功的转发，会在无人应答的端口前留下一个看起来健康的会话。 |
| `ServerAliveInterval` / `ServerAliveCountMax` | 链路中断会表现为 supervisor 可以重启的 `ssh` 退出。以 `-o` 传入，因此对这一条连接会覆盖用户自己的 `ssh_config`。 |
| `-T` | runtime 的 stdout 承载就绪行与日志；分配 pty 会改写两者。 |
| `-L` | 窗口与 API 客户端所访问的转发。 |

目标没有指定的一切——用户、端口、身份、跳板机——都交给用户自己的 `ssh` 配置，它保持权威。

## 远端脚本

`remoteCommandLine` 生成的脚本从远端双向监管 runtime，因为两个方向都无法从对方推出：杀掉本地 `ssh` 触及不到 sshd 已从通道分离的远端 runtime，而自行退出的 runtime 会让 `ssh` 连着一个什么都不提供的会话。脚本把 runtime 放到后台、等待它、并以它的状态码退出；由 shell 内建的 read——而不是辅助进程，后者被杀死后仍会占着会话的 stdin——在 stdin 关闭时结束 runtime。

该看门狗读的是会话 stdin 的一个副本，而不是 stdin 本身。关闭作业控制的 shell 会在处理显式重定向**之前**，把每个异步命令的 stdin 指向 `/dev/null`，因此一个读 fd 0 的看门狗会在启动的瞬间读到文件结束，杀掉它本该守护的 runtime——在 `sh` 与 `bash` 上如此，`zsh` 上则不会。

**调用方必须在 runtime 的整个生命周期内为该脚本保持 stdin 打开。** 关闭 stdin 就是优雅停止，它以 `SIGTERM` 的形式到达 runtime 并触发其自身的销毁流程；而一个 stdin 为 `/dev/null` 的启动会在 runtime 刚起来的瞬间把它结束掉。

脚本默认通过登录 shell 解析启动器，因为 `ssh host <command>` 运行的是非交互 shell，其 `PATH` 常常不含用户级 npm 前缀。指定了绝对路径启动器的目标可以关掉它。

## 服务端根目录

主机上只用一个目录承载某条连接接触到的一切，删掉它就抹掉了每一次访问的痕迹：

```
~/.dsh-server/            the server root, exported to the runtime as DSH_HOME
  bin/<version>/          an installation from the registry
  bin/<version>-<digest>/ an installation from a payload this machine sent
  sessions/ storages/     what the runtime itself writes
```

连接可以指定另一个根目录——绝对路径，或以 `~/` 开头——这一个根同时移动安装物与数据。路径在对面构造，因为只有对面知道 `$HOME` 在哪。

## 启动器从哪里来

`RemoteLauncher` 是互斥的，三种恰好覆盖了主机能访问到什么：

| 启动器 | 适用于这样的主机 | 安装到 |
|---|---|---|
| `{kind: 'managed', version?}` | 能访问 npm registry | `bin/<version>` |
| `{kind: 'archive', path}` | 什么都访问不到——负载由本机送去 | `bin/<version>-<digest>` |
| `{kind: 'host', command}` | 已经自带启动器 | — |

三种都没指明的目标会得到一次受管安装：已带启动器的主机是例外，而一次悄悄找错 `dsh` 的 `PATH` 查找，比一份由外壳持有的安装更糟。两种"装上去"的形式都完全不看账户的 `PATH`，这正是它们能在登录 shell 没有 `PATH` 的主机上工作的原因。

从 registry 安装是同一段脚本的前置部分，因此供给与启动是同一次 `ssh` 会话、同一次认证：

```sh
dsh_dir="$dsh_home/bin/<version>"
dsh_launcher="$dsh_dir/node_modules/.bin/dsh"
if [ ! -x "$dsh_launcher" ]; then …node and npm checks… npm install --prefix "$dsh_dir" …; fi
```

**启动器存在就是全部检查。** 之后的连接不需要 registry、也不需要网络，而且没有任何东西会自行升级：目录按连接所请求的内容作用域，因此改变它才是移动一台主机的动作。版本名与摘要被校验到路径安全的字母表，这正是脚本可以不加引用地把它插进路径的原因。

前置部分用 `readProgress` 读取的 `dsh-remote: ` 前缀播报自己的步骤，因为安装要花上几分钟，而什么都不显示的外壳看起来像卡死了。它也把自己能指认的失败——没有 Node、Node 太旧、没有 npm、安装失败、安装后没有启动器、没有 tar、负载没能解开——作为退出状态交给 `diagnoseSshFailure` 直接读取，因为只有这些失败的含义无需从输出里还原。

## 给没有网络的主机送去负载

外壳读出归档自称是什么，向主机问一个问题，然后把归档流式送进一个负责解包的 `ssh`。两台机器上都不落临时文件。

`planPayloadProbe` 问的就是那一个问题，并在一次往返里拿到两个答案：主机是什么，以及它是否已经带有这份负载。前者不是走过场——**负载只能在它被构建的那个平台上运行。** 它携带的 closure 含有运行时在启动时导入的已编译模块，因此在别处构建的负载意味着一个根本起不来的运行时，而不是一个降级运行的运行时；`describePayloadMismatch` 会在任何字节被搬动之前把它变成一次拒绝。请在与主机匹配的机器上构建负载：`pnpm run package:remote-server`。

`planPayloadTransfer` 在目标旁边解包再改名就位，因此被中断的传输不会留下任何会被之后的探测误认为完整安装的目录。负载不自带 Node——它替代的是 registry，不是其下的运行时——所以启动仍会拒绝 Node 太旧的主机。它的启动器是包自身的入口 `node_modules/@deepseek-ai/dsh/lib/bin.js`：部署出的 closure 是一棵依赖树，不是一次 npm 安装，没有 `node_modules/.bin`。

## 两个端口

外壳通过绑定来分配本地那一端，这是它在自己机器上能做到的。在 runtime 绑定之前，没有任何办法证明某个远端端口是空闲的，因此 `pickRemotePort` 从 IANA 动态范围内抽取，而冲突是一次调用方用新抽取值重试的启动失败——与处理本地冲突的是同一条路径。

远端 runtime 报告的是它在自己主机上绑定的地址，而只有被转发的端口能被外壳访问到。`verifyForwardedUrl` 会拒绝其他任何地址，而不是把窗口指向一个正在提供别的东西的端口。

## 模型体验

无：本库为运行在任何 harness context 之外的外壳规划进程启动；这里没有任何东西会进入模型请求。

#### KV 缓存影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与后续工作

- **不支持交互式认证。** `BatchMode=yes` 正是让失败的连接不会把窗口化外壳永远挂住的原因，它同时排除了口令、键盘交互与加密密钥的提示。想要这些的外壳必须自己拥有提示界面，并为该连接去掉这个选项。
- **静默中断的链路可能让远端 runtime 活得更久。** stdin 看门狗在 sshd 关闭通道时触发，这需要 sshd 察觉客户端已消失：`ClientAliveInterval` 默认是关闭的，因此一条没有发出 TCP FIN 就被切断的链路，会让远端 runtime 一直等到 TCP keepalive 到期。
- **profile 不向表单暴露。** 提供窗口的外壳需要一个提供 HTTP 的 profile，因此 `profile` 只是一个已存字段，而不是人在添加主机时做的选择。
- **从 registry 安装需要主机上有 npm。** 没有 Node、Node 版本低于启动器所需、或没有 npm 的主机会被带着诊断拒绝，而不是改用别的方式供给；对于有 Node 但没有 registry 的主机，答案是负载。
- **负载锁定平台，且由别处产出。** 它携带已编译模块，因此在 macOS 上构建的负载无法服务 Linux 主机；本包不构建负载：`pnpm run package:remote-server` 为它运行所在的那台机器产出一份。
- **任何安装都不会原地升级。** 连接所请求的内容决定目录作用域，因此主机会停在它首次安装的那一份上，直到连接改为请求别的东西。此后已经移动的 dist-tag——包括 `latest`——不会移动那台主机。
- **仅支持 OpenSSH。** 该计划是一条 OpenSSH 客户端命令行；其他客户端的选项不做转换。
