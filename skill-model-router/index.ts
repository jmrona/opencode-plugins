// skill-model-router/index.ts
//
// "Model per skill" for opencode, in the style of Claude Code's `model:`
// skill frontmatter. Scans your skills (project + global) and, for each
// SKILL.md that declares routing metadata, registers a custom tool
// `skill_<name>` that executes that skill in a child session on the model
// it declares (e.g. a local model served by LM Studio / llama.cpp / Ollama).
//
// Full documentation: README.md in this folder.
// Pure, unit-testable logic: lib.ts (tests in lib.test.ts).

import { type Plugin, tool } from "@opencode-ai/plugin"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"
import {
  type RouterConfig,
  type SkillDef,
  buildChildPrompt,
  isRouted,
  mergeConfig,
  parseSkill,
  routedModel,
  splitModel,
  toolName,
} from "./lib"

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

async function loadConfig(options?: Record<string, unknown>): Promise<RouterConfig> {
  let fileConfig = {}
  try {
    const raw = await readFile(fileURLToPath(new URL("./config.json", import.meta.url)), "utf8")
    fileConfig = JSON.parse(raw)
  } catch {} // no config.json (or invalid JSON): fall back to defaults
  return mergeConfig(fileConfig, options as any)
}

async function discoverSkills(dirs: string[]): Promise<Map<string, SkillDef>> {
  const skills = new Map<string, SkillDef>()
  for (const dir of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory() || skills.has(e.name)) continue
      const raw = await readFile(path.join(dir, e.name, "SKILL.md"), "utf8").catch(() => undefined)
      if (!raw) continue
      const s = parseSkill(raw)
      if (s) skills.set(s.name, s)
    }
  }
  return skills
}

async function providerHealthy(client: any, providerID: string, timeoutMs: number): Promise<boolean> {
  try {
    const cfg = await client.config.get()
    const baseURL: string | undefined = cfg.data?.provider?.[providerID]?.options?.baseURL
    if (!baseURL) return true // cloud provider: no local endpoint to probe, assume healthy
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const SkillModelRouter: Plugin = async ({ client, directory }, options) => {
  const cfg = await loadConfig(options)

  const toast = async (message: string, variant: "info" | "warning") => {
    if (!cfg.toast.enabled) return
    // The toast only exists when a TUI is attached; in headless/server mode
    // the call fails and we ignore it.
    try {
      await client.tui.showToast({
        body: { title: "skill-model-router", message, variant, duration: cfg.toast.duration },
      })
    } catch {}
  }

  const skills = await discoverSkills([
    path.join(directory, ".opencode", "skills"),
    path.join(homedir(), ".config", "opencode", "skills"),
  ])

  // reasoning_effort per child session: the prompt API accepts no per-request
  // model options, so we inject them into the child session's LLM call via
  // the chat.params hook — the same passthrough agents use for their
  // reasoningEffort field.
  const effortBySession = new Map<string, string>()

  const routed = [...skills.values()].filter(isRouted)
  const tools: Record<string, ReturnType<typeof tool>> = {}

  for (const skill of routed) {
    tools[toolName(skill.name)] = tool({
      description: `${skill.description} (skill "${skill.name}", runs on ${routedModel(skill) ?? "the session's default model"}${skill.fallback ? `, falls back to ${skill.fallback}` : ""})`,
      args: {
        prompt: tool.schema
          .string()
          .describe(
            "Full task or question for this skill. Include all necessary context: the child session cannot see this conversation.",
          ),
      },
      async execute(args, ctx) {
        const text = buildChildPrompt(skill, skills, args.prompt)

        // 1. Model selection with health check and fallback. When no model is
        //    pinned (metadata.model absent, or set to "default"), the child
        //    session is created without an explicit model and opencode
        //    resolves the globally selected one.
        const pinned = routedModel(skill)
        const primary = pinned ? splitModel(pinned) : undefined
        const fallback = skill.fallback ? splitModel(skill.fallback) : undefined
        const primaryHealthy = primary
          ? await providerHealthy(client, primary.providerID, cfg.healthcheck.timeout * 1000)
          : true
        type Candidate = {
          model?: { providerID: string; modelID: string }
          label: string
          role: "primary" | "fallback"
        }
        const candidates: Candidate[] = []
        if (primaryHealthy)
          candidates.push({ model: primary, label: pinned ?? "default (session model)", role: "primary" })
        if (fallback) candidates.push({ model: fallback, label: skill.fallback!, role: "fallback" })
        if (candidates.length === 0) {
          ctx.metadata({ title: `${skill.name} (unavailable: ${primary!.providerID} unreachable)` })
          await toast(`${skill.name}: ${primary!.providerID} unreachable, no fallback`, "warning")
          return `Error: provider "${primary!.providerID}" for skill "${skill.name}" is unreachable and no metadata.fallback_model is declared. Is the local model server running?`
        }

        // 2. Run in a child session; if a candidate fails or exceeds
        //    generation.timeout, the generation is aborted and the next
        //    candidate is tried.
        const errors: string[] = []
        for (const candidate of candidates) {
          const { model, label: full } = candidate
          const isFallback = candidate.role === "fallback"
          const why = isFallback
            ? primaryHealthy
              ? `fallback: ${pinned ?? "session model"} failed`
              : `fallback: ${primary!.providerID} unreachable`
            : "primary"

          // parentID: the child session is created under the session that
          // invoked the tool, so it never clutters the root /sessions list
          // (the TUI only lists sessions without a parent) and remains
          // navigable like task-tool subagent sessions.
          const session = await client.session.create({
            body: { parentID: ctx.sessionID, title: `skill:${skill.name} (${full})` },
          })
          const id = session.data?.id
          if (!id) {
            errors.push(`${full}: could not create child session`)
            continue
          }
          if (skill.reasoningEffort) effortBySession.set(id, skill.reasoningEffort)

          let result
          try {
            result = await client.session.prompt({
              path: { id },
              body: { ...(model ? { model } : {}), parts: [{ type: "text", text }] },
              ...(cfg.generation.timeout > 0
                ? { signal: AbortSignal.timeout(cfg.generation.timeout * 1000) }
                : {}),
            })
          } catch (e: any) {
            // Timeout or network error: abort the generation server-side so
            // it does not keep running in the background, then try the next
            // candidate.
            await client.session.abort({ path: { id } }).catch(() => {})
            const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError"
            errors.push(`${full}: ${timedOut ? `timed out after ${cfg.generation.timeout}s` : String(e)}`)
            continue
          } finally {
            effortBySession.delete(id)
          }
          if (result.error) {
            errors.push(`${full}: ${JSON.stringify(result.error)}`)
            continue
          }
          const info: any = result.data?.info
          const output = (result.data?.parts ?? [])
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n")
          if (output) {
            // Tool-part title (visible in the status line and in metadata;
            // the TUI's generic tool renderer does not yet paint it in the
            // header).
            ctx.metadata({
              title: `${skill.name} (${full}${isFallback ? ", fallback" : ""})`,
              metadata: { skill: skill.name, model: full, via: why },
            })
            await toast(`${skill.name} → ${full}${isFallback ? ` (${why})` : ""}`, isFallback ? "warning" : "info")
            return output
          }
          // No text came back: surface the real reason from the assistant
          // message (e.g. "model not loaded" from a local provider).
          const detail = info?.error ? ` — ${JSON.stringify(info.error).slice(0, 300)}` : ""
          errors.push(`${full}: empty output${detail}`)
        }
        ctx.metadata({ title: `${skill.name} (failed on all models)` })
        await toast(`${skill.name}: all models failed — ${errors[0]?.slice(0, 140) ?? "unknown"}`, "warning")
        return `Error running skill "${skill.name}". Attempts:\n${errors.join("\n")}`
      },
    })
  }

  return {
    tool: tools,
    // Injects reasoning_effort into the LLM calls of our child sessions.
    "chat.params": async (input, output) => {
      const effort = effortBySession.get(input.sessionID)
      if (effort && output?.options) output.options.reasoningEffort = effort
    },
  }
}
