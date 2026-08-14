# Agent Note: harness-source 段落要求 checkout 真实存在

Status: implemented

[English](2026-08-13-harness-source-section-requires-a-real-checkout.md) | 中文

## Problem

`harness:source` 提示词段落会告诉每个模型「The DeepSeek Harness implementation checkout is at `<path>`」，并请它去该路径查看或扩展 DSH。这个路径由调用方 bundle 自身模块向上数四层目录得到：对本 workspace 中的 `packages/bundle/web-app/{src,lib}/` 正确，在其他任何地方都不正确。

已安装的包位于 `node_modules/@deepseek-ai/dsh-web-app/lib/`，因此同样数四层会落在安装根上。在打包后的桌面应用中，该根是 `<app>/Contents/Resources/backend/`，其中只有 `node_modules` 和一份生成的依赖 manifest——没有 `packages/` 树，没有源码。于是提示词在一个排在 persona 之前的段落里，于每一次请求都指名了一个并不存在的 checkout。

代价是模型会照此行动。当被问到 preset 如何组装插件时，DeepSeek V4 把仓库相对路径（`packages/preset/src`）写进了 `grep`；该搜索根不存在，ripgrep 以 2 退出，`SEARCH_FAILED` 终止了整段 `run_code` 程序，包括那些本会成功的调用。[工作目录区分](2026-07-30-source-checkout-workdir-distinction.md)修正了这个段落在 checkout 确实存在时的措辞，却没有检查它究竟存不存在。

## Decision

`dsh-app-boot` 中的 `resolveHarnessCheckout(moduleUrl)` 沿调用方模块的目录链向上查找 workspace 根 manifest `@deepseek-ai/dsh-root` 来确定 checkout，若没有任何祖先目录带有它则返回 `undefined`。`dsh-web-app` 与 `dsh-tui-app` 两个 bundle 把它的结果直接传给 `addHarnessSourceSection`；后者对 `undefined` 不注册任何东西——与它对没有 `systemPrompt` 服务的树早已具备的静默空操作相同。

标记选用根 manifest 名称，而不是探测 `pnpm-workspace.yaml` 或 `packages/`，因为安装进任一无关 pnpm monorepo 的 dsh 都能满足后者，并把那个仓库当成 harness 的 checkout。

向上查找彻底取代了数层数：两种布局深度不同，任何固定层数都不可能对二者同时成立，而查找在包于 workspace 内移动后依然正确。`addHarnessSourceSection` 仍接受显式的根路径，因此以其他方式获知自身 checkout 的组合仍可指名一个。

已安装的应用对 checkout 只字不提。它没有可读源码可供提供，而声明源码缺席只会引诱模型去搜寻它们。

## Verification

`dsh-app-boot` 单元测试从测试模块自身的 URL 解析出本 workspace，并断言返回的根包含 `packages/boot/app-boot/package.json`，因此重命名根 manifest 会显式失败，而不是悄悄丢掉该段落；另一个测试构造临时的 `node_modules/@deepseek-ai/<pkg>/lib/` 树，沿途放置缺失、无法解析、非对象以及名称不符的 manifest，断言解析结果为 `undefined`。还有一个测试断言根为 `undefined` 时不注册任何段落。`dsh-web-app` 与 `dsh-tui-app` 的组合测试继续从源码观察到该段落。

## Alternatives considered

**保留路径，并将其描述为已安装的包树。** 已否决：模型从一份被告知是「实现」的已编译 `lib/` 产物中得不到任何可行动的东西，而提示词顶部多出的第二个路径，又会成为[工作目录区分](2026-07-30-source-checkout-workdir-distinction.md)当初必须排除的那种工作目录候选。

**探测 `packages/` 或 `pnpm-workspace.yaml`。** 已否决：安装在任何 pnpm monorepo 中都会命中，harness 会把陌生人的仓库当作自己的源码宣告出去。

**由各 bundle 在调用前检查解析出的根。** 已否决：同一个条件判断出现在每个调用方，各自留下未覆盖的 false 分支，而这条规则本可由段落的所有者统一执行一次。

**让桌面应用配置 checkout 路径。** 已否决：它根本没有可配置的 checkout，而配置字段会把「运行中的代码位于何处」这一事实变成部署选择。

## Consequences

从源码运行的开发者所见的段落没有变化。已安装的运行面失去该段落，因此在那里被问及 DSH 内部实现的模型完全没有源码路径，只能询问用户或从会话 workspace 出发——而这正是它的真实处境。段落注册时，向上查找会多出若干次小 manifest 读取，每个运行面挂载一次。

把已安装的运行面指向它确实附带的实现——带有类型声明与 README 的 `node_modules` 包树——仍是开放选项，在把模型送去那里之前需要先确定自己的措辞。
