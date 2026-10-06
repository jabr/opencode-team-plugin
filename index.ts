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
// `project` opts into others.
//
// Delivery rides the session inbox as durable synthetic user input; the
// event stream is deliberately unused (volatile: missed on disconnect).
// There is no polling loop — agents that want replies read their own history
// via `team_query read`, optionally after `team_query wait`.
import { Plugin } from "@opencode/plugin"
import {
  OpenCode,
  type OpenCodeClient,
  type SessionInboxInfo,
  type SessionMessageInfo,
} from "@opencode/client"
import { Service } from "@opencode/client/service"

// Keep tool output compact — message text is truncated per block.
const MAX_TEXT = 500
const DEFAULT_LIMIT = 20
// `wait` bounds: the wait API has no timeout parameter of its own.
const DEFAULT_WAIT_S = 300

function truncate(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Full API client (loopback to the service this plugin runs inside).
 * The plugin ctx's session domain is a Pick<> without `list`/`active`,
 * so discovery is used instead of relying on undocumented ctx internals.
 */
let loopback: Promise<OpenCodeClient> | null = null

function api(): Promise<OpenCodeClient> {
  loopback ??= (async () => {
    const endpoint = await Service.discover()
    if (!endpoint) throw new Error("team: no healthy opencode service found")
    return OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
    })
  })()
  // If discovery/connection failed once, allow a fresh attempt next call.
  loopback.catch(() => {
    loopback = null
  })
  return loopback
}

/**
 * Compact renderer for a session message; `null` skips low-signal noise.
 * Synthetic messages are expected to carry the in-text
 * "[agent-message from …]" frame added at send time; unframed ones (older
 * history, other producers) render as bare text with no provenance.
 */
function describe(message: SessionMessageInfo): string | null {
  switch (message.type) {
    case "user":
      return `user: ${truncate(message.text)}`
    case "synthetic":
      return truncate(message.text)
    case "assistant": {
      const parts = message.content
        .map((part) => {
          if (part.type === "text" && part.text) return truncate(part.text)
          return part.type === "tool" ? `[tool:${part.name}]` : null
        })
        .filter((part): part is string => part != null)
      return `assistant${message.agent ? `(${message.agent})` : ""}: ${parts.join(" ")}`
    }
    case "system":
      return message.text ? `system: ${truncate(message.text)}` : "system"
    case "idle":
      return null
    default:
      return `${message.type}`
  }
}

/** The human bits of a pending inbox item, for compact listings. */
function inboxFacts(item: SessionInboxInfo): { text?: string; from?: string } {
  // Only user/synthetic payloads carry text and metadata; other kinds are
  // structured controls with nothing to quote.
  const payload = item.payload as { text?: string; metadata?: Record<string, unknown> }
  return {
    text: payload.text ? truncate(payload.text) : undefined,
    from: payload.metadata?.from !== undefined ? String(payload.metadata.from) : undefined,
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

    // Project scope for query reads: refuse sessions outside it (the API
    // itself is not project-trapped; this is plugin policy). Returns the
    // fetched session so callers can reuse it.
    const scopedSession = async (action: string, sessionID: string, scope: string) => {
      const target = await ctx.session.get({ sessionID })
      if (target.projectID !== scope) {
        throw new Error(
          `team query ${action}: refused — "${sessionID}" is not in project "${scope}" (pass \`project\` to opt in)`,
        )
      }
      return target
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
          "Send a message to another agent session in this project. " +
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
          },
          required: ["to", "text"],
          additionalProperties: false,
        },
        options: { namespace: "team", permission: "team_send", codemode: true },
        execute: async (raw, context) => {
          const { to, text, mode } = raw as {
            to: string
            text: string
            mode?: "queue" | "steer" | "interrupt" | "park"
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
            if (target.projectID !== projectID) {
              // Messaging is project-trapped by policy. The API itself is not.
              throw new Error(`team send: refused — "${targetID}" belongs to a different project`)
            }

            if (mode === "interrupt") {
              // Aborts the running execution (resume: false = do not restart it).
              // The queued message below then schedules a fresh run.
              await ctx.session.interrupt({ sessionID: targetID, resume: false })
            }

            await ctx.session.synthetic({
              sessionID: targetID,
              // The wire format delivers this as a plain user turn, so
              // provenance must ride IN the text (see the context hook below).
              text: `[agent-message from ${context.sessionID}]\n${text}`,
              delivery: mode === "steer" ? "steer" : "queue",
              // Park admits durably without scheduling a run.
              resume: mode === "park" ? false : undefined,
              // Sender attribution: the receiver can reply without discovery.
              metadata: { from: context.sessionID },
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
          "Inspect, search, and monitor sibling/child sessions. Actions: " +
          "inbox (list a session's pending inbox items; `inboxID` cancels one, 'all' cancels every pending item), " +
          "list (find sessions; children by default, `parent` for siblings, `search` filters by title), " +
          "read (tail a session's messages, `cursor` pages further back and the response returns `next`), " +
          "status (whether a session is running or blocked on a permission ask or form; omit sessionID for all running in the scoped project), " +
          "wait (block until the given session goes idle, bounded by `timeout` seconds).",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["inbox", "list", "read", "status", "wait"] },
            sessionID: {
              type: "string",
              description: "inbox/read/status/wait: target session ID (defaults to this session for inbox).",
            },
            parent: {
              type: "string",
              description:
                "list: 'my' (default — this session's children), 'parent' (siblings), 'all' (recent sessions), or a session ID.",
            },
            search: { type: "string", description: "list: title search filter." },
            project: {
              type: "string",
              description:
                "inbox/list/read/status/wait: project ID to read another project's sessions (opt-in; defaults to this project).",
            },
            limit: {
              type: "integer",
              description: "list/read: max results (default 20). read returns the last N messages.",
            },
            inboxID: {
              type: "string",
              description:
                "inbox: cancel this pending inbox item instead of listing ('all' cancels every pending item).",
            },
            cursor: {
              type: "string",
              description: "read: paging cursor from a previous response's `next` (older history).",
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
            await scopedSession("inbox", targetID, input.project ?? projectID)
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
              project: input.project ?? projectID,
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
            if (!input.sessionID) throw new Error("team query read: sessionID is required")
            await scopedSession("read", input.sessionID, input.project ?? projectID)
            // The API rejects `cursor` combined with `order`: the cursor
            // already encodes order and direction. Take the pinned tail
            // (desc) for a fresh read and follow the cursor when paging.
            const { data, cursor } = await client.message.list({
              sessionID: input.sessionID,
              limit: input.limit ?? DEFAULT_LIMIT,
              ...(input.cursor ? { cursor: input.cursor } : { order: "desc" }),
            })
            // Oldest-first for readability.
            const lines = data
              .map((message) => describe(message))
              .filter((line): line is string => line != null)
              .reverse()
            return {
              content: JSON.stringify({
                session: input.sessionID,
                messages: lines,
                // Opaque cursor for the next (older) page, when history remains.
                next: cursor?.next ?? null,
              }),
            }
          }

          if (input.action === "wait") {
            if (!input.sessionID) throw new Error("team query wait: sessionID is required")
            // Waiting on yourself would deadlock the calling turn.
            if (input.sessionID === context.sessionID) {
              throw new Error("team query wait: cannot wait on your own session")
            }
            await scopedSession("wait", input.sessionID, input.project ?? projectID)
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
            const target = await scopedSession("status", input.sessionID, input.project ?? projectID)
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
            project: input.project ?? projectID,
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
