import { test, mock } from "node:test"
import assert from "node:assert/strict"
import type { OpenCodeClient, SessionCreateInput, SessionSyntheticInput } from "@opencode/client"
import plugin from "./index.ts"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { checkoutSource, spawnPermissions, spawnSession } from "./spawn.ts"

const allow = { action: "*", resource: "*", effect: "allow" as const }

function fixture(options: { waitFails?: boolean; sessionReadFailures?: number } = {}) {
  const self = { id: "ses_caller", title: "Creator session" as string | undefined, projectID: "caller-project", location: { directory: "/checkout/subdir" }, permissions: [] }
  let created: SessionCreateInput | undefined
  let synthetic: SessionSyntheticInput | undefined
  let worktreeInput: unknown
  let fail: "worktree" | "session" | "task" | undefined
  let moved = false
  let sessionReadFailures = options.sessionReadFailures ?? 0
  const child = { ...self, id: "ses_new" }
  const client = {
    agent: { get: async () => ({ data: { permissions: [allow, { action: "edit", resource: "*", effect: "deny" }] } }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID === self.id) return self
        if (sessionReadFailures-- > 0) throw new Error("session read failed")
        return child
      },
      create: async (input: SessionCreateInput) => {
        if (fail === "session") throw new Error("session failed")
        created = input
        child.location = input.parentID ? self.location : { directory: input.location!.directory }
        return child
      },
      synthetic: async (input: SessionSyntheticInput) => {
        if (fail === "task") throw new Error("admission failed")
        synthetic = input
        return { id: "msg_admitted" }
      },
      move: async ({ directory }: { directory: string }) => { moved = true; child.location = { directory } },
      wait: async () => { if (options.waitFails) throw new Error("wait failed") },
    },
    worktree: {
      list: async () => [{ directory: "/checkout" }],
      create: async (input: unknown) => {
        worktreeInput = input
        if (fail === "worktree") throw new Error("worktree failed")
        return { directory: "/actual/worktree" }
      },
    },
  }
  return { client: client as unknown as OpenCodeClient, self,
    fail: (value: typeof fail) => { fail = value },
    state: () => ({ created, synthetic, worktreeInput, moved }) }
}

test("root is idle by default, caller-local, with provenance but no parent or copied grants", async () => {
  const f = fixture()
  const result = await spawnSession(f.client, f.self.id, "build", { title: "Independent" })
  assert.equal(result.ok, true)
  assert.equal(result.started, false)
  assert.equal(result.directory, f.self.location.directory)
  const { created, synthetic } = f.state()
  assert.equal(created!.parentID, undefined)
  assert.equal(created!.agent, undefined)
  assert.equal(created!.model, undefined)
  assert.deepEqual(created!.metadata, { "team.spawn": { creatorSessionID: f.self.id, kind: "root" } })
  assert.deepEqual(created!.permissions, [{ action: "edit", resource: "*", effect: "deny" }])
  assert.equal(synthetic, undefined)
})

test("child in new worktree moves before synthetic admission and keeps chosen agent/model", async () => {
  const f = fixture()
  const model = { providerID: "provider", id: "model", variant: "variant" }
  const result = await spawnSession(f.client, f.self.id, "build", {
    title: "Child", kind: "child", agent: "review", model, text: "Task", worktree: { name: "feature" },
  })
  assert.equal(result.ok, true)
  assert.equal(result.directory, "/actual/worktree")
  assert.equal(result.started, true)
  assert.equal(result.inboxID, "msg_admitted")
  const state = f.state()
  assert.equal(state.created!.parentID, f.self.id)
  assert.equal(state.created!.agent, "review")
  assert.deepEqual(state.created!.model, model)
  assert.deepEqual(state.worktreeInput, { projectID: "caller-project", from: "/checkout", name: "feature" })
  assert.equal(state.moved, true)
  assert.deepEqual(state.synthetic, { sessionID: "ses_new", text: "[agent-message from ses_caller]\nTask", description: "Message from Creator session", metadata: { from: f.self.id }, delivery: "queue", resume: true })
})

test("spawn task update falls back to creator ID when its title is missing", async () => {
  const f = fixture()
  f.self.title = undefined
  await spawnSession(f.client, f.self.id, "build", { title: "Recipient", text: "Full initial task" })
  assert.equal(f.state().synthetic!.description, "Message from ses_caller")
  assert.equal(f.state().synthetic!.text, "[agent-message from ses_caller]\nFull initial task")
})

test("root worktree uses actual directory without moving or setting parentage", async () => {
  const f = fixture()
  const result = await spawnSession(f.client, f.self.id, "build", { title: "Root", worktree: {} })
  assert.equal(result.ok, true)
  assert.equal(result.directory, "/actual/worktree")
  assert.equal(f.state().moved, false)
  assert.equal(f.state().created!.parentID, undefined)
})

test("partial failures preserve resource IDs and actual directories", async () => {
  for (const stage of ["worktree", "session", "task"] as const) {
    const f = fixture()
    f.fail(stage)
    const result = await spawnSession(f.client, f.self.id, "build", { title: "Failure", worktree: {}, text: "Task" })
    assert.equal(result.ok, false)
    assert.equal(result.started, false)
    assert.ok("stage" in result && result.stage === stage)
    assert.equal(result.sessionID, stage === "task" ? "ses_new" : undefined)
    assert.equal(result.worktree?.directory, stage === "worktree" ? undefined : "/actual/worktree")
  }
})

for (const failure of ["wait", "read-once", "read-persistent"] as const) {
  test(`directory recovery after a successful move and ${failure} failure`, async () => {
    const f = fixture({
      waitFails: failure === "wait",
      sessionReadFailures: failure === "read-persistent" ? Infinity : failure === "read-once" ? 1 : 0,
    })
    const result = await spawnSession(f.client, f.self.id, "build", {
      title: "Move failure", kind: "child", worktree: {}, text: "Do not admit this task",
    })
    assert.equal(result.ok, false)
    assert.equal(result.stage, "location")
    assert.equal(result.sessionID, "ses_new")
    assert.deepEqual(result.worktree, { directory: "/actual/worktree" })
    assert.equal(result.started, false)
    assert.equal(f.state().moved, true)
    assert.equal(f.state().synthetic, undefined)
    assert.equal(result.error, failure === "wait" ? "wait failed" : "session read failed")
    assert.equal(result.directory, failure === "read-persistent" ? "/checkout/subdir" : "/actual/worktree")
    assert.equal(result.directoryStatus, failure === "read-persistent" ? "last-known" : "refreshed")
    if (failure === "read-persistent") assert.match(result.warning!, /last-known directory is uncertain/)
  })
}

test("blank titles fail before any resource creation", async () => {
  const f = fixture()
  await assert.rejects(spawnSession(f.client, f.self.id, "build", { title: "  ", worktree: {} }), /title/)
  assert.equal(f.state().created, undefined)
  assert.equal(f.state().worktreeInput, undefined)
})

test("permission ceiling never copies grants or relaxes restrictions", () => {
  assert.deepEqual(spawnPermissions([allow]), [])
  assert.deepEqual(spawnPermissions([]), [{ action: "*", resource: "*", effect: "deny" }])
  assert.deepEqual(spawnPermissions([
    allow, { action: "read", resource: "*.env", effect: "ask" },
    { action: "edit", resource: "*", effect: "deny" }, { action: "edit", resource: "*", effect: "allow" },
  ]), [{ action: "read", resource: "*.env", effect: "deny" }, { action: "edit", resource: "*", effect: "deny" }])
})

test("source selection uses inventory and path boundaries, not checkout naming", () => {
  assert.equal(checkoutSource("/repo/nested/src", [{ directory: "/repo" }, { directory: "/repo/nested" }]), "/repo/nested")
  assert.throws(() => checkoutSource("/repo-other/src", [{ directory: "/repo" }]), /inventory/)
})

test("spawn registration has an independent permission and roots are discoverable in the query schema", async () => {
  const tools: any[] = []
  const ctx = {
    location: { project: { id: "wrong-plugin-project" } },
    tool: { transform: async (register: any) => register({ namespace() {}, add(tool: any) { tools.push(tool) } }) },
    session: { hook: async () => {} },
  }
  await plugin.setup(ctx as any)
  const spawn = tools.find((tool) => tool.name === "spawn")
  assert.deepEqual(spawn.options, { namespace: "team", permission: "team_spawn", codemode: true })
  const query = tools.find((tool) => tool.name === "query")
  assert.match(query.input.properties.parent.description, /roots/)
})

test("query roots filters before pagination, derives caller project, and preserves existing defaults/opt-in", async () => {
  const calls: any[] = []
  const session = { id: "ses_result", projectID: "caller-project", title: "Result", location: { directory: "/other-checkout" }, time: { updated: 123 } }
  const client = {
    project: { list: async () => [{ id: "explicit-project", canonical: "/explicit-checkout", name: "Explicit" }] },
    session: {
      list: async () => { throw new Error("Use native ctx.session.list") },
      active: async () => ({}),
    },
    permission: { request: { list: async () => ({ data: [] }) } },
    form: { list: async () => ({ data: [] }) },
  }
  mock.method(Service, "discover", async () => ({ url: "http://localhost:1" }) as any)
  mock.method(Service, "headers", () => ({}))
  mock.getter(OpenCode, "make", () => () => client as any)
  try {
    const tools: any[] = []
    await plugin.setup({
      location: { project: { id: "wrong-plugin-project" } },
      tool: { transform: async (register: any) => register({ namespace() {}, add(tool: any) { tools.push(tool) } }) },
      session: {
        hook: async () => {},
        get: async () => ({ id: "ses_caller", projectID: "caller-project" }),
        list: async (input: any) => { calls.push(input); return { data: [session] } },
      },
    } as any)
    const query = tools.find((tool) => tool.name === "query")
    const out = await query.execute({ action: "list", parent: "roots", search: "Result", limit: 1 }, { sessionID: "ses_caller" })
    assert.deepEqual(calls.at(-1), { parentID: null, search: "Result", archived: false, project: "caller-project", limit: 1, order: "desc" })
    assert.equal(JSON.parse(out.content)[0].directory, "/other-checkout")
    await query.execute({ action: "list" }, { sessionID: "ses_caller" })
    assert.equal(calls.at(-1).parentID, "ses_caller")
    assert.equal(calls.at(-1).archived, undefined)
    await query.execute({ action: "list", parent: "all", project: "explicit-project" }, { sessionID: "ses_caller" })
    assert.equal(calls.at(-1).parentID, undefined)
    assert.equal(calls.at(-1).project, "explicit-project")
    await query.execute({ action: "list", parent: "roots", project: "Explicit" }, { sessionID: "ses_caller" })
    assert.equal(calls.at(-1).project, "explicit-project")
    assert.equal(calls.at(-1).parentID, null)
    assert.equal(calls.at(-1).archived, false)
    await assert.rejects(query.execute({ action: "list", parent: "parent" }, { sessionID: "ses_caller" }), /no parent/)
  } finally {
    mock.restoreAll()
  }
})
