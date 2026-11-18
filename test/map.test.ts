import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Mapper, mapInput, toolName } from "../src/map"

const parts = () => {
  const m = new Mapper()
  const out = readFileSync(new URL("./fixtures/haiku-5tools.jsonl", import.meta.url), "utf8")
    .trim().split("\n").flatMap((l) => m.feed(JSON.parse(l)))
  return { m, out }
}

test("emits one providerExecuted call+result per rendered tool, in order", () => {
  const { out } = parts()
  const calls = out.filter((p) => p.type === "tool-call")
  expect(calls.map((c) => c.toolName)).toEqual(["shell", "read", "write", "edit", "webfetch"])
  expect(calls.every((c) => c.providerExecuted)).toBe(true)
  const results = out.filter((p) => p.type === "tool-result")
  expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.toolCallId))
  expect(results[0].result).toBe("hi")
})

test("ToolSearch is not rendered; text blocks are balanced", () => {
  const { out } = parts()
  expect(out.some((p) => p.toolName === "ToolSearch")).toBe(false)
  const starts = out.filter((p) => p.type === "text-start").length
  expect(out.filter((p) => p.type === "text-end").length).toBe(starts)
  expect(out.filter((p) => p.type === "tool-input-start").length).toBe(5)
})

test("inputs mapped to opencode 2 keys (path, camelCase)", () => {
  const { out } = parts()
  const by = (n: string) => JSON.parse(out.find((p) => p.type === "tool-call" && p.toolName === n)!.input)
  expect(by("read").path).toMatch(/a\.txt$/)
  expect(by("write").path).toMatch(/b\.txt$/)
  expect(by("edit").path).toMatch(/\.txt$/)
  expect(by("write").content).toBe("x")
  expect(by("edit")).toMatchObject({ oldString: "x", newString: "y", replaceAll: false })
  expect(by("webfetch")).toEqual({ url: "https://example.com", format: "markdown" })
  expect(mapInput("Bash", { command: "ls" }).description).toBe("ls")
  expect(mapInput("Grep", { pattern: "x", path: "src", glob: "*.ts" })).toEqual({ pattern: "x", path: "src", include: "*.ts" })
  expect(mapInput("Agent", { subagent_type: "Explore", description: "d", prompt: "p" })).toEqual({ agent: "Explore", description: "d", prompt: "p" })
  expect(mapInput("Skill", { skill: "pdf" })).toEqual({ id: "pdf" })
})

test("every Claude tool except ToolSearch is shown; unmapped ones keep Claude's name", () => {
  expect(toolName("Glob")).toBe("glob")
  expect(toolName("Agent")).toBe("subagent")
  expect(toolName("TodoWrite")).toBe("TodoWrite")
  expect(toolName("mcp__srv__do")).toBe("mcp__srv__do")
  expect(toolName("ToolSearch")).toBeUndefined()
  const m = new Mapper()
  const ev = (event: any) => m.feed({ type: "stream_event", event })
  const out = [
    ...ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "TodoWrite", input: {} } }),
    ...ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"todos":[]}' } }),
    ...ev({ type: "content_block_stop", index: 0 }),
    ...m.feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  ]
  expect(out.map((p) => p.type)).toEqual(["tool-input-start", "tool-input-delta", "tool-input-end", "tool-call", "tool-result"])
  expect(out.at(-1)).toMatchObject({ toolName: "TodoWrite", result: "ok", providerExecuted: true })
})

test("captures session id and usage from result", () => {
  const { m } = parts()
  expect(m.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  expect(m.usage.outputTokens).toBeGreaterThan(0)
})

import { buildContent, buildPrompt, inPlanMode, mediaBlock, workingDir } from "../src/model"
test("cwd comes from opencode's system prompt, settings are only a fallback", () => {
  const p: any = [{ role: "system", content: "x\n  Working directory: /a/b c\n y" }]
  expect(workingDir(p, "/fallback")).toBe("/a/b c")
  expect(workingDir([{ role: "system", content: "none" }] as any, "/fallback")).toBe("/fallback")
})
test("prompt: resumed session sends only the new user turn; fresh one replays history", () => {
  const p: any = [
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "text", text: "ans" }] },
    { role: "user", content: [{ type: "text", text: "two" }] },
  ]
  expect(buildPrompt(p, true)).toBe("two")
  expect(buildPrompt(p, false)).toContain("user: one")
  expect(buildPrompt(p, false)).toContain("Current request:\ntwo")
})
test("prompt: every user message after the last reply is sent (steers, reminders, updates)", () => {
  const u = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const p: any = [u("one"), { role: "assistant", content: [{ type: "text", text: "ans" }] }, u("<system-reminder>plan</system-reminder>"), u("two"), u("three")]
  expect(buildPrompt(p, true)).toBe("<system-reminder>plan</system-reminder>\n\ntwo\n\nthree")
  expect(buildPrompt(p, false)).toContain("Current request:\n<system-reminder>plan</system-reminder>\n\ntwo\n\nthree")
  // first turn: no history wrapper, all user messages
  expect(buildPrompt([u("reminder"), u("go")] as any, false)).toBe("reminder\n\ngo")
})
test("plan mode follows the newest opencode Plan reminder", () => {
  const u = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const on = u("<system-reminder>\nYou are in Plan mode. Discuss the plan...\n</system-reminder>")
  const off = u("<system-reminder>\nYou are NO LONGER in Plan mode. The previous...\n</system-reminder>")
  expect(inPlanMode([u("hi")] as any)).toBe(false)
  expect(inPlanMode([on, u("hi")] as any)).toBe(true)
  expect(inPlanMode([on, u("hi"), off, u("go")] as any)).toBe(false)
  expect(inPlanMode([u("You are in Plan mode.")] as any)).toBe(false) // only opencode's reminder counts
})
test("cwd follows the newest <env> block, including escaped system updates", () => {
  const p: any = [
    { role: "system", content: "x\n<env>\n  Working directory: /old\n</env>" },
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "<system-update>\nThe environment you are running in is now:\n&lt;env&gt;\n  Working directory: /new &amp; dir\n&lt;/env&gt;\n</system-update>" }] },
  ]
  expect(workingDir(p, "/fallback")).toBe("/new & dir")
  expect(workingDir(p.slice(0, 2), "/fallback")).toBe("/old")
  // a user merely typing the words does not move the directory
  expect(workingDir([p[0], { role: "user", content: "Working directory: /evil" }] as any)).toBe("/old")
})
test("images and PDFs become Claude content blocks; other files are skipped", () => {
  expect(mediaBlock({ mediaType: "image/png", data: "QUJD" })).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } })
  expect(mediaBlock({ mediaType: "image/png", data: new Uint8Array([65, 66, 67]) })).toMatchObject({ source: { data: "QUJD" } })
  expect(mediaBlock({ mediaType: "image/jpeg", data: new URL("data:image/jpeg;base64,QUJD") })).toMatchObject({ source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } })
  expect(mediaBlock({ mediaType: "image/png", data: new URL("https://x.test/a.png") })).toEqual({ type: "image", source: { type: "url", url: "https://x.test/a.png" } })
  expect(mediaBlock({ mediaType: "application/pdf", data: "QUJD" })).toMatchObject({ type: "document" })
  expect(mediaBlock({ mediaType: "text/plain", data: "QUJD" })).toBeUndefined()
  const p: any = [
    { role: "user", content: [{ type: "text", text: "old" }, { type: "file", mediaType: "image/png", data: "T0xE" }] },
    { role: "assistant", content: [{ type: "text", text: "ans" }] },
    { role: "user", content: [{ type: "text", text: "look" }, { type: "file", mediaType: "image/png", data: "QUJD" }] },
  ]
  expect(buildContent(p, true)).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }, { type: "text", text: "look" }])
  expect(buildContent(p.slice(0, 2), true)).toBe("Continue.")
})
