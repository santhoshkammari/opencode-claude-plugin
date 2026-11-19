#!/usr/bin/env node
// Offline stand-in for the `claude` CLI, used by test/model.test.ts.
// Logs argv, cwd, selected env and every stdin line to $FAKE_CLAUDE_LOG (JSONL), then replays
// $FAKE_CLAUDE_FIXTURE (stream-json lines) to stdout, $FAKE_CLAUDE_DELAY ms apart.
// Stream-json input: replays after the first user message, answers control requests, and exits when
// stdin closes after the result (like the real CLI). Plain -p: reads all stdin first.
import { appendFileSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"

const log = (o) => process.env.FAKE_CLAUDE_LOG && appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + "\n")
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CLAUDE") || k === "ANTHROPIC_API_KEY"))
log({ argv: process.argv.slice(2), cwd: process.cwd(), env })

const lines = readFileSync(process.env.FAKE_CLAUDE_FIXTURE, "utf8").trim().split("\n")
const delay = Number(process.env.FAKE_CLAUDE_DELAY ?? 0)
const session = JSON.parse(lines[0]).session_id
const out = (o) => process.stdout.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let interrupted = false
let exitCode = 0
let stdinClosed = false
let resultSent = false
const finish = () => { if (stdinClosed && resultSent) process.exit(exitCode) }

async function replay() {
  for (const line of lines) {
    if (interrupted) return
    if (delay) await sleep(delay)
    if (interrupted) return
    out(line)
    if (JSON.parse(line).type === "result") resultSent = true
  }
  finish()
}

if (process.argv.includes("stream-json") && process.argv[process.argv.indexOf("--input-format") + 1] === "stream-json") {
  let started = false
  createInterface({ input: process.stdin }).on("line", (line) => {
    const f = JSON.parse(line)
    log({ stdin: f })
    if (f.type === "control_request" && f.request.subtype === "interrupt") {
      interrupted = true
      exitCode = 1
      out({ type: "control_response", response: { subtype: "success", request_id: f.request_id, response: {} } })
      out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: session, usage: {} })
      resultSent = true
      finish()
    } else if (f.type === "control_request" && f.request.subtype === "get_context_usage") {
      out({ type: "control_response", response: { subtype: "success", request_id: f.request_id, response: { totalTokens: 4321, maxTokens: 1000000, categories: [] } } })
    } else if (f.type === "control_request" && f.request.subtype === "generate_session_title") {
      out({ type: "control_response", response: { subtype: "success", request_id: f.request_id, response: { title: "Fake title" } } })
    } else if (f.type === "user" && !started) {
      started = true
      replay()
    }
  }).on("close", () => { stdinClosed = true; finish() })
} else {
  let input = ""
  process.stdin.on("data", (d) => (input += d)).on("end", () => {
    log({ stdin: input })
    stdinClosed = true
    replay()
  })
}
