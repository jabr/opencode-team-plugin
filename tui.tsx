// team (TUI half) — little one-off TUI bits for the team plugin package.
// Nothing here submits prompts or runs model turns; state comes from the
// TUI's own client-side session store, which the host keeps live-synced.
//
// Each bit is one KeymapCommand factory below; add new ones to COMMANDS.
// Slash/palette only: keep `bind: false` and leave the layer's `bindings`
// unset unless a bit genuinely deserves a keyboard shortcut.
//
// The file is named .tsx for the TUI loader convention (see README) even
// though nothing here renders JSX (yet).

import { spawnSync } from "node:child_process"
import process from "node:process"
import { Plugin } from "@opencode/plugin/tui"
import type { Context, KeymapCommand } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"

// How long the session-ID toast stays up: long enough to read and
// mouse-select, short enough not to linger.
const TOAST_MS = 10_000

// Copy via the platform clipboard utility; the TUI has no host-clipboard
// API and the terminal's OSC 52 support varies. Returns false when no
// utility succeeded — callers still show the text so it can be
// mouse-selected.
function copyToClipboard(text: string): boolean {
  const tryCopy = (command: string, args: string[] = []) => {
    try {
      return spawnSync(command, args, { input: text }).status === 0
    } catch {
      return false
    }
  }
  if (process.platform === "darwin") return tryCopy("pbcopy")
  if (process.platform === "win32") return tryCopy("clip")
  return tryCopy("wl-copy") || tryCopy("xclip", ["-selection", "clipboard"])
}

// Copy via OSC 52 through the TUI renderer — the same terminal-escape
// backend the built-in "Copy session ID" command uses. The builtin combines
// it with the OS pasteboard through an internal native host-clipboard
// service (its "all-available" policy); that service is not exposed to
// plugins, so the platform utility above stands in for the host side. Both
// destinations are attempted: terminals gate OSC 52 behind settings and SSH
// forwards often disable it, while utilities are absent on headless boxes —
// each covers the other's gaps. Returns false when the escape was not
// written.
function copyViaOsc52(context: Context, text: string): boolean {
  // The renderer is opentui's CliRenderer (an optional peer, so it types as
  // any through the plugin context); declare just the slice used here.
  const renderer = context.renderer as unknown as {
    isOsc52Supported(): boolean
    copyToClipboardOSC52(text: string): boolean
  }
  try {
    return renderer.isOsc52Supported() && renderer.copyToClipboardOSC52(text)
  } catch {
    return false
  }
}

// Copy a session ID to every clipboard destination and toast the result.
// Both destinations are attempted even when one succeeds: OSC 52 success
// only means the escape was written (terminals may gate or ignore it), and
// platform utilities may be absent on headless boxes — each covers the
// other's gaps.
function copySessionId(context: Context, sessionID: string): void {
  const copiedOsc52 = copyViaOsc52(context, sessionID)
  const copiedLocal = copyToClipboard(sessionID)
  const copied = copiedOsc52 || copiedLocal
  context.ui.toast.show({
    title: copied ? "Session ID copied" : "Session ID (clipboard unavailable)",
    message: sessionID,
    variant: copied ? "success" : "warning",
    duration: copied ? 2_000 : TOAST_MS,
  })
}

// /session-id — copy the focused session's ID to the clipboard and show it.
// The CLI's `opencode session delete/export` and the team tools all want
// ses_… IDs. The TUI ships a built-in palette command for this
// (session.copy.id, "Copy session ID" under "Session"), but it is
// palette-only — this bit's value is the /session-id slash command from the
// composer.
function sessionIdCommand(context: Context): KeymapCommand {
  return {
    id: "team.session-id",
    title: "Show and copy session ID",
    description: "Copy the focused session's ID to the clipboard",
    group: "Team",
    bind: false,
    palette: true,
    slash: { name: "session-id" },
    run: () => {
      // Slash commands are typed in a session composer, so the focused route
      // is the session they belong to — except from the palette on home.
      const route = context.ui.router.current()
      if (route.type !== "session") {
        context.ui.toast.show({ message: "No session is open", variant: "warning" })
        return
      }
      copySessionId(context, route.sessionID)
    },
  }
}

// Per-session status for the tree. Beyond idle/running, surfaces the
// blocked-but-running distinction: a session stuck on a permission ask or a
// form is busy yet cannot progress until it is answered.
function sessionStatus(context: Context, sessionID: string): string {
  const data = context.data.session
  if ((data.permission.list(sessionID)?.length ?? 0) > 0) return "blocked:permission"
  if ((data.form.list(sessionID)?.length ?? 0) > 0) return "blocked:form"
  return data.status(sessionID)
}

// /list-agents — the focused session's agent family: itself, its parent,
// its siblings, and its children, each with status, agent, queued inbox
// count, and full ID. A root session (no parent) has no siblings by
// definition, so its other top-level project sessions are listed instead.
// Selecting a row copies that session's ID (what /session-id does for the
// focused session, generalized).
function treeCommand(context: Context): KeymapCommand {
  return {
    id: "team.tree",
    title: "Show agent tree",
    description: "Parent, siblings, and children of the focused session with status",
    group: "Team",
    bind: false,
    palette: true,
    slash: { name: "list-agents" },
    run: async () => {
      // Slash commands are typed in a session composer, so the focused route
      // is the session they belong to — except from the palette on home.
      const route = context.ui.router.current()
      if (route.type !== "session") {
        context.ui.toast.show({ message: "No session is open", variant: "warning" })
        return
      }

      const sessions = context.data.session
      const self = sessions.get(route.sessionID)
      if (!self) {
        context.ui.toast.show({ message: "Session not found", variant: "warning" })
        return
      }
      // Tree order: self, parent, siblings, children. Deterministic order
      // within a group: oldest first.
      const byCreated = (a: SessionInfo, b: SessionInfo) => a.time.created - b.time.created
      // The store lists every project's sessions; scope the tree to the
      // focused session's project. Family rows are in it by construction;
      // the "other sessions" fallback must be filtered explicitly.
      const all = sessions.list().filter((s) => s.projectID === self.projectID)
      const siblings = self?.parentID
        ? all.filter((s) => s.parentID === self.parentID && s.id !== self.id).sort(byCreated)
        : []
      const children = all.filter((s) => s.parentID === route.sessionID).sort(byCreated)
      const parent = self?.parentID ? sessions.get(self.parentID) : undefined
      // A root session has no parent or siblings by definition; show the
      // project's other top-level sessions instead so the tree is not empty.
      // Most recently updated first — these are "what else is around", not a
      // family ordering.
      const others = self?.parentID
        ? []
        : all
            .filter((s) => !s.parentID && s.id !== route.sessionID && s.time.archived == null)
            .sort((a, b) => b.time.updated - a.time.updated)

      const rows = [
        ...(self ? [{ session: self, category: "this session" }] : []),
        ...(parent ? [{ session: parent, category: "parent" }] : []),
        ...siblings.map((session) => ({ session, category: "siblings" })),
        ...children.map((session) => ({ session, category: "children" })),
        ...others.map((session) => ({ session, category: "other sessions" })),
      ]
      // Blocked-state data is event-synced, but refresh it for the handful of
      // sessions about to be shown; a stale "running" would hide a stuck ask.
      // Both sources sessionStatus() consults are refreshed.
      await Promise.all(
        rows.flatMap(({ session }) => [
          sessions.permission.sync(session.id).catch(() => {}),
          sessions.form.sync(session.id).catch(() => {}),
        ]),
      )

      if (rows.length === 0) {
        context.ui.toast.show({ message: "No sessions found", variant: "warning" })
        return
      }
      const pick = await context.ui.dialog.select<string>({
        title: "Agent tree",
        options: rows.map(({ session, category }) => {
          const pending = sessions.pending.list(session.id).length
          const facts = [
            sessionStatus(context, session.id),
            session.agent,
            pending > 0 ? `inbox:${pending}` : null,
            session.id,
          ].filter((fact) => fact != null)
          return {
            title: session.title || session.id,
            value: session.id,
            category,
            // Two lines per entry: the leading break drops the metadata
            // under the title instead of cramming everything on one line.
            description: `\n${facts.join(" · ")}`,
          }
        }),
      })
      if (pick) copySessionId(context, pick)
    },
  }
}

// Every team command, in registration order.
const COMMANDS: Array<(context: Context) => KeymapCommand> = [sessionIdCommand, treeCommand]

export default Plugin.define({
  id: "team.cli",
  setup(context) {
    // Keymap layers are owned by a rendering component: registering one
    // directly in setup() throws "Keymap.Provider is missing". The `app` slot
    // mounts once at the app root and contributes nothing visible — it exists
    // only to give the layer a component owner (and dispose it on unload).
    return context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: COMMANDS.map((command) => command(context)),
        }))
        return null
      },
    })
  },
})
