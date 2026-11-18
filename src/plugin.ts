// opencode server plugin that makes switching between claude-native and any other provider work both ways.
// Load it with `"plugins": ["/path/to/opencode-claude-native/dist/plugin"]` in opencode.json(c).
//
// Claude runs its own tools, so its assistant messages hold tool calls *and* their results (providerExecuted).
// opencode replays them to the next model as they are, and its OpenAI-compatible / Anthropic adapters reject a
// tool result inside an assistant message (packages/ai/src/protocols/openai-chat.ts lowerAssistantMessage). So:
// - another provider gets Claude's tool use as ordinary assistant tool calls followed by tool-result messages;
// - claude-native gets a marker on each assistant message saying whether Claude made it, so the provider sends
//   Claude only what it missed (history.ts).

import { MARK } from "./history.js"

const DEFAULT_PROVIDER = "claude-native"

type Part = Record<string, any>
type Message = { id?: string; role: string; content: readonly Part[]; [k: string]: any }

/** Same class as the input message (opencode's Schema class), else a plain object. */
function remake(like: Message, fields: Record<string, unknown>): Message {
  const Ctor = (like as any)?.constructor
  const plain: Record<string, any> = { id: like.id, metadata: like.metadata, native: like.native, ...fields }
  for (const k of Object.keys(plain)) if (plain[k] === undefined) delete plain[k]
  if (typeof Ctor === "function" && Ctor !== Object) {
    try { return new Ctor(plain) } catch {}
  }
  return plain as unknown as Message
}

const executed = (p: Part) => (p.type === "tool-call" || p.type === "tool-result") && p.providerExecuted === true

/**
 * Split each assistant message that holds provider-executed tool results into
 * assistant(text, calls) -> tool(result)... -> assistant(rest), with providerExecuted cleared, the shape every
 * chat API accepts. A call without a result (stopped turn) gets an error result, since chat APIs need one per call.
 */
export function splitExecuted(messages: readonly Message[]): Message[] {
  const out: Message[] = []
  for (const m of messages) {
    if (m.role !== "assistant" || !m.content.some((p) => p.type === "tool-result" && executed(p))) {
      out.push(m)
      continue
    }
    let parts: Part[] = []
    let calls: Part[] = []
    let results = new Map<string, Part>()
    let first = true
    const flush = () => {
      if (!parts.length && !calls.length) return
      out.push(remake(m, { role: "assistant", content: [...parts, ...calls], ...(first ? {} : { id: undefined }) }))
      first = false
      for (const c of calls) {
        const r = results.get(c.id)
        out.push(remake(m, {
          id: undefined,
          role: "tool",
          content: [r ? { ...r, providerExecuted: undefined, providerMetadata: undefined }
            : { type: "tool-result", id: c.id, name: c.name, result: { type: "error", value: "Tool did not finish (interrupted)." } }],
        }))
      }
      parts = []
      calls = []
      results = new Map()
    }
    for (const p of m.content) {
      if (p.type === "tool-call") {
        if (calls.length && results.size) flush()
        calls.push(executed(p) ? { ...p, providerExecuted: undefined, providerMetadata: undefined } : p)
      } else if (p.type === "tool-result") {
        results.set(p.id, p)
      } else {
        if (calls.length) flush()
        parts.push(p)
      }
    }
    flush()
  }
  return out
}

/** Put `{ocn: {claude}}` on the first part of every assistant message (it reaches the provider as providerOptions). */
export function markAssistants(messages: readonly Message[], isClaude: (id: string | undefined) => boolean): Message[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.content.length) return m
    const [head, ...rest] = m.content
    const mark = { ...head, providerMetadata: { ...head.providerMetadata, [MARK]: { claude: isClaude(m.id) } } }
    return remake(m, { role: m.role, content: [mark, ...rest], providerMetadata: m.providerMetadata })
  })
}

/** Ids of the assistant messages the claude-native provider produced, from opencode's session context. */
async function claudeIds(ctx: any, sessionID: string, provider: string): Promise<Set<string> | undefined> {
  try {
    const r = await ctx.session.context({ sessionID })
    const list: any[] | undefined = Array.isArray(r) ? r : r?.data
    if (!Array.isArray(list)) return
    return new Set(list.filter((m) => m.type === "assistant" && String(m.model?.providerID) === provider).map((m) => String(m.id)))
  } catch {
    return
  }
}

export default {
  id: "opencode-claude-native",
  setup: async (ctx: any) => {
    const provider: string = ctx.options?.providerID ?? DEFAULT_PROVIDER
    const rewrite = async (e: any) => {
      if (!Array.isArray(e?.messages)) return
      if (String(e.model?.providerID) !== provider) {
        e.messages = splitExecuted(e.messages)
        return
      }
      if (!e.messages.some((m: Message) => m.role === "assistant")) return
      // No answer from the session API: leave the messages unmarked; the provider then uses its old rule.
      const ids = await claudeIds(ctx, e.sessionID, provider)
      if (!ids) return
      e.messages = markAssistants(e.messages, (id) => !!id && ids.has(id))
    }
    for (const hook of ["context", "compaction", "generate", "title"]) await ctx.session.hook(hook, rewrite)
  },
}
