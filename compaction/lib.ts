// Pure logic for the compaction-context plugin.
//
// Everything here is deliberately free of opencode APIs and of any I/O beyond a
// reader function passed in, so it can be tested without a running opencode.
// index.ts holds the parts that only make sense against a live runtime.

import { homedir } from "node:os"

export type Format = "raw" | "json" | "jsonl"

export type Provider = {
  /** Shown in logs; not injected. */
  name: string
  /** File to read. `~` is expanded. May contain a `*` glob in the final segment. */
  path: string
  /** How to turn the file into text. Defaults to `raw`. */
  format?: Format
  /** `json` only: top-level keys to keep. Omit to keep the whole document. */
  select?: string[]
  /** `jsonl` only: how many trailing lines to keep. Defaults to 10. */
  tail?: number
  /** When a glob matches several files, which one to use. Defaults to `newest`. */
  pick?: "newest" | "all"
  /** Markdown heading placed above this provider's text. Defaults to `name`. */
  heading?: string
  /** Set false to keep the entry in config but stop injecting it. */
  enabled?: boolean
}

/**
 * Where to compact, expressed as an absolute token count, a percentage of the
 * model's context window, or a fraction of it.
 *
 * Three forms because one is not enough. A fraction that is safe on a 1M window
 * is not safe on a 128k one: the floor a session settles at after compacting is
 * roughly a fixed number of tokens — system prompt, skill descriptions, the
 * summary — so on a small window that same fraction can sit below the floor and
 * re-fire forever. An absolute limit sidesteps that entirely.
 */
export type Trigger = number | string

export type ThresholdConfig = {
  /** Off by default: firing compaction early is a bigger intervention than injecting text. */
  enabled: boolean
  /** Default trigger for any model without an entry in `modelLimits`. */
  at: Trigger
  /** Per `provider/model-id` overrides, which win over `at`. */
  modelLimits: Record<string, Trigger>
  /** `provider/model-id` to run the compaction on. Null uses the session's own model. */
  model: string | null
  /** Ignore further triggers for this long after firing, in ms. */
  cooldownMs: number
  /** Show a TUI toast when compaction is triggered. */
  toast: boolean
}

export type Config = {
  /** Hard cap on the injected text, across all providers. */
  maxChars: number
  /** Per-provider cap, applied before the global one. */
  maxCharsPerProvider: number
  providers: Provider[]
  threshold: ThresholdConfig
}

export const DEFAULTS: Config = {
  maxChars: 6000,
  maxCharsPerProvider: 3000,
  providers: [],
  threshold: {
    enabled: false,
    at: "60%",
    modelLimits: {},
    model: null,
    cooldownMs: 60_000,
    toast: true,
  },
}

/**
 * Merges providers by `name`: a later layer replaces an entry of the same name
 * and appends new ones.
 *
 * Replacing the array wholesale would mean a project that wants to add its own
 * NOTES.md silently loses every global provider, which is the opposite of what
 * anyone writing a project config intends. Merging by name keeps both, and still
 * allows a project to switch one off with `enabled: false`.
 */
export function mergeProviders(base: Provider[], overlay: Provider[]): Provider[] {
  const out = [...base]
  for (const p of overlay) {
    const i = out.findIndex((x) => x.name === p.name)
    if (i === -1) out.push(p)
    else out[i] = { ...out[i], ...p }
  }
  return out
}

/** Layers applied in order, each overriding the last. Providers merge by name. */
export function mergeConfig(...layers: Array<Partial<Config> | undefined>): Config {
  const out: Config = { ...DEFAULTS, providers: [...DEFAULTS.providers], threshold: { ...DEFAULTS.threshold } }
  for (const layer of layers) {
    if (!layer) continue
    if (typeof layer.maxChars === "number") out.maxChars = layer.maxChars
    if (typeof layer.maxCharsPerProvider === "number") out.maxCharsPerProvider = layer.maxCharsPerProvider
    if (Array.isArray(layer.providers)) out.providers = mergeProviders(out.providers, layer.providers)
    if (layer.threshold) {
      const { modelLimits, ...rest } = layer.threshold
      out.threshold = { ...out.threshold, ...rest }
      if (modelLimits) out.threshold.modelLimits = { ...out.threshold.modelLimits, ...modelLimits }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Threshold

export type Tokens = {
  input: number
  output: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

/**
 * How much of the context window the next request will occupy.
 *
 * `input + cache.read` on purpose. `output` is the reply, not the prompt, and
 * `cache.write` counts tokens that are already in `input` — including either
 * inflates the figure badly. Measured against real compaction history, summing
 * all four produced totals above the model's own context limit, which is how the
 * over-count showed itself.
 *
 * This is still an estimate: it reflects the last completed request, so the next
 * one will be larger by whatever has been added since.
 */
export function contextUsed(tokens: Tokens | undefined): number {
  if (!tokens) return 0
  return (tokens.input ?? 0) + (tokens.cache?.read ?? 0)
}

/** "llama.cpp/qwen/qwen3.6-35b-a3b" -> provider "llama.cpp", model "qwen/qwen3.6-35b-a3b" */
export function parseModelRef(ref: string): { providerID: string; modelID: string } | null {
  const i = ref.indexOf("/")
  if (i <= 0 || i === ref.length - 1) return null
  return { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) }
}

/**
 * Turns a trigger into an absolute token count.
 *
 *   120000   -> 120000 tokens, whatever the window
 *   "80%"    -> 80% of the model's context window
 *   0.8      -> the same, kept so existing fraction configs still work
 *
 * A bare number above 1 is absolute and a bare number at or below 1 is a
 * fraction. That split is the one ambiguity here, and it resolves the way anyone
 * writing the config would expect: nobody means "compact at 0.8 tokens", and
 * nobody means "compact at 120000 times the window".
 *
 * Returns 0 when it cannot be resolved — an unknown window for a percentage — so
 * the caller declines rather than compacting at an arbitrary point.
 */
export function resolveTrigger(trigger: Trigger | undefined, contextLimit: number): number {
  if (trigger === undefined || trigger === null) return 0
  if (typeof trigger === "number") {
    if (!isFinite(trigger) || trigger <= 0) return 0
    return trigger > 1 ? Math.floor(trigger) : Math.floor(trigger * contextLimit)
  }
  const text = trigger.trim()
  const pct = text.endsWith("%") ? Number(text.slice(0, -1)) : NaN
  if (isFinite(pct) && pct > 0) return Math.floor((pct / 100) * contextLimit)
  const n = Number(text)
  if (isFinite(n) && n > 0) return n > 1 ? Math.floor(n) : Math.floor(n * contextLimit)
  return 0
}

/** The per-model override if there is one, else the default. */
export function triggerFor(
  cfg: Pick<ThresholdConfig, "at" | "modelLimits">,
  providerID: string,
  modelID: string,
  contextLimit: number,
): number {
  const key = `${providerID}/${modelID}`
  const override = cfg.modelLimits?.[key]
  return resolveTrigger(override !== undefined ? override : cfg.at, contextLimit)
}

export type TriggerInput = {
  used: number
  limit: number
  /** Absolute token count at which to fire, from `triggerFor`. */
  triggerAt: number
  now: number
  lastFiredAt?: number
  cooldownMs: number
  /** A compaction we asked for is still running. */
  pending: boolean
  /** The message that prompted this check is itself a summary. */
  isSummary: boolean
  /** The session has a parent, i.e. it is a routed skill or subagent session. */
  isChild: boolean
}

export type TriggerDecision = { fire: boolean; fraction: number; reason: string }

/**
 * Decides whether to trigger compaction. Pure, so every guard below is testable
 * without a session: the failure mode that matters is firing repeatedly, and
 * that is exactly the kind of bug that only shows up under conditions which are
 * awkward to reproduce live.
 */
export function shouldCompact(input: TriggerInput): TriggerDecision {
  const fraction = input.limit > 0 ? input.used / input.limit : 0
  const no = (reason: string): TriggerDecision => ({ fire: false, fraction, reason })

  if (input.limit <= 0) return no("context limit unknown for this model")
  if (input.triggerAt <= 0) return no("no usable threshold configured for this model")
  if (input.isChild) return no("child session")
  if (input.isSummary) return no("message is a compaction summary")
  if (input.pending) return no("a compaction is already running")
  if (input.lastFiredAt !== undefined && input.now - input.lastFiredAt < input.cooldownMs) {
    return no("within cooldown")
  }
  if (input.used < input.triggerAt) return no(`below threshold (${input.used}/${input.triggerAt})`)
  return { fire: true, fraction, reason: `threshold reached (${input.used}/${input.triggerAt})` }
}

export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home
  if (p.startsWith("~/")) return home + p.slice(1)
  if (p.startsWith("$HOME/")) return home + p.slice(5)
  return p
}

/** Splits "a/b/c-*.json" into its directory and the glob to match inside it. */
export function splitGlob(p: string): { dir: string; pattern: string | null } {
  const i = p.lastIndexOf("/")
  const dir = i === -1 ? "." : p.slice(0, i)
  const base = i === -1 ? p : p.slice(i + 1)
  return base.includes("*") ? { dir, pattern: base } : { dir, pattern: null }
}

/** Only `*` is supported, which is all the paths this plugin deals with need. */
export function matchesGlob(name: string, pattern: string): boolean {
  const rx = new RegExp("^" + pattern.split("*").map(escapeRegex).join(".*") + "$")
  return rx.test(name)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function formatJson(text: string, select?: string[]): string {
  const parsed = JSON.parse(text)
  if (!select?.length || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return JSON.stringify(parsed, null, 2)
  }
  const picked: Record<string, unknown> = {}
  for (const key of select) {
    if (key in (parsed as Record<string, unknown>)) picked[key] = (parsed as Record<string, unknown>)[key]
  }
  // Selecting nothing that exists is a config mistake, not a reason to inject an
  // empty object — fall back to the whole document so the context is never silently
  // useless.
  return JSON.stringify(Object.keys(picked).length ? picked : parsed, null, 2)
}

export function formatJsonl(text: string, tail = 10): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0)
  return lines.slice(-Math.max(1, tail)).join("\n")
}

export function formatFile(text: string, provider: Provider): string {
  switch (provider.format ?? "raw") {
    case "json":
      return formatJson(text, provider.select)
    case "jsonl":
      return formatJsonl(text, provider.tail)
    default:
      return text.trim()
  }
}

/** Truncates on a line boundary where possible, and says so rather than cutting silently. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastNewline = cut.lastIndexOf("\n")
  const body = lastNewline > max * 0.5 ? cut.slice(0, lastNewline) : cut
  return body + "\n… (truncated)"
}

export type Section = { heading: string; body: string }

/** Assembles the final context blocks, applying both caps. Never throws. */
export function buildSections(sections: Section[], cfg: Config): string[] {
  const out: string[] = []
  let budget = cfg.maxChars
  for (const s of sections) {
    if (budget <= 0) break
    const body = truncate(s.body, Math.min(cfg.maxCharsPerProvider, budget))
    if (!body.trim()) continue
    const block = `## ${s.heading}\n\n${body}`
    budget -= block.length
    out.push(block)
  }
  return out
}
