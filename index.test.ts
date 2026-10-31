// Hermetic tests for the `project` opt-in: value matching, refusal
// messages, scope resolution, and cross-project send. The plugin's module
// imports are mocked, so these run the real index.ts wiring (ctx + loopback
// API) against synthetic cross-project fixtures.
import { describe, expect, mock, test } from "bun:test"

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

const synthetic = mock(async () => {})
const sessionList = mock(async (input?: { parentID?: string }) => ({
  data: input?.parentID === SELF_ID ? [SESSIONS.ses_child] : [],
}))

const fakeClient = {
  project: { list: async () => REGISTRY },
  session: {
    list: sessionList,
    active: async () => ({} as Record<string, never>),
    inbox: { list: async () => [], cancel: async () => {} },
  },
  message: { list: async () => ({ data: [], cursor: undefined }) },
  permission: { request: { list: async () => ({ data: [] }) } },
  form: { list: async () => ({ data: [] }) },
}

mock.module("@opencode/client", () => ({ OpenCode: { make: async () => fakeClient } }))
mock.module("@opencode/client/service", () => ({
  Service: { discover: async () => ({ url: "http://127.0.0.1:1" }), headers: () => ({}) },
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
const READ_MISSING =
  `team query read: "${TARGET_ID}" ("Rewriting the metrics pipeline") is the agent in ${OTHER_WHERE} — ` +
  `did you mean the agent in acme-api? pass project: "acme-api" to read across projects`
const READ_WRONG =
  `team query read: project "other-repo" doesn't match — "${TARGET_ID}" is the agent in ${OTHER_WHERE}. ` +
  `did you mean the agent in acme-api? pass project: "acme-api"`
const SEND_MISSING =
  `team send: "${TARGET_ID}" ("Rewriting the metrics pipeline") is the agent in ${OTHER_WHERE} — ` +
  `did you mean the agent in acme-api? pass project: "acme-api" to message across projects`
const SEND_WRONG =
  `team send: project "other-repo" doesn't match — "${TARGET_ID}" is the agent in ${OTHER_WHERE}. ` +
  `did you mean the agent in acme-api? pass project: "acme-api"`

describe("query read (targeted)", () => {
  test("cross-project read refuses with a did-you-mean when project is absent", async () => {
    await expectRefusal(query.execute({ action: "read", sessionID: TARGET_ID }, self), READ_MISSING)
  })

  test("wrong project value refuses even though project was passed", async () => {
    await expectRefusal(
      query.execute({ action: "read", sessionID: TARGET_ID, project: "other-repo" }, self),
      READ_WRONG,
    )
  })

  test("matching values succeed: name, basename, path, case, raw id", async () => {
    for (const project of [
      "acme-api",
      "ACME-API",
      OTHER.canonical,
      "/srv/work/Acme-Api",
      OTHER.id,
    ]) {
      const out = await query.execute({ action: "read", sessionID: TARGET_ID, project }, self)
      expect(JSON.parse(out.content).session).toBe(TARGET_ID)
    }
  })

  test("same-project read without project still works", async () => {
    const out = await query.execute({ action: "read", sessionID: "ses_sibling" }, self)
    expect(JSON.parse(out.content).session).toBe("ses_sibling")
  })

  test("same-project read with a wrong project value refuses, not silently ignored", async () => {
    await expectRefusal(
      query.execute({ action: "read", sessionID: "ses_sibling", project: "acme-api" }, self),
      `team query read: project "acme-api" doesn't match — "ses_sibling" is the agent in opencode-team-plugin (${CURRENT.canonical}). ` +
        `did you mean the agent in opencode-team-plugin? pass project: "opencode-team-plugin"`,
    )
  })

  test("named project: label and matching use the registered name", async () => {
    await expectRefusal(
      query.execute({ action: "read", sessionID: "ses_named" }, self),
      `team query read: "ses_named" is the agent in named-project (${NAMED.canonical}) — ` +
        `did you mean the agent in named-project? pass project: "named-project" to read across projects`,
    )
    await query.execute({ action: "read", sessionID: "ses_named", project: "named-project" }, self)
    // The directory basename matches even when a name is registered.
    await query.execute({ action: "read", sessionID: "ses_named", project: "named-project-dir" }, self)
  })

  test("unregistered project falls back to the session's own facts", async () => {
    await query.execute({ action: "read", sessionID: "ses_unregistered", project: UNREGISTERED.canonical }, self)
    await expectRefusal(
      query.execute({ action: "read", sessionID: "ses_unregistered" }, self),
      `team query read: "ses_unregistered" is the agent in unregistered (${UNREGISTERED.canonical}) — ` +
        `did you mean the agent in unregistered? pass project: "unregistered" to read across projects`,
    )
  })

  test("inbox and status take the same opt-in path", async () => {
    const inbox = await query.execute({ action: "inbox", sessionID: TARGET_ID, project: "acme-api" }, self)
    expect(JSON.parse(inbox.content).session).toBe(TARGET_ID)
    const status = await query.execute({ action: "status", sessionID: TARGET_ID, project: "acme-api" }, self)
    expect(JSON.parse(status.content).id).toBe(TARGET_ID)
    await expectRefusal(query.execute({ action: "status", sessionID: TARGET_ID }, self), READ_MISSING.replace("read", "status"))
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
      description: "Message from self",
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
