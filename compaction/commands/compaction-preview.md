---
description: Show what opencode-compaction would inject into the next compaction prompt
---

A dry run of the compaction plugin: what it would inject if a compaction happened
right now. No compaction is triggered and nothing is written.

!`node --experimental-strip-types ~/.config/opencode/plugins/compaction/preview.ts 2>&1`

Read the output above and say briefly whether the configuration looks right.

- If a provider was skipped, say which and why. "directory does not exist" means
  a wrong path; "no file matched" usually just means there is nothing to inject
  right now, which is normal.
- If the injected text is close to the character cap, say so — content is
  truncated at the cap, and a block cut short is worth knowing about.
- If something obviously private or irrelevant is in there, point it out. A `json`
  provider without `select` injects the whole document, which is the usual cause.

Do not reproduce the injected text; it is already shown. Keep it to a few lines.
