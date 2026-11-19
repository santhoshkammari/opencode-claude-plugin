// Offline tests for the provider's process handling, against test/fake-claude.mjs (no real Claude).
import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClaudeNative } from "../src/index"
import { rewindPoint } from "../src/history"
import { claudeError, compactCommand, formatContext, isContextCommand, opencodeInstructions } from "../src/model"

const fake = new URL("./fake-claude.mjs", import.meta.url).pathname
chmodSync(fake, 0o755)
const fixture = new URL("./fixtures/haiku-5tools.jsonl", import.meta.url).pathname

// opencode's primary turns carry its output limit (core/src/session/model-request.ts); generate/title do not.
const agent = (m: any) => ({ doStream: (o: any) => m.doStream({ maxOutputTokens: 32_000, ...o }) })

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocn-model-"))
  Object.assign(process.env, {
    OPENCODE_CLAUDE_NATIVE_STORE: join(dir, "sessions.json"),
    FAKE_CLAUDE_LOG: join(dir, "log.jsonl"),
    FAKE_CLAUDE_FIXTURE: fixture,
    FAKE_CLAUDE_DELAY: "0",
    ...env,
  })
  const model: any = agent(createClaudeNative({ cliPath: fake }).languageModel("haiku"))
  const calls = () =>
    existsSync(join(dir, "log.jsonl"))
      ? readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      : []
  return { dir, model, calls }
}

const system = (dir: string) => ({ role: "system", content: `x\n<env>\n  Working directory: ${dir}\n</env>` })
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })

async function collect(stream: ReadableStream<any>) {
  const parts: any[] = []
  for await (const p of stream as any) parts.push(p)
  return parts
}

const uncaught: unknown[] = []
const onUncaught = (e: unknown) => uncaught.push(e)
process.on("uncaughtException", onUncaught)
afterEach(() => { uncaught.length = 0 })

test("agent turn streams the replayed frames and finishes", async () => {
  const { dir, model } = setup()
  const { stream } = await model.doStream({
    prompt: [system(dir), user("hi")],
    headers: { "x-opencode-session-id": "ses_a", "x-session-affinity": "ses_a" },
  })
  const parts = await collect(stream)
  expect(parts.filter((p) => p.type === "tool-call").length).toBe(5)
  expect(parts.at(-1).type).toBe("finish")
  expect(parts.at(-1).finishReason.unified).toBe("stop")
})

test("cancel mid-turn does not write to the closed stream", async () => {
  const { dir, model } = setup({ FAKE_CLAUDE_DELAY: "5" })
  const { stream } = await model.doStream({
    prompt: [system(dir), user("hi")],
    headers: { "x-opencode-session-id": "ses_b", "x-session-affinity": "ses_b" },
  })
  const reader = stream.getReader()
  for (;;) {
    const { value } = await reader.read()
    if (value?.type === "tool-input-start") break
  }
  await reader.cancel()
  await new Promise((r) => setTimeout(r, 1500))
  expect(uncaught).toEqual([])
})

test("cancel sends Claude's interrupt control request, not SIGTERM", async () => {
  const { dir, model, calls } = setup({ FAKE_CLAUDE_DELAY: "5" })
  const { stream } = await model.doStream({
    prompt: [system(dir), user("hi")],
    headers: { "x-opencode-session-id": "ses_c", "x-session-affinity": "ses_c" },
  })
  const reader = stream.getReader()
  for (;;) {
    const { value } = await reader.read()
    if (value?.type === "tool-input-start") break
  }
  await reader.cancel()
  await new Promise((r) => setTimeout(r, 500))
  const sent = calls().filter((c) => c.stdin).map((c) => c.stdin)
  expect(sent.some((m) => m.type === "control_request" && m.request.subtype === "interrupt")).toBe(true)
  // the interrupted turn still maps the opencode session to its Claude session
  const store = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))
  expect(Object.values(store)).toContain("b643f604-0e63-48da-bb83-1a55a333fc09")
})

test("missing claude binary fails the turn instead of throwing", async () => {
  const { dir } = setup()
  const model: any = createClaudeNative({ cliPath: join(dir, "no-such-claude") }).languageModel("haiku")
  for (const prompt of [[system(dir), user("hi")], [user("helper request")]]) {
    const { stream } = await model.doStream({ prompt, headers: { "x-opencode-session-id": "ses_d" } })
    const parts = await collect(stream)
    expect(parts.find((p) => p.type === "error")?.error.message).toContain("no-such-claude")
    expect(parts.at(-1).type).toBe("finish")
  }
  await new Promise((r) => setTimeout(r, 200))
  expect(uncaught).toEqual([])
})

test("child claude does not inherit a parent Claude Code session", async () => {
  const { dir, model, calls } = setup({ CLAUDE_CODE_SESSION_ID: "parent-session", CLAUDECODE: "1", CLAUDE_CODE_OAUTH_TOKEN: "keep-me" })
  try {
    const { stream } = await model.doStream({ prompt: [system(dir), user("hi")], headers: { "x-opencode-session-id": "ses_e" } })
    await collect(stream)
    const env = calls().find((c) => c.argv).env
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("keep-me")
  } finally {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  }
})

test("session map is keyed on x-opencode-session-id, not the shared affinity", async () => {
  const { dir, model } = setup()
  // a child session: affinity is the parent's id
  for (const id of ["ses_parent", "ses_child"]) {
    const { stream } = await model.doStream({
      prompt: [system(dir), user("hi")],
      headers: { "x-opencode-session-id": id, "x-session-affinity": "ses_parent" },
    })
    await collect(stream)
  }
  const store = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))
  expect(Object.keys(store).sort()).toEqual(["ses_child", "ses_parent"])
})

test("a model switch resumes the same Claude session with the new --model", async () => {
  const { dir, calls } = setup()
  const asst = { role: "assistant", content: [{ type: "text", text: "ok" }] }
  for (const [i, id] of ["haiku", "sonnet"].entries()) {
    const model: any = agent(createClaudeNative({ cliPath: fake }).languageModel(id))
    const { stream } = await model.doStream({ prompt: [system(dir), user("hi"), ...(i ? [asst, user("again")] : [])], headers: { "x-opencode-session-id": "ses_f" } })
    await collect(stream)
  }
  const argv = calls().filter((c) => c.argv).map((c) => c.argv)
  expect(argv[1]).toContain("sonnet")
  expect(argv[1][argv[1].indexOf("--resume") + 1]).toBe("b643f604-0e63-48da-bb83-1a55a333fc09")
})

test("sessions saved under the old <session>::<model> key still resume", async () => {
  const { dir, model, calls } = setup()
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ "ses_g::haiku": "old-claude-id" }))
  const { stream } = await model.doStream({ prompt: [system(dir), user("hi")], headers: { "x-opencode-session-id": "ses_g" } })
  await collect(stream)
  const argv = calls().find((c) => c.argv).argv
  expect(argv[argv.indexOf("--resume") + 1]).toBe("old-claude-id")
})

test("a fork's first turn branches the source's Claude session with --fork-session", async () => {
  const { dir, model, calls } = setup()
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ ses_src: "src-claude" }))
  const fork = { "x-opencode-session-id": "ses_fork", "x-session-affinity": "ses_src" }
  const { stream } = await model.doStream({ prompt: [system(dir), user("a"), assistant("b"), user("c")], headers: fork })
  await collect(stream)
  const argv = calls().find((c) => c.argv).argv
  expect(argv[argv.indexOf("--resume") + 1]).toBe("src-claude")
  expect(argv).toContain("--fork-session")
  const store = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))
  expect(store).toEqual({ ses_src: "src-claude", ses_fork: "b643f604-0e63-48da-bb83-1a55a333fc09" })
})

test("a child session does not resume or fork its parent's Claude session", async () => {
  const { dir, model, calls } = setup()
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ ses_par: "parent-claude" }))
  const child = { "x-opencode-session-id": "ses_kid", "x-session-affinity": "ses_par", "x-opencode-parent-session-id": "ses_par" }
  const { stream } = await model.doStream({ prompt: [system(dir), user("task")], headers: child })
  await collect(stream)
  const argv = calls().find((c) => c.argv).argv
  expect(argv).not.toContain("--resume")
  expect(argv).not.toContain("--fork-session")
})

test("Plan mode starts claude with --permission-mode plan", async () => {
  const { dir, model, calls } = setup()
  const reminder = user("<system-reminder>\nYou are in Plan mode. Discuss the plan with the user.\n</system-reminder>")
  const { stream } = await model.doStream({ prompt: [system(dir), reminder, user("refactor x")], headers: { "x-opencode-session-id": "ses_h" } })
  await collect(stream)
  const argv = calls().find((c) => c.argv).argv
  expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan")
  expect(argv).not.toContain("--dangerously-skip-permissions")
})

test("a pasted image reaches claude as an image block", async () => {
  const { dir, model, calls } = setup()
  const msg = { role: "user", content: [{ type: "text", text: "what is this" }, { type: "file", mediaType: "image/png", data: "QUJD" }] }
  const { stream } = await model.doStream({ prompt: [system(dir), msg], headers: { "x-opencode-session-id": "ses_i" } })
  await collect(stream)
  const sent = calls().find((c) => c.stdin?.type === "user").stdin
  expect(sent.message.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } })
  expect(sent.message.content[1]).toEqual({ type: "text", text: "what is this" })
})

const argvOf = (calls: () => any[]) => calls().filter((c) => c.argv).map((c) => c.argv)

test("compaction answers from a tool-free throwaway fork of the Claude session", async () => {
  const { dir, model, calls } = setup()
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ ses_k: "claude-k" }))
  const summarize = user("You MUST summarize the conversation above into a structured summary.\n\nDo not continue the task or call tools.")
  const { stream } = await model.doStream({ prompt: [system(dir), user("a"), assistant("b"), summarize], headers: { "x-opencode-session-id": "ses_k" } })
  const parts = await collect(stream)
  const [argv] = argvOf(calls)
  expect(argv[argv.indexOf("--resume") + 1]).toBe("claude-k")
  expect(argv).toContain("--fork-session")
  expect(argv).toContain("--no-session-persistence")
  expect(argv[argv.indexOf("--tools") + 1]).toBe("")
  expect(argv).not.toContain("--dangerously-skip-permissions")
  expect(calls().find((c) => c.stdin).stdin).toContain("Do not continue the task")
  expect(calls().find((c) => c.argv).cwd).toBe(dir)
  expect(parts.filter((p) => p.type === "tool-call").length).toBe(5) // fixture replays tools; real claude has none
  // opencode's summary replaces the history: no second Claude /compact, the session mapping is dropped so the next turn starts fresh
  expect(calls().filter((c) => c.argv).length).toBe(1)
  expect(JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))).toEqual({})
})

test("session generate (no output limit) is a side job too; without a Claude session it uses the text history", async () => {
  const { dir, model, calls } = setup()
  const { stream } = await model.doStream({
    prompt: [system(dir), user("a"), assistant("b"), user("write a commit message")],
    headers: { "x-opencode-session-id": "ses_l" },
    maxOutputTokens: undefined,
  })
  await collect(stream)
  const [argv] = argvOf(calls)
  expect(argv).not.toContain("--resume")
  expect(argv).toContain("--no-session-persistence")
  expect(argv).toContain("--system-prompt")
  expect(calls().find((c) => c.stdin).stdin).toContain("user: a")
  expect(existsSync(join(dir, "sessions.json"))).toBe(false)
})

test("a title request for a session that already has a Claude session does not wait for a first-turn title", async () => {
  const { dir, model, calls } = setup()
  writeFileSync(join(dir, "sessions.json"), JSON.stringify({ ses_m: "claude-m" }))
  const t0 = Date.now()
  const { stream } = await model.doStream({
    prompt: [{ role: "system", content: "You are a title generator. You output ONLY a thread title." }, user("rename me")],
    headers: { "x-opencode-session-id": "ses_m" },
    maxOutputTokens: undefined,
  })
  await collect(stream)
  expect(Date.now() - t0).toBeLessThan(5_000)
  expect(argvOf(calls)[0]).toContain("--system-prompt")
})

test("the first-turn title is handed to opencode's title request once, not to later regenerations", async () => {
  const { dir, model } = setup()
  const title = () => model.doStream({
    prompt: [{ role: "system", content: "You are a title generator. You output ONLY a thread title." }, user("hi")],
    headers: { "x-opencode-session-id": "ses_n" },
    maxOutputTokens: undefined,
  })
  const first = title() // opencode sends its title request before the first turn
  await collect((await model.doStream({ prompt: [system(dir), user("hi")], headers: { "x-opencode-session-id": "ses_n" } })).stream)
  const text = (parts: any[]) => parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")
  expect(text(await collect((await first).stream))).toBe("Fake title")
  expect(text(await collect((await title()).stream))).not.toBe("Fake title")
})

test("a failure before any output tells opencode not to retry; a transient one may be retried", async () => {
  const { dir } = setup()
  const model: any = agent(createClaudeNative({ cliPath: "/nonexistent/claude" }).languageModel("haiku"))
  const parts = await collect((await model.doStream({ prompt: [system(dir), user("hi")], headers: { "x-opencode-session-id": "ses_o" } })).stream)
  const err = parts.find((p) => p.type === "error").error
  expect(err.message).toContain("cannot run /nonexistent/claude")
  expect(err.isRetryable).toBe(false)
  expect(err.responseHeaders["x-should-retry"]).toBe("false")
  expect(parts.at(-1).finishReason.unified).toBe("error")
  expect(claudeError("API Error: 529 Overloaded").constructor).toBe(Error)
  expect((claudeError("model not found") as any).statusCode).toBe(400)
})

test("a turn sent right after Stop waits for the stopped claude and resumes its session", async () => {
  const { dir, model, calls } = setup({ FAKE_CLAUDE_DELAY: "5" })
  const h = { "x-opencode-session-id": "ses_stop", "x-session-affinity": "ses_stop" }
  const { stream } = await model.doStream({ prompt: [system(dir), user("long job")], headers: h })
  const reader = stream.getReader()
  for (;;) {
    const { value } = await reader.read()
    if (value?.type === "tool-input-start") break
  }
  await reader.cancel()
  // no pause: opencode starts the next turn as soon as the stream is cancelled
  const next = await model.doStream({ prompt: [system(dir), user("long job"), assistant("partial"), user("next")], headers: h })
  await collect(next.stream)
  const argv = calls().filter((c) => c.argv).map((c) => c.argv)
  expect(argv.length).toBe(2)
  expect(argv[1]).toContain("--resume")
  expect(argv[1][argv[1].indexOf("--resume") + 1]).toBe("b643f604-0e63-48da-bb83-1a55a333fc09")
})

test("opencodeInstructions keeps AGENTS.md, date and env, drops opencode's own prompt", () => {
  const sys = (text: string) => [{ role: "system", content: text }, { role: "user", content: [{ type: "text", text: "hi" }] }] as any
  const full = "You are an AI agent running in OpenCode\n# Code Mode\ntools...\n<available_skills></available_skills>\n\nInstructions from: /p/AGENTS.md\nRULE\n\nToday's date: X\n\n<env>\n  Working directory: /p\n</env>"
  expect(opencodeInstructions(sys(full))).toBe("Instructions from: /p/AGENTS.md\nRULE\n\nToday's date: X\n\n<env>\n  Working directory: /p\n</env>")
  expect(opencodeInstructions(sys("intro\nToday's date: X\n<env></env>"))).toBe("Today's date: X\n<env></env>")
  expect(opencodeInstructions(sys("You name conversations"))).toBe("")
})

test("compactCommand detects a typed /compact, with optional instructions", () => {
  const p = (t: string) => [{ role: "user", content: [{ type: "text", text: t }] }] as any
  expect(compactCommand(p("/compact "))).toBe("")
  expect(compactCommand(p("/compact keep the SQL"))).toBe("keep the SQL")
  expect(compactCommand(p("please /compact"))).toBeUndefined()
  expect(compactCommand(p("/compaction"))).toBeUndefined()
})

test("rewindPoint: undo is fewer assistant messages than recorded turns", () => {
  const ends = { 1: "u1", 2: "u2", 3: "u3" }
  expect(rewindPoint(ends, 3)).toBeUndefined()
  expect(rewindPoint(ends, 5)).toBeUndefined()
  expect(rewindPoint(ends, 2)).toEqual({ uuid: "u2", keep: { 1: "u1", 2: "u2" } })
  expect(rewindPoint(ends, 1)).toEqual({ uuid: "u1", keep: { 1: "u1" } })
  expect(rewindPoint(ends, 0)).toEqual({ uuid: null, keep: {} })
  expect(rewindPoint({}, 0)).toBeUndefined()
})

test("after /undo the next turn resumes at the recorded message; undoing everything starts fresh", async () => {
  const { dir, calls } = setup()
  const model: any = agent(createClaudeNative({ cliPath: fake }).languageModel("haiku"))
  const asst = { role: "assistant", content: [{ type: "text", text: "ok" }] }
  const turn = async (history: any[]) => {
    const { stream } = await model.doStream({ prompt: [system(dir), ...history], headers: { "x-opencode-session-id": "ses_u" } })
    await collect(stream)
  }
  await turn([user("one")])
  await turn([user("one"), asst, user("two")])
  await turn([user("one"), asst, user("two"), asst, user("three")])
  await turn([user("one"), asst, user("four")]) // /undo of turns two and three
  await turn([user("zero")]) // /undo of everything
  const argv = calls().filter((c) => c.argv).map((c) => c.argv)
  expect(argv[2]).not.toContain("--resume-session-at")
  expect(argv[3]).toContain("--resume-session-at")
  expect(argv[4]).not.toContain("--resume")
})

test("/context is detected and formatted like Claude's own breakdown", () => {
  const p = (t: string) => [{ role: "user", content: [{ type: "text", text: t }] }] as any
  expect(isContextCommand(p("/context "))).toBe(true)
  expect(isContextCommand(p("/context please"))).toBe(false)
  const out = formatContext({ total: 4715, max: 1_000_000, categories: [{ name: "Messages", tokens: 1650, kind: "used" }] })
  expect(out).toContain("**Tokens:** 4.7k / 1m (0.5%)")
  expect(out).toContain("| Messages | 1,650 | 0.2% |")
})
