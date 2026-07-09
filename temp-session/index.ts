// temp-session/index.ts
//
// /temp-session: marks the current session as temporary — flagged in its
// title, hidden from /sessions where the server supports archiving, and
// deleted on the next opencode start.
//
// How it works:
// 1. The /temp-session command (see commands/temp-session.md) is intercepted
//    by the command.execute.before hook. It marks the CURRENT session rather
//    than creating a new one: current opencode builds offer no programmatic
//    way to navigate the TUI to an arbitrary session, but the TUI already
//    creates a session and drops you into it when you run a command from the
//    home view. Flow: home -> /temp-session -> you are inside the temporary
//    session.
// 2. A guard refuses to mark a session that already has history, so an
//    established session can never be scheduled for deletion by accident.
//    At hook time a session freshly created for this command has zero
//    messages (the command's own prompt is persisted after the hook).
// 3. The session is retitled with the temporary prefix and archived on a
//    best-effort basis (archived sessions are excluded from /sessions;
//    older servers silently ignore the field and the title alone marks it).
// 4. The session id is recorded in state.json; on the next opencode start
//    the plugin deletes the recorded sessions (when cleanup_on_start is on).
// 5. The command template produces a one-line acknowledgment; once that
//    turn completes (session.idle) the plugin reverts to the first message,
//    leaving the transcript visually empty (/undo semantics — /redo brings
//    it back).
//
// Accepted trade-off: leave the temporary session and you cannot navigate
// back to it from the TUI (it is not listed). That is the intended
// behaviour.
//
// Hard-won lesson encoded below: a plugin's init must never await calls to
// the opencode server — plugins initialise while the server is still
// starting, so a synchronous call deadlocks the boot and the TUI comes up
// blank. Any startup work that talks to the server has to be detached.

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

type TempConfig = {
  /** Prefix that marks a session as temporary in its title. */
  title_prefix: string
  /** Delete the sessions recorded in state.json on the next start. */
  cleanup_on_start: boolean
}

const DEFAULTS: TempConfig = { title_prefix: "[temp]", cleanup_on_start: true }

const statePath = fileURLToPath(new URL("./state.json", import.meta.url))

async function readState(): Promise<string[]> {
  try {
    const ids = JSON.parse(await readFile(statePath, "utf8"))
    return Array.isArray(ids) ? ids : []
  } catch {
    return []
  }
}

async function writeState(ids: string[]) {
  try {
    await writeFile(statePath, JSON.stringify(ids))
  } catch {}
}

export const TempSession: Plugin = async ({ client }, options) => {
  let fileConfig: Partial<TempConfig> = {}
  try {
    fileConfig = JSON.parse(await readFile(fileURLToPath(new URL("./config.json", import.meta.url)), "utf8"))
  } catch {}
  const cfg: TempConfig = { ...DEFAULTS, ...fileConfig, ...(options as Partial<TempConfig>) }

  const toast = async (message: string, variant: "info" | "warning") => {
    try {
      await client.tui.showToast({ body: { title: "temp-session", message, variant, duration: 4000 } })
    } catch {}
  }

  const log = async (message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({ body: { service: "temp-session", level: "info", message, extra } })
    } catch {}
  }

  // Startup cleanup: delete the temporary sessions recorded by previous runs.
  //
  // CRITICAL: detached from init (setTimeout, not awaited). Plugin init runs
  // while the opencode server is still booting; awaiting HTTP calls against
  // the server here deadlocks the start (the server waits for the plugin,
  // the plugin waits for the server) and the TUI comes up blank.
  if (cfg.cleanup_on_start) {
    setTimeout(async () => {
      try {
        const ids = await readState()
        if (!ids.length) return
        const remaining: string[] = []
        for (const id of ids) {
          const ok = await client.session
            .delete({ path: { id } })
            .then((r: any) => !r.error)
            .catch(() => false)
          if (!ok) remaining.push(id)
        }
        await writeState(remaining)
        await log(`startup cleanup: deleted ${ids.length - remaining.length}/${ids.length} temp session(s)`)
      } catch {}
    }, 3000)
  }

  // Freshly marked sessions whose acknowledgment turn still needs hiding
  // (revert to the first message once the turn finishes).
  const pendingRevert = new Set<string>()

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const id = (event as any).properties?.sessionID
      if (!id || !pendingRevert.has(id)) return
      pendingRevert.delete(id)
      // Hide the acknowledgment turn: reverting to the first message leaves
      // the transcript visually empty (/undo semantics; /redo restores it).
      const msgs = await client.session.messages({ path: { id } }).catch(() => undefined)
      const first = ((msgs?.data as any[]) ?? [])[0]?.info?.id
      if (!first) return
      await client.session.revert({ path: { id }, body: { messageID: first } }).catch(() => {})
      await log("acknowledgment hidden via revert", { id })
    },

    "command.execute.before": async (input) => {
      if (input.command !== "temp-session") return

      const id = input.sessionID

      // Guard: never mark a session that already has history. At hook time a
      // session freshly created for this command has zero messages (the
      // command's prompt is persisted after the hook).
      const msgs = await client.session.messages({ path: { id } }).catch(() => undefined)
      if (((msgs?.data as any[]) ?? []).length > 0) {
        await log("refused to mark session with history", { id })
        await toast(
          "this session has history — start a fresh one (leader+n or /new) and run /temp-session there",
          "warning",
        )
        return
      }

      const title = `${cfg.title_prefix} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`
      // Best-effort archiving: on recent servers this hides the session from
      // /sessions; older servers silently drop the field and the title plus
      // the startup cleanup carry the feature.
      await client.session
        .update({ path: { id }, body: { title, time: { archived: Date.now() } } as any })
        .catch(() => client.session.update({ path: { id }, body: { title } }).catch(() => {}))

      const ids = await readState()
      ids.push(id)
      await writeState(ids)
      pendingRevert.add(id)

      const fresh = await client.session.get({ path: { id } }).catch(() => undefined)
      const archived = Boolean((fresh?.data as any)?.time?.archived)
      await log("session marked as temporary", { id, archived })
      await toast(
        archived
          ? "this session is now temporary — hidden from /sessions, deleted on next start"
          : "this session is now temporary — marked in title, deleted on next start",
        "info",
      )
    },
  }
}
