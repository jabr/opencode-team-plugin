import { isAbsolute, relative, resolve } from "node:path"
import type { OpenCodeClient, PermissionRule, SessionInfo, WorktreeInfo } from "@opencode/client"
import { agentMessage } from "./agent-message.ts"

export interface SpawnInput {
  title: string
  kind?: "root" | "child"
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  text?: string
  worktree?: { name?: string }
}

// Only add denies, never grants: session rules override destination agent rules.
// Copying caller allows could bypass a different agent/location's denies. Ask
// rules become denies so they cannot weaken destination denies or be bypassed
// by saved approvals. Retaining even overridden restrictions is conservative.
// Without an explicit universal allow, implicit asks cannot be represented as
// a restrictive-only overlay; fail closed with a universal deny instead.
export function spawnPermissions(caller: PermissionRule[]): PermissionRule[] {
  if (!caller.some((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")) {
    return [{ action: "*", resource: "*", effect: "deny" }]
  }
  return caller.filter((rule) => rule.effect !== "allow").map((rule) => ({ ...rule, effect: "deny" }))
}

export function checkoutSource(directory: string, inventory: readonly { directory: string }[]): string {
  const matches = inventory.filter((entry) => {
    const path = relative(entry.directory, directory)
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"))
  })
  matches.sort((a, b) => resolve(b.directory).length - resolve(a.directory).length)
  if (!matches[0]) throw new Error("Caller checkout is absent from OpenCode worktree inventory; refresh it before spawning")
  return matches[0].directory
}

/** Resource creation is intentionally not rolled back on any later failure. */
export async function spawnSession(client: OpenCodeClient, sessionID: string, agent: string, input: SpawnInput) {
  if (!input.title.trim()) throw new Error("team spawn: title must not be blank")
  const self = await client.session.get({ sessionID })
  const callerAgent = await client.agent.get({ agentID: agent, location: self.location })
  const callerRules = [...callerAgent.data.permissions, ...(self.permissions ?? [])]
  let directory: string = self.location.directory
  let worktree: WorktreeInfo | undefined
  let session: SessionInfo | undefined
  let stage: "worktree" | "session" | "location" | "task" = input.worktree ? "worktree" : "session"
  try {
    if (input.worktree) {
      const inventory = await client.worktree.list({ projectID: self.projectID })
      worktree = await client.worktree.create({
        projectID: self.projectID,
        from: checkoutSource(directory, inventory),
        name: input.worktree.name,
      })
      directory = worktree.directory
    }
    stage = "session"
    session = await client.session.create({
      title: input.title,
      parentID: input.kind === "child" ? self.id : undefined,
      agent: input.agent,
      model: input.model,
      location: { directory },
      metadata: { "team.spawn": { creatorSessionID: self.id, kind: input.kind ?? "root" } },
      permissions: spawnPermissions(callerRules),
    })
    directory = session.location.directory
    stage = "location"
    // OpenCode creates children at their parent's location (also in 2.2.0).
    // Move the idle child before admitting any task in a new worktree.
    if (worktree && directory !== worktree.directory) {
      await client.session.move({ sessionID: session.id, directory: worktree.directory })
      await client.session.wait({ sessionID: session.id })
      session = await client.session.get({ sessionID: session.id })
      directory = session.location.directory
    }
    if (session.projectID !== self.projectID) throw new Error("Created session is outside the caller's project; no task admitted")
    if (worktree && directory !== worktree.directory) throw new Error("Session did not reach the new worktree; no task admitted")
    stage = "task"
    const admitted = input.text === undefined ? undefined : await client.session.synthetic({
      sessionID: session.id,
      ...agentMessage(self, input.text),
      delivery: "queue",
      resume: true,
    })
    return { ok: true, sessionID: session.id, directory, worktree, started: admitted !== undefined, inboxID: admitted?.id }
  } catch (error) {
    let directoryStatus: "refreshed" | "last-known" | undefined
    if (session) {
      directoryStatus = "last-known"
      try {
        // A move may have committed before wait/get failed. Refresh the retained
        // session without letting recovery hide the original error or hang.
        const current = await client.session.get({ sessionID: session.id }, { signal: AbortSignal.timeout(5_000) })
        directory = current.location.directory
        directoryStatus = "refreshed"
      } catch {
        // Keep the last observed directory, explicitly marked as uncertain.
      }
    }
    return {
      ok: false,
      stage,
      sessionID: session?.id,
      directory,
      directoryStatus,
      worktree,
      started: false,
      error: error instanceof Error ? error.message : String(error),
      warning: "Resources are not rolled back. Inspect the returned session/worktree before retrying; an interrupted request may have succeeded server-side. A last-known directory is uncertain, and a pending move may still change the location after a refresh.",
    }
  }
}
