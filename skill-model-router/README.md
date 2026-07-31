# skill-model-router

**Model per skill for [opencode](https://opencode.ai)** — declare a model in a skill's frontmatter and that skill runs on that model, with automatic fallback when it is unreachable.

This is the equivalent of Claude Code's `model:` skill frontmatter field, which opencode does not support natively. Agents can pin a model ([`model` in agent config](https://opencode.ai/docs/agents#model)); skills cannot.

```yaml
---
name: quick-explain
description: Quick, self-contained explanation of a technical concept.
metadata:
  model: llama.cpp/qwen/qwen3.6-35b-a3b   # runs locally
  fallback_model: openai/gpt-5.4          # when the local server is down
---
```

That skill now runs on your local model. Your main conversation keeps its own model and context, untouched.

## Why

Not every skill deserves your best model. Summarising a diff, writing a commit message, classifying a change or explaining a term are cheap, self-contained, text-in/text-out jobs — the sort of thing a 30B model on your own machine handles well. Meanwhile the work that actually needs judgement stays on the expensive model.

opencode has no native way to express that: every skill runs inline on whatever model the session is using. The obvious workaround — switching models by hand around each call — is exactly the kind of bookkeeping you stop doing after a day.

There are open requests for related things — routing by task type ([#8456](https://github.com/anomalyco/opencode/issues/8456)), a tool that lets the model switch models ([#8278](https://github.com/anomalyco/opencode/issues/8278)), a separate model for compaction ([#6976](https://github.com/anomalyco/opencode/issues/6976)) — but none of them is per-skill routing, and agents already have their own `model` field. This plugin fills that specific gap.

The catch with local models is that they are not always up. A router that sends work to `localhost` is only useful if it notices when nothing is listening, which is why the health check and fallback below are not an afterthought.

## How it works

At startup the plugin scans your skills (project `.opencode/skills/` and global `~/.config/opencode/skills/`). For every `SKILL.md` declaring **any routing field** under `metadata`, it registers a custom tool named `skill_<name>` whose description is the skill's own description — so the agent invokes it automatically when relevant, exactly like a normal skill. Skills without routing metadata are left alone; they already work inline, and duplicating them as tools would only bloat the tool list.

When a routed tool runs:

1. **Health check.** If the target provider has an `options.baseURL` (an OpenAI-compatible local server), the plugin probes `GET {baseURL}/models` with a short timeout. This is what avoids opencode's indefinite retry loop against a dead local endpoint. Cloud providers are assumed reachable.
2. **Model selection.** Healthy primary → primary. Unhealthy primary with a `fallback_model` → fallback. Unhealthy primary without one → an immediate, explicit error rather than a hang.
3. **Isolated execution.** The skill body and the caller's task run in a dedicated child session on the selected model, nested under the calling session so it stays navigable without cluttering the root session list.
4. **Generation watchdog.** A model that accepts the request and then hangs mid-generation is aborted after `generation.timeout` seconds, and the fallback is tried.
5. **Visibility.** A TUI toast reports which model actually ran, and the child session title (`skill:explain (openai/gpt-5.6)`) is a permanent audit trail.

> **Why a child session rather than switching the model in place?** opencode's plugin hooks cannot change the model of an in-flight turn. Delegating to a child session is the only mechanism available from plugin land that gets a different model per skill. Native support would be a `model` field in skill frontmatter, the way agents already have one.

## Install

See [the repository README](../README.md) for the shared install steps: copy this
folder plus `index.ts` into your opencode `plugins/` directory, and make sure
`@opencode-ai/plugin` is in your config directory's `package.json`.

Then add routing metadata to a skill and restart opencode. The toast on first use
tells you which model actually ran.

## Skill frontmatter

All routing fields live under `metadata`, the one extensible field opencode's skill spec allows — so skills stay fully compatible with vanilla opencode and with Claude Code:

```yaml
---
name: quick-explain
description: Quick, self-contained explanation of a technical concept.
metadata:
  model: llama.cpp/qwen/qwen3.6-35b-a3b   # required to activate routing
  fallback_model: openai/gpt-5.4          # optional
  reasoning_effort: high                  # optional
  preload: cognitive-profile              # optional, comma-separated
---
```

| Field | Required | Description |
|---|---|---|
| `model` | No | `provider/model-id` the skill runs on. Multi-slash ids work (`llama.cpp/qwen/qwen3.6-35b-a3b` → provider `llama.cpp`). When absent — or set to the alias `default` — the child session is created unpinned and opencode resolves your globally selected model. Useful when you want isolation, `preload` or `reasoning_effort` without forcing a model. |
| `fallback_model` | No | Used when the primary provider fails the health check, errors, or exceeds `generation.timeout`. Without it, failures return an explicit error instead of hanging. |
| `reasoning_effort` | No | Injected as the `reasoningEffort` model option into the child session's LLM calls (via the `chat.params` hook) — the same passthrough agents use. Values are provider-specific (`low`/`medium`/`high`). |
| `preload` | No | Comma-separated skill names whose bodies are prepended to the child prompt, like Claude Code's subagent skill preloading. The child session starts clean and cannot load skills reliably on small models; preloading sidesteps that. |

Note that declaring **any** of these four activates routing — `model` is not special in that respect.

## Configuration

`config.json` sits next to the plugin. All fields optional, defaults shown:

```json
{
  "toast": { "enabled": true, "duration": 5000 },
  "healthcheck": { "timeout": 2 },
  "generation": { "timeout": 120 },
  "display": { "hidePrompt": true }
}
```

| Option | Default | Description |
|---|---|---|
| `toast.enabled` | `true` | Show a TUI toast with the model that actually ran, warning-styled when the fallback was used. |
| `toast.duration` | `5000` | Toast duration in ms. Position is not configurable — it is hardcoded in opencode's TUI. |
| `healthcheck.timeout` | `2` | Seconds to wait for the primary provider's `GET {baseURL}/models` before declaring it dead. Raise it if your local server cold-starts slowly, or you will fall back to the cloud model every time you have not used it in a while. |
| `generation.timeout` | `120` | Seconds to wait for the child-session generation before aborting and trying the fallback. `0` disables the watchdog. Applies per candidate model. |
| `display.hidePrompt` | `true` | Replace the `prompt` argument with `model` in the recorded tool call so the TUI header stays one line. See below. |

Loading the plugin through `opencode.json`'s plugin array in tuple form overrides `config.json`:

```json
{ "plugin": [["./plugins/skill-model-router", { "toast": { "enabled": false } }]] }
```

## Hiding the prompt

Routed prompts are long by design: the child session sees no conversation history, so the caller has to hand it the question, the project context and anything else it needs. opencode's TUI renders plugin tools through a hardcoded generic `name [key=value]` header, ignores the tool part's `title`, and has no expand-on-click ([#21018](https://github.com/anomalyco/opencode/issues/21018)) — so that entire payload lands in your transcript:

```
skill_explain [prompt=User question verbatim: "..." Context: ... cognitive_weights: {...}]
```

The only lever a plugin has over that line is the arguments themselves. With `display.hidePrompt` on, the `tool.execute.before` hook removes `prompt` from the recorded arguments, parks it in memory, and writes a `model` argument instead:

```
skill_explain [model=openai/gpt-5.6]
```

`execute()` reads the prompt back from that stash — keyed by `callID` when the runtime exposes one, otherwise by a per session+tool FIFO. Nothing is truncated or dropped; the full prompt stays available in the child session (navigable from the TUI, the practical "click to see the prompt" path) and in the tool part's `metadata.prompt`, which the web UI renders.

The tool description tells the calling agent that the recorded call is redacted, so it does not re-issue a call whose prompt looks missing.

Set `"display": { "hidePrompt": false }` to restore the original behaviour. Do that if your opencode version validates tool arguments against the plugin schema *after* the `tool.execute.before` hook — deleting a required argument would then fail, and the skill returns `Error: no prompt reached skill "…"`.

## What this is not

The child session **cannot see your conversation** — the tool's `prompt` argument is all the context it gets. That makes this a fit for self-contained skills, and a poor fit for orchestration workflows needing personas, tool access or parallelism. Use opencode's native subagents, which have their own per-agent `model` field, for those.

Routed skills also stay visible to opencode's native `skill` tool. If the agent loads one that way it runs inline on the session model. Deny them in `permission.skill` to force the routed path.

## Development

| File | What it is |
|---|---|
| `index.ts` | Plugin entry — hooks, child-session creation, health probe. The parts that only make sense against a live runtime. |
| `lib.ts` | Pure logic: frontmatter parsing, config merge, model-string splitting, child-prompt assembly. |
| `lib.test.ts` | Unit tests for `lib.ts`. |
| `config.json` | Optional configuration. Defaults apply when absent. |

```sh
bun test lib.test.ts
# or
node --experimental-strip-types --test lib.test.ts
```

The split between `index.ts` and `lib.ts` is the point: parsing, config merging and prompt assembly are all testable without opencode running, while the hooks are not. Keeping them in one file would mean testing none of it. The tests cover frontmatter parsing (CRLF, quoted values, unknown metadata keys), config merge precedence (defaults < `config.json` < plugin options), model-string splitting, and child-prompt assembly.

## Known limitations

- **The tool header can only show its arguments.** opencode's TUI renders custom tools with a generic `name [args]` header and ignores the tool part's title ([#21018](https://github.com/anomalyco/opencode/issues/21018), [#17492](https://github.com/anomalyco/opencode/issues/17492)). `display.hidePrompt` works within that constraint rather than removing it.
- **Concurrent calls to the same skill in one session** fall back to FIFO prompt matching when the runtime exposes no `callID`, so two simultaneous calls to the same skill could swap prompts. Sequential calls — the normal case — are exact.
- **`reasoning_effort` is passed through unvalidated**; values are provider-specific.
- **Cloud providers are assumed healthy**, having no baseURL to probe. Failures there are still caught by the generation watchdog and per-request errors.
- **Toast position is fixed** (top-right, hardcoded in opencode's TUI).

## Origin

This plugin grew out of an idea that came up within my team at
[Future plc](https://www.futureplc.com/) while I was working there. The problem
it addresses — skills that do not need the session's most capable model, with no
way to express that in opencode — was first framed in that context, and the work
started from it.

## Licence

[MIT](./LICENSE), copyright Jose Romero and Future Publishing Limited. This
plugin carries its own licence file; the one at the root of the repository covers
the others.
