# compaction

**Keep state alive across compaction in [opencode](https://opencode.ai).** When a long session gets compacted, this plugin appends the state that lives *outside* the conversation — a task list on disk, notes about how you work, the phase an agent is halfway through — to the compaction prompt, so the summary keeps it.

## The problem

Compaction replaces your transcript with a summary, and the agent carries on from that summary. Whatever the summariser drops is gone.

That is fine for chat, and quietly destructive for anything stateful. A skill tracking a ticket across six phases keeps its state in a JSON file on disk; the summariser never sees that file, only the messages, so it has no reason to preserve "we are on phase 4 of 6, tasks 1 and 2 are done, the user asked to skip the design phase". After compaction the agent picks up a plausible-sounding summary and starts improvising — usually by re-asking things you already answered.

You can tell the skill to re-read its state file after compaction, and that helps, but it depends on the model remembering an instruction at exactly the moment its memory was truncated. This plugin removes the dependency: the state goes *into* the compaction prompt, so it is in the summary rather than something to be recovered afterwards.

## How it works

It hooks `experimental.session.compacting`, reads the files you list as **providers**, formats them, and appends them to the prompt with an instruction to carry concrete details through verbatim.

A **provider** is just a file you want to survive compaction, plus how to turn it
into text. The plugin knows nothing about what is in it — point it at whatever
your setup keeps outside the conversation:

- A `NOTES.md` or `TODO.md` in the project, so the agent does not forget the plan.
- Whatever a stateful skill writes to disk — a task list, a phase, a checklist.
- A file of preferences or conventions you would otherwise repeat every session.
- Anything a script generates: current branch and open PRs, a deploy status, a
  failing-test list.

**Nothing is enabled out of the box.** The shipped `config.json` contains two
disabled examples, so a fresh install injects nothing until you say what matters
to you. Set `enabled: true` on one, or add your own.

### What not to add

Not everything needs rescuing, and the budget is small enough that adding the
wrong things crowds out the right ones. The test is whether it lives outside
*both* the conversation and the system prompt:

| Where it lives | Survives compaction? | Worth a provider? |
|---|---|---|
| `AGENTS.md`, rule files loaded via `instructions`, skill descriptions | Yes — they are in the system prompt, which is re-sent on every request | No |
| Things said in the conversation | Only if the summariser keeps them | No, that is what compaction is already trying to do |
| State files on disk | No, nothing reads them | **Yes** |

Rules are the tempting mistake: they feel important, so it seems natural to
protect them. But opencode puts them in the system prompt, so they are already
there after every compaction — injecting them again duplicates them and spends
budget that something genuinely at risk could have used.

The simplest possible provider is a file injected as-is:

```json
{
  "name": "project notes",
  "heading": "Project notes",
  "path": "./NOTES.md",
  "format": "raw"
}
```

A more involved one, pulling the live state out of a skill that writes JSON per
ticket and keeping only the fields that matter:

```json
{
  "name": "ticket-coach session",
  "heading": "Active coaching session",
  "path": "~/.config/opencode/data/ticket-coach/sessions/*.json",
  "format": "json",
  "pick": "newest",
  "select": ["ticket_id", "phases", "current_phase_index", "tasks"]
}
```

And an append-only log, where only the recent entries are worth carrying:

```json
{
  "name": "preferences",
  "heading": "How this person works",
  "path": "~/.config/opencode/data/notes.jsonl",
  "format": "jsonl",
  "tail": 8
}
```

| Field | Purpose |
|---|---|
| `path` | File to read. `~` and `$HOME` expand. A `*` in the final segment is matched against the directory. |
| `format` | `raw` (default), `json`, or `jsonl`. |
| `select` | `json` only. Top-level keys to keep — the point is to inject the state, not the whole file. |
| `tail` | `jsonl` only. How many trailing lines to keep. Defaults to 10. |
| `pick` | `newest` (default) or `all`, when a glob matches several files. |
| `heading` | Markdown heading above this block. Defaults to `name`. |
| `enabled` | Set `false` to keep an entry configured but inactive. |

`select` is the field that earns its keep. A ticket-coach session file carries a full design plan that is deliberately never shown to the user; injecting it into a compaction prompt would both waste the budget and leak it into the summary. Naming the keys you want keeps the injection to the part that actually needs to survive.

## Two caps, and why

`maxCharsPerProvider` and `maxChars` bound each block and the total. Without them, this plugin quietly works against itself: compaction exists to shrink context, and a plugin that pastes 40KB of JSON into the compaction prompt makes the problem it was called to solve worse. Truncation cuts on a line boundary where it can and appends `… (truncated)` so a clipped block never reads as a complete one.

## Failure behaviour

The hook fires at the one moment where state is about to be discarded, so it is written to fail small:

- A missing file is the normal state — no coaching session running, no notes yet — and is skipped silently.
- A file that exists but cannot be read or parsed (half-written JSON, say) is skipped **with a reason in the log**. Silent skipping was the original behaviour and it was wrong: "the plugin quietly did nothing" is indistinguishable from "there was nothing to inject", which defeats the point of the plugin.
- Any unexpected error is caught and logged, and compaction proceeds unchanged. Adding no context is a bad outcome; breaking compaction is a much worse one.

Everything the plugin does is logged. Note that opencode does not render the
`service` field in its log lines, so grep for the message text rather than for
`compaction-context`:

```sh
grep -h "provider(s)\|injected context\|skipped:" ~/.local/share/opencode/log/opencode.log | tail
```

On startup you should see `loaded with N provider(s): …`; after a compaction,
`injected context into compaction prompt` with the character count.

## Compacting earlier than opencode would

opencode compacts at a threshold you cannot configure. This plugin can compact
sooner, which is the [most](https://github.com/anomalyco/opencode/issues/8140)
[requested](https://github.com/anomalyco/opencode/issues/10016)
[missing](https://github.com/anomalyco/opencode/issues/11314)
[knob](https://github.com/anomalyco/opencode/issues/11930) around compaction.

```json
"threshold": {
  "enabled": false,
  "at": 0.6,
  "model": null,
  "cooldownMs": 60000,
  "toast": true
}
```

| Field | Purpose |
|---|---|
| `enabled` | Off by default. Triggering compaction is a real intervention, unlike appending text to a prompt. |
| `at` | Fraction of the model's context limit at which to compact. |
| `model` | `provider/model-id` to run the compaction on. `null` uses the session's model. Summarising is mechanical work; a cheaper model usually does it fine. |
| `cooldownMs` | Minimum gap between triggers for one session. |
| `toast` | Show a TUI toast when it fires. |

It acts on `session.idle`, never mid-turn. An assistant message completing does
not mean the agent has finished: it may be partway through a tool-call loop, and
compacting there truncates the work — in testing, a session researching a release
lost its answer that way. Token usage is recorded as messages complete, but the
decision waits for the session to go quiet.

**Watch before you enable it.** Every completed assistant turn logs the fraction it
computed, whether or not it fires:

```
context 41.3% (52907/128000) — below threshold
```

That figure is an estimate — `input + cache.read` from the last completed request
— so it lags the true size by whatever has been added since. Rather than trusting
a default, run with `enabled: false` for a few sessions, see what the log reports
just before opencode compacts on its own, and set `at` below that.

Getting this from history rather than guesswork is possible too, since opencode
records both the compaction events and the token counts. Two things to know if you
try: the `compaction` part is only a marker, so you have to look at the assistant
message before it, and summing all four token fields over-counts badly — totals
came out above the model's own context limit, which is what pinned the estimate
down to `input + cache.read`.

**It will not fire** on child sessions (routed skills and subagents, which are
short-lived and mid-task), on the summary message a compaction just produced,
while a compaction it triggered is still running, within the cooldown, or when the
model's context limit is unknown. The last one matters: guessing a limit would mean
compacting at an arbitrary point, so it does nothing instead.

## Does it actually work?

Reasonable question for a plugin whose whole output is a few paragraphs appended
to a prompt you never see. The compaction prompt itself is not persisted — the
`compaction` part opencode stores is only a marker (`auto`, `overflow`,
`tail_start_id`) — so the way to check is the summary it produced:

```sh
sqlite3 -readonly ~/.local/share/opencode/opencode.db "
WITH c AS (
  SELECT session_id, time_created FROM part
  WHERE json_extract(data,'\$.type')='compaction'
  ORDER BY time_created DESC LIMIT 1
)
SELECT substr(json_extract(p.data,'\$.text'), 1, 800)
FROM part p, c
WHERE p.session_id = c.session_id AND p.time_created >= c.time_created
  AND json_extract(p.data,'\$.type') = 'text'
ORDER BY p.time_created LIMIT 1;"
```

The cleanest test is to compact a session whose conversation has nothing to do
with the injected state. If a session spent entirely discussing something else
produces a summary naming your ticket, your task statuses and your preferences,
that information cannot have come from the transcript.

## Install

See [the repository README](../README.md) for the shared install steps: copy this
folder plus `index.ts` into your opencode `plugins/` directory, and make sure
`@opencode-ai/plugin` is in your config directory's `package.json`.

Then edit `config.json` to point at your own state files, and restart opencode.

`config.json` is yours once installed. Updating the plugin means pulling the code,
not overwriting that file — the version in this repository ships with everything
disabled precisely so it is never the interesting one.

## Development

| File | What it is |
|---|---|
| `index.ts` | Plugin entry: the hook, file resolution, logging. |
| `lib.ts` | Pure logic: config merge, path/glob handling, formatting, truncation, budget. |
| `lib.test.ts` | Unit tests for `lib.ts`. |
| `config.json` | Default providers. |

```sh
node --experimental-strip-types --test lib.test.ts
```

The split exists so the fiddly parts — glob matching, `select` fallbacks, truncation boundaries, budget exhaustion — are testable without a running opencode. The hook itself is thin on purpose.

## Status and scope

Both halves of the plugin are in place: injecting state into the compaction prompt, and triggering compaction on a configurable threshold.

`experimental.session.compacting` is, as the name says, experimental. It could change.

## Licence

MIT
