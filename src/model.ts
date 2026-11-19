import { appendFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { createInterface } from "node:readline"
import { APICallError, type LanguageModelV3, type LanguageModelV3CallOptions, type LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Mapper } from "./map.js"
import { conversation, freshStart, promptText, summaryKey, upToDate } from "./history.js"
import { getClaudeSession, getKnownSummary, setClaudeSession, setKnownSummary } from "./sessions.js"

export interface Settings { cliPath?: string; cwd?: string; extraArgs?: string[]; systemPrompt?: string; tools?: string; compactClaude?: boolean }

/**
 * Lean mode: Claude Code with no harness. Two built-in tools (Bash, Read), no settings/hooks/CLAUDE.md, no MCP, no skills
 * or slash commands. The system prompt replaces Claude Code's default (provider option `systemPrompt` overrides it).
 */
const leanArgs = (tools = "Bash,Read") => ["--tools", tools, "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]
const DEFAULT_SYSTEM_PROMPT = `You are a senior software engineer working in the user's terminal. Bash is your main tool and it runs any command, so search, edit, run, test, convert and inspect everything through it. Read is for viewing images and PDFs. Python 3 and standard Unix tools are your power tools. Work the way an experienced engineer who scripts everything would.

How to work
- Act on clear requests directly. Ask only when you are blocked on a decision that is the user's to make.
- Look before you change: \`git status\`, \`ls\`, \`rg\`, \`sed -n 'a,bp'\`. Make the smallest change that solves the problem.
- Verify your work by running the tests or the program, and report the real output. If something failed or you skipped a step, say so.
- Reference code as path:line.

Style
- Talk like a smart caveman: drop filler, articles, pleasantries and hedging; fragments are fine. Pattern: thing, action, reason, next step. Technical terms and code stay exact.
- Explain mechanisms with a tiny concrete example first (toy numbers, a small table or snippet), walk it step by step, then name the concept.
- Show causal chains with no skipped steps: X changes, what touches Y, why it breaks. Back claims with a before/after or a measured number.
- Define jargon in one line on first use. Brevity cuts preamble and restatement, never the mechanism steps.
- Never truncate printed output with slices like [:x] unless asked. If unsure how a library or flag behaves, read its source and say what the code says; don't assume from the name.
- Code: keep it simple, not verbose, no docstrings or comments unless needed.

Think in scripts, not in retyping
- Search with \`rg\` (ripgrep): fast, respects .gitignore, supports regex, \`-g '*.py'\`, \`-l\`, \`-C 3\`, \`--json\`. Use \`fd\` or \`find\` to locate files. Batch many lookups into one command.
- To change many lines, find them with \`rg\`, then write a small \`python3 -\` script that does the replacement (\`re.sub\`, \`pathlib\`), run it over every matching file, and check with \`git diff\`. Do not rewrite a whole file to change a few lines.
- Treat structured text as data. To add a column to a markdown table, parse it into pandas, add the column, and write the table back out. Use \`json\`/\`jq\` for JSON, \`csv\`/pandas for CSV, \`yaml\` for YAML, \`ast\`/\`libcst\` for code transformations, and \`sqlite3\` for databases. Computing an answer in code beats counting by eye.
- Use heredocs (\`python3 - <<'EOF'\`) for multi-line scripts, and \`set -e\` or explicit checks so a failing step stops the run. Print only what you need to see (counts, changed lines, \`git diff --stat\`).
- Run independent commands together and in parallel when one does not depend on another.

Files, images and documents
- Use Read to look at images (screenshots, diagrams, photos) and PDFs: it shows them to you directly. Use it for any image path the user mentions.
- Read text files with \`sed -n\`, \`head\`, \`rg -n\` in Bash. Use \`tesseract <file> stdout\` only for bulk OCR of many images.

Safety
- Permission checks are off, so you can run anything. Confirm first before anything destructive or hard to undo: \`rm -rf\`, \`git reset --hard\`, force-push, dropping data, or touching shared services. Treat unfamiliar files and changes as the user's work.
- Never print or log secrets, tokens or passwords, and do not put them in command arguments.\``
const LEAN_ENV = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
}

/**
 * Variables a Claude Code session sets for its own child processes. When opencode is started from a Claude Code
 * shell they would make every spawned claude join that session (same session id). Auth and config variables
 * (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, ...) are kept.
 */
const PARENT_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env, ...LEAN_ENV }
  for (const k of PARENT_SESSION_VARS) delete out[k]
  return out
}

/**
 * The part of opencode's system prompt worth forwarding to Claude: from the first "Instructions from:" block
 * (AGENTS.md / CLAUDE.md contents), or from the date line when there are none, to the end (date, <env>).
 * Everything before it is opencode's own prompt and tool docs, which describe tools Claude does not have.
 * Changes after the first turn reach Claude as messages, so a resumed session stays consistent.
 */
export function opencodeInstructions(prompt: LanguageModelV3CallOptions["prompt"]): string {
  const text = systemText(prompt)
  const starts = [text.search(/^Instructions from: /m), text.search(/^Today's date: /m)].filter((i) => i >= 0)
  return starts.length ? text.slice(Math.min(...starts)).trim() : ""
}

const textOf = (content: any): string =>
  typeof content === "string" ? content : (content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")

const systemText = (prompt: LanguageModelV3CallOptions["prompt"]): string =>
  (prompt as any[]).filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n")

/**
 * The new user input for Claude: every user message after the last assistant/tool message. opencode sends steered
 * messages, Plan/agent reminders, wrapped system updates and `!shell` output as separate user messages before the
 * prompt. A resumed Claude session also gets the messages it missed (another provider's turns, see history.ts);
 * a new one gets the earlier conversation as text.
 */
export function buildPrompt(prompt: LanguageModelV3CallOptions["prompt"], resuming: boolean, knownSummary?: string): string {
  return promptText(prompt, resuming, knownSummary)
}

/** The user messages of the new input. */
const freshMessages = (prompt: LanguageModelV3CallOptions["prompt"]) => {
  const msgs = conversation(prompt)
  return msgs.slice(freshStart(msgs))
}

/** Claude content block for an opencode file part: images and PDFs, which Claude reads. Other files: undefined. */
export function mediaBlock(p: { mediaType?: string; data?: unknown }): Record<string, unknown> | undefined {
  const type = p.mediaType?.startsWith("image/") ? "image" : p.mediaType === "application/pdf" ? "document" : undefined
  if (!type || p.data == null) return
  const d = p.data
  if (d instanceof URL || (typeof d === "string" && /^(https?|data):/.test(d))) {
    const url = d.toString()
    const inline = /^data:([^;,]+)?(?:;[^,]*)*;base64,(.*)$/s.exec(url)
    if (inline) return { type, source: { type: "base64", media_type: inline[1] ?? p.mediaType, data: inline[2] } }
    return /^https?:/.test(url) ? { type, source: { type: "url", url } } : undefined
  }
  // AI SDK: a string is base64, otherwise bytes
  const data = typeof d === "string" ? d : Buffer.from(d as Uint8Array).toString("base64")
  return { type, source: { type: "base64", media_type: p.mediaType, data } }
}

/** stream-json user content: the prompt text, plus the images/PDFs attached to the new user messages. */
export function buildContent(prompt: LanguageModelV3CallOptions["prompt"], resuming: boolean, knownSummary?: string): string | Record<string, unknown>[] {
  const text = buildPrompt(prompt, resuming, knownSummary)
  const media = freshMessages(prompt)
    .flatMap((m): any[] => (Array.isArray(m.content) ? m.content : []))
    .filter((p: any) => p.type === "file")
    .map(mediaBlock)
    .filter((b): b is Record<string, unknown> => !!b)
  return media.length ? [...media, { type: "text", text }] : text
}

// opencode's Plan reminders (core/src/plugin/plan.ts), user messages kept in the history. The newest one decides.
const PLAN_ON = "You are in Plan mode."
const PLAN_OFF = "You are NO LONGER in Plan mode."
/** opencode's Plan agent is read-only; Claude must then run in its plan permission mode, not skip permissions. */
export function inPlanMode(prompt: LanguageModelV3CallOptions["prompt"]): boolean {
  let on = false
  for (const m of prompt as any[]) {
    if (m.role !== "user") continue
    const t = textOf(m.content)
    if (!t.includes("<system-reminder>")) continue
    if (t.includes(PLAN_OFF)) on = false
    else if (t.includes(PLAN_ON)) on = true
  }
  return on
}

// <env> blocks name the directory. The system prompt keeps the session's first one until a compaction; a later
// directory change arrives as a user message wrapping a system update, with "<", ">", "&" escaped.
const ENV_DIR = /(?:<|&lt;)env(?:>|&gt;)[\s\S]*?Working directory:\s*(\S[^\n]*)/g
const unescape = (t: string) => t.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")

/** opencode may run in a shared background service, so process.cwd() is not the project; its prompt names it. */
export function workingDir(prompt: LanguageModelV3CallOptions["prompt"], fallback?: string): string {
  let dir: string | undefined
  for (const m of prompt as any[]) {
    if (m.role !== "system" && m.role !== "user") continue
    for (const hit of textOf(m.content).matchAll(ENV_DIR)) dir = unescape(hit[1].trim())
  }
  dir ??= /Working directory:\s*(\S.*)/.exec(systemText(prompt))?.[1].trim()
  return dir ?? fallback ?? process.cwd()
}

/**
 * opencode also calls the model for helper jobs (session title, summary, compaction). Those carry no
 * "Working directory:" in the system prompt. They must never become an agent turn: no tools, no --resume,
 * no session mapping, or they run the user's request a second time in the service's cwd.
 */
export const isAgentTurn = (prompt: LanguageModelV3CallOptions["prompt"]) => /Working directory:/.test(systemText(prompt))
export const isTitleRequest = (prompt: LanguageModelV3CallOptions["prompt"]) => systemText(prompt).includes("You are a title generator")

// opencode's compaction appends a summary prompt (core/src/session/compaction.ts buildPrompt) or, when the reply
// skips the template, its NUDGE. Both are the last user message of a request with the agent's system prompt.
const COMPACTION = /Do not continue the task or call tools\.|did not fill in the required summary template/
export function isCompaction(prompt: LanguageModelV3CallOptions["prompt"]): boolean {
  const last = (prompt as any[]).filter((m) => m.role === "user").at(-1)
  return !!last && COMPACTION.test(textOf(last.content))
}

/** The user typed `/compact [instructions]` as a message: opencode sends it as plain text to the provider. */
const COMPACT_CMD = /^\s*\/compact\b\s*(.*)$/s
export function compactCommand(prompt: LanguageModelV3CallOptions["prompt"]): string | undefined {
  const last = (prompt as any[]).filter((m) => m.role === "user").at(-1)
  const m = last && COMPACT_CMD.exec(textOf(last.content).trim())
  return m ? m[1].trim() : undefined
}

/**
 * Claude's own `/compact` on a real Claude session, headless. `claude -p --resume <id> "/compact"` runs the same
 * manual compaction as the TUI (writes a compact_boundary and the summary into the transcript), so Claude's real
 * context shrinks, not just opencode's record of it. Slash commands must be on for this one call.
 */
export function compactClaude(s: Settings, modelId: string, session: string, cwd: string, instructions = ""): Promise<{ pre: number; post: number }> {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--model", modelId, "--resume", session,
    "--tools", s.tools ?? "Bash,Read", "--setting-sources", "", "--strict-mcp-config",
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(s.cliPath ?? "claude", args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] })
    child.stdin.on("error", () => {})
    child.stdin.end(("/compact " + instructions).trim())
    let stderr = "", out = ""
    let meta: { pre: number; post: number } | undefined
    child.stderr.on("data", (d) => (stderr += d))
    createInterface({ input: child.stdout }).on("line", (line) => {
      let f: any
      try { f = JSON.parse(line) } catch { return }
      if (f.type === "system" && f.subtype === "compact_boundary") meta = { pre: f.compact_metadata?.pre_tokens ?? 0, post: f.compact_metadata?.post_tokens ?? 0 }
      if (f.type === "result") out = String(f.result ?? "")
    })
    child.on("error", (e) => reject(new Error(`cannot run ${s.cliPath ?? "claude"}: ${e.message}`)))
    child.on("close", (code) => (meta ? resolve(meta) : reject(new Error(out || stderr.trim() || `claude /compact failed (exit ${code})`))))
  })
}

/**
 * Agent-context requests that must not become a turn in the Claude session: compaction, and session generate
 * (core/src/session/generate.ts, "generate from session context without mutating the session"). Primary turns
 * and compaction carry opencode's output limit; generate and title requests keep the provider default.
 */
export const isSideJob = (o: Pick<LanguageModelV3CallOptions, "prompt" | "maxOutputTokens">) =>
  isCompaction(o.prompt) || o.maxOutputTokens == null

// Failures opencode may fix by sending again. Anything else (bad model, auth, usage limit, missing binary) fails
// the same way every time, and each of opencode's 10 retries would add the prompt to the Claude transcript again.
const TRANSIENT = /overloaded|\b5\d\d\b|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|network error/i
/** Turn error for opencode: plain Error (retried) when transient, else an HTTP-shaped error that says "do not retry". */
export function claudeError(message: string): Error {
  if (TRANSIENT.test(message)) return new Error(message)
  return new APICallError({
    message,
    url: "claude-cli",
    requestBodyValues: {},
    statusCode: 400,
    responseHeaders: { "x-should-retry": "false" },
    isRetryable: false,
  })
}

// Claude's own session title (generate_session_title, same as Claude Code's UI), handed from the first
// agent turn to opencode's title request for the same opencode session. Whichever call comes first creates it.
const titles = new Map<string, { promise: Promise<string | undefined>; resolve: (t: string | undefined) => void }>()
function titleSlot(ocSession: string) {
  let slot = titles.get(ocSession)
  if (!slot) {
    let resolve!: (t: string | undefined) => void
    const promise = new Promise<string | undefined>((r) => (resolve = r))
    slot = { promise, resolve }
    titles.set(ocSession, slot)
    setTimeout(() => titles.delete(ocSession), 5 * 60_000).unref?.()
  }
  return slot
}
const TITLE_WAIT_MS = 30_000
/** After an interrupt request, time Claude gets to end the turn before it is killed. */
const INTERRUPT_GRACE_MS = 3_000

/**
 * Running claude process per opencode session, resolved when it exits. After Stop, opencode may start the next turn
 * at once while the stopped process still writes its interrupt to the transcript; a second `--resume` of the same
 * Claude session then would race it (or, before the first turn saved its id, start a new Claude session).
 */
const running = new Map<string, Promise<void>>()
async function afterPrevious(ocSession: string) {
  const prev = running.get(ocSession)
  if (!prev) return
  await Promise.race([prev, new Promise((r) => setTimeout(r, INTERRUPT_GRACE_MS + 5_000).unref?.())])
}
function track(ocSession: string, child: ReturnType<typeof spawn>) {
  const done = new Promise<void>((r) => { child.once("close", () => r()); child.once("error", () => r()) })
  running.set(ocSession, done)
  done.then(() => { if (running.get(ocSession) === done) running.delete(ocSession) })
}

/**
 * Stream writer that drops parts once the stream is closed. opencode cancels the stream on interrupt, and
 * the child still emits lines and `close` after that; enqueue/close on a cancelled stream throw.
 */
function writer(c: ReadableStreamDefaultController<LanguageModelV3StreamPart>) {
  let open = true
  return {
    push: (p: unknown) => { if (open) c.enqueue(p as LanguageModelV3StreamPart) },
    close: () => { if (open) { open = false; c.close() } },
    cancelled: () => { open = false },
  }
}

/** Ends a stream: optional error part, then finish with the turn's usage. */
function end(out: ReturnType<typeof writer>, mapper: Mapper, message?: string) {
  if (message !== undefined) out.push({ type: "error", error: claudeError(message) })
  const error = message !== undefined
  const u = mapper.usage
  out.push({
    type: "finish",
    finishReason: { unified: error ? "error" : "stop", raw: error ? "error" : "stop" },
    usage: {
      inputTokens: { total: u.inputTokens + u.cacheRead + u.cacheWrite, noCache: u.inputTokens, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
      outputTokens: { total: u.outputTokens, text: u.outputTokens, reasoning: 0 },
    },
  })
  out.close()
}

/** Debug trace to $OCN_DUMP (one JSON line per event). */
const trace = (o: Record<string, unknown>) => {
  if (process.env.OCN_DUMP) appendFileSync(process.env.OCN_DUMP, JSON.stringify({ trace: Date.now(), ...o }) + "\n")
}

const textStream = (text: string, inputTokens = 0): ReadableStream<LanguageModelV3StreamPart> =>
  new ReadableStream<LanguageModelV3StreamPart>({
    start: (c) => {
      c.enqueue({ type: "stream-start", warnings: [] })
      c.enqueue({ type: "text-start", id: "t0" } as any)
      c.enqueue({ type: "text-delta", id: "t0", delta: text } as any)
      c.enqueue({ type: "text-end", id: "t0" } as any)
      c.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
      } as any)
      c.close()
    },
  })

export class ClaudeNativeModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly supportedUrls = {}
  constructor(readonly modelId: string, readonly provider: string, private s: Settings) {}

  async doGenerate(): Promise<never> {
    throw new Error("opencode-claude-native supports streaming only")
  }

  async doStream(o: LanguageModelV3CallOptions): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }> {
    const headers = Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    // x-session-affinity is a cache-routing key, not the session: forks carry their source's id and child
    // sessions their parent's. The session itself is x-opencode-session-id.
    const ocSession = ((headers["x-opencode-session-id"] ?? headers["x-session-affinity"]) as string) || "default"
    if (process.env.OCN_DUMP)
      appendFileSync(process.env.OCN_DUMP, JSON.stringify({ headers, maxOutputTokens: o.maxOutputTokens, toolChoice: o.toolChoice, tools: o.tools?.map((t: any) => t.name), prompt: o.prompt }) + "\n")

    if (isAgentTurn(o.prompt) && ocSession !== "default") await afterPrevious(ocSession)
    const own = getClaudeSession(ocSession, this.modelId)
    if (!isAgentTurn(o.prompt)) {
      // Wait for Claude's title only while the session's first turn may still make one: a title request for a
      // session that already has a Claude session is a regeneration, and the old title would be wrong.
      if (isTitleRequest(o.prompt) && ocSession !== "default" && (titles.has(ocSession) || !own)) {
        const timeout = new Promise<undefined>((r) => setTimeout(() => r(undefined), TITLE_WAIT_MS).unref?.())
        const title = await Promise.race([titleSlot(ocSession).promise, timeout])
        titles.delete(ocSession)
        if (title) return { stream: textStream(title) }
      }
      return this.helper(o)
    }
    // Compaction or generate: a tool-free reply from a throwaway fork of the Claude session, so it has the real
    // context but neither runs tools nor leaves the summary prompt in the transcript.
    if (isSideJob(o)) return this.helper(o, own, ocSession)

    // `/compact` typed in opencode: compact the real Claude session instead of sending the word to Claude as a prompt.
    const compactArg = compactCommand(o.prompt)
    if (compactArg !== undefined) {
      if (!own) return { stream: textStream("Nothing to compact: no Claude session for this conversation yet.") }
      const done = compactClaude(this.s, this.modelId, own, workingDir(o.prompt, this.s.cwd), compactArg)
      if (ocSession !== "default") running.set(ocSession, done.then(() => {}, () => {}))
      try {
        const { pre, post } = await done
        return { stream: textStream(`Compacted Claude context: ${pre.toLocaleString("en")} → ${post.toLocaleString("en")} tokens.`, post) }
      } catch (e: any) {
        return { stream: new ReadableStream({ start: (c) => { c.enqueue({ type: "stream-start", warnings: [] }); c.enqueue({ type: "error", error: claudeError(e.message) }); c.enqueue({ type: "finish", finishReason: { unified: "error", raw: "error" }, usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } }); c.close() } }) }
      }
    }

    // A fork's first turn: opencode sends the fork source as affinity (children send their parent, so skip those).
    // Branch the source's Claude transcript with --fork-session; the source session is left untouched.
    const affinity = headers["x-session-affinity"] as string | undefined
    const forkOf =
      !own && affinity && affinity !== ocSession && !headers["x-opencode-parent-session-id"]
        ? getClaudeSession(affinity, this.modelId)
        : undefined
    const existing = own ?? forkOf
    const wantTitle = !own && ocSession !== "default"
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
      "--model", this.modelId,
      ...leanArgs(this.s.tools),
      "--system-prompt", [this.s.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, opencodeInstructions(o.prompt)].filter(Boolean).join("\n\n"),
      ...(inPlanMode(o.prompt) ? ["--permission-mode", "plan"] : ["--dangerously-skip-permissions"]),
      ...(existing ? ["--resume", existing] : []),
      ...(forkOf ? ["--fork-session"] : []),
      ...(this.s.extraArgs ?? []),
    ]
    const child = spawn(this.s.cliPath ?? "claude", args, { cwd: workingDir(o.prompt, this.s.cwd), env: childEnv(), stdio: ["pipe", "pipe", "pipe"] })
    if (ocSession !== "default") track(ocSession, child)
    const known = own ? getKnownSummary(ocSession) : undefined
    const text = buildPrompt(o.prompt, !!existing, known)
    if (wantTitle) {
      // Claude Code's own title generator (tool-free Haiku call); persist writes the ai-title entry to the transcript.
      child.stdin.write(JSON.stringify({ type: "control_request", request_id: "ocn_title", request: { subtype: "generate_session_title", description: text, persist: true } }) + "\n")
    }
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: buildContent(o.prompt, !!existing, known) } }) + "\n")
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    child.stdin.on("error", () => {})

    // Stop like Claude Code's Esc: the interrupt control request ends the turn, rejects a running tool and records
    // "[Request interrupted by user]" in the transcript, so the next --resume knows. SIGTERM only if Claude hangs.
    let exited = false
    let interrupting = false
    const interrupt = (why = "abort") => {
      trace({ event: "interrupt", why, exited, interrupting, ocSession })
      if (exited || interrupting) return
      interrupting = true
      child.stdin.write(JSON.stringify({ type: "control_request", request_id: "ocn_interrupt", request: { subtype: "interrupt" } }) + "\n")
      setTimeout(() => { if (!exited) child.kill("SIGTERM") }, INTERRUPT_GRACE_MS).unref?.()
      setTimeout(() => { if (!exited) child.kill("SIGKILL") }, INTERRUPT_GRACE_MS + 3_000).unref?.()
    }
    child.on("close", () => (exited = true))
    if (o.abortSignal?.aborted) interrupt()
    o.abortSignal?.addEventListener("abort", () => interrupt("abort"))

    // stream-json input keeps the child alive until stdin closes: close it once the turn's result
    // and (if asked) the title response are both in, or a little after the result if the title is late.
    let resultSeen = false
    let titlePending = wantTitle
    const settleTitle = (t?: string) => {
      if (!titlePending) return
      titlePending = false
      titleSlot(ocSession).resolve(t)
      if (resultSeen) child.stdin.end()
    }
    const mapper = new Mapper()
    let out!: ReturnType<typeof writer>
    const stream: ReadableStream<LanguageModelV3StreamPart> = new ReadableStream<LanguageModelV3StreamPart>({
      start: (c) => {
        out = writer(c)
        out.push({ type: "stream-start", warnings: [] })
        const rl = createInterface({ input: child.stdout })
        rl.on("line", (line) => {
          let f: any
          try { f = JSON.parse(line) } catch { return }
          if (f.type === "control_response" && f.response?.request_id === "ocn_title") {
            const t = f.response.subtype === "success" ? f.response.response?.title : undefined
            settleTitle(typeof t === "string" && t.trim() ? t.trim() : undefined)
            return
          }
          for (const p of mapper.feed(f)) out.push(p)
          // Save the Claude session as soon as it exists: a turn stopped early still has a transcript to resume.
          if (f.type === "system" && f.subtype === "init" && f.session_id && ocSession !== "default") setClaudeSession(ocSession, f.session_id)
          if (f.type === "stream_event" && f.event?.type === "content_block_start") trace({ event: "block", kind: f.event.content_block?.type })
          if (f.type === "control_response") trace({ event: "control_response", id: f.response?.request_id })
          if (f.type === "result") {
            trace({ event: "result", subtype: f.subtype, stop: f.stop_reason })
            resultSeen = true
            if (!titlePending || interrupting) child.stdin.end()
            else setTimeout(() => settleTitle(undefined), 10_000).unref?.()
          }
        })
        child.on("close", (code) => {
          settleTitle(undefined)
          if (mapper.sessionId) setClaudeSession(ocSession, mapper.sessionId)
          const failed = mapper.isError || (code !== 0 && !mapper.resultText)
          end(out, mapper, failed ? mapper.resultText || stderr || `claude exited ${code}` : undefined)
        })
        // spawn failure (e.g. claude not on the PATH of opencode's service): fail the turn instead of an uncaught error
        child.on("error", (e) => end(out, mapper, `cannot run ${this.s.cliPath ?? "claude"}: ${e.message}`))
      },
      cancel: () => {
        out.cancelled()
        interrupt("cancel")
      },
    })
    return { stream }
  }

  /**
   * opencode helper job (title fallback, summary, compaction, generate): one-shot completion, no tools, nothing saved.
   * With `resume`, it answers from a fork of that Claude session (--fork-session --no-session-persistence leaves
   * the session's transcript untouched); without, from the system prompt plus the conversation as text.
   */
  private async helper(o: LanguageModelV3CallOptions, resume?: string, ocSession?: string): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }> {
    const args = [
      "-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
      "--model", this.modelId, "--tools", "", "--no-session-persistence",
      ...(resume ? ["--resume", resume, "--fork-session"] : ["--system-prompt", systemText(o.prompt)]),
    ]
    // a resumed session is looked up under its project directory
    const cwd = resume ? workingDir(o.prompt, this.s.cwd) : tmpdir()
    const child = spawn(this.s.cliPath ?? "claude", args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] })
    child.stdin.on("error", () => {})
    const known = resume && ocSession ? getKnownSummary(ocSession) : undefined
    child.stdin.end(buildPrompt(o.prompt, !!resume, known))
    // A compaction summary Claude writes while it has seen everything: the next turn skips that checkpoint.
    const compaction = !!resume && !!ocSession && isCompaction(o.prompt)
    const synced = compaction && upToDate(o.prompt, known)
    let summary = ""
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    o.abortSignal?.addEventListener("abort", () => child.kill("SIGTERM"))
    const mapper = new Mapper()
    let out!: ReturnType<typeof writer>
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (c) => {
        out = writer(c)
        out.push({ type: "stream-start", warnings: [] })
        const rl = createInterface({ input: child.stdout })
        rl.on("line", (line) => {
          let f: any
          try { f = JSON.parse(line) } catch { return }
          for (const p of mapper.feed(f)) {
            if (p.type === "text-delta") summary += p.delta
            out.push(p)
          }
        })
        child.on("close", (code) => {
          const failed = mapper.isError || (code !== 0 && !mapper.resultText)
          if (compaction && !failed) setKnownSummary(ocSession!, synced && summary.trim() ? summaryKey(summary) : undefined)
          const finish = () => end(out, mapper, failed ? mapper.resultText || stderr || `claude exited ${code}` : undefined)
          // opencode's summary only replaces opencode's own history; Claude's session would stay full. Compact it too.
          if (compaction && !failed && resume && this.s.compactClaude !== false) {
            const done = compactClaude(this.s, this.modelId, resume, cwd)
            running.set(ocSession!, done.then(() => {}, () => {}))
            done.then(finish, (e) => { trace({ event: "compact-failed", error: String(e) }); finish() })
          } else finish()
        })
        // spawn failure (e.g. claude not on the PATH of opencode's service): fail the turn instead of an uncaught error
        child.on("error", (e) => end(out, mapper, `cannot run ${this.s.cliPath ?? "claude"}: ${e.message}`))
      },
      cancel: () => {
        out.cancelled()
        child.kill("SIGTERM")
      },
    })
    return { stream }
  }
}
