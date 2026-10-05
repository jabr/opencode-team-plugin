// team (TUI half) — little one-off TUI bits for the team plugin package.
// Everything here is strictly local to the client: no prompts are submitted,
// no model turns, no server round trips beyond what the TUI itself already
// does.
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

// /session-id (alias /sid) — copy the focused session's ID to the clipboard
// and show it. The CLI's `opencode session delete/export` and the team tools
// all want ses_… IDs. The TUI ships a built-in palette command for this
// (session.copy.id, "Copy session ID" under "Session"), but it is
// palette-only — this bit's value is the /sid slash alias from the composer.
function sessionIdCommand(context: Context): KeymapCommand {
  return {
    id: "team.session-id",
    title: "Show and copy session ID",
    description: "Copy the focused session's ID to the clipboard",
    group: "Team",
    bind: false,
    palette: true,
    slash: { name: "session-id", aliases: ["sid"] },
    run: () => {
      // Slash commands are typed in a session composer, so the focused route
      // is the session they belong to — except from the palette on home.
      const route = context.ui.router.current()
      if (route.type !== "session") {
        context.ui.toast.show({ message: "No session is open", variant: "warning" })
        return
      }
      // Attempt every clipboard destination (see the copy helpers); one
      // succeeding is enough.
      const copiedOsc52 = copyViaOsc52(context, route.sessionID)
      const copiedLocal = copyToClipboard(route.sessionID)
      const copied = copiedOsc52 || copiedLocal
      context.ui.toast.show({
        title: copied ? "Session ID copied" : "Session ID (clipboard unavailable)",
        message: route.sessionID,
        variant: copied ? "success" : "warning",
        duration: copied ? 2_000 : TOAST_MS,
      })
    },
  }
}

// Every team command, in registration order.
const COMMANDS: Array<(context: Context) => KeymapCommand> = [sessionIdCommand]

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
