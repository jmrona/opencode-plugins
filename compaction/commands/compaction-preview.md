---
description: Show what opencode-compaction would inject into the next compaction prompt
subtask: true
---

A dry run of the compaction plugin. No compaction is triggered and nothing is written.

!`node --no-warnings --experimental-strip-types ~/.config/opencode/plugins/compaction/preview.ts 2>&1`

---

This runs in a subtask, so the output above never reaches the user — only your
final message does. Two blocks have to be carried across.

**Your reply must be exactly the template below**, with each placeholder replaced.
Nothing before the first line of it, nothing after the last.

```
## Providers

[INSERT_PROVIDERS_TABLE_HERE]

[INSERT_SUMMARY_LINE_HERE]

## What would be injected

[INSERT_INJECTED_BLOCK_HERE]

## Verdict

[YOUR VERDICT]
```

Filling the placeholders:

- `[INSERT_PROVIDERS_TABLE_HERE]` → the text between `<<<TABLE:PROVIDERS>>>` and
  `<<<END:PROVIDERS>>>`, without the markers.
- `[INSERT_SUMMARY_LINE_HERE]` → the text between `<<<SUMMARY>>>` and
  `<<<END:SUMMARY>>>`, without the markers.
- `[INSERT_INJECTED_BLOCK_HERE]` → the text between `<<<INJECTED>>>` and
  `<<<END:INJECTED>>>`, without the markers, wrapped in a fenced code block.
- `[YOUR VERDICT]` → three or four lines, no more.

**Treat the text between markers as opaque.** Copy it character for character. Do
not re-align columns, round numbers, reorder rows or shorten anything.

The injected block is the whole point of the command: it is what would be appended
to the compaction prompt, and seeing it is how anyone judges whether the
configuration is right. Copy it in full, however long it is.

Note what this does **not** show, and say so if asked: the summary compaction
would actually produce. That is written by a model at compaction time from the
conversation plus this block, so it cannot be previewed without compacting. What
is shown here is the part the plugin contributes and you control.

For the verdict, say only what the output supports:

- A provider marked `skipped` with "directory does not exist" means the path is
  wrong. "no file matched" usually means there is simply nothing to inject right
  now, which is normal and not a fault.
- If the summary says content was truncated, say which provider is oversized —
  the `chars` column shows what each produced before the cap — and note that
  raising `maxCharsPerProvider` or narrowing that provider's `select` would fix
  it. Truncation is worth flagging because the tail of a block is silently lost.
- If the injected text contains something that has no business in a summary,
  point it out. A `json` provider without `select` injects the whole document,
  which is the usual cause.
- If everything is in order, say so in one line rather than padding.

Do not call any tool and do not load any skill. Everything needed is above.
