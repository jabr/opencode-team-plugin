import { test, mock } from "node:test"
import assert from "node:assert/strict"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import plugin from "./index.ts"

test("family broadcasts and project-wide status use native session listing", async () => {
  const lists: unknown[] = []
  const messages: unknown[] = []
  const target = {
    id: "ses_target", title: "Target", projectID: "caller-project",
    location: { directory: "/checkout" }, time: { updated: 123 },
  }
  const client = {
    session: {
      list: async () => { throw new Error("Use native ctx.session.list") },
      active: async () => ({ ses_target: {} }),
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
        get: async ({ sessionID }: { sessionID: string }) => sessionID === "ses_caller"
          ? { ...target, id: sessionID, parentID: "ses_parent" }
          : target,
        list: async (input: unknown) => { lists.push(input); return { data: [target] } },
        synthetic: async (input: unknown) => { messages.push(input) },
      },
    } as any)
    const send = tools.find((tool) => tool.name === "send")
    for (const to of ["children", "siblings"]) {
      await send.execute({ to, text: "Broadcast" }, { sessionID: "ses_caller" })
    }
    assert.deepEqual(lists, [
      { parentID: "ses_caller", project: "caller-project", limit: 100 },
      { parentID: "ses_parent", project: "caller-project", limit: 100 },
    ])
    assert.equal(messages.length, 2)
    const query = tools.find((tool) => tool.name === "query")
    const result = await query.execute({ action: "status" }, { sessionID: "ses_caller" })
    assert.deepEqual(lists.at(-1), { project: "caller-project", limit: 100 })
    assert.equal(JSON.parse(result.content)[0].id, target.id)
  } finally {
    mock.restoreAll()
  }
})
