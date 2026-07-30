// opencode-compaction — inject durable state into the compaction prompt.
//
// When opencode compacts a long session, it asks a model to summarise the
// conversation so far. Anything the summary drops is gone: the agent carries on
// from the summary, not from the transcript. State that lives outside the
// conversation — a task list on disk, notes about the user, a phase the agent is
// partway through — is exactly what a generic summariser has no reason to keep,
// because it never appears in the messages it is reading.
//
// This plugin hooks `experimental.session.compacting` and appends that state to
// the compaction prompt, so it survives.

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, readdir, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import {
  mergeConfig,
  expandHome,
  splitGlob,
  matchesGlob,
  formatFile,
  buildSections,
  contextUsed,
  parseModelRef,
  shouldCompact,
  triggerFor,
  type Config,
  type Provider,
  type Section,
} from "./lib.ts"

/** Sentinel: the directory the path points into does not exist at all. */
const MISSING_DIR = Symbol("missing-dir")

/** Resolves a provider's path to a concrete file, honouring a trailing glob. */
async function resolvePath(provider: Provider): Promise<string | null | typeof MISSING_DIR> {
  const full = expandHome(provider.path)
  const { dir, pattern } = splitGlob(full)
  if (!pattern) {
    try {
      await stat(full)
      return full
    } catch {
      return null // missing is the normal first-run state, not an error
    }
  }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // The directory itself is missing. That is a different thing from "no file
    // matched the glob": an empty sessions directory means no session is running,
    // which is normal, whereas a directory that does not exist usually means the
    // configured path is wrong. `null` vs `MISSING_DIR` is what lets the caller
    // stay quiet about the first and warn about the second.
    return MISSING_DIR
  }
  const matches = names.filter((n) => matchesGlob(n, pattern))
  if (!matches.length) return null
  if (matches.length === 1 || provider.pick !== "newest") return join(dir, matches[0])

  const withTimes = await Promise.all(
    matches.map(async (n) => {
      const p = join(dir, n)
      try {
        return { p, mtime: (await stat(p)).mtimeMs }
      } catch {
        return { p, mtime: 0 }
      }
    }),
  )
  withTimes.sort((a, b) => b.mtime - a.mtime)
  return withTimes[0].p
}

type Skip = { skipped: string; path?: string }

/**
 * Returns the section, or why it was skipped. Skipping is always the right call
 * — a malformed file must never fail compaction — but a silent skip is not: the
 * whole point of this plugin is that state survives, and "it quietly did not"
 * looks identical to "there was nothing to inject". So every skip carries a
 * reason and gets logged.
 */
export async function readProvider(provider: Provider): Promise<Section | Skip> {
  if (provider.enabled === false) return { skipped: "disabled in config" }
  const path = await resolvePath(provider)
  if (path === MISSING_DIR) return { skipped: "directory does not exist — check the path", path: provider.path }
  if (!path) return { skipped: "no file matched", path: provider.path }
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    return { skipped: `unreadable: ${err instanceof Error ? err.message : String(err)}`, path }
  }
  let body: string
  try {
    body = formatFile(raw, provider)
  } catch (err) {
    return { skipped: `could not parse as ${provider.format ?? "raw"}: ${err instanceof Error ? err.message : String(err)}`, path }
  }
  if (!body.trim()) return { skipped: "file is empty", path }
  return { heading: provider.heading ?? provider.name, body }
}

export function isSection(r: Section | Skip): r is Section {
  return "heading" in r
}

// readProvider, isSection and loadLayers are exported for preview.ts, so the dry
// run reports exactly what the hook does rather than a reimplementation that can
// drift from it. Extra exports here are harmless: opencode instantiates the
// exports of the plugins/ barrel, not of this module, and the barrel re-exports
// only CompactionContext.

/**
 * Config layers, applied in order so each overrides the last:
 *
 *   1. config.json next to the plugin — the shipped defaults
 *   2. ~/.config/opencode/compaction.json — your settings
 *   3. $OPENCODE_CONFIG_DIR/compaction.json — if you use a custom config dir
 *   4. .opencode/compaction.json in the project — per-repository settings
 *   5. plugin options passed in opencode.json
 *
 * The project layer is the point of this: a repository can declare the state
 * files worth rescuing — its own NOTES.md, whatever a project skill writes —
 * without every developer editing their global config, and without the project
 * wiping the providers they already had. Providers merge by name rather than
 * replacing, so a project adds to the list instead of replacing it.
 */
export async function loadLayers(): Promise<Array<Partial<Config> | undefined>> {
  const read = async (path: string): Promise<Partial<Config> | undefined> => {
    try {
      return JSON.parse(await readFile(path, "utf8"))
    } catch {
      // Missing is the normal case for every layer but the first. A malformed one
      // is reported by the caller, which has the logger.
      return undefined
    }
  }
  const home = process.env.HOME ?? ""
  const custom = process.env.OPENCODE_CONFIG_DIR
  return [
    await read(fileURLToPath(new URL("./config.json", import.meta.url))),
    await read(join(home, ".config/opencode/compaction.json")),
    custom ? await read(join(custom, "compaction.json")) : undefined,
    await read(join(process.cwd(), ".opencode/compaction.json")),
  ]
}

export const CompactionContext: Plugin = async ({ client }, options) => {
  const layers = await loadLayers()
  const cfg = mergeConfig(...layers, options as Partial<Config>)

  const log = async (message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({ body: { service: "compaction-context", level: "info", message, extra } })
    } catch {}
  }

  // Logged unconditionally: a plugin that loads correctly and then never fires
  // until a compaction happens is otherwise indistinguishable from one that
  // failed to load at all, which makes it needlessly hard to verify an install.
  //
  // Deferred, and deliberately not awaited. Plugin init runs while the opencode
  // server is still coming up, so an HTTP call to that same server from here has
  // nothing to answer it: at best the log is silently dropped (which is what
  // happened — the message never appeared), at worst init blocks waiting for a
  // server that is waiting for init. Handing it to the event loop lets startup
  // finish first.
  setTimeout(() => {
    // Counts enabled providers, not configured ones. The shipped config has
    // examples switched off, and reporting those as loaded would suggest the
    // plugin is doing something it is not.
    const active = cfg.providers.filter((p) => p.enabled !== false)
    void log(
      active.length
        ? `loaded with ${active.length} provider(s): ${active.map((p) => p.name).join(", ")}`
        : "loaded, but no provider is enabled; nothing will be injected",
      {
        configured: cfg.providers.length,
        threshold: cfg.threshold.enabled ? `${cfg.threshold.at}` : "off",
      },
    )
  }, 3000).unref?.()

  // --- threshold state -------------------------------------------------------
  // Context limits are fetched once and cached: they change only when the
  // provider list does, and looking them up on every assistant message would be
  // an HTTP call per turn for a number that does not move.
  let limits: Map<string, number> | null = null
  const lastFiredAt = new Map<string, number>()
  const pending = new Set<string>()
  const isChildSession = new Map<string, boolean>()

  /**
   * Latest observed usage per session, recorded from assistant messages and acted
   * on only when the session goes idle.
   *
   * Acting directly on `message.updated` was the first attempt and it was wrong.
   * An assistant message completing does not mean the turn is over: the agent may
   * be midway through a tool-call loop, and compacting there truncates whatever it
   * was doing. It did exactly that in practice — a session researching a release
   * had its work cut off and never produced an answer.
   */
  const lastUsage = new Map<
    string,
    { used: number; limit: number; providerID: string; modelID: string; isSummary: boolean }
  >()

  async function contextLimit(providerID: string, modelID: string): Promise<number> {
    if (!limits) {
      limits = new Map()
      try {
        const res = await client.config.providers()
        const data = (res as any)?.data
        for (const p of data?.providers ?? []) {
          for (const m of Object.values<any>(p.models ?? {})) {
            const limit = m?.limit?.context
            if (typeof limit === "number") limits.set(`${p.id}/${m.id}`, limit)
          }
        }
      } catch (err) {
        await log("could not read provider list; threshold disabled until restart", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return limits.get(`${providerID}/${modelID}`) ?? 0
  }

  async function childSession(id: string): Promise<boolean> {
    const cached = isChildSession.get(id)
    if (cached !== undefined) return cached
    let child = false
    try {
      const res = await client.session.get({ path: { id } })
      child = Boolean((res as any)?.data?.parentID)
    } catch {
      // Unknown: treat as a child, i.e. do nothing. Declining to act on a session
      // we could not identify is the safe direction.
      child = true
    }
    isChildSession.set(id, child)
    return child
  }

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "session.compacted") {
          const id = (event as any).properties?.sessionID
          if (id) pending.delete(id)
          return
        }
        if (!cfg.threshold.enabled) return

        // Record only. Deciding here would risk compacting mid-turn.
        if (event.type === "message.updated") {
          const info = (event as any).properties?.info
          if (!info || info.role !== "assistant" || !info.time?.completed) return
          lastUsage.set(info.sessionID, {
            used: contextUsed(info.tokens),
            limit: await contextLimit(info.providerID, info.modelID),
            providerID: info.providerID,
            modelID: info.modelID,
            isSummary: Boolean(info.summary),
          })
          return
        }

        // The session has finished working — the one safe moment to compact.
        if (event.type !== "session.idle") return
        const sessionID: string = (event as any).properties?.sessionID
        if (!sessionID) return
        const usage = lastUsage.get(sessionID)
        if (!usage) return
        const { used, limit } = usage

        const decision = shouldCompact({
          used,
          limit,
          triggerAt: triggerFor(cfg.threshold, usage.providerID, usage.modelID, limit),
          now: Date.now(),
          lastFiredAt: lastFiredAt.get(sessionID),
          cooldownMs: cfg.threshold.cooldownMs,
          pending: pending.has(sessionID),
          isSummary: usage.isSummary,
          isChild: await childSession(sessionID),
        })

        // Logged on every turn, not only when it fires. The estimate below is
        // exactly that — an estimate — and the only way to choose a sensible
        // `at` is to watch what it actually reports on real sessions first.
        await log(
          `context ${(decision.fraction * 100).toFixed(1)}% (${used}/${limit}) — ${decision.reason}`,
          { sessionID, model: `${usage.providerID}/${usage.modelID}` },
        )
        if (!decision.fire) return

        pending.add(sessionID)
        lastFiredAt.set(sessionID, Date.now())

        const override = cfg.threshold.model ? parseModelRef(cfg.threshold.model) : null
        if (cfg.threshold.model && !override) {
          await log(`threshold.model "${cfg.threshold.model}" is not provider/model-id; using the session model`)
        }
        // The body is required, despite being typed optional: omitting it returns
        // 400 "Expected object, got undefined" (kind: Payload). So when no override
        // model is configured, send the session's own model explicitly rather than
        // leaving the payload out.
        const body = override ?? { providerID: usage.providerID, modelID: usage.modelID }

        try {
          // The SDK resolves with { data, error } instead of throwing on an HTTP
          // error, so a try/catch alone reports success for every failed call —
          // which is exactly what happened: "compaction triggered" was logged
          // while the context kept growing. The response has to be inspected.
          const res: any = await client.session.summarize({
            path: { id: sessionID },
            body,
          } as any)

          if (res?.error) {
            pending.delete(sessionID)
            await log("summarize was rejected", {
              sessionID,
              error: typeof res.error === "string" ? res.error : JSON.stringify(res.error),
              status: res.response?.status,
            })
            return
          }

          await log(`compaction triggered at ${(decision.fraction * 100).toFixed(1)}%`, {
            sessionID,
            with: `${body.providerID}/${body.modelID}${override ? "" : " (session model)"}`,
          })

          // Safety net: `pending` is normally cleared by the session.compacted
          // event, but if that event never arrives — because the compaction
          // silently did not happen — the session would be blocked from ever
          // triggering again for the rest of the process.
          // unref so a pending timer never keeps the host process alive on its own.
          setTimeout(() => {
            if (pending.delete(sessionID)) {
              void log("no session.compacted event arrived; clearing pending", { sessionID })
            }
          }, 120_000).unref?.()

          if (cfg.threshold.toast) {
            await client.tui
              .showToast({
                body: {
                  title: "compaction",
                  message: `compacted at ${(decision.fraction * 100).toFixed(0)}% of context`,
                  variant: "info",
                  duration: 4000,
                },
              })
              .catch(() => {})
          }
        } catch (err) {
          // Leave the cooldown in place: if summarize is failing, retrying on the
          // very next message would turn one failure into a stream of them.
          pending.delete(sessionID)
          await log("failed to trigger compaction", {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } catch {
        // Never let an event handler throw into opencode's event loop.
      }
    },

    "experimental.session.compacting": async (input, output) => {
      // This hook runs at a delicate moment: it is the last chance to preserve
      // state before the transcript is replaced by a summary. Every failure path
      // below degrades to injecting less, never to throwing — a plugin that
      // breaks compaction is far worse than one that adds no context.
      try {
        const sections: Section[] = []
        for (const provider of cfg.providers) {
          const result = await readProvider(provider)
          if (isSection(result)) {
            sections.push(result)
          } else if (result.skipped !== "no file matched" && result.skipped !== "disabled in config") {
            // A missing file is the normal state (no coaching session running, no
            // notes yet). A file that exists but could not be used is not.
            await log(`provider "${provider.name}" skipped: ${result.skipped}`, { path: result.path })
          }
        }
        if (!sections.length) return

        const blocks = buildSections(sections, cfg)
        if (!blocks.length) return

        output.context.push(
          [
            [
              "The following state lives outside this conversation and must survive compaction.",
              "It is current as of the moment of compaction. Carry it into the summary verbatim",
              "where it is concrete (identifiers, task lists, statuses); do not paraphrase it away.",
            ].join("\n"),
            blocks.join("\n\n"),
          ].join("\n\n"),
        )

        await log("injected context into compaction prompt", {
          sessionID: input.sessionID,
          providers: sections.length,
          chars: blocks.reduce((n, b) => n + b.length, 0),
        })
      } catch (err) {
        await log("failed to inject context; compaction continues unchanged", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
