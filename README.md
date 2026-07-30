# opencode-plugins

Local plugins for [opencode](https://opencode.ai), built to fill gaps the core does not cover yet:

| Plugin | What it adds |
|---|---|
| [`skill-model-router`](./skill-model-router/) | **Model per skill**, in the style of Claude Code's `model:` skill frontmatter: run a skill on a cheap local model with cloud fallback, per-skill reasoning effort, skill preloading, and health checks. |
| [`compaction`](./compaction/) | **State that survives compaction**, plus the two knobs opencode does not expose: injects on-disk state (task lists, notes, whatever a skill tracks) into the compaction prompt, and optionally compacts at your own threshold — per model, absolute or percentage — on a model of your choosing. Ships a `/compaction-preview` command and a config schema. |
| [`temp-session`](./temp-session/) | A `/temp-session` command for **throwaway sessions**: title-flagged, hidden from `/sessions` where supported, and deleted on the next start. |

Each plugin folder has its own README with full documentation, configuration reference, and known limitations.

## Install

opencode auto-loads local plugins from `plugins/*.{ts,js}` — top level only, no subdirectories — and instantiates every exported function as a plugin. This repository therefore ships a one-file barrel:

1. Copy the plugin folders you want, plus `index.ts`, into your opencode `plugins/` directory (global `~/.config/opencode/plugins/` or per-project `.opencode/plugins/`). Taking only some of them means dropping the others' lines from `index.ts`.
2. Copy `temp-session/commands/temp-session.md` into your `commands/` directory, if you installed that one.
3. Ensure `@opencode-ai/plugin` is a dependency in your config directory's `package.json` (opencode runs `bun install` at startup):

```json
{ "dependencies": { "@opencode-ai/plugin": "^1.4.6" } }
```

4. Restart opencode.

## Tests

Each plugin keeps its testable logic in `lib.ts`, separate from the hooks in
`index.ts`, so the parsing, config merging and decision rules can be exercised
without a running opencode:

```
cd skill-model-router   # or compaction
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
- **The SDK resolves with `{ data, error }` rather than throwing** — a `try`/`catch` around a failing call reports success. Inspect `res.error`, or you will log work that never happened.
- **Types marking a request body optional do not mean the server agrees** — `session.summarize` returns 400 "Expected object, got undefined" without one.
- **A completed assistant message is not a finished turn** — the agent may be midway through a tool-call loop. `session.idle` is the event that means the session has actually stopped working.
- **Log something on startup** — a plugin that loaded and is waiting for its trigger is otherwise indistinguishable from one that failed to load. Note that opencode does not render the `service` field, so grep the message text.

## Related

[`opencode-skill-usage`](https://github.com/jmrona/opencode-skill-usage) lives in its
own repository rather than here: it is a command and a shell script, not a plugin,
so it installs into `commands/` and `scripts/` instead of `plugins/`. It reports
which of your skills actually get used — including, if you run `skill-model-router`,
how often a routed skill was invoked through the native path and bypassed its model.

## Licence

[MIT](./LICENSE)
