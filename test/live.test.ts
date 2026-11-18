// Live test: real `claude` (Haiku) driven through the provider's doStream, exactly as opencode would.
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClaudeNative } from "../src/index"

const dir = mkdtempSync(join(tmpdir(), "ocn-"))
process.env.OPENCODE_CLAUDE_NATIVE_STORE = join(dir, "sessions.json")
const model = createClaudeNative({ cwd: dir }).languageModel("haiku")

async function turn(text: string, session: string) {
  const { stream } = await (model as any).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
    headers: { "x-session-affinity": session },
    maxOutputTokens: 8192,
  })
  const parts: any[] = []
  for await (const p of stream as any) parts.push(p)
  return parts
}

test("haiku: bash/write/read/edit run in Claude, surface as opencode tool parts", async () => {
  const parts = await turn(
    "Do exactly these: 1) bash: echo hi  2) write f.txt containing x  3) read f.txt  4) edit f.txt changing x to y. Then reply DONE.",
    "ses_A",
  )
  const names = parts.filter((p) => p.type === "tool-call").map((p) => p.toolName)
  expect(names).toEqual(["shell", "write", "read", "edit"])
  expect(parts.filter((p) => p.type === "tool-result").length).toBe(4)
  expect(readFileSync(join(dir, "f.txt"), "utf8").trim()).toBe("y")
  const fin = parts.at(-1)
  expect(fin.type).toBe("finish")
  expect(fin.finishReason.unified).toBe("stop")
}, 120_000)

test("session mapping: same opencode session resumes same Claude session", async () => {
  const store = JSON.parse(readFileSync(process.env.OPENCODE_CLAUDE_NATIVE_STORE!, "utf8"))
  const id = store["ses_A"]
  expect(id).toBeTruthy()
  const parts = await turn("What did f.txt contain after my edit? Answer with just the character.", "ses_A")
  const text = parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")
  expect(text).toContain("y")
  expect(JSON.parse(readFileSync(process.env.OPENCODE_CLAUDE_NATIVE_STORE!, "utf8"))["ses_A"]).toBe(id)
}, 120_000)
