import { test } from "node:test"
import assert from "node:assert/strict"
import type { SessionSyntheticInput } from "@opencode/client"
import plugin from "./index.ts"
import { agentMessage } from "./agent-message.ts"

test("shared agent payload preserves full text and stable sender identity", () => {
  assert.deepEqual(agentMessage({ id: "ses_sender", title: "  Human readable title  " }, "First line\n\nLast line"), {
    text: "[agent-message from ses_sender]\nFirst line\n\nLast line",
    description: "Message from Human readable title",
    metadata: { from: "ses_sender" },
  })
  for (const title of [undefined, "", "  "]) {
    assert.equal(agentMessage({ id: "ses_sender", title }, "").description, "Message from ses_sender")
  }
})

test("send includes a user-visible description without changing delivery modes", async () => {
  const tools: any[] = []
  const messages: SessionSyntheticInput[] = []
  const interrupts: unknown[] = []
  let senderTitle: string | undefined = "  Coordinator  "
  await plugin.setup({
    location: { project: { id: "caller-project" } },
    tool: { transform: async (register: any) => register({ namespace() {}, add(tool: any) { tools.push(tool) } }) },
    session: {
      hook: async () => {},
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, title: senderTitle, projectID: "caller-project", parentID: "ses_parent" }),
      synthetic: async (input: SessionSyntheticInput) => { messages.push(input) },
      interrupt: async (input: unknown) => { interrupts.push(input) },
    },
  } as any)
  const send = tools.find((tool) => tool.name === "send")
  for (const mode of [undefined, "steer", "interrupt", "park"]) {
    await send.execute({ to: "ses_target", text: "Visible message\nwith details", mode }, { sessionID: "ses_caller" })
    const message = messages.at(-1)!
    assert.equal(message.text, "[agent-message from ses_caller]\nVisible message\nwith details")
    assert.equal(message.description, "Message from Coordinator")
    assert.deepEqual(message.metadata, { from: "ses_caller" })
    assert.equal(message.delivery, mode === "steer" ? "steer" : "queue")
    assert.equal(message.resume, mode === "park" ? false : undefined)
  }
  assert.deepEqual(interrupts, [{ sessionID: "ses_target", resume: false }])
  for (const title of [undefined, "  "]) {
    senderTitle = title
    await send.execute({ to: "ses_target", text: "Full message body" }, { sessionID: "ses_caller" })
    assert.equal(messages.at(-1)!.description, "Message from ses_caller")
    assert.equal(messages.at(-1)!.text, "[agent-message from ses_caller]\nFull message body")
  }
})
