// Unit tests for the pure logic in lib.ts.
// Run with:  bun test lib.test.ts
//        or: node --experimental-strip-types --test lib.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_CONFIG,
  buildChildPrompt,
  isRouted,
  mergeConfig,
  parseSkill,
  routedModel,
  splitModel,
  toolName,
  type SkillDef,
} from "./lib.ts"

// ---------------------------------------------------------------------------
// parseSkill
// ---------------------------------------------------------------------------

const FULL_SKILL = `---
name: quick-explain
description: "Quick, self-contained explanation"
metadata:
  model: llama.cpp/qwen/qwen3-8b
  fallback_model: openai/gpt-5-mini
  reasoning_effort: high
  preload: style-guide, api-conventions
---

# Quick Explain

Body here.`

test("parseSkill: full frontmatter", () => {
  const s = parseSkill(FULL_SKILL)
  assert.ok(s)
  assert.equal(s.name, "quick-explain")
  assert.equal(s.description, "Quick, self-contained explanation") // quotes stripped
  assert.equal(s.model, "llama.cpp/qwen/qwen3-8b")
  assert.equal(s.fallback, "openai/gpt-5-mini")
  assert.equal(s.reasoningEffort, "high")
  assert.deepEqual(s.preload, ["style-guide", "api-conventions"])
  assert.ok(s.body.startsWith("# Quick Explain"))
})

test("parseSkill: skill without metadata is not routed", () => {
  const s = parseSkill(`---\nname: plain\ndescription: plain skill\n---\n\nBody.`)
  assert.ok(s)
  assert.equal(s.model, undefined)
  assert.equal(s.fallback, undefined)
  assert.equal(s.reasoningEffort, undefined)
  assert.deepEqual(s.preload, [])
})

test("parseSkill: unrelated metadata keys do not confuse the parser", () => {
  const s = parseSkill(`---\nname: x\nmetadata:\n  audience: maintainers\n  model: p/m\n---\nBody.`)
  assert.equal(s?.model, "p/m")
})

test("parseSkill: no frontmatter -> undefined", () => {
  assert.equal(parseSkill("just a plain file"), undefined)
})

test("parseSkill: frontmatter without a name -> undefined", () => {
  assert.equal(parseSkill(`---\ndescription: no name\n---\nBody.`), undefined)
})

test("parseSkill: CRLF line endings", () => {
  const s = parseSkill(`---\r\nname: crlf\r\nmetadata:\r\n  model: p/m\r\n---\r\nBody.`)
  assert.equal(s?.name, "crlf")
  assert.equal(s?.model, "p/m")
})

test("parseSkill: unquoted description containing a colon", () => {
  const s = parseSkill(`---\nname: x\ndescription: Use when the user asks: what is X\n---\nBody.`)
  assert.equal(s?.description, "Use when the user asks: what is X")
})

// ---------------------------------------------------------------------------
// splitModel / toolName
// ---------------------------------------------------------------------------

test("splitModel: model id containing several slashes", () => {
  assert.deepEqual(splitModel("llama.cpp/qwen/qwen3-8b"), {
    providerID: "llama.cpp",
    modelID: "qwen/qwen3-8b",
  })
})

test("splitModel: simple provider/model", () => {
  assert.deepEqual(splitModel("openai/gpt-5-mini"), { providerID: "openai", modelID: "gpt-5-mini" })
})

test("toolName: dashes become underscores", () => {
  assert.equal(toolName("quick-explain"), "skill_quick_explain")
  assert.equal(toolName("commit-msg"), "skill_commit_msg")
})

// ---------------------------------------------------------------------------
// isRouted / routedModel
// ---------------------------------------------------------------------------

test("isRouted: any routing field activates the tool", () => {
  const base = { name: "s", description: "d", body: "b", preload: [] as string[] }
  assert.equal(isRouted({ ...base }), false) // plain skill: left untouched
  assert.equal(isRouted({ ...base, model: "p/m" }), true)
  assert.equal(isRouted({ ...base, fallback: "p/m" }), true)
  assert.equal(isRouted({ ...base, reasoningEffort: "high" }), true)
  assert.equal(isRouted({ ...base, preload: ["dep"] }), true)
})

test("routedModel: absent or 'default' -> no pin (global model)", () => {
  const base = { name: "s", description: "d", body: "b", preload: [] as string[] }
  assert.equal(routedModel({ ...base }), undefined)
  assert.equal(routedModel({ ...base, model: "default" }), undefined)
  assert.equal(routedModel({ ...base, model: "llama.cpp/qwen/qwen3-8b" }), "llama.cpp/qwen/qwen3-8b")
})

// ---------------------------------------------------------------------------
// mergeConfig
// ---------------------------------------------------------------------------

test("mergeConfig: nothing supplied -> defaults", () => {
  assert.deepEqual(mergeConfig({}), DEFAULT_CONFIG)
})

test("mergeConfig: partial config keeps the remaining defaults", () => {
  const cfg = mergeConfig({ healthcheck: { timeout: 5 } })
  assert.equal(cfg.healthcheck.timeout, 5)
  assert.equal(cfg.toast.enabled, DEFAULT_CONFIG.toast.enabled)
  assert.equal(cfg.generation.timeout, DEFAULT_CONFIG.generation.timeout)
})

test("mergeConfig: a partial nested field does not drag the rest of its section", () => {
  const cfg = mergeConfig({ toast: { duration: 8000 } })
  assert.equal(cfg.toast.duration, 8000)
  assert.equal(cfg.toast.enabled, true) // default, not undefined
})

test("mergeConfig: opencode.json options win over the file", () => {
  const cfg = mergeConfig({ toast: { enabled: true, duration: 8000 } }, { toast: { enabled: false } })
  assert.equal(cfg.toast.enabled, false) // option wins
  assert.equal(cfg.toast.duration, 8000) // file value kept where options say nothing
})

test("mergeConfig: generation.timeout 0 (disabled) is respected", () => {
  assert.equal(mergeConfig({ generation: { timeout: 0 } }).generation.timeout, 0)
})

// ---------------------------------------------------------------------------
// buildChildPrompt
// ---------------------------------------------------------------------------

function mkSkill(over: Partial<SkillDef>): SkillDef {
  return { name: "s", description: "d", body: "BODY", preload: [], ...over }
}

test("buildChildPrompt: no preload -> body + task", () => {
  const out = buildChildPrompt(mkSkill({}), new Map(), "do the thing")
  assert.equal(out, "BODY\n\n---\n\nTask: do the thing")
})

test("buildChildPrompt: an existing preload is injected before the body", () => {
  const skills = new Map([["dep", mkSkill({ name: "dep", body: "DEP BODY" })]])
  const out = buildChildPrompt(mkSkill({ preload: ["dep"] }), skills, "task")
  assert.ok(out.indexOf('<preloaded_skill name="dep">') < out.indexOf("BODY"))
  assert.ok(out.includes("DEP BODY"))
})

test("buildChildPrompt: a missing preload is flagged as not found", () => {
  const out = buildChildPrompt(mkSkill({ preload: ["ghost"] }), new Map(), "task")
  assert.ok(out.includes('<preloaded_skill name="ghost" error="not found" />'))
})
