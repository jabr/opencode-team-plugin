import type { SessionInfo } from "@opencode/client"

/** Shared synthetic payload; callers choose the target and delivery behavior. */
export function agentMessage(sender: Pick<SessionInfo, "id" | "title">, text: string) {
  return {
    // Models receive synthetic text as a user turn, so provenance belongs here.
    text: `[agent-message from ${sender.id}]\n${text}`,
    // Web/desktop clients use description as a compact update label.
    description: `Message from ${sender.title?.trim() || sender.id}`,
    metadata: { from: sender.id },
  }
}
