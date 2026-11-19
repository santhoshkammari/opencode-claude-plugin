// What Claude has not seen yet. The Claude session keeps its own transcript, so a turn sends only the messages
// after Claude's last reply. When the user switched to another provider in between, those messages include the
// other model's replies and tool calls; Claude gets them as a text record before the new request.
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

type Prompt = LanguageModelV3CallOptions["prompt"]
type Msg = Prompt[number]

/** Key of the marker the server plugin (plugin.ts) puts on the first part of each assistant message. */
export const MARK = "ocn"

const textOf = (content: any): string =>
  typeof content === "string" ? content : (content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")

/** user / assistant / tool messages; the system prompt is sent separately. */
export const conversation = (prompt: Prompt): Msg[] => (prompt as Msg[]).filter((m) => m.role !== "system")

/** Marker on an assistant message: true = Claude made it, false = another model, undefined = no plugin. */
export function madeByClaude(m: Msg): boolean | undefined {
  if (m.role !== "assistant" || !Array.isArray(m.content)) return
  for (const p of m.content as any[]) {
    const v = p.providerOptions?.[MARK]?.claude
    if (typeof v === "boolean") return v
  }
}

// opencode's compaction checkpoint (core/src/session/runner/to-llm-message.ts)
const CHECKPOINT = /<conversation-checkpoint>[\s\S]*?<summary>\n?([\s\S]*?)\n?<\/summary>/
/** The summary text of a compaction checkpoint message, else undefined. */
export const checkpointSummary = (m: Msg): string | undefined =>
  m.role === "user" ? CHECKPOINT.exec(textOf(m.content))?.[1] : undefined

/**
 * Index of the first message of the new input: the user messages after the last assistant/tool message or
 * compaction checkpoint (a checkpoint is a user message, but it is history, not input).
 */
export function freshStart(msgs: Msg[]): number {
  let i = msgs.length
  while (i > 0 && msgs[i - 1].role === "user" && checkpointSummary(msgs[i - 1]) === undefined) i--
  return i
}

const RECENT = /<recent-context>\n?([\s\S]*?)\n?<\/recent-context>/
/**
 * The verbatim recent messages opencode keeps beside a checkpoint's summary. Claude may not have seen them even when
 * it wrote the summary (compaction.ts summarizes only the older part), so they are always sent.
 */
const recentOf = (m: Msg): string => (m.role === "user" ? RECENT.exec(textOf(m.content))?.[1]?.trim() ?? "" : "")

/** Short, whitespace-insensitive key for a summary, to recognise one Claude wrote. */
export const summaryKey = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300)

/**
 * Index of the last message Claude already knows (-1: none).
 * - With the plugin's markers: Claude's last own assistant message, or a compaction checkpoint whose summary Claude
 *   wrote while it was up to date (`knownSummary`).
 * - Without markers (plugin not installed): the last assistant message, as before.
 */
export function seenUpTo(msgs: Msg[], knownSummary?: string): number {
  const marked = msgs.some((m) => madeByClaude(m) !== undefined)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === "assistant" && (!marked || madeByClaude(m) === true)) return i
    const s = checkpointSummary(m)
    if (s !== undefined && knownSummary && summaryKey(s) === knownSummary) return i
  }
  return -1
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s)
const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v))

function toolOutput(o: any): string {
  if (o == null) return ""
  if (o.type === "text" || o.type === "error-text") return String(o.value ?? "")
  if (o.type === "json" || o.type === "error-json") return json(o.value)
  if (o.type === "content") return (o.value ?? []).map((x: any) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n")
  if (o.type === "execution-denied") return `[denied${o.reason ? `: ${o.reason}` : ""}]`
  return json(o)
}

/** One message as plain text lines, for a model that did not see it. Tool calls and results are shortened. */
export function render(m: Msg): string {
  // opencode's instruction updates for the other model (tool catalogs, AGENTS.md); Claude has its own tools and setup
  if (m.role === "system" || (m.role === "user" && textOf(m.content).trimStart().startsWith("<system-update>"))) return ""
  const parts: any[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as any[])
  const lines: string[] = []
  for (const p of parts) {
    if (p.type === "text" && p.text) lines.push(p.text)
    else if (p.type === "file") lines.push(`[attached ${p.filename ?? p.mediaType}]`)
    else if (p.type === "tool-call") lines.push(`[tool call ${p.toolName} ${cap(json(p.input), 1500)}]`)
    else if (p.type === "tool-result") lines.push(`[tool result ${p.toolName}: ${cap(toolOutput(p.output ?? p.result), 3000)}]`)
  }
  if (!lines.length) return ""
  const who = m.role === "tool" ? "tool" : m.role === "assistant" ? (madeByClaude(m) === false ? "assistant (other model)" : "assistant") : "user"
  return `${who}: ${lines.join("\n")}`
}

export const renderAll = (msgs: Msg[]) => msgs.map(render).filter(Boolean).join("\n\n")

/**
 * The text Claude gets for this turn.
 * - New Claude session: the earlier conversation as text, then the request.
 * - Resumed session: only the request, plus a record of the messages Claude missed (another model's turns).
 */
export function promptText(prompt: Prompt, resuming: boolean, knownSummary?: string): string {
  const msgs = conversation(prompt)
  const start = freshStart(msgs)
  // Nothing new after the last reply (opencode resuming a stopped turn): ask Claude to go on.
  const current = msgs.slice(start).map((m) => textOf(m.content)).filter(Boolean).join("\n\n") || "Continue."
  if (!resuming) {
    const hist = renderAll(msgs.slice(0, start))
    return hist ? `Earlier conversation:\n${hist}\n\nCurrent request:\n${current}` : current
  }
  const missed = missedText(msgs, start, knownSummary)
  if (!missed) return current
  return (
    "<conversation-update>\nThis chat continued with another model while you were switched out. You have not seen " +
    "these messages (a summary in them may repeat what you know). Files may have changed.\n\n" +
    `${missed}\n</conversation-update>\n\n${current}`
  )
}

/** Messages before `start` that Claude has not seen, as text ('' when it is up to date). */
function missedText(msgs: Msg[], start: number, knownSummary?: string): string {
  const seen = seenUpTo(msgs.slice(0, start), knownSummary)
  const recent = seen >= 0 && checkpointSummary(msgs[seen]) !== undefined ? recentOf(msgs[seen]) : ""
  return [recent && `Recent messages kept beside the summary:\n${recent}`, renderAll(msgs.slice(seen + 1, start))]
    .filter(Boolean).join("\n\n")
}

/** True when Claude has seen everything before the new input (no other-model turns since its last reply). */
export function upToDate(prompt: Prompt, knownSummary?: string): boolean {
  const msgs = conversation(prompt)
  return !missedText(msgs, freshStart(msgs), knownSummary)
}

/** Assistant messages in opencode's history (it drops undone ones, so this falls after /undo). */
export const assistantCount = (prompt: Prompt): number => conversation(prompt).filter((m) => m.role === "assistant").length

/** True when the history starts from a compaction checkpoint (the message count is then not comparable). */
export const hasCheckpoint = (prompt: Prompt): boolean => conversation(prompt).some((m) => checkpointSummary(m) !== undefined)

/**
 * Where to rewind after an undo. `ends` maps an assistant-message count to the Claude uuid recorded after it.
 * Undo = the history has fewer assistant messages than the newest recorded count. Returns the uuid to resume at,
 * `null` to start a fresh Claude session (everything undone), or undefined for no rewind. `keep` is the ends to keep.
 */
export function rewindPoint(ends: Record<number, string>, count: number): { uuid: string | null; keep: Record<number, string> } | undefined {
  const keys = Object.keys(ends).map(Number)
  if (!keys.length || count >= Math.max(...keys)) return
  const k = Math.max(-1, ...keys.filter((n) => n <= count))
  const keep = Object.fromEntries(keys.filter((n) => n <= k).map((n) => [n, ends[n]]))
  return { uuid: k >= 0 ? ends[k] : null, keep }
}
