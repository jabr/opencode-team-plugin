# Team

Agent-to-agent messaging for [OpenCode](https://opencode.ai) V2. One plugin
package gives every session two tools — `team_send` to deliver messages to
other sessions, `team_query` to inspect, search, and monitor them — plus two
TUI commands: `/session-id` to copy the focused session's ID, and
`/list-agents` to show its agent family (parent, siblings, children) with
status.

Sessions (parents, children, siblings) can coordinate directly instead of
routing everything through the human's composer.

## Install

Install from GitHub (this package is **not** published to npm):

```sh
opencode plugin add github:jabr/opencode-team-plugin
```

Or reference it directly in `opencode.json` — as a Git package spec or a local
path:

```jsonc
{
  "plugins": [
    "github:jabr/opencode-team-plugin",
    // or: "../libs/opencode-team-plugin"
  ]
}
```

## Tools

### `team_send`

Send a message to another agent session in this project. The message is
delivered to the target model as durable input.

**Addressing** (`to`):

| Value | Meaning |
|---|---|
| `ses_…` | a specific session ID |
| `parent` | this session's parent |
| `siblings` | all other children of this session's parent |
| `children` | all children of this session (the parent broadcast) |

**Delivery modes** (`mode`) — an escalation ladder, from "act on this" to
"just remember this":

- **`queue`** (default) — queued for after the target finishes its current turn,
  waking idle sessions. Use for anything the target should act on next.
- **`steer`** — injected at the target's next model call without stopping
  execution. Use for mid-run course corrections that shouldn't discard
  in-flight work.
- **`interrupt`** — aborts the target's current execution entirely, then
  delivers; the message starts a fresh run. Use when its current work is wrong
  or obsolete ("stop what you're doing").
- **`park`** — admitted durably but does **not** wake the target; it is
  delivered only if the target runs again later. Use for FYI context,
  findings, or notes the target should see IF it resumes — never for action
  items.

Sending to your own session is refused.

### `team_query`

Inspect, search, and monitor sibling/child sessions. Actions:

- **inbox** — list a session's pending inbox items (defaults to the caller);
  `inboxID` cancels one, `"all"` cancels every pending item.
- **list** — find sessions: `parent: "my"` (default — this session's
  children), `parent: "parent"` (siblings), `parent: "all"` (recent sessions),
  or a session ID; `search` filters by title.
- **read** — tail a session's messages (compact summaries, oldest-first);
  `cursor` pages further back using the response's `next`.
- **status** — whether a session is running or blocked (`"permission"` /
  `"form"` ask pending — busy but cannot progress); omit `sessionID` for
  every running session in the scoped project.
- **wait** — block until the given session goes idle, bounded by `timeout`
  seconds (default 300).

## The `[agent-message from ses_…]` protocol

Delivered messages reach the target model as plain user turns — the wire
format requires a user-role final message and carries no marker — so the
provenance rides **in the text**: every message is framed as

```text
[agent-message from ses_…]
<message>
```

A context hook teaches every agent what the frame means: a user turn starting
`[agent-message from ses_…]` is a durable message from another AI agent
session, **not** the human user. Treat the sender as a coordinating peer:
honor its requests at natural boundaries and reply with `team_send` addressed
to the sender's session ID (also carried in the message metadata as `from`,
so a reply needs no discovery).

There is no polling loop: an agent that wants replies reads its own history
with `team_query` `read`, optionally after `team_query` `wait`. Pending
messages are inspectable and cancellable with `team_query` `inbox`.

## TUI commands

### `/session-id`

Also "Show and copy session ID" in the command palette (group "Team"): copies
the focused session's ID to the clipboard and shows it in a toast. The CLI's
`opencode session delete/export` and the team tools all want `ses_…` IDs. The
TUI also ships a built-in palette command for this ("Copy session ID" under
"Session"), but it is palette-only — `/session-id` is the fast path from the
composer.

### `/list-agents`

Also "Show agent tree" in the command palette (group "Team"): opens a select
dialog listing the focused session's agent family — itself, its parent, its
siblings, and its children (oldest first within each group). A root session
has no parent or siblings by definition, so its other top-level project
sessions are listed instead (most recently updated first). Each row shows
the session's status, agent, queued inbox count, and full ID:

- **status** — `running`, `idle`, or the blocked-but-running distinction:
  `blocked:permission` (stuck on a permission ask) or `blocked:form` (stuck
  on a form), which is the "busy but cannot progress" state.
- **selection** — pressing Enter copies that session's ID (what
  `/session-id` does for the focused session, generalized); Esc dismisses.

Both commands are strictly local: no prompts submitted, no model turns —
state comes from the TUI's client-side session store, which the host keeps
live-synced.

## Permissions

Each tool has its own permission key — `team_send` and `team_query` — so
config can gate them independently:

```jsonc
{
  "permission": {
    "team_send": "deny", // e.g. read-only subagents may query but not send
  }
}
```

## Scoping and security

Messaging is project-trapped **by plugin policy**, not by the server: the HTTP
API will happily message or read any session by ID. This plugin refuses
cross-project sends and defaults all reads to the current project; an explicit
`project` input opts into another project for reads (and is checked the same
way on `list`/`read`/`status`/`wait`/`inbox`).

## Requirements

- OpenCode V2 (the plugin and TUI plugin APIs).
- The tools are registered `codemode: true` (catalog-only in Code Mode
  sessions), so they cost ~zero context there.

## License

[MIT](LICENSE.txt) — Copyright (c) 2026 Justin Bradford.
