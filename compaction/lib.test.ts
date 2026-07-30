import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULTS,
  mergeConfig,
  expandHome,
  splitGlob,
  matchesGlob,
  formatJson,
  formatJsonl,
  formatFile,
  truncate,
  buildSections,
  contextUsed,
  parseModelRef,
  shouldCompact,
  resolveTrigger,
  triggerFor,
  mergeProviders,
  type TriggerInput,
} from "./lib.ts"

test("mergeConfig applies defaults < file < options", () => {
  const merged = mergeConfig({ maxChars: 100 }, { maxChars: 200 })
  assert.equal(merged.maxChars, 200)
  assert.equal(merged.maxCharsPerProvider, DEFAULTS.maxCharsPerProvider)
})

test("mergeConfig merges providers by name across layers", () => {
  // A project layer must be able to add a provider without discarding the global
  // ones, which is what replacing the array would do.
  const global = [{ name: "notes", path: "/global/notes.md" }]
  const project = [{ name: "project", path: "./NOTES.md" }]
  const merged = mergeConfig({ providers: global }, { providers: project }).providers
  assert.deepEqual(merged.map((p) => p.name), ["notes", "project"])
})

test("mergeProviders lets a later layer override one entry by name", () => {
  const merged = mergeProviders(
    [{ name: "notes", path: "/a", tail: 10 }],
    [{ name: "notes", path: "/b" }],
  )
  assert.equal(merged.length, 1)
  assert.equal(merged[0].path, "/b")
  assert.equal(merged[0].tail, 10, "fields not restated are kept")
})

test("mergeProviders lets a project disable an inherited provider", () => {
  const merged = mergeProviders(
    [{ name: "notes", path: "/a" }],
    [{ name: "notes", path: "/a", enabled: false }],
  )
  assert.equal(merged[0].enabled, false)
})

test("mergeConfig merges modelLimits rather than replacing the map", () => {
  const merged = mergeConfig(
    { threshold: { modelLimits: { "openai/a": 100 } } as any },
    { threshold: { modelLimits: { "openai/b": 200 } } as any },
  )
  assert.deepEqual(merged.threshold.modelLimits, { "openai/a": 100, "openai/b": 200 })
})

test("mergeConfig ignores undefined layers", () => {
  assert.equal(mergeConfig(undefined, { maxChars: 5 }, undefined).maxChars, 5)
})

test("expandHome handles ~, $HOME and absolute paths", () => {
  assert.equal(expandHome("~/x", "/home/j"), "/home/j/x")
  assert.equal(expandHome("$HOME/x", "/home/j"), "/home/j/x")
  assert.equal(expandHome("~", "/home/j"), "/home/j")
  assert.equal(expandHome("/tmp/x", "/home/j"), "/tmp/x")
  // A tilde that is not a home reference must be left alone.
  assert.equal(expandHome("~weird/x", "/home/j"), "~weird/x")
})

test("splitGlob separates directory from pattern", () => {
  assert.deepEqual(splitGlob("/a/b/*.json"), { dir: "/a/b", pattern: "*.json" })
  assert.deepEqual(splitGlob("/a/b/c.json"), { dir: "/a/b", pattern: null })
})

test("matchesGlob matches only what it should", () => {
  assert.ok(matchesGlob("PROJ-42.json", "*.json"))
  assert.ok(matchesGlob("VAN3-89.json", "VAN3-*.json"))
  assert.ok(!matchesGlob("notes.jsonl", "*.json"))
  // Dots in the pattern must be literal, not regex wildcards.
  assert.ok(!matchesGlob("axjson", "*.json"))
})

test("formatJson keeps only selected keys", () => {
  const out = formatJson(JSON.stringify({ a: 1, b: 2, c: 3 }), ["a", "c"])
  assert.deepEqual(JSON.parse(out), { a: 1, c: 3 })
})

test("formatJson falls back to the whole document when no selected key exists", () => {
  const doc = { a: 1 }
  const out = formatJson(JSON.stringify(doc), ["nope"])
  assert.deepEqual(JSON.parse(out), doc)
})

test("formatJson ignores select for arrays", () => {
  const out = formatJson(JSON.stringify([1, 2]), ["a"])
  assert.deepEqual(JSON.parse(out), [1, 2])
})

test("formatJsonl keeps the trailing lines and drops blanks", () => {
  const src = ["{}", "", "a", "b", "c"].join("\n")
  assert.equal(formatJsonl(src, 2), "b\nc")
  assert.equal(formatJsonl(src, 0), "c", "a tail of zero still keeps one line")
})

test("formatFile dispatches on format and defaults to raw", () => {
  assert.equal(formatFile("  hi  ", { name: "x", path: "p" }), "hi")
  assert.equal(formatFile('{"a":1}', { name: "x", path: "p", format: "json" }), '{\n  "a": 1\n}')
})

test("truncate marks the cut instead of hiding it", () => {
  const out = truncate("a".repeat(100), 20)
  assert.ok(out.length < 100)
  assert.ok(out.endsWith("… (truncated)"))
})

test("truncate prefers a line boundary", () => {
  const text = "line one\n" + "x".repeat(50)
  const out = truncate(text, 30)
  assert.ok(out.startsWith("line one"))
})

test("truncate leaves short text untouched", () => {
  assert.equal(truncate("short", 100), "short")
})

test("buildSections applies the per-provider cap", () => {
  const blocks = buildSections([{ heading: "H", body: "b".repeat(500) }], {
    ...DEFAULTS,
    maxCharsPerProvider: 50,
  })
  assert.ok(blocks[0].length < 200)
  assert.ok(blocks[0].startsWith("## H"))
})

test("buildSections stops once the global budget is spent", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ heading: `H${i}`, body: "b".repeat(200) }))
  const blocks = buildSections(many, { ...DEFAULTS, maxChars: 300, maxCharsPerProvider: 200 })
  assert.ok(blocks.length < 10)
  assert.ok(blocks.join("").length <= 600)
})

test("buildSections drops empty bodies rather than emitting a bare heading", () => {
  const blocks = buildSections([{ heading: "H", body: "   " }], DEFAULTS)
  assert.deepEqual(blocks, [])
})

// --- threshold -------------------------------------------------------------

test("mergeConfig merges threshold field by field rather than replacing it", () => {
  const merged = mergeConfig({ threshold: { at: 0.8 } as any })
  assert.equal(merged.threshold.at, 0.8)
  assert.equal(merged.threshold.cooldownMs, DEFAULTS.threshold.cooldownMs)
  assert.equal(merged.threshold.enabled, false, "must stay off unless explicitly enabled")
})

test("contextUsed counts input and cache reads only", () => {
  // output and cache.write are excluded on purpose: including them produced
  // totals above the model's own context limit against real history.
  assert.equal(contextUsed({ input: 1000, output: 500, cache: { read: 4000, write: 900 } }), 5000)
  assert.equal(contextUsed({ input: 100, output: 0 }), 100)
  assert.equal(contextUsed(undefined), 0)
})

test("parseModelRef keeps multi-slash model ids intact", () => {
  assert.deepEqual(parseModelRef("openai/gpt-5.6"), { providerID: "openai", modelID: "gpt-5.6" })
  assert.deepEqual(parseModelRef("llama.cpp/qwen/qwen3.6-35b-a3b"), {
    providerID: "llama.cpp",
    modelID: "qwen/qwen3.6-35b-a3b",
  })
  assert.equal(parseModelRef("nope"), null)
  assert.equal(parseModelRef("/leading"), null)
  assert.equal(parseModelRef("trailing/"), null)
})

const base: TriggerInput = {
  used: 80_000,
  limit: 100_000,
  triggerAt: 60_000,
  now: 1_000_000,
  cooldownMs: 60_000,
  pending: false,
  isSummary: false,
  isChild: false,
}

test("shouldCompact fires once past the threshold", () => {
  const d = shouldCompact(base)
  assert.equal(d.fire, true)
  assert.equal(d.fraction, 0.8)
})

test("shouldCompact holds below the threshold", () => {
  assert.equal(shouldCompact({ ...base, used: 50_000 }).fire, false)
})

test("shouldCompact declines when no threshold resolves for the model", () => {
  const d = shouldCompact({ ...base, triggerAt: 0 })
  assert.equal(d.fire, false)
  assert.match(d.reason, /no usable threshold/)
})

test("shouldCompact never fires on child sessions", () => {
  const d = shouldCompact({ ...base, isChild: true })
  assert.equal(d.fire, false)
  assert.match(d.reason, /child/)
})

test("shouldCompact ignores the summary message it just produced", () => {
  // Without this the plugin would react to its own compaction output and loop.
  const d = shouldCompact({ ...base, isSummary: true })
  assert.equal(d.fire, false)
})

test("shouldCompact does not stack compactions", () => {
  assert.equal(shouldCompact({ ...base, pending: true }).fire, false)
})

test("shouldCompact respects the cooldown, then releases it", () => {
  assert.equal(shouldCompact({ ...base, lastFiredAt: base.now - 1_000 }).fire, false)
  assert.equal(shouldCompact({ ...base, lastFiredAt: base.now - 61_000 }).fire, true)
})

test("shouldCompact refuses when the context limit is unknown", () => {
  // Guessing a limit would mean compacting at an arbitrary point; better to do nothing.
  const d = shouldCompact({ ...base, limit: 0 })
  assert.equal(d.fire, false)
  assert.match(d.reason, /limit unknown/)
})

test("shouldCompact reports the fraction even when it declines", () => {
  const d = shouldCompact({ ...base, used: 30_000, limit: 100_000 })
  assert.equal(d.fraction, 0.3)
})

// --- trigger resolution ----------------------------------------------------

test("resolveTrigger reads percentages", () => {
  assert.equal(resolveTrigger("80%", 100_000), 80_000)
  assert.equal(resolveTrigger("12.5%", 100_000), 12_500)
})

test("resolveTrigger treats a number above one as absolute tokens", () => {
  // The whole point of the absolute form: independent of window size.
  assert.equal(resolveTrigger(120_000, 1_000_000), 120_000)
  assert.equal(resolveTrigger(120_000, 128_000), 120_000)
})

test("resolveTrigger treats a number at or below one as a fraction", () => {
  assert.equal(resolveTrigger(0.2, 1_000_000), 200_000)
  assert.equal(resolveTrigger(1, 128_000), 128_000)
})

test("resolveTrigger returns zero for anything unusable", () => {
  for (const v of [undefined, 0, -5, "", "abc", "0%", "-10%"] as any[]) {
    assert.equal(resolveTrigger(v, 100_000), 0, `expected 0 for ${JSON.stringify(v)}`)
  }
})

test("triggerFor prefers a per-model limit over the default", () => {
  const cfg = { at: "60%", modelLimits: { "openai/small": 20_000 } }
  assert.equal(triggerFor(cfg, "openai", "small", 128_000), 20_000)
  assert.equal(triggerFor(cfg, "openai", "large", 1_000_000), 600_000)
})

test("triggerFor matches on the full provider/model key", () => {
  // Multi-slash model ids are normal (llama.cpp/qwen/qwen3.6-35b-a3b), so the key
  // is everything after the provider, not just the first segment.
  const cfg = { at: "50%", modelLimits: { "llama.cpp/qwen/qwen3.6-35b-a3b": 30_000 } }
  assert.equal(triggerFor(cfg, "llama.cpp", "qwen/qwen3.6-35b-a3b", 262_144), 30_000)
})

test("a fraction safe on a wide window is unsafe on a narrow one, which absolutes fix", () => {
  // The bug this feature exists for: ~11k tokens of floor after compacting.
  const floor = 11_000
  const fraction = { at: 0.05, modelLimits: {} }
  assert.ok(triggerFor(fraction, "o", "wide", 1_050_000) > floor, "fine on a wide window")
  assert.ok(triggerFor(fraction, "o", "narrow", 128_000) < floor, "loops on a narrow one")

  const absolute = { at: 0.05, modelLimits: { "o/narrow": 40_000 } }
  assert.ok(triggerFor(absolute, "o", "narrow", 128_000) > floor, "per-model limit fixes it")
})
