// Dry run: shows exactly what this plugin would inject if a compaction happened
// right now, without one happening.
//
// Configuring providers otherwise means editing config, restarting opencode,
// forcing a compaction and reading the logs — a slow loop for questions as small
// as "does this glob resolve?" or "is my select dropping the right keys?". This
// answers them immediately, and reports the same skip reasons the plugin logs.
//
//   node --experimental-strip-types preview.ts
//
// Nothing is written and no compaction is triggered.

import { CompactionContext } from "./index.ts"

type Logged = { message: string; extra?: Record<string, unknown> }

const logs: Logged[] = []
const client = {
  app: { log: async (x: any) => void logs.push(x.body) },
  tui: { showToast: async () => {} },
  // Threshold checks never run here: this only invokes the compaction hook.
  config: { providers: async () => ({ data: { providers: [] } }) },
  session: { get: async () => ({ data: {} }), summarize: async () => ({ data: {} }) },
}

const hooks: any = await CompactionContext({ client } as any, undefined as any)
const output = { context: [] as string[] }
await hooks["experimental.session.compacting"]({ sessionID: "preview" }, output)

// The load line is emitted on a timer so it does not block plugin init; wait for
// it rather than reporting a provider count that has not arrived yet.
await new Promise((r) => setTimeout(r, 3200))

const bar = "─".repeat(72)
const load = logs.find((l) => l.message.startsWith("loaded"))
const skips = logs.filter((l) => l.message.includes("skipped:"))
const injected = logs.find((l) => l.message.startsWith("injected"))

console.log(bar)
console.log(load ? load.message : "plugin did not report loading — check config.json")
if (load?.extra) console.log(`  ${JSON.stringify(load.extra)}`)

if (skips.length) {
  console.log(bar)
  console.log("Skipped:")
  for (const s of skips) console.log(`  ${s.message}${s.extra?.path ? `\n    ${s.extra.path}` : ""}`)
}

console.log(bar)
if (!output.context.length) {
  console.log("Nothing would be injected.")
  console.log("")
  console.log("If that is unexpected: every provider is either disabled, or its file")
  console.log("is missing. A missing file is reported silently by design, since no")
  console.log("active coaching session or no notes yet is the normal state — but a")
  console.log("wrong path shows up under Skipped above.")
} else {
  const text = output.context[0]
  console.log(`Would inject ${text.length} characters` + (injected?.extra ? ` from ${injected.extra.providers} provider(s)` : ""))
  console.log(bar)
  console.log(text)
}
console.log(bar)
