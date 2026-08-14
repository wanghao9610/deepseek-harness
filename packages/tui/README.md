# tui/ — the interactive terminal front door

English | [中文](README.zh.md)

The terminal half of the DeepSeek Harness GUI, parallel to [`client/`](../client/README.md) (browser) and [`host/`](../host/README.md) (its server side). A front door owns input and presentation only; agent lifecycle, persistence, tools, and the model-facing question tool stay separate composition entries. The [profile front-door Agent Note](../../.agents/notes/implemented/feature/2026-08-13-tui-profile-front-door.md) owns the surface decision.

| Package | Role | ctx key |
|---|---|---|
| [`tui/`](tui/README.md) | Full-screen pi-tui front door: transcript, editor, dialogs, prompt-value registry | `ctx.tui`, `ctx.tuiPrompt` |

[`@deepseek-ai/dsh-tui-app`](../bundle/tui-app/README.md) composes this group into the shipped `dsh --profile tui` surface.
