# opencode-plugins

Two local plugins for [opencode](https://opencode.ai), built to fill gaps the core does not cover yet:

| Plugin | What it adds |
|---|---|
| [`skill-model-router`](./skill-model-router/) | **Model per skill**, in the style of Claude Code's `model:` skill frontmatter ([opencode#8456](https://github.com/anomalyco/opencode/issues/8456)): run a skill on a cheap local model with cloud fallback, per-skill reasoning effort, skill preloading, and health checks. |
| [`temp-session`](./temp-session/) | A `/temp-session` command for **throwaway sessions**: title-flagged, hidden from `/sessions` where supported, and deleted on the next start. |

Each plugin folder has its own README with full documentation, configuration reference, and known limitations.

## Install

opencode auto-loads local plugins from `plugins/*.{ts,js}` — top level only, no subdirectories — and instantiates every exported function as a plugin. This repository therefore ships a one-file barrel:

1. Copy `skill-model-router/`, `temp-session/`, and `index.ts` into your opencode `plugins/` directory (global `~/.config/opencode/plugins/` or per-project `.opencode/plugins/`).
2. Copy `temp-session/commands/temp-session.md` into your `commands/` directory.
3. Ensure `@opencode-ai/plugin` is a dependency in your config directory's `package.json` (opencode runs `bun install` at startup):

```json
{ "dependencies": { "@opencode-ai/plugin": "^1.4.6" } }
```

4. Restart opencode.

## Tests

```
cd skill-model-router
bun test lib.test.ts
# or
node --experimental-strip-types --test lib.test.ts
```

## Lessons for opencode plugin authors

Collected the hard way while building these:

- **Never await opencode API calls during plugin init** — plugins initialise while the server boots; a synchronous call deadlocks the start and the TUI comes up blank. Detach startup work.
- **Do not cancel commands by throwing from `command.execute.before`** — the TUI renders hook errors with a full stack trace.
- **Feature-detect the server** — capabilities such as `time.archived` on session update or the `tui.session.select` event vary between builds. Send best-effort, then verify the result.
- **Plugin hooks cannot change the model of an in-flight turn** — delegation to a child session is the only plugin-land mechanism for per-task model selection; `chat.params` can, however, inject model options (e.g. `reasoningEffort`) into a session's LLM calls.
- **Custom tools render generically in the TUI** — the tool-part title set via `ctx.metadata` is not shown in the header; use toasts, metadata, and session titles for visibility.

## Licence

[MIT](./LICENSE) — set the copyright holder in `LICENSE` before publishing.
