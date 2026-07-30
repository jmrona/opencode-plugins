---
description: Show what opencode-compaction would inject into the next compaction prompt
---

!`node --no-warnings --experimental-strip-types ~/.config/opencode/plugins/compaction/preview.ts 2>&1`

The dry run above is already visible to the user. **Do not reproduce any of it.**

Add three or four lines of verdict, no more:

- A provider marked `skipped` with "directory does not exist" means a wrong path.
  "no file matched" usually means there is nothing to inject right now, which is
  normal rather than a fault.
- `fitted` means keys were dropped to fit the budget; name them, and say that
  raising `maxCharsPerProvider`, narrowing `select` or adding to `omit` are the
  levers. Anything listed in `keep` was protected and is intact.
- If the total is near or over the cap, say so.
- If something with no business in a summary appears in the injected block, point
  it out. A `json` provider without `select` injects the whole document.

If asked what this does not show: the summary compaction actually produces. That
is written by a model at compaction time from the conversation plus this block, so
previewing it would mean compacting. This shows the part the plugin contributes.

Do not call any tool and do not load any skill.
