// Dry run: shows exactly what this plugin would inject if a compaction happened
// right now, without one happening.
//
// Configuring providers otherwise means editing config, restarting opencode,
// forcing a compaction and reading the logs — a slow loop for questions as small
// as "does this glob resolve?" or "is my select dropping the right keys?".
//
//   node --no-warnings --experimental-strip-types preview.ts
//
// It calls the plugin's own readProvider and buildSections rather than
// reimplementing them, so what it reports cannot drift from what the hook does.
// Output is wrapped in markers for the /compaction-preview command to relay.
// Nothing is written and no compaction is triggered.

import { mergeConfig, buildSections, type Section } from "./lib.ts"
import { loadLayers, readProvider, isSection } from "./index.ts"

const cfg = mergeConfig(...(await loadLayers()))

type Row = { name: string; status: string; detail: string; chars: number }
const rows: Row[] = []
const sections: Section[] = []

for (const provider of cfg.providers) {
  const result = await readProvider(provider, cfg.maxCharsPerProvider)
  if (isSection(result)) {
    sections.push(result)
    rows.push({ name: provider.name, status: result.note ? "fitted" : "ok", detail: result.note ?? provider.path, chars: result.body.length })
  } else {
    rows.push({
      name: provider.name,
      status: provider.enabled === false ? "disabled" : "skipped",
      detail: result.skipped === "disabled in config" ? provider.path : result.skipped,
      chars: 0,
    })
  }
}

const blocks = buildSections(sections as any, cfg)
const injected = blocks.length
  ? [
      [
        "The following state lives outside this conversation and must survive compaction.",
        "It is current as of the moment of compaction. Carry it into the summary verbatim",
        "where it is concrete (identifiers, task lists, statuses); do not paraphrase it away.",
      ].join("\n"),
      blocks.join("\n\n"),
    ].join("\n\n")
  : ""

const head = ["provider", "status", "chars", "source / reason"]
const body = rows.map((r) => [r.name, r.status, r.chars ? String(r.chars) : "-", r.detail])
const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length), 3))
const line = (cells: string[]) => "| " + cells.map((c, i) => c.padEnd(widths[i])).join(" | ") + " |"

console.log("<<<TABLE:PROVIDERS>>>")
console.log(line(head))
console.log("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|")
for (const r of body) console.log(line(r))
console.log("<<<END:PROVIDERS>>>")

const ok = rows.filter((r) => r.status === "ok" || r.status === "fitted").length
const truncated = injected.includes("(truncated)")
const pct = cfg.maxChars ? Math.round((injected.length / cfg.maxChars) * 100) : 0
console.log("<<<SUMMARY>>>")
console.log(
  injected.length
    ? `${ok} of ${cfg.providers.length} providers would inject ${injected.length} of ${cfg.maxChars} characters (${pct}%)${truncated ? " - content was truncated at the cap" : ""}.`
    : "Nothing would be injected. Every provider is disabled, or its file is missing.",
)
console.log("<<<END:SUMMARY>>>")

console.log("<<<INJECTED>>>")
console.log(injected || "(nothing)")
console.log("<<<END:INJECTED>>>")
