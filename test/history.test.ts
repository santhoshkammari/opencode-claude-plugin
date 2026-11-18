import { expect, test } from "bun:test"
import { buildPrompt } from "../src/model"
import { seenUpTo, summaryKey, upToDate } from "../src/history"
import { markAssistants, splitExecuted } from "../src/plugin"

const sys = { role: "system", content: "Working directory: /tmp" }
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const mark = (claude: boolean) => ({ ocn: { claude } })
const claudeSays = (text: string) => ({ role: "assistant", content: [{ type: "text", text, providerOptions: mark(true) }] })
const otherSays = (text: string, extra: any[] = []) => ({ role: "assistant", content: [{ type: "text", text, providerOptions: mark(false) }, ...extra] })

test("no switch: a resumed turn sends only the new user input", () => {
  const p: any = [sys, user("remember ALPHA"), claudeSays("OK"), user("what word?")]
  expect(buildPrompt(p, true)).toBe("what word?")
})

test("after another model's turn, Claude gets that turn (with its tools) before the request", () => {
  const p: any = [
    sys, user("remember ALPHA"), claudeSays("OK"),
    user("remember BRAVO and make b.txt"),
    otherSays("Creating it.", [{ type: "tool-call", toolCallId: "c1", toolName: "shell", input: { command: "echo hi > b.txt" } }]),
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "shell", output: { type: "text", value: "" } }] },
    otherSays("Done, BRAVO noted."),
    user("list both words"),
  ]
  const t = buildPrompt(p, true)
  expect(t).toContain("<conversation-update>")
  expect(t).toContain("user: remember BRAVO and make b.txt")
  expect(t).toContain("assistant (other model): Creating it.")
  expect(t).toContain('[tool call shell {"command":"echo hi > b.txt"}]')
  expect(t).toContain("Done, BRAVO noted.")
  expect(t).not.toContain("remember ALPHA")
  expect(t.endsWith("list both words")).toBe(true)
})

test("without the plugin's markers the old rule holds: everything up to the last assistant is known", () => {
  const p: any = [sys, user("a"), { role: "assistant", content: [{ type: "text", text: "x" }] }, user("b")]
  expect(buildPrompt(p, true)).toBe("b")
})

test("a checkpoint whose summary Claude wrote while up to date is known; another model's is sent", () => {
  const cp = (s: string) => user(`<conversation-checkpoint>\nThe following is a summary\n\n<summary>\n${s}\n</summary>\n</conversation-checkpoint>`)
  const p: any = [sys, cp("Goal: MANGO"), user("word?")]
  expect(buildPrompt(p, true, summaryKey("Goal: MANGO"))).toBe("word?")
  expect(buildPrompt(p, true)).toContain("Goal: MANGO")
  expect(seenUpTo((p as any[]).slice(1, 2), summaryKey("Goal: MANGO"))).toBe(0)
})

test("upToDate is false when another model spoke after Claude", () => {
  expect(upToDate([sys, user("a"), claudeSays("x"), user("c")] as any)).toBe(true)
  expect(upToDate([sys, user("a"), claudeSays("x"), user("b"), otherSays("y"), user("c")] as any)).toBe(false)
})

test("a new Claude session gets the earlier conversation, other model's tool calls included", () => {
  const p: any = [sys, user("make a.txt"), otherSays("ok", [{ type: "tool-call", toolCallId: "c", toolName: "write", input: { path: "a.txt" } }]), user("now?")]
  const t = buildPrompt(p, false)
  expect(t.startsWith("Earlier conversation:")).toBe(true)
  expect(t).toContain("[tool call write")
  expect(t.endsWith("Current request:\nnow?")).toBe(true)
})

test("plugin: Claude's executed tools become call + tool-result messages for other providers", () => {
  const m = {
    id: "msg1", role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "tool-call", id: "toolu_1", name: "shell", input: { command: "ls" }, providerExecuted: true },
      { type: "tool-result", id: "toolu_1", name: "shell", result: { type: "text", value: "a.txt" }, providerExecuted: true },
      { type: "text", text: "Found a.txt." },
      { type: "tool-call", id: "toolu_2", name: "read", input: { path: "a.txt" }, providerExecuted: true },
    ],
  }
  const out = splitExecuted([{ role: "user", content: [{ type: "text", text: "hi" }] }, m])
  expect(out.map((x) => x.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"])
  expect(out[1].id).toBe("msg1")
  expect(out[1].content.map((p) => p.type)).toEqual(["text", "tool-call"])
  expect(out[1].content[1].providerExecuted).toBeUndefined()
  expect(out[2].content[0]).toMatchObject({ type: "tool-result", id: "toolu_1", result: { value: "a.txt" } })
  expect(out[2].content[0].providerExecuted).toBeUndefined()
  expect(out[3].content.map((p) => p.type)).toEqual(["text", "tool-call"])
  expect(out[4].content[0]).toMatchObject({ id: "toolu_2", result: { type: "error" } }) // stopped before a result
})

test("plugin: other providers' messages pass through unchanged", () => {
  const m = { role: "assistant", content: [{ type: "tool-call", id: "c", name: "shell", input: {} }] }
  expect(splitExecuted([m])[0]).toBe(m)
})

test("plugin: marks say which assistant messages Claude made", () => {
  const out = markAssistants(
    [{ id: "a", role: "assistant", content: [{ type: "text", text: "x" }] }, { id: "b", role: "assistant", content: [{ type: "text", text: "y" }] }, { id: "u", role: "user", content: [] }],
    (id) => id === "a",
  )
  expect(out[0].content[0].providerMetadata).toEqual({ ocn: { claude: true } })
  expect(out[1].content[0].providerMetadata).toEqual({ ocn: { claude: false } })
  expect(out[2].content).toEqual([])
})

test("a known checkpoint still sends its verbatim recent part (it may hold another model's turn)", () => {
  const cp = user("<conversation-checkpoint>\nx\n\n<summary>\nGoal: INDIA\n</summary>\n\n<recent-context>\nuser: remember JULIET\n</recent-context>\n</conversation-checkpoint>")
  const t = buildPrompt([sys, cp, user("both words?")] as any, true, summaryKey("Goal: INDIA"))
  expect(t).toContain("remember JULIET")
  expect(t).not.toContain("Goal: INDIA")
})

test("opencode's system updates for the other model are left out of the record", () => {
  const p: any = [sys, user("a"), claudeSays("x"), user("<system-update>\nThe Code Mode tool catalog has changed.\n</system-update>"), user("b"), otherSays("y"), user("c")]
  const t = buildPrompt(p, true)
  expect(t).not.toContain("Code Mode")
  expect(t).toContain("user: b")
})
