// Hermetic tests for the `project` opt-in and the list/read split: value
// matching, refusal messages, scope resolution, cross-project send, triage
// previews, and singular full-message reads. The plugin's module imports are
// mocked, so these run the real index.ts wiring (ctx + loopback API) against
// synthetic cross-project fixtures. Full reads fetch the raw loopback
// endpoint, so a tiny Bun.serve stands in for the opencode server.
import { afterAll, describe, expect, mock, test } from "bun:test"

const CURRENT = {
  id: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
  canonical: "/srv/repos/opencode-team-plugin",
}
const OTHER = {
  id: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
  canonical: "/srv/work/acme-api",
}
const NAMED = { id: "cccc3333cccc3333cccc3333cccc3333cccc3333", canonical: "/srv/named-project-dir" }
const UNREGISTERED = { id: "dddd4444dddd4444dddd4444dddd4444dddd4444", canonical: "/srv/unregistered" }

const SELF_ID = "ses_self"
const TARGET_ID = "ses_target_in_other_project"

// Must stay in registry order: the unknown-project refusal lists these.
const REGISTRY = [
  { id: CURRENT.id, canonical: CURRENT.canonical },
  { id: OTHER.id, canonical: OTHER.canonical },
  { id: NAMED.id, canonical: NAMED.canonical, name: "named-project" },
]

const session = (id: string, project: { id: string; canonical: string }, title?: string) => ({
  id,
  projectID: project.id,
  location: { directory: project.canonical },
  title,
  time: { created: 0, updated: 0 },
})

const SESSIONS: Record<string, ReturnType<typeof session>> = {
  [SELF_ID]: session(SELF_ID, CURRENT, "self"),
  [TARGET_ID]: session(TARGET_ID, OTHER, "Rewriting the metrics pipeline"),
  ses_sibling: session("ses_sibling", CURRENT, "same-project sibling"),
  ses_named: session("ses_named", NAMED),
  ses_unregistered: session("ses_unregistered", UNREGISTERED),
  ses_child: session("ses_child", CURRENT, "a child"),
}

// --- fixtures for list (triage previews) -----------------------------------

const REVIEW_TEXT =
  "Review of the team plugin. The scoping policy is enforced in the plugin rather than the server, " +
  "which means the raw HTTP API remains unscoped and refusals are the only guardrail for callers " +
  "bypassing the tools. Delivery rides the session inbox as durable synthetic input."
const MESSAGES_ASC = [
  { id: "msg_1", type: "user", text: "Review the team plugin and report issues." },
  {
    id: "msg_2",
    type: "assistant",
    agent: "reviewer",
    content: [
      { type: "tool", name: "read" },
      { type: "tool", name: "read" },
      { type: "tool", name: "grep" },
      { type: "text", text: REVIEW_TEXT },
    ],
  },
]
// The API returns newest-first; the plugin reverses to oldest-first.
const messageList = mock(async () => ({ data: [...MESSAGES_ASC].reverse(), cursor: undefined }))

// --- fixture server for read (singular, full text) --------------------------
// The raw loopback route is GET /api/session/{sid}/message/{mid}.

const FULL_TEXT = "## Review\n\n1. Scoping lives in the plugin.\n2. Refusals name the retry value.\n"
const messageServer = Bun.serve({
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/session/ses_sibling/message/msg_full") {
      return Response.json({
        id: "msg_full",
        type: "assistant",
        agent: "reviewer",
        content: [{ type: "text", text: FULL_TEXT }],
      })
    }
    return new Response("not found", { status: 404 })
  },
})
afterAll(() => messageServer.stop(true))

// --- inbox fixtures ----------------------------------------------------------

let inboxItems: unknown[] = []

const synthetic = mock(async () => {})
const sessionList = mock(async (input?: { parentID?: string }) => ({
  data: input?.parentID === SELF_ID ? [SESSIONS.ses_child] : [],
}))

const fakeClient = {
  project: { list: async () => REGISTRY },
  session: {
    list: sessionList,
    active: async () => ({} as Record<string, never>),
    inbox: { list: async () => inboxItems, cancel: async () => {} },
  },
  message: { list: messageList },
  permission: { request: { list: async () => ({ data: [] }) } },
  form: { list: async () => ({ data: [] }) },
}

mock.module("@opencode/client", () => ({ OpenCode: { make: async () => fakeClient } }))
mock.module("@opencode/client/service", () => ({
  Service: { discover: async () => ({ url: messageServer.url }), headers: () => ({}) },
}))
mock.module("@opencode/plugin", () => ({ Plugin: { define: (p: unknown) => p } }))

const tools: any[] = []
await (
  await import("./index.ts")
).default.setup({
  location: { project: { id: CURRENT.id } },
  session: {
    get: async ({ sessionID }: { sessionID: string }) => {
      const target = SESSIONS[sessionID]
      if (!target) throw new Error(`no such session: ${sessionID}`)
      return target
    },
    synthetic,
    interrupt: async () => {},
    wait: async () => {},
    hook: () => {},
  },
  tool: {
    transform: async (cb: (editor: unknown) => void) =>
      cb({
        namespace: () => {},
        add: (tool: unknown) => tools.push(tool),
      }),
  },
} as any)

const send = tools.find((tool) => tool.name === "send")!
const query = tools.find((tool) => tool.name === "query")!
const self = { sessionID: SELF_ID }

/** Execute and require a refusal with exactly this message. */
async function expectRefusal(promise: Promise<unknown>, expected: string) {
  let message = "(no error)"
  try {
    await promise
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).toBe(expected)
}

const OTHER_WHERE = `acme-api (${OTHER.canonical})`
const LIST_MISSING =
  `team query list: "${TARGET_ID}" ("Rewriting the metrics pipeline") is the agent in ${OTHER_WHERE} — ` +
  `did you mean the agent in acme-api? pass project: "acme-api" to read across projects`
const LIST_WRONG =
  `team query list: project "other-repo" doesn't match — "${TARGET_ID}" is the agent in ${OTHER_WHERE}. ` +
  `did you mean the agent in acme-api? pass project: "acme-api"`
const SEND_MISSING =
  `team send: "${TARGET_ID}" ("Rewriting the metrics pipeline") is the agent in ${OTHER_WHERE} — ` +
  `did you mean the agent in acme-api? pass project: "acme-api" to message across projects`
const SEND_WRONG =
  `team send: project "other-repo" doesn't match — "${TARGET_ID}" is the agent in ${OTHER_WHERE}. ` +
  `did you mean the agent in acme-api? pass project: "acme-api"`

describe("query list (session messages, triage)", () => {
  test("rows carry ids, kinds, ~200-char previews, and a tool-call summary, oldest-first", async () => {
    const out = await query.execute({ action: "list", sessionID: "ses_sibling" }, self)
    const parsed = JSON.parse(out.content)
    expect(parsed.session).toBe("ses_sibling")
    expect(parsed.next).toBeNull()
    expect(parsed.messages.map((row: any) => row.id)).toEqual(["msg_1", "msg_2"])
    const [user, assistant] = parsed.messages
    expect(user.kind).toBe("user")
    expect(user.preview).toBe("Review the team plugin and report issues.")
    expect(assistant.kind).toBe("assistant")
    expect(assistant.agent).toBe("reviewer")
    // 200-char head + the ellipsis.
    expect(assistant.preview.length).toBe(201)
    expect(assistant.preview.endsWith("…")).toBe(true)
    expect(assistant.tools).toBe("3 tool calls: read×2, grep")
  })

  test("fresh lists pin the tail (desc) and default the limit", async () => {
    messageList.mockClear()
    await query.execute({ action: "list", sessionID: "ses_sibling" }, self)
    expect(messageList).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "ses_sibling", order: "desc", limit: 20 }),
    )
  })

  test("cross-project list refuses with a did-you-mean when project is absent", async () => {
    await expectRefusal(query.execute({ action: "list", sessionID: TARGET_ID }, self), LIST_MISSING)
  })

  test("wrong project value refuses even though project was passed", async () => {
    await expectRefusal(
      query.execute({ action: "list", sessionID: TARGET_ID, project: "other-repo" }, self),
      LIST_WRONG,
    )
  })

  test("matching values succeed: name, basename, path, case, raw id", async () => {
    for (const project of ["acme-api", "ACME-API", OTHER.canonical, "/srv/work/Acme-Api", OTHER.id]) {
      const out = await query.execute({ action: "list", sessionID: TARGET_ID, project }, self)
      expect(JSON.parse(out.content).session).toBe(TARGET_ID)
    }
  })

  test("same-project list without project still works", async () => {
    const out = await query.execute({ action: "list", sessionID: "ses_sibling" }, self)
    expect(JSON.parse(out.content).session).toBe("ses_sibling")
  })

  test("same-project list with a wrong project value refuses, not silently ignored", async () => {
    await expectRefusal(
      query.execute({ action: "list", sessionID: "ses_sibling", project: "acme-api" }, self),
      `team query list: project "acme-api" doesn't match — "ses_sibling" is the agent in opencode-team-plugin (${CURRENT.canonical}). ` +
        `did you mean the agent in opencode-team-plugin? pass project: "opencode-team-plugin"`,
    )
  })

  test("named project: label and matching use the registered name", async () => {
    await expectRefusal(
      query.execute({ action: "list", sessionID: "ses_named" }, self),
      `team query list: "ses_named" is the agent in named-project (${NAMED.canonical}) — ` +
        `did you mean the agent in named-project? pass project: "named-project" to read across projects`,
    )
    await query.execute({ action: "list", sessionID: "ses_named", project: "named-project" }, self)
    // The directory basename matches even when a name is registered.
    await query.execute({ action: "list", sessionID: "ses_named", project: "named-project-dir" }, self)
  })

  test("unregistered project falls back to the session's own facts", async () => {
    await query.execute({ action: "list", sessionID: "ses_unregistered", project: UNREGISTERED.canonical }, self)
    await expectRefusal(
      query.execute({ action: "list", sessionID: "ses_unregistered" }, self),
      `team query list: "ses_unregistered" is the agent in unregistered (${UNREGISTERED.canonical}) — ` +
        `did you mean the agent in unregistered? pass project: "unregistered" to read across projects`,
    )
  })
})

describe("query read (singular, full text)", () => {
  test("returns the complete message, whitespace preserved", async () => {
    const out = await query.execute({ action: "read", sessionID: "ses_sibling", messageID: "msg_full" }, self)
    const parsed = JSON.parse(out.content)
    expect(parsed.session).toBe("ses_sibling")
    expect(parsed.message.id).toBe("msg_full")
    expect(parsed.message.kind).toBe("assistant")
    expect(parsed.message.agent).toBe("reviewer")
    expect(parsed.message.text).toBe(FULL_TEXT)
    expect(parsed.message.truncated).toBeUndefined()
  })

  test("a missing message names the session and message", async () => {
    await expectRefusal(
      query.execute({ action: "read", sessionID: "ses_sibling", messageID: "msg_nope" }, self),
      "team query read: message not found (msg_nope in ses_sibling)",
    )
  })

  test("sessionID and messageID are both required", async () => {
    await expectRefusal(
      query.execute({ action: "read", sessionID: "ses_sibling" }, self),
      "team query read: sessionID and messageID are required",
    )
    await expectRefusal(
      query.execute({ action: "read", messageID: "msg_full" }, self),
      "team query read: sessionID and messageID are required",
    )
  })

  test("cross-project read refuses with a did-you-mean", async () => {
    await expectRefusal(
      query.execute({ action: "read", sessionID: TARGET_ID, messageID: "msg_full" }, self),
      LIST_MISSING.replace("team query list", "team query read"),
    )
  })
})

describe("query inbox", () => {
  test("payloads render in full, uncapped", async () => {
    const mail = "pending task: ".repeat(500) // 7000 chars
    inboxItems = [{ id: "inb_1", type: "synthetic", delivery: "queue", payload: { text: mail } }]
    const out = await query.execute({ action: "inbox" }, self)
    const row = JSON.parse(out.content).pending[0]
    expect(row.text).toBe(mail)
    expect(row.truncated).toBeUndefined()
    expect(row.from).toBeUndefined()
    inboxItems = []
  })

  test("inbox and status take the same opt-in path", async () => {
    const inbox = await query.execute({ action: "inbox", sessionID: TARGET_ID, project: "acme-api" }, self)
    expect(JSON.parse(inbox.content).session).toBe(TARGET_ID)
    const status = await query.execute({ action: "status", sessionID: TARGET_ID, project: "acme-api" }, self)
    expect(JSON.parse(status.content).id).toBe(TARGET_ID)
    await expectRefusal(
      query.execute({ action: "status", sessionID: TARGET_ID }, self),
      LIST_MISSING.replace("team query list", "team query status"),
    )
  })
})

describe("query list / status-all (scope selection)", () => {
  test("project resolves by name to the registry id", async () => {
    await query.execute({ action: "list", project: "acme-api" }, self)
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({ project: OTHER.id }))
  })

  test("unknown project refuses listing the known labels", async () => {
    await expectRefusal(
      query.execute({ action: "list", project: "nosuch" }, self),
      `team query list: unknown project "nosuch" — known projects: ` +
        `"opencode-team-plugin" (${CURRENT.canonical}), "acme-api" (${OTHER.canonical}), "named-project" (${NAMED.canonical})`,
    )
  })

  test("status without sessionID resolves the scope the same way", async () => {
    await query.execute({ action: "status", project: OTHER.id }, self)
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({ project: OTHER.id }))
  })

  test("absent project keeps the current-project default", async () => {
    await query.execute({ action: "list" }, self)
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({ project: CURRENT.id }))
  })
})

describe("send", () => {
  test("cross-project send with matching project delivers the unchanged wire frame", async () => {
    synthetic.mockReset()
    const out = await send.execute({ to: TARGET_ID, text: "ping", project: "acme-api" }, self)
    expect(synthetic).toHaveBeenCalledTimes(1)
    expect(synthetic).toHaveBeenCalledWith({
      sessionID: TARGET_ID,
      text: `[agent-message from ${SELF_ID}]\nping`,
      delivery: "queue",
      resume: undefined,
      metadata: { from: SELF_ID },
    })
    expect(out.content).toBe('delivered (queued) to: Rewriting the metrics pipeline')
  })

  test("cross-project send without project refuses with the did-you-mean", async () => {
    synthetic.mockReset()
    await expectRefusal(send.execute({ to: TARGET_ID, text: "ping" }, self), SEND_MISSING)
    expect(synthetic).not.toHaveBeenCalled()
  })

  test("wrong project value refuses", async () => {
    await expectRefusal(send.execute({ to: TARGET_ID, text: "ping", project: "other-repo" }, self), SEND_WRONG)
  })

  test("same-project send without project still works", async () => {
    synthetic.mockReset()
    const out = await send.execute({ to: "ses_sibling", text: "ping" }, self)
    expect(synthetic).toHaveBeenCalledTimes(1)
    expect(out.content).toBe('delivered (queued) to: same-project sibling')
  })

  test("role targets verify too: children refuse a value naming another project", async () => {
    synthetic.mockReset()
    await expectRefusal(
      send.execute({ to: "children", text: "ping", project: "acme-api" }, self),
      `team send: project "acme-api" doesn't match — "ses_child" is the agent in opencode-team-plugin (${CURRENT.canonical}). ` +
        `did you mean the agent in opencode-team-plugin? pass project: "opencode-team-plugin"`,
    )
    expect(synthetic).not.toHaveBeenCalled()
    // Matching value (or none) delivers to the whole child set.
    await send.execute({ to: "children", text: "ping", project: "opencode-team-plugin" }, self)
    await send.execute({ to: "children", text: "ping" }, self)
    expect(synthetic).toHaveBeenCalledTimes(2)
  })
})

describe("tool surface stability", () => {
  test("schemas and options are unchanged apart from the new string input", () => {
    for (const tool of [send, query]) {
      expect(tool.input.additionalProperties).toBe(false)
      expect(tool.input.properties.project.type).toBe("string")
    }
    expect(send.input.required).toEqual(["to", "text"])
    expect(query.input.required).toEqual(["action"])
    expect(send.options).toEqual({ namespace: "team", permission: "team_send", codemode: true })
    expect(query.options).toEqual({ namespace: "team", permission: "team_query", codemode: true })
  })
})
