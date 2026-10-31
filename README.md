# Team

Agent-to-agent messaging for [OpenCode](https://opencode.ai) V2. One plugin
package gives every session three tools — `team_spawn` to create sessions,
`team_send` to deliver messages, and `team_query` to inspect and monitor them — plus two
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

### `team_spawn`

Create a persistent, independent top-level session by default. This makes it
available in the normal session list; it does **not** switch the UI or open a
terminal. Use `kind: "child"` to attach a fresh child to the calling session.
This complements, rather than replaces, built-in `subagent`.

```ts
await tools.team.spawn({ title: "Review deployment", text: "Review the deployment plan." })
await tools.team.spawn({ title: "Scratch session" }) // idle, no model turn
await tools.team.spawn({ title: "Isolated task", kind: "child", worktree: { name: "isolated" } })
```

- `title` is required and must not be blank.
- `agent` and `model: { providerID, id, variant? }` are optional; omission
  preserves normal configured defaults, not the caller's selections.
- `text` admits an initial task asynchronously through the same synthetic
  agent-message protocol as `team_send`. No transcript is copied or forked.
- Without `worktree`, use the caller's actual directory. With `worktree: { name? }`,
  create through OpenCode's configured strategy, from the caller's checkout
  (resolved from project worktree inventory, including callers in subdirectories).
  Starting branches and selecting existing checkouts are not exposed.
- Root sessions have no parent/sibling addressing or parent lifecycle coupling.
  Creator provenance is recorded separately in session metadata under `team.spawn`.
- No automatic completion messages, cancellation propagation, or result collection.
  Coordinate using `team_send` and `team_query` read/status/wait.

Success returns JSON with `ok`, `sessionID`, actual `directory`, `started`, and
optional `worktree: { directory }` and `inboxID`. `started: true` means task
**admission**, not completion. Partial failures return `ok: false`, `stage`,
`error`, and any known resource IDs/paths. Transport failures may leave admission
uncertain. When a session exists, recovery attempts a bounded location refresh:
`directoryStatus: "refreshed"` means the directory was read again;
`"last-known"` means that read failed and the reported directory is uncertain.
A pending move may still change the location after a refresh.
Inspect retained resources before retrying; neither sessions nor
worktrees are automatically deleted. Worktrees persist independently of sessions.

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

**Cross-project** (`project`) — passing the target's project (its id, name,
or directory) opts a `ses_…` target in another project in, and is verified
against the target; a mismatch refuses with a did-you-mean naming the real
project. Role addressing (`parent`/`siblings`/`children`) is inherently
same-project.

Sending to your own session is refused.

### `team_query`

Inspect, search, and monitor sibling/child sessions. Actions:

- **inbox** — list a session's pending inbox items (defaults to the caller);
  `inboxID` cancels one, `"all"` cancels every pending item.
- **list** — find sessions: `parent: "my"` (default — this session's
  children), `parent: "parent"` (siblings), `parent: "roots"` (unarchived
  top-level sessions across the project's checkouts/worktrees), `parent: "all"`
  (recent sessions), or a session ID; `search` filters by title. Results include
  `directory`. Root selection, title search, and archive filtering happen on
  the server before pagination.
- **read** — tail a session's messages (compact summaries, oldest-first);
  `cursor` pages further back using the response's `next`.
- **status** — whether a session is running or blocked (`"permission"` /
  `"form"` ask pending — busy but cannot progress); omit `sessionID` for
  every running session in the scoped project.
- **wait** — block until the given session goes idle, bounded by `timeout`
  seconds (default 300).

Every action accepts `project` to reach another project's sessions — see
[Scoping and security](#scoping-and-security).

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

The synthetic message's `description` is a compact update label,
`Message from <sender session title>` (falling back to the session ID).
Web/desktop clients display this under Updates, not as an expandable
full-message view. The full framed message remains in `text` for the
receiving agent and is already returned by the session message API.
Expandable viewing requires frontend support. Older messages remain unchanged.
This applies to both `team_send` and initial tasks from `team_spawn`.

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

Each tool has its own permission key — `team_spawn`, `team_send`, and `team_query` — so
config can gate them independently:

```jsonc
{
  "permissions": [
    { "action": "team_spawn", "resource": "*", "effect": "deny" },
    { "action": "team_send", "resource": "*", "effect": "deny" },
  ], // e.g. read-only subagents may query but not spawn or send
}
```

## Scoping and security

Spawning uses a deliberately conservative permission ceiling for both roots
and children. The caller's executing agent rules and session rules are read in
the caller's location. All `ask` and `deny` rules are frozen as session-level
**denies**, even restrictions overridden by later caller grants. Allows and
saved approvals are never copied, so they cannot weaken a destination agent's
or location's rules. Without an explicit caller `allow` for action/resource
`*`/`*`, the ceiling denies everything, including otherwise implicit asks.
This can be more restrictive than the caller (for example, an `.env` ask becomes
a deny), but never more permissive. The ceiling remains on subsequent agent
switches. User-authorized session permission edits can replace it.

Messaging is project-trapped **by plugin policy**, not by the server: the HTTP
API will happily message or read any session by ID. This plugin refuses
cross-project sends and defaults all reads to the current project.

`project` (on both tools) opts into another project. It accepts a project id,
registered name, directory basename, or full path — case-insensitive — so
`project: "acme-api"` just works, and the raw 40-hex project ID keeps
working. Passing it is both the opt-in and an assertion: it is verified
against the target session's actual project (even when same-project), so a
wrong value refuses rather than being ignored. Refusals are the discovery
mechanism — they name the target's real project and end with the exact retry
value:

```text
team query read: "ses_…" ("…session title…") is the agent in acme-api (/Users/…/acme-api) — did you mean the agent in acme-api? pass project: "acme-api" to read across projects
```

`team_send` refuses the same way ("to message across projects"). For the
scope-selecting actions — `list`, and `status` with no `sessionID` — the value
is resolved against the project registry instead, and an unknown name refuses
by listing the known projects. Without `project`, cross-project delivery stays
refused.

Project defaults come from the calling session, not the plugin instance's
checkout. Spawning has no arbitrary parent-ID or cross-project option.

## Development

Run `npm test` with Node 22.18+ (native TypeScript stripping).
Run `bun test index.test.ts` for the upstream project-selection tests.
Run `npm run typecheck` with Bun installed.

## Requirements

- OpenCode V2 (the plugin and TUI plugin APIs).
- The tools are registered `codemode: true` (catalog-only in Code Mode
  sessions), so they cost ~zero context there.

## License

[MIT](LICENSE.txt) — Copyright (c) 2026 Justin Bradford.
