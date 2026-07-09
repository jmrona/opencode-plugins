# temp-session

**Temporary sessions for [opencode](https://opencode.ai)** — a `/temp-session` command that turns the session you are in into a scratchpad: flagged in its title, hidden from `/sessions` where the server supports archiving, and deleted on the next opencode start.

## Usage

From the home view (or after `leader+n`), type:

```
/temp-session
```

The TUI creates a session and drops you into it; the plugin marks it as temporary, hides the acknowledgment turn, and you work in it as normal. A toast confirms the mode:

- **"hidden from /sessions, deleted on next start"** — your server supports archiving; the session is invisible immediately.
- **"marked in title, deleted on next start"** — older server; the session stays visible as `[temp] <date>` until the next start deletes it.

Running `/temp-session` inside a session that already has history is refused with a toast — an established session can never be scheduled for deletion by accident.

**Accepted trade-off:** leave a temporary session and you cannot navigate back to it from the TUI (it is not listed). That is the point.

## How it works

1. The `command.execute.before` hook intercepts `/temp-session` and marks the **current** session rather than creating a new one. Current opencode builds offer no programmatic way to navigate the TUI to an arbitrary session (`tui.session.select` is not handled everywhere, and quick-switch slots are pin-based), but running a command from home already creates a session and puts you in it — so the current session *is* the temporary one.
2. A zero-messages guard protects sessions with history (at hook time, a session freshly created for the command has no persisted messages yet).
3. The session is retitled `[temp] <date>` and archived best-effort — archived sessions are excluded from the `/sessions` list; servers that predate `time.archived` in the update payload silently ignore it.
4. The id is recorded in `state.json`; on the next start the plugin deletes recorded sessions (ids that fail to delete are retried on the following start).
5. The command's one-line acknowledgment is hidden once its turn completes, via `session.revert` to the first message (`/undo` semantics — `/redo` restores it), leaving an empty transcript.

## Install

```
plugins/
├── index.ts            # barrel — opencode only auto-loads plugins/*.ts (top level)
└── temp-session/
    ├── index.ts
    ├── config.json     # optional
    └── README.md
commands/
└── temp-session.md     # copy from this folder's commands/ — makes /temp-session exist
```

Add to the barrel:

```ts
// plugins/index.ts
export { TempSession } from "./temp-session"
```

Copy `commands/temp-session.md` into your opencode `commands/` directory (global `~/.config/opencode/commands/` or per-project `.opencode/commands/`). Requires `@opencode-ai/plugin` as a dependency in your config directory's `package.json`.

## Configuration

`config.json` next to the plugin (all fields optional; defaults shown):

```json
{
  "title_prefix": "[temp]",
  "cleanup_on_start": true
}
```

| Option | Default | Description |
|---|---|---|
| `title_prefix` | `"[temp]"` | Prefix that marks a session as temporary in its title. |
| `cleanup_on_start` | `true` | Delete the recorded temporary sessions on the next opencode start. Disable to keep them (hidden where archiving works, title-marked otherwise). |

Options can also be supplied through `opencode.json`'s plugin tuple form and take precedence over `config.json`.

## Lessons learnt (read before writing your own plugin)

- **Never await opencode API calls in plugin init.** Plugins initialise while the server is still booting; a synchronous call deadlocks the start and the TUI comes up blank. Detach any startup work (`setTimeout`, not awaited).
- **Do not cancel a command by throwing from `command.execute.before`.** It works, but the TUI renders the error with a full stack trace. Let the template run something cheap instead.
- **Feature-detect the server.** `time.archived` in the update payload and the `tui.session.select` event exist only in recent builds; send them best-effort and verify the result rather than assuming.

## Known limitations

- On servers without archiving support, the temporary session stays visible in `/sessions` (title-marked) until the next start.
- The acknowledgment turn briefly appears before being hidden (it is reverted when the turn completes).
- `/undo`-style `/redo` in a temporary session can resurface the hidden acknowledgment. Harmless.
