// opencode session id (x-opencode-session-id) -> Claude Code session id, persisted
// so a resumed opencode session continues the same Claude transcript.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const file = () =>
  process.env.OPENCODE_CLAUDE_NATIVE_STORE ?? join(homedir(), ".local/state/opencode-claude-native/sessions.json")

const load = (): Record<string, string> => {
  try { return existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {} } catch { return {} }
}

// One Claude session per opencode session, whatever the model: claude --resume takes a different --model, so a
// model switch keeps the conversation. Entries from older versions were keyed `<session>::<model>`.
export const getClaudeSession = (opencodeSession: string, legacyModel?: string): string | undefined => {
  const m = load()
  return m[opencodeSession] ?? (legacyModel ? m[`${opencodeSession}::${legacyModel}`] : undefined)
}
export function setClaudeSession(opencodeSession: string, id: string) {
  const m = load()
  m[opencodeSession] = id
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(m, null, 2))
}

// Compaction summaries Claude wrote while it had seen the whole conversation: opencode session -> summaryKey.
// The next turn then treats that checkpoint as already known instead of sending it to Claude again.
const summaries = () => file().replace(/\.json$/, "") + ".summaries.json"
const loadSummaries = (): Record<string, string> => {
  try { return existsSync(summaries()) ? JSON.parse(readFileSync(summaries(), "utf8")) : {} } catch { return {} }
}
export const getKnownSummary = (opencodeSession: string): string | undefined => loadSummaries()[opencodeSession]
export function setKnownSummary(opencodeSession: string, key: string | undefined) {
  const m = loadSummaries()
  if (key) m[opencodeSession] = key
  else delete m[opencodeSession]
  mkdirSync(dirname(summaries()), { recursive: true })
  writeFileSync(summaries(), JSON.stringify(m, null, 2))
}
