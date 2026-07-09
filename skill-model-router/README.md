# skill-model-router

**Model per skill for [opencode](https://opencode.ai)** — the equivalent of Claude Code's `model:` skill frontmatter field, which opencode doesn't support natively ([opencode#8456](https://github.com/anomalyco/opencode/issues/8456)).

Declare a model in a skill's frontmatter and the skill runs on that model — for example a local LM Studio / llama.cpp / Ollama model for cheap mechanical tasks — with automatic fallback to a cloud model when the local server is down or hangs.

## How it works

At startup the plugin scans your skills (project `.opencode/skills/` and global `~/.config/opencode/skills/`). For each `SKILL.md` that declares **any routing field** under `metadata` (`model`, `fallback_model`, `reasoning_effort`, or `preload`), it registers a custom tool named `skill_<name>` (dashes become underscores) whose description is the skill's description — so the primary agent invokes it automatically when relevant, exactly like a normal skill. Skills without routing metadata are left untouched: they already work inline through opencode's native skill tool, and duplicating them as tools would only bloat the tool list.

When the tool runs:

1. **Health check.** If the target provider has an `options.baseURL` (OpenAI-compatible local server), the plugin probes `GET {baseURL}/models` with a short timeout. Cloud providers (no baseURL) and unpinned skills are assumed reachable. This avoids opencode's indefinite retry loop against a dead local endpoint.
2. **Model selection.** Healthy primary → primary (the pinned `model`, or the session's globally selected model when unpinned). Unhealthy primary + `fallback_model` → fallback. Unhealthy primary, no fallback → immediate error (no hang).
3. **Isolated execution.** The skill body (plus any `preload` skills) and the caller's task run in a **dedicated child session** on the selected model. Your main conversation's context and model are untouched. The child session is created with the calling session as its parent, so it does not clutter the root `/sessions` list — it nests under the current session (navigable like task-tool subagent sessions) and is titled `skill:<name> (<provider>/<model>)` so you can audit which model actually ran.
4. **Generation watchdog.** If the model accepts the request but hangs mid-generation, the request is aborted after `generation.timeout` seconds (the child session is aborted server-side too) and the fallback is tried.
5. **Visibility.** A TUI toast reports which model actually ran (`quick-explain → openai/gpt-5-mini (fallback: llama.cpp unreachable)`), the tool part's title/metadata record model and reason, and the child session title is the permanent audit trail.

> **Why a child session instead of switching the model in place?** opencode's plugin hooks can't change the model of an in-flight turn. Delegation to a child session is the only plugin-land mechanism that gets a different model per skill. (Native support would be a `model` field in skill frontmatter — see the issue linked above.)

## Install

```
plugins/
├── index.ts                 # barrel — opencode only auto-loads plugins/*.ts (top level)
└── skill-model-router/
    ├── index.ts             # plugin entry
    ├── lib.ts               # pure logic (parsing, config merge, prompt assembly)
    ├── lib.test.ts          # unit tests
    ├── config.json          # plugin configuration (optional)
    └── README.md
```

The barrel re-exports the plugin:

```ts
// plugins/index.ts
export { SkillModelRouter } from "./skill-model-router"
```

Requires `@opencode-ai/plugin` as a dependency in your config directory's `package.json` (opencode runs `bun install` at startup).

## Skill frontmatter

All routing fields live under `metadata`, the one extensible field opencode's skill spec allows — skills stay fully compatible with vanilla opencode and Claude Code:

```yaml
---
name: quick-explain
description: Quick, self-contained explanation of a technical concept.
metadata:
  model: llama.cpp/qwen/qwen3-8b   # optional — omit to use the globally selected model
  fallback_model: openai/gpt-5-mini
  reasoning_effort: high
  preload: style-guide             # comma-separated skill names
---
```

| Field | Required | Description |
|---|---|---|
| `model` | No | `provider/model-id` the skill runs on. Multi-slash model ids work (`llama.cpp/qwen/qwen3-8b` → provider `llama.cpp`). When absent — or set to the explicit alias `default` — the child session is created without a pinned model and opencode resolves your globally selected model. Useful when you only want isolation, `preload`, or `reasoning_effort` without forcing a model. |
| `fallback_model` | No | Used when the primary provider fails the health check, errors, or exceeds `generation.timeout`. Without it, failures return an explicit error instead of hanging. |
| `reasoning_effort` | No | Injected as the `reasoningEffort` model option into the child session's LLM calls (via the `chat.params` hook) — same passthrough agents use. Values are provider-specific (e.g. `low`/`medium`/`high`). |
| `preload` | No | Comma-separated skill names whose bodies are prepended to the child prompt (like Claude Code's subagent skill preloading). The child session starts clean and cannot load skills reliably on small models — preloading sidesteps that. |

## Plugin configuration

`config.json` next to the plugin (all fields optional; defaults shown):

```json
{
  "toast": {
    "enabled": true,
    "duration": 5000
  },
  "healthcheck": {
    "timeout": 2
  },
  "generation": {
    "timeout": 120
  }
}
```

| Option | Default | Description |
|---|---|---|
| `toast.enabled` | `true` | Show a TUI toast with the model that actually ran (warning-styled when the fallback was used). |
| `toast.duration` | `5000` | Toast duration in ms. Position is not configurable — it's hardcoded in opencode's TUI. |
| `healthcheck.timeout` | `2` | Seconds to wait for the primary provider's `GET {baseURL}/models` before declaring it dead and using the fallback. Raise it if your local server cold-starts slowly. |
| `generation.timeout` | `120` | Seconds to wait for the child-session generation before aborting and trying the fallback. `0` disables the watchdog. Applies per candidate model. |

If the plugin is loaded through `opencode.json`'s plugin array using the tuple form, those options override `config.json`:

```json
{ "plugin": [["./plugins/skill-model-router", { "toast": { "enabled": false } }]] }
```

## Writing routable skills

The child session **cannot see your conversation** — the tool's `prompt` argument is all the context it gets (the tool description instructs the calling agent accordingly). This makes the plugin a fit for **self-contained, text-in/text-out skills**: explain, summarise a diff, write a commit message, classify, translate. It is *not* a replacement for orchestration workflows that need personas, tool access, or parallelism — use opencode's native subagents (with their per-agent `model` field) for those.

Note that routed skills also remain visible to opencode's native `skill` tool. If the agent loads one that way, it runs inline on the session model. To force the routed path, deny them in `permission.skill`.

## Tests

```
bun test lib.test.ts
# or
node --experimental-strip-types --test lib.test.ts
```

Covers frontmatter parsing (including CRLF, quoted values, extra metadata keys), config merging precedence (defaults < config.json < plugin options), model-string splitting, and child-prompt assembly.

## Known limitations

- **Tool header doesn't show the model.** opencode's TUI renders custom tools with a generic `name [args]` header and ignores the tool part title. The model is visible in the toast, the tool metadata, and the child session title. (Upstream fix: render `state.title` in `GenericTool`.)
- **Toast position is fixed** (top-right, hardcoded in opencode's TUI).
- **`reasoning_effort` values are not validated** — they're passed through to the provider as-is.
- **Cloud providers are assumed healthy** (no baseURL to probe); failures there are still caught by the generation watchdog and per-request errors.
