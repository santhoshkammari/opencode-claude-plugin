// Pure mapping: Claude Code stream-json frame -> opencode-shaped AI SDK stream parts.
// Claude executes every tool itself; we only translate what it emits so opencode
// renders and stores the same tool calls (providerExecuted: true).

export type Part = Record<string, any>

const rec = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as any) : {})

// Claude tool name -> opencode 2 tool name (core/src/tool/plugin/*.ts); the TUI has a view for each of these.
export const TOOL_NAMES: Record<string, string> = {
  Bash: "shell",
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  Agent: "subagent",
  Task: "subagent",
  Skill: "skill",
}

// Claude's own plumbing, not work the user wants to see.
const HIDDEN = new Set(["ToolSearch"])

/** opencode tool name for a Claude tool: mapped, else Claude's name (opencode's TUI shows it as a generic tool). */
export const toolName = (claude: string): string | undefined => (HIDDEN.has(claude) ? undefined : TOOL_NAMES[claude] ?? claude)

const opt = (k: string, v: unknown) => (v == null ? {} : { [k]: v })

// Claude input -> opencode input (opencode 2 uses `path` and camelCase keys)
export function mapInput(tool: string, i: Record<string, any>): Record<string, any> {
  switch (tool) {
    case "Bash":
      return { command: i.command, description: i.description ?? i.command, ...opt("timeout", i.timeout), ...opt("background", i.run_in_background) }
    case "Read":
      return { path: i.file_path, ...opt("offset", i.offset), ...opt("limit", i.limit) }
    case "Write":
      return { path: i.file_path, content: i.content }
    case "Edit":
      return { path: i.file_path, oldString: i.old_string, newString: i.new_string, replaceAll: i.replace_all ?? false }
    case "MultiEdit":
      return { path: i.file_path, edits: i.edits }
    case "Glob":
      return { pattern: i.pattern, ...opt("path", i.path) }
    case "Grep":
      return { pattern: i.pattern, ...opt("path", i.path), ...opt("include", i.glob) }
    case "WebFetch":
      return { url: i.url, format: "markdown" }
    case "WebSearch":
      return { query: i.query }
    case "Agent":
    case "Task":
      return { agent: i.subagent_type ?? "general", description: i.description, prompt: i.prompt, ...opt("background", i.run_in_background) }
    case "Skill":
      return { id: i.skill, ...opt("args", i.args) }
    default:
      return i
  }
}

const toUsage = (v: unknown) => {
  const u = rec(v)
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  }
}

interface Block {
  kind: "text" | "thinking" | "tool"
  id: string
  tool?: string
  json: string
}

export class Mapper {
  private blocks = new Map<number, Block>()
  private tools = new Map<string, string>() // tool_use_id -> claude tool name
  private n = 0
  sessionId?: string
  usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }
  resultText?: string
  isError = false

  /** Feed one parsed JSONL frame; returns zero or more stream parts. */
  feed(f: any): Part[] {
    if (f.session_id && f.type !== "rate_limit_event") this.sessionId = f.session_id
    if (f.type === "stream_event") {
      // Last API call's usage = the real context size now. The result frame sums every call in the turn
      // (N tool calls -> ~N x the context), which made opencode think the window was full and compact early.
      if (f.event?.type === "message_delta" && f.event.usage && !f.parent_tool_use_id) this.lastCall = toUsage(f.event.usage)
      return this.stream(f.event)
    }
    if (f.type === "user") return this.toolResults(f.message?.content)
    if (f.type === "result") {
      this.isError = !!f.is_error
      this.resultText = f.result
      this.usage = this.lastCall ?? toUsage(f.usage)
    }
    return []
  }

  private lastCall?: Mapper["usage"]

  private stream(e: any): Part[] {
    const out: Part[] = []
    if (e.type === "content_block_start") {
      const b = e.content_block
      const id = b.id ?? `blk_${this.n++}`
      if (b.type === "text") {
        this.blocks.set(e.index, { kind: "text", id, json: "" })
        out.push({ type: "text-start", id })
      } else if (b.type === "thinking") {
        this.blocks.set(e.index, { kind: "thinking", id, json: "" })
        out.push({ type: "reasoning-start", id })
      } else if (b.type === "tool_use" && toolName(b.name)) {
        this.blocks.set(e.index, { kind: "tool", id: b.id, tool: b.name, json: "" })
        this.tools.set(b.id, b.name)
        out.push({ type: "tool-input-start", id: b.id, toolName: toolName(b.name), providerExecuted: true })
      }
    } else if (e.type === "content_block_delta") {
      const blk = this.blocks.get(e.index)
      if (!blk) return out
      const d = e.delta
      if (d.type === "text_delta") out.push({ type: "text-delta", id: blk.id, delta: d.text })
      else if (d.type === "thinking_delta") out.push({ type: "reasoning-delta", id: blk.id, delta: d.thinking })
      else if (d.type === "input_json_delta") blk.json += d.partial_json
    } else if (e.type === "content_block_stop") {
      const blk = this.blocks.get(e.index)
      if (!blk) return out
      this.blocks.delete(e.index)
      if (blk.kind === "text") out.push({ type: "text-end", id: blk.id })
      else if (blk.kind === "thinking") out.push({ type: "reasoning-end", id: blk.id })
      else {
        let input: Record<string, any> = {}
        try { input = JSON.parse(blk.json || "{}") } catch {}
        const mapped = JSON.stringify(mapInput(blk.tool!, input))
        out.push({ type: "tool-input-delta", id: blk.id, delta: mapped })
        out.push({ type: "tool-input-end", id: blk.id })
        out.push({ type: "tool-call", toolCallId: blk.id, toolName: toolName(blk.tool!), input: mapped, providerExecuted: true })
      }
    }
    return out
  }

  private toolResults(content: any): Part[] {
    if (!Array.isArray(content)) return []
    const out: Part[] = []
    for (const c of content) {
      if (c.type !== "tool_result") continue
      const claude = this.tools.get(c.tool_use_id)
      if (!claude) continue // tool we do not render (ToolSearch) or a subagent's own tool
      const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? "").join("") : String(c.content ?? "")
      out.push({
        type: "tool-result",
        toolCallId: c.tool_use_id,
        toolName: toolName(claude),
        result: text,
        ...(c.is_error ? { isError: true } : {}),
        providerExecuted: true,
      })
    }
    return out
  }
}
