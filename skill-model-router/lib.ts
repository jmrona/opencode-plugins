// Pure logic for skill-model-router: no I/O, no opencode imports.
// Everything here is unit-testable (see lib.test.ts).

export type SkillDef = {
  name: string
  description: string
  body: string
  model?: string
  fallback?: string
  reasoningEffort?: string
  preload: string[]
}

export type RouterConfig = {
  toast: {
    enabled: boolean
    /** Toast duration in ms */
    duration: number
  }
  healthcheck: {
    /** Seconds to wait for the primary provider health check before
     *  declaring it dead and switching to fallback_model. */
    timeout: number
  }
  generation: {
    /** Seconds to wait for the child-session generation before aborting it
     *  and switching to fallback_model. 0 disables the limit. */
    timeout: number
  }
  display: {
    /** Replace the `prompt` argument with a `model` argument in the recorded
     *  tool call, so the TUI's generic header reads
     *  `skill_explain [model=openai/gpt-5.6-luna]` instead of dumping the
     *  whole prompt. The prompt itself is preserved (child session + tool
     *  part metadata). Set false to restore the raw prompt in the header. */
    hidePrompt: boolean
  }
}

export const DEFAULT_CONFIG: RouterConfig = {
  toast: { enabled: true, duration: 5000 },
  healthcheck: { timeout: 2 },
  generation: { timeout: 120 },
  display: { hidePrompt: true },
}

type PartialConfig = {
  toast?: Partial<RouterConfig["toast"]>
  healthcheck?: Partial<RouterConfig["healthcheck"]>
  generation?: Partial<RouterConfig["generation"]>
  display?: Partial<RouterConfig["display"]>
}

/** Merge file config and opencode.json plugin options over defaults.
 *  Options win over the file; both win over DEFAULT_CONFIG. */
export function mergeConfig(fileConfig: PartialConfig, options?: PartialConfig): RouterConfig {
  const pick = <S extends keyof RouterConfig, K extends keyof RouterConfig[S]>(section: S, key: K) =>
    (options?.[section] as any)?.[key] ?? (fileConfig?.[section] as any)?.[key] ?? DEFAULT_CONFIG[section][key]
  return {
    toast: { enabled: pick("toast", "enabled"), duration: pick("toast", "duration") },
    healthcheck: { timeout: pick("healthcheck", "timeout") },
    generation: { timeout: pick("generation", "timeout") },
    display: { hidePrompt: pick("display", "hidePrompt") },
  }
}

/** Parse a SKILL.md file. Returns undefined when there is no frontmatter or
 *  no name. Only `metadata.*` keys are read for routing, because `metadata`
 *  is the one extensible field allowed by opencode's skill frontmatter spec. */
export function parseSkill(raw: string): SkillDef | undefined {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return undefined
  const fm = m[1]
  const get = (key: string) => {
    const v = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim()
    return v?.replace(/^["'](.*)["']$/s, "$1")
  }
  const meta = (key: string) =>
    fm.match(new RegExp(`^metadata:\\s*\\r?\\n(?:[ \\t]+.+\\r?\\n?)*?[ \\t]+${key}:[ \\t]*(.+)$`, "m"))?.[1]?.trim()
  const name = get("name")
  if (!name) return undefined
  return {
    name,
    description: get("description") ?? name,
    body: m[2].trim(),
    model: meta("model"),
    fallback: meta("fallback_model"),
    reasoningEffort: meta("reasoning_effort"),
    preload: (meta("preload") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

/** "llama.cpp/qwen/qwen3.6-35b-a3b" -> provider "llama.cpp", model "qwen/qwen3.6-35b-a3b" */
export function splitModel(full: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = full.split("/")
  return { providerID, modelID: rest.join("/") }
}

/** A skill is routed (gets a skill_* tool) when it declares ANY routing
 *  field. Skills without routing metadata stay untouched: they already work
 *  inline through opencode's native skill tool, and duplicating every plain
 *  skill as a tool would bloat the tool list. */
export function isRouted(skill: SkillDef): boolean {
  return Boolean(skill.model || skill.fallback || skill.reasoningEffort || skill.preload.length > 0)
}

/** Pinned model for a routed skill. Absent `model` — or the explicit alias
 *  `model: default` — means "no pin": the child session is created without a
 *  model and opencode resolves the globally selected one. */
export function routedModel(skill: SkillDef): string | undefined {
  if (!skill.model || skill.model === "default") return undefined
  return skill.model
}

/** Value written into the recorded tool call's `model` argument when
 *  `display.hidePrompt` is on. This is what the TUI's generic renderer paints
 *  in the header, so it must stay short and single-line. */
export function displayModel(skill: SkillDef): string {
  return routedModel(skill) ?? "default (session model)"
}

/** Tool name registered for a routed skill. */
export function toolName(skillName: string): string {
  return `skill_${skillName.replace(/-/g, "_")}`
}

/** Assemble the prompt sent to the child session: preloaded skill bodies,
 *  then the skill body, then the caller's task. */
export function buildChildPrompt(skill: SkillDef, skills: Map<string, SkillDef>, task: string): string {
  const preloaded = skill.preload
    .map((name) => {
      const dep = skills.get(name)
      return dep
        ? `<preloaded_skill name="${name}">\n${dep.body}\n</preloaded_skill>`
        : `<preloaded_skill name="${name}" error="not found" />`
    })
    .join("\n\n")
  return [preloaded, skill.body, `---\n\nTask: ${task}`].filter(Boolean).join("\n\n")
}
