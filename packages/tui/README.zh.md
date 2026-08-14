# tui/ —— 交互式终端前端

[English](README.md) | 中文

DeepSeek Harness GUI 的终端一半，与 [`client/`](../client/README.md)（浏览器）和 [`host/`](../host/README.md)（其服务端）并列。前端只持有输入与呈现；agent 生命周期、持久化、工具，以及面向模型的提问工具仍是各自独立的组合条目。[profile 前端 Agent Note](../../.agents/notes/implemented/feature/2026-08-13-tui-profile-front-door.md) 持有该表层决策。

| 包 | 角色 | ctx key |
|---|---|---|
| [`tui/`](tui/README.md) | 全屏 pi-tui 前端：transcript、编辑器、对话框、提示词取值注册表 | `ctx.tui`、`ctx.tuiPrompt` |

[`@deepseek-ai/dsh-tui-app`](../bundle/tui-app/README.md) 把本分组组合成已交付的 `dsh --profile tui` 表层。
