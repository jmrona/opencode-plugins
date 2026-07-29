// Unit tests for the pure logic in lib.ts.
// Run with:  bun test lib.test.ts
//        or: node --experimental-strip-types --test lib.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_CONFIG,
  buildChildPrompt,
  displayModel,
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
  model: llama.cpp/qwen/qwen3.6-35b-a3b
  fallback_model: openai/gpt-5.4
  reasoning_effort: high
  preload: cognitive-profile, api-conventions
---

# Quick Explain

Body here.`

test("parseSkill: full frontmatter", () => {
  const s = parseSkill(FULL_SKILL)
  assert.ok(s)
  assert.equal(s.name, "quick-explain")
  assert.equal(s.description, "Quick, self-contained explanation") // comillas fuera
  assert.equal(s.model, "llama.cpp/qwen/qwen3.6-35b-a3b")
  assert.equal(s.fallback, "openai/gpt-5.4")
  assert.equal(s.reasoningEffort, "high")
  assert.deepEqual(s.preload, ["cognitive-profile", "api-conventions"])
  assert.ok(s.body.startsWith("# Quick Explain"))
})

test("parseSkill: skill sin metadata -> sin routing", () => {
  const s = parseSkill(`---\nname: plain\ndescription: plain skill\n---\n\nBody.`)
  assert.ok(s)
  assert.equal(s.model, undefined)
  assert.equal(s.fallback, undefined)
  assert.equal(s.reasoningEffort, undefined)
  assert.deepEqual(s.preload, [])
})

test("parseSkill: metadata con otras claves no confunde al parser", () => {
  const s = parseSkill(`---\nname: x\nmetadata:\n  audience: maintainers\n  model: p/m\n---\nBody.`)
  assert.equal(s?.model, "p/m")
})

test("parseSkill: sin frontmatter -> undefined", () => {
  assert.equal(parseSkill("just a plain file"), undefined)
})

test("parseSkill: frontmatter sin name -> undefined", () => {
  assert.equal(parseSkill(`---\ndescription: no name\n---\nBody.`), undefined)
})

test("parseSkill: CRLF", () => {
  const s = parseSkill(`---\r\nname: crlf\r\nmetadata:\r\n  model: p/m\r\n---\r\nBody.`)
  assert.equal(s?.name, "crlf")
  assert.equal(s?.model, "p/m")
})

test("parseSkill: description sin comillas y con dos puntos", () => {
  const s = parseSkill(`---\nname: x\ndescription: Use when the user asks: what is X\n---\nBody.`)
  assert.equal(s?.description, "Use when the user asks: what is X")
})

// ---------------------------------------------------------------------------
// splitModel / toolName
// ---------------------------------------------------------------------------

test("splitModel: modelo con varias barras", () => {
  assert.deepEqual(splitModel("llama.cpp/qwen/qwen3.6-35b-a3b"), {
    providerID: "llama.cpp",
    modelID: "qwen/qwen3.6-35b-a3b",
  })
})

test("splitModel: provider/modelo simple", () => {
  assert.deepEqual(splitModel("openai/gpt-5.4"), { providerID: "openai", modelID: "gpt-5.4" })
})

test("toolName: guiones a underscores", () => {
  assert.equal(toolName("quick-explain"), "skill_quick_explain")
  assert.equal(toolName("commit-msg"), "skill_commit_msg")
})

// ---------------------------------------------------------------------------
// isRouted / routedModel
// ---------------------------------------------------------------------------

test("isRouted: cualquier campo de routing activa el tool", () => {
  const base = { name: "s", description: "d", body: "b", preload: [] as string[] }
  assert.equal(isRouted({ ...base }), false) // skill normal: no se toca
  assert.equal(isRouted({ ...base, model: "p/m" }), true)
  assert.equal(isRouted({ ...base, fallback: "p/m" }), true)
  assert.equal(isRouted({ ...base, reasoningEffort: "high" }), true)
  assert.equal(isRouted({ ...base, preload: ["dep"] }), true)
})

test("routedModel: ausente o 'default' -> sin pin (modelo global)", () => {
  const base = { name: "s", description: "d", body: "b", preload: [] as string[] }
  assert.equal(routedModel({ ...base }), undefined)
  assert.equal(routedModel({ ...base, model: "default" }), undefined)
  assert.equal(routedModel({ ...base, model: "llama.cpp/qwen/qwen3.6-35b-a3b" }), "llama.cpp/qwen/qwen3.6-35b-a3b")
})

// ---------------------------------------------------------------------------
// displayModel
// ---------------------------------------------------------------------------

test("displayModel: usa el modelo fijado", () => {
  const skill = parseSkill(FULL_SKILL)!
  assert.equal(displayModel(skill), "llama.cpp/qwen/qwen3.6-35b-a3b")
})

test("displayModel: sin pin (o model: default) etiqueta la sesion", () => {
  const skill: SkillDef = { name: "x", description: "d", body: "", preload: [], reasoningEffort: "high" }
  assert.equal(displayModel(skill), "default (session model)")
  assert.equal(displayModel({ ...skill, model: "default" }), "default (session model)")
})

test("displayModel: es de una sola linea (va en la cabecera del TUI)", () => {
  const skill = parseSkill(FULL_SKILL)!
  assert.ok(!displayModel(skill).includes("\n"))
})

// ---------------------------------------------------------------------------
// mergeConfig
// ---------------------------------------------------------------------------

test("mergeConfig: sin nada -> defaults", () => {
  assert.deepEqual(mergeConfig({}), DEFAULT_CONFIG)
})

test("mergeConfig: config parcial conserva el resto de defaults", () => {
  const cfg = mergeConfig({ healthcheck: { timeout: 5 } })
  assert.equal(cfg.healthcheck.timeout, 5)
  assert.equal(cfg.toast.enabled, DEFAULT_CONFIG.toast.enabled)
  assert.equal(cfg.generation.timeout, DEFAULT_CONFIG.generation.timeout)
})

test("mergeConfig: campo anidado parcial no arrastra al resto de la seccion", () => {
  const cfg = mergeConfig({ toast: { duration: 8000 } })
  assert.equal(cfg.toast.duration, 8000)
  assert.equal(cfg.toast.enabled, true) // default, no undefined
})

test("mergeConfig: options de opencode.json ganan al fichero", () => {
  const cfg = mergeConfig({ toast: { enabled: true, duration: 8000 } }, { toast: { enabled: false } })
  assert.equal(cfg.toast.enabled, false) // option gana
  assert.equal(cfg.toast.duration, 8000) // fichero se conserva donde option no dice nada
})

test("mergeConfig: generation.timeout 0 (deshabilitado) se respeta", () => {
  assert.equal(mergeConfig({ generation: { timeout: 0 } }).generation.timeout, 0)
})

test("mergeConfig: display.hidePrompt por defecto activo y desactivable", () => {
  assert.equal(mergeConfig({}).display.hidePrompt, true)
  assert.equal(mergeConfig({ display: { hidePrompt: false } }).display.hidePrompt, false)
  // false explicito en options debe ganar al true del fichero (no perderse por ??)
  assert.equal(mergeConfig({ display: { hidePrompt: true } }, { display: { hidePrompt: false } }).display.hidePrompt, false)
})

// ---------------------------------------------------------------------------
// buildChildPrompt
// ---------------------------------------------------------------------------

function mkSkill(over: Partial<SkillDef>): SkillDef {
  return { name: "s", description: "d", body: "BODY", preload: [], ...over }
}

test("buildChildPrompt: sin preload -> body + task", () => {
  const out = buildChildPrompt(mkSkill({}), new Map(), "do the thing")
  assert.equal(out, "BODY\n\n---\n\nTask: do the thing")
})

test("buildChildPrompt: preload existente se inyecta antes del body", () => {
  const skills = new Map([["dep", mkSkill({ name: "dep", body: "DEP BODY" })]])
  const out = buildChildPrompt(mkSkill({ preload: ["dep"] }), skills, "task")
  assert.ok(out.indexOf('<preloaded_skill name="dep">') < out.indexOf("BODY"))
  assert.ok(out.includes("DEP BODY"))
})

test("buildChildPrompt: preload inexistente queda marcado como not found", () => {
  const out = buildChildPrompt(mkSkill({ preload: ["ghost"] }), new Map(), "task")
  assert.ok(out.includes('<preloaded_skill name="ghost" error="not found" />'))
})
