// team — agent-to-agent messaging for OpenCode v2.
//
// Two tools, both registered `codemode: true` (catalog-only in Code Mode, so
// they cost ~zero context there):
//
//   team_send   deliver a message to another session — a ses_… ID, 'parent',
//               'siblings', or 'children' — queued by default, with steer /
//               interrupt / park delivery modes.
//   team_query  inbox | list | read | status | wait over other sessions.
//
// Scoping policy is enforced HERE, not by the server: the HTTP API will
// happily message or read any session by ID. This plugin refuses
// cross-project sends and defaults all reads to the current project;
// `project` opts into others — verified against the target, so refusals
// can name the real project and the retry value.
//
// Delivery rides the session inbox as durable synthetic user input; the
// event stream is deliberately unused (volatile: missed on disconnect).
// There is no polling loop — agents that want replies read their own history
// via `team_query list` (full text of any message via `team_query read`),
// optionally after `team_query wait`.
import { basename } from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  OpenCode,
  type OpenCodeClient,
  type SessionInboxInfo,
  type SessionMessageInfo,
  type SessionInfo,
} from "@opencode/client"
import { Service } from "@opencode/client/service"
import { agentMessage } from "./agent-message.ts"

// Message listing is triage, not consumption: ~PREVIEW-char heads plus
// message IDs, with `read` (sessionID + messageID) fetching any message
// in full. Full-fidelity paths are deliberately uncapped: an explicit
// full read must return the whole message.
const PREVIEW = 200
const DEFAULT_LIMIT = 20
// `wait` bounds: the wait API has no timeout parameter of its own.
const DEFAULT_WAIT_S = 300

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Full API client (loopback to the service this plugin runs inside).
 * The plugin ctx's session domain is a Pick<> without `list`/`active`,
 * so discovery is used instead of relying on undocumented ctx internals.
 * The discovered endpoint is kept alongside the client: the promise client
 * lacks `message.get`, so singular full reads fetch the message raw
 * (see the query read action).
 */
type Loopback = {
  client: OpenCodeClient
  endpoint: NonNullable<Awaited<ReturnType<typeof Service.discover>>>
}

let loopback: Promise<Loopback> | null = null

function connect(): Promise<Loopback> {
  loopback ??= (async () => {
    const endpoint = await Service.discover()
    if (!endpoint) throw new Error("team: no healthy opencode service found")
    const client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
    })
    return { client, endpoint }
  })()
  // If discovery/connection failed once, allow a fresh attempt next call.
  loopback.catch(() => {
    loopback = null
  })
  return loopback
}

function api(): Promise<OpenCodeClient> {
  return connect().then(({ client }) => client)
}

/** Aggregate tool-call parts into one summary line, e.g.
 *  "3 tool calls: read×2, grep" — previews spend their budget on text,
 *  not on [tool:…] spam. */
function toolSummary(names: string[]): string | undefined {
  if (names.length === 0) return undefined
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  const parts = [...counts].map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
  return `${names.length} tool call${names.length > 1 ? "s" : ""}: ${parts.join(", ")}`
}

/**
 * Triage row for a session message: the message ID plus a ~PREVIEW-char
 * head preview, so a caller can decide which message(s) to fetch in full
 * via `read`. Synthetic messages are expected to carry the in-text
 * "[agent-message from …]" frame added at send time; unframed ones (older
 * history, other producers) render as bare text with no provenance.
 * Returns `null` to skip low-signal noise (idle).
 */
function previewRow(message: SessionMessageInfo): Record<string, unknown> | null {
  switch (message.type) {
    case "idle":
      return null
    case "user":
    case "synthetic":
      return { id: message.id, kind: message.type, preview: truncate(message.text, PREVIEW) }
    case "system":
      return { id: message.id, kind: "system", preview: message.text ? truncate(message.text, PREVIEW) : "" }
    case "assistant": {
      const text = message.content
        .map((part) => (part.type === "text" && part.text ? part.text : ""))
        .join(" ")
      const tools = toolSummary(message.content.flatMap((part) => (part.type === "tool" ? [part.name] : [])))
      return {
        id: message.id,
        kind: "assistant",
        ...(message.agent ? { agent: message.agent } : {}),
        preview: truncate(text, PREVIEW),
        ...(tools ? { tools } : {}),
      }
    }
    default:
      return { id: message.id, kind: message.type, preview: "" }
  }
}

/**
 * Full-fidelity render for a singular `read`. Unlike previews, whitespace
 * is preserved (deliverables are often markdown) and there is no cap: the
 * caller asked for this message in full.
 */
function fullRow(message: SessionMessageInfo): Record<string, unknown> {
  let text = ""
  let agent: string | undefined
  switch (message.type) {
    case "user":
    case "synthetic":
      text = message.text
      break
    case "system":
      text = message.text ?? ""
      break
    case "assistant":
      agent = message.agent
      text = message.content
        .map((part) => (part.type === "text" && part.text ? part.text : ""))
        .join("\n\n")
      break
    default:
      text = ""
  }
  return {
    id: message.id,
    kind: message.type,
    ...(agent ? { agent } : {}),
    text,
  }
}

/**
 * Pending mail renders in full: it is the caller's own mail, delivery would
 * surface all of it anyway, and the API response already carries the text.
 */
function inboxFacts(item: SessionInboxInfo): { text?: string; from?: string } {
  // Only user/synthetic payloads carry text and metadata; other kinds are
  // structured controls with nothing to quote.
  const payload = item.payload as { text?: string; metadata?: Record<string, unknown> }
  if (!payload.text) return {}
  return {
    text: payload.text,
    ...(payload.metadata?.from !== undefined ? { from: String(payload.metadata.from) } : {}),
  }
}

/** The project identity `project` values are matched and reported against. */
type ProjectIdentity = { id: string; canonical: string; name?: string }

/** A project's human label: registered name, else its directory basename. */
function projectLabel(project: { name?: string; canonical: string }): string {
  return project.name ?? basename(project.canonical)
}

/**
 * `project` matches a project by id, registered name, directory basename,
 * or full path — case-insensitive, exact. Raw project IDs (the only value
 * the old scoping accepted) keep working.
 */
function projectMatches(value: string, project: ProjectIdentity): boolean {
  const v = value.toLowerCase()
  return (
    v === project.id.toLowerCase() ||
    v === project.canonical.toLowerCase() ||
    v === basename(project.canonical).toLowerCase() ||
    (project.name !== undefined && v === project.name.toLowerCase())
  )
}

/**
 * Refusals are the discovery mechanism: name the target's real project and
 * end with the exact retry value, so a mis-scoped call costs one round
 * trip. `given` undefined = no `project` was passed (cross-project
 * refused); otherwise the passed value didn't match.
 */
function projectRefusal(
  prefix: string,
  targetID: string,
  title: string | undefined,
  identity: ProjectIdentity,
  across: string,
  given?: string,
): Error {
  const label = projectLabel(identity)
  const where = `${label} (${identity.canonical})`
  // The missing case quotes the title too: the caller may not know which
  // agent an opaque ID names.
  if (given === undefined) {
    const who = `"${targetID}"${title ? ` ("${title}")` : ""}`
    return new Error(
      `${prefix}: ${who} is the agent in ${where} — did you mean the agent in ${label}? pass project: "${label}" ${across}`,
    )
  }
  return new Error(
    `${prefix}: project "${given}" doesn't match — "${targetID}" is the agent in ${where}. did you mean the agent in ${label}? pass project: "${label}"`,
  )
}

/**
 * A target's project identity: the registry carries names and canonical
 * paths; the session itself always has the id and directory, so a registry
 * miss degrades to those rather than failing the check.
 */
async function targetProjectIdentity(target: SessionInfo): Promise<ProjectIdentity> {
  const fallback: ProjectIdentity = { id: target.projectID, canonical: target.location.directory }
  try {
    const projects = await (await api()).project.list()
    return projects.find((p) => p.id === target.projectID) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Blocked-but-running detection for status/list rows: a session stuck on a
 * permission ask or a form is busy yet cannot progress until it is answered.
 * Both listings are location-wide one-shots keyed by sessionID, so this is
 * two round trips regardless of row count. Failures degrade to "not
 * blocked" (null) rather than failing the query — null means "not blocked
 * or undeterminable". Scoped to the caller's location: cross-project rows
 * (via the `project` opt-in) always read null.
 */
async function blockedMap(client: OpenCodeClient): Promise<Map<string, "permission" | "form">> {
  const [permissions, forms] = await Promise.all([
    client.permission.request.list().then((out) => out.data).catch(() => []),
    client.form.list().then((out) => out.data).catch(() => []),
  ])
  const blocked = new Map<string, "permission" | "form">()
  for (const request of permissions) blocked.set(request.sessionID, "permission")
  for (const form of forms) if (!blocked.has(form.sessionID)) blocked.set(form.sessionID, "form")
  return blocked
}

export default Plugin.define({
  id: "team.server",
  async setup(ctx) {
    const projectID = ctx.location.project.id

    /**
     * Project scope check on a fetched target, shared by send and query.
     * `project` absent: this project only — a cross-project target refuses
     * with a did-you-mean naming its real project. `project` present: it
     * must match the target's project even when same-project; matching IS
     * the cross-project opt-in, a mismatch never passes silently.
     */
    const checkProjectScope = async (
      prefix: string,
      across: string,
      target: SessionInfo,
      projectInput: string | undefined,
    ): Promise<void> => {
      if (projectInput === undefined && target.projectID === projectID) return
      const identity = await targetProjectIdentity(target)
      if (projectInput === undefined || !projectMatches(projectInput, identity)) {
        throw projectRefusal(prefix, target.id, target.title, identity, across, projectInput)
      }
    }

    // Project scope for query reads: refuse sessions outside it (the API
    // itself is not project-trapped; this is plugin policy). Returns the
    // fetched session so callers can reuse it.
    const scopedSession = async (action: string, sessionID: string, projectInput: string | undefined) => {
      const target = await ctx.session.get({ sessionID })
      await checkProjectScope(`team query ${action}`, "to read across projects", target, projectInput)
      return target
    }

    /**
     * Scope selection where there is no target session to verify against
     * (list; status with no sessionID): resolve the value against the
     * project registry. Unresolvable values refuse with the known labels.
     */
    const resolveScope = async (action: string, value: string | undefined): Promise<string> => {
      if (value === undefined) return projectID
      const projects = await (await api()).project.list()
      const match = projects.find((project) => projectMatches(value, project))
      if (!match) {
        const known = projects.map((p) => `"${projectLabel(p)}" (${p.canonical})`).join(", ")
        throw new Error(`team query ${action}: unknown project "${value}" — known projects: ${known}`)
      }
      return match.id
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "team",
        description: "Agent-to-agent messaging and session inspection",
      })

      // ------------------------------------------------------------- send
      editor.add({
        name: "send",
        description:
          "Send a message to another agent session. " +
          "The message is delivered to the target model as durable input. " +
          "`mode` selects how: 'queue' (default) delivers after the target finishes its current turn (waking idle sessions); " +
          "'steer' injects at the target's next model call without stopping execution; " +
          "'interrupt' aborts the target's current execution entirely, then delivers and starts a fresh run; " +
          "'park' admits durably without waking the target (delivered on its next run; for context-only messages, not action items).",
        input: {
          type: "object",
          properties: {
            to: {
              type: "string",
              description:
                "Target: a session ID (ses_…), 'parent' (this session's parent), 'siblings' (all other children of this session's parent), or 'children' (all children of this session).",
            },
            text: { type: "string", description: "Message for the receiving model." },
            mode: {
              type: "string",
              enum: ["queue", "steer", "interrupt", "park"],
              description:
                "Delivery mode. 'queue' (default): after the target's current turn ends, waking idle sessions — " +
                "use for anything the target should act on next. " +
                "'steer': at the target's next model call, without stopping execution — " +
                "use for mid-run course corrections that shouldn't discard in-flight work. " +
                "'interrupt': abort the target's run first; the message starts a fresh run — " +
                "use when its current work is wrong or obsolete ('stop what you're doing'). " +
                "'park': admit durably but do not wake the target; delivered only if it runs again later — " +
                "use for FYI context, findings, or notes it should see IF it resumes, never for action items.",
            },
            project: {
              type: "string",
              description: "The target's project, if it is in another project.",
            },
          },
          required: ["to", "text"],
          additionalProperties: false,
        },
        options: { namespace: "team", permission: "team_send", codemode: true },
        execute: async (raw, context) => {
          const { to, text, mode, project } = raw as {
            to: string
            text: string
            mode?: "queue" | "steer" | "interrupt" | "park"
            project?: string
          }
          if (to === context.sessionID) {
            throw new Error("team send: refuses your own session; just reply in turn")
          }

          const self = await ctx.session.get({ sessionID: context.sessionID })
          // Role addressing: a child always knows its parent; siblings share
          // that parent. Raw ses_… IDs pass through unchanged. 'children' is
          // the parent broadcast. Resolved targets still pass the project
          // check in the delivery loop below.
          let targets: string[]
          if (to === "parent") {
            if (!self.parentID) throw new Error("team send: this session has no parent")
            targets = [self.parentID]
          } else if (to === "siblings") {
            if (!self.parentID) throw new Error("team send: this session has no parent, so no siblings")
            const { data } = await (await api()).session.list({
              parentID: self.parentID,
              project: projectID,
              limit: 100,
            })
            targets = data.filter((session) => session.id !== context.sessionID).map((session) => session.id)
          } else if (to === "children") {
            // Exclude none: children of this session can never include itself.
            const { data } = await (await api()).session.list({
              parentID: context.sessionID,
              project: projectID,
              limit: 100,
            })
            targets = data.map((session) => session.id)
          } else {
            targets = [to]
          }

          const delivered: string[] = []
          for (const targetID of targets) {
            const target = await ctx.session.get({ sessionID: targetID })
            // Messaging is project-trapped by policy; the API itself is
            // not. `project` is both the cross-project opt-in and an
            // assertion about the target — role targets resolve inside
            // this project, so only a since-moved parent or a wrong value
            // can trip this.
            await checkProjectScope("team send", "to message across projects", target, project)

            if (mode === "interrupt") {
              // Aborts the running execution (resume: false = do not restart it).
              // The queued message below then schedules a fresh run.
              await ctx.session.interrupt({ sessionID: targetID, resume: false })
            }

            await ctx.session.synthetic({
              sessionID: targetID,
              ...agentMessage(self, text),
              delivery: mode === "steer" ? "steer" : "queue",
              // Park admits durably without scheduling a run.
              resume: mode === "park" ? false : undefined,
            })
            delivered.push(target.title || targetID)
          }

          const label = {
            queue: "queued",
            steer: "steer",
            interrupt: "interrupted+queued",
            park: "parked",
          }[mode ?? "queue"]
          return { content: `delivered (${label}) to: ${delivered.join(", ") || "(no targets)"}` }
        },
      })

      // ------------------------------------------------------------ query
      editor.add({
        name: "query",
        description:
          "Inspect, search, and monitor sibling/child and other sessions. Actions: " +
          "inbox (list a session's pending inbox items; `inboxID` cancels one, 'all' cancels every pending item), " +
          "list (sessions: children by default, `parent` for siblings, `search` filters by title; with `sessionID`, " +
          "that session's messages — compact triage previews with message IDs, oldest-first, `cursor` pages back via `next`), " +
          "read (one message in full: `sessionID` + `messageID` from a list row; list previews are truncated to ~200 chars), " +
          "status (whether a session is running or blocked on a permission ask or form; omit sessionID for all running in the scoped project), " +
          "wait (block until the given session goes idle, bounded by `timeout` seconds).",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["inbox", "list", "read", "status", "wait"] },
            sessionID: {
              type: "string",
              description:
                "inbox/read/list/status/wait: target session ID (defaults to this session for inbox). " +
                "list with sessionID returns that session's messages.",
            },
            messageID: {
              type: "string",
              description: "read: the message ID to fetch in full (from a list response row).",
            },
            parent: {
              type: "string",
              description:
                "list: 'my' (default — this session's children), 'parent' (siblings), 'all' (recent sessions), or a session ID.",
            },
            search: { type: "string", description: "list: title search filter." },
            project: {
              type: "string",
              description: "Sessions in another project (by id, name, or path); defaults to this project.",
            },
            limit: {
              type: "integer",
              description: "list: max results (default 20). With sessionID: the last N messages.",
            },
            inboxID: {
              type: "string",
              description:
                "inbox: cancel this pending inbox item instead of listing ('all' cancels every pending item).",
            },
            cursor: {
              type: "string",
              description:
                "list: paging cursor from a previous response's `next` (older history), when listing a session's messages.",
            },
            timeout: {
              type: "integer",
              description: "wait: max seconds to wait before giving up (default 300).",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        // Distinct permission key from team_send so config can gate them
        // independently (e.g. read-only subagents).
        options: { namespace: "team", permission: "team_query", codemode: true },
        execute: async (raw, context) => {
          const input = raw as {
            action: "inbox" | "list" | "read" | "status" | "wait"
            sessionID?: string
            messageID?: string
            parent?: string
            search?: string
            project?: string
            limit?: number
            inboxID?: string
            cursor?: string
            timeout?: number
          }
          const client = await api()

          if (input.action === "inbox") {
            // Self-cleanup is the common case, so default to the caller.
            const targetID = input.sessionID ?? context.sessionID
            await scopedSession("inbox", targetID, input.project)
            const items = await client.session.inbox.list({ sessionID: targetID })
            const cancelled: string[] = []
            if (input.inboxID === "all") {
              for (const item of items) {
                await client.session.inbox.cancel({ sessionID: targetID, inboxID: item.id })
                cancelled.push(item.id)
              }
            } else if (input.inboxID) {
              await client.session.inbox.cancel({ sessionID: targetID, inboxID: input.inboxID })
              cancelled.push(input.inboxID)
            }
            // Re-list after cancelling so the caller sees the cleaned slate.
            const pending = cancelled.length > 0 ? await client.session.inbox.list({ sessionID: targetID }) : items
            return {
              content: JSON.stringify({
                session: targetID,
                cancelled,
                pending: pending.map((item) => ({
                  id: item.id,
                  type: item.type,
                  delivery: item.delivery,
                  ...inboxFacts(item),
                })),
              }),
            }
          }

          if (input.action === "list") {
            // With a sessionID, list that session's messages: triage
            // previews plus message IDs, for follow-up full reads.
            if (input.sessionID) {
              await scopedSession("list", input.sessionID, input.project)
              // The API rejects `cursor` combined with `order`: the cursor
              // already encodes order and direction. Take the pinned tail
              // (desc) for a fresh list and follow the cursor when paging.
              const { data, cursor } = await client.message.list({
                sessionID: input.sessionID,
                limit: input.limit ?? DEFAULT_LIMIT,
                ...(input.cursor ? { cursor: input.cursor } : { order: "desc" }),
              })
              // Oldest-first for readability.
              const messages = data
                .map((message) => previewRow(message))
                .filter((row): row is NonNullable<typeof row> => row != null)
                .reverse()
              return {
                content: JSON.stringify({
                  session: input.sessionID,
                  messages,
                  // Opaque cursor for the next (older) page, when history remains.
                  next: cursor?.next ?? null,
                }),
              }
            }
            // Scope relative to the calling session: "my" children, "parent"
            // siblings, "all" recent sessions of the (chosen) project, or an
            // explicit session ID as parent.
            let parentID: string | undefined = context.sessionID
            if (input.parent === "all") {
              parentID = undefined
            } else if (input.parent === "parent") {
              const self = await ctx.session.get({ sessionID: context.sessionID })
              // A root session has no siblings; fail instead of silently
              // widening the scope to every session in the project.
              if (!self.parentID) throw new Error("team query list: this session has no parent")
              parentID = self.parentID
            } else if (input.parent && input.parent !== "my") {
              parentID = input.parent
            }

            const { data } = await client.session.list({
              parentID,
              search: input.search,
              // Default scope: this project. The `project` input opts out.
              project: await resolveScope("list", input.project),
              limit: input.limit ?? DEFAULT_LIMIT,
              order: "desc",
            })
            const running = await client.session.active()
            const blocked = await blockedMap(client)
            const rows = data.map((session) => ({
              id: session.id,
              title: session.title,
              parent: session.parentID ?? null,
              agent: session.agent,
              running: session.id in running,
              blocked: blocked.get(session.id) ?? null,
              updated: session.time.updated,
            }))
            return { content: JSON.stringify(rows) }
          }

          if (input.action === "read") {
            if (!input.sessionID || !input.messageID) {
              throw new Error("team query read: sessionID and messageID are required")
            }
            await scopedSession("read", input.sessionID, input.project)
            // The promise client lacks message.get; fetch the message raw
            // from the same loopback endpoint the client was built from.
            const { endpoint } = await connect()
            const response = await fetch(
              `${endpoint.url}/api/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
              { headers: Service.headers(endpoint) },
            )
            if (!response.ok) {
              const why = response.status === 404 ? "message not found" : `HTTP ${response.status}`
              throw new Error(`team query read: ${why} (${input.messageID} in ${input.sessionID})`)
            }
            const message = (await response.json()) as SessionMessageInfo
            return {
              content: JSON.stringify({ session: input.sessionID, message: fullRow(message) }),
            }
          }

          if (input.action === "wait") {
            if (!input.sessionID) throw new Error("team query wait: sessionID is required")
            // Waiting on yourself would deadlock the calling turn.
            if (input.sessionID === context.sessionID) {
              throw new Error("team query wait: cannot wait on your own session")
            }
            await scopedSession("wait", input.sessionID, input.project)
            // The wait API has no timeout of its own; race one so a stuck
            // target cannot hold the caller's turn hostage.
            const timeoutMs = (input.timeout ?? DEFAULT_WAIT_S) * 1000
            let timer: ReturnType<typeof setTimeout> | undefined
            const timeout = new Promise<"timeout">((resolve) => {
              timer = setTimeout(() => resolve("timeout"), timeoutMs)
            })
            const status = await Promise.race([
              ctx.session.wait({ sessionID: input.sessionID }).then(() => "idle" as const),
              timeout,
            ])
            if (timer) clearTimeout(timer)
            return { content: JSON.stringify({ session: input.sessionID, status }) }
          }

          // status
          if (input.sessionID) {
            const target = await scopedSession("status", input.sessionID, input.project)
            const [running, blocked] = await Promise.all([client.session.active(), blockedMap(client)])
            return {
              content: JSON.stringify({
                id: target.id,
                title: target.title,
                agent: target.agent,
                running: input.sessionID in running,
                blocked: blocked.get(target.id) ?? null,
              }),
            }
          }
          const { data } = await client.session.list({
            project: await resolveScope("status", input.project),
            limit: 100,
          })
          const [running, blocked] = await Promise.all([client.session.active(), blockedMap(client)])
          const rows = data
            .filter((session) => session.id in running)
            .map((session) => ({
              id: session.id,
              title: session.title,
              agent: session.agent,
              blocked: blocked.get(session.id) ?? null,
            }))
          return { content: JSON.stringify(rows) }
        },
      })
    })

    // Agent-to-agent protocol, injected system-side on every agent-loop model
    // call. Synthetic messages reach the model as plain user turns (the wire
    // format requires a user-role final message and carries no marker), so
    // this line plus the in-text "[agent-message from …]" frame added at send
    // time are what tells agents the message is not from the human.
    await ctx.session.hook("context", (event) => {
      event.system.push({
        type: "text",
        text:
          `Agent-to-agent messaging is active (team plugin). Your session ID is ${event.sessionID}. ` +
          `A user turn starting "[agent-message from ses_…]" is a durable message from another AI agent session, not the human user. ` +
          `Treat the sender as a coordinating peer: honor its requests at natural boundaries and, if needed, reply with team_send (to: the sender's ID).`,
      })
    })
  },
})
