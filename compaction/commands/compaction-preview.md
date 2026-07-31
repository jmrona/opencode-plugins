---
description: Show what opencode-compaction would inject into the next compaction prompt
model: openai/gpt-5.6-luna
subtask: true
---

Below is a dry run of the compaction plugin. Nothing has been compacted: the
plugin was only asked which providers it would read and what block it would add
to the next compaction prompt.

!`node --no-warnings --experimental-strip-types ~/.config/opencode/plugins/compaction/preview.ts 2>&1`

---

This runs in a subtask, so the dry run above never reaches the user — only your
final message does. Three of its blocks have to be carried across, and the rest
is yours to interpret.

**Your reply must be exactly the template below**, with each placeholder replaced.
Do not add headings, preambles, or anything before the first line of it.

```
## Providers

[INSERT_PROVIDERS_TABLE_HERE]

[INSERT_PROVIDERS_SUMMARY_HERE]

## Would be injected

[INSERT_INJECTED_BLOCK_HERE]

## Verdict

[YOUR VERDICT]
```

Filling the placeholders:

- `[INSERT_PROVIDERS_TABLE_HERE]` → the text between `<<<TABLE:PROVIDERS>>>` and
  `<<<END:PROVIDERS>>>`, without the markers themselves.
- `[INSERT_PROVIDERS_SUMMARY_HERE]` → the text between `<<<SUMMARY>>>` and
  `<<<END:SUMMARY>>>`, without the markers. It is a single line.
- `[INSERT_INJECTED_BLOCK_HERE]` → the text between `<<<INJECTED>>>` and
  `<<<END:INJECTED>>>`, without the markers, in full however long it is. This is
  the block the compaction model would actually receive, so the user has to see
  all of it.
- `[YOUR VERDICT]` → three or four lines, no more.

**Treat the text between the markers as opaque.** Copy it character for character.
Do not read it for content when copying, do not re-align columns, round numbers,
reorder rows, drop keys, elide the middle of the JSON, or add commentary inside
it. It is already formatted. If a marked block is empty, put "None." in its place
rather than inventing content.

What to look for in the verdict, and how to read it honestly:

- **`skipped` with "directory does not exist"** is a wrong path, and worth saying
  plainly. **"no file matched"** usually means there is simply nothing to inject
  right now, which is normal and not a fault.

- **`fitted`** means keys were dropped to fit the budget. Name the keys that went,
  and give the levers: raise `maxCharsPerProvider`, narrow `select`, or extend
  `omit`. Anything listed under `keep` was protected and is intact.

- **The total against the cap.** Say if it is near or over it. Sitting at 98% of
  the budget is worth a sentence even when nothing has been dropped yet.

- **Content that has no business in a summary.** If the injected block carries
  something transient or irrelevant, say which provider it came from.

- **What this cannot show:** the summary compaction actually produces. A model
  writes that at compaction time from the conversation plus this block, so the
  dry run tells you what that model will be given, not what it will make of it.

Suggest changes; do not make them. Do not call any tool and do not load any skill.
