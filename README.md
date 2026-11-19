# opencode-claude-plugin

**Use Claude Code inside [OpenCode](https://github.com/sst/opencode) with Claude's built-in tools, not MCP.** Same OpenCode UI, a fraction of the token cost.

OpenCode provider that runs the real `claude` CLI and renders its built-in tool calls as native OpenCode tools (`shell`, `read`, `edit`, `grep`, ...).

## Why

Every MCP tool you load adds its schema to every request, so context cost grows with each tool. Claude's built-in tools are cheap and already tuned for the model.

This plugin keeps Claude on its built-in tools and maps their names and inputs to OpenCode's, so the OpenCode UI shows them exactly like its own.

"hi" on Haiku, measured with `claude -p` (input + cache tokens):

| Setup | Tokens |
|---|---|
| Claude Code defaults (tools, MCP, skills, hooks) | 14.1k |
| **opencode-claude-plugin lean mode** (`Bash` + `Read`) | **2.5k** |

Need more tools? Set the `tools` option (e.g. `"Bash,Read,Edit,Grep"`) to enable more built-ins. Each one costs tokens only if you turn it on.

## What we cut

Cutting is the whole point. Every item below is switched off, so none of it lands in your context:

| Disabled | How |
|---|---|
| All built-in tools except `Bash` and `Read` | `--tools Bash,Read` |
| MCP servers and their tool schemas | `--strict-mcp-config` |
| Skills and slash commands | `--disable-slash-commands` |
| Settings, hooks, plugins | `--setting-sources ""` |
| `CLAUDE.md` files | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` |
| Auto memory | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| Git instructions in the prompt | `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` |
| Background tasks | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` |
| Claude Code's long system prompt | replaced by a short one (`systemPrompt` option) |

## How it works

```
OpenCode ──► claude CLI (stream-json) ──► Claude runs its own tools
   ▲                                              │
   └──── tool-name + input mapping ◄──────────────┘
          Bash→shell  Read→read  Edit→edit  Grep→grep  Agent→subagent ...
```

- Claude executes tools; OpenCode only renders and stores them.
- Streams text, thinking and tool input token by token.
- One OpenCode session = one Claude session (`--resume`, fork, Plan mode → read-only).
- Switch a session between Claude and any other provider without losing history.
- `/compact` runs Claude's own compaction on the real session (headless `claude --resume <id> "/compact"`), so Claude's context actually shrinks. OpenCode-triggered compaction (auto-compact included) does the same after writing its summary; set `compactClaude: false` to turn that off.
- Token counts match Claude's own `/context`: OpenCode shows the real context size of Claude's last API call (verified equal after normal turns, tool turns, undo and compact). Type `/context` in OpenCode for Claude's breakdown (system prompt, tools, messages).
- `/undo` rewinds Claude too: the plugin records Claude's last message per turn, and when OpenCode's history has fewer turns it resumes the transcript at that point (`--resume-session-at`); undo everything and a fresh Claude session starts from the history. File changes are not reverted by this; OpenCode's own snapshot revert handles files.
- Stop (Esc) interrupts Claude cleanly; failed auth/usage limits don't retry-loop.

## Install

Requires OpenCode 2.x, the [`claude` CLI](https://docs.claude.com/en/docs/claude-code) (logged in) and [Bun](https://bun.sh).

```bash
git clone https://github.com/santhoshkammari/opencode-claude-plugin
cd opencode-claude-plugin && bun install && bun run build
```

`opencode.json`:

```jsonc
{
  "plugins": ["/path/to/opencode-claude-plugin/dist/plugin"],   // provider switching
  "provider": {
    "claude-native": {
      "name": "Claude Native",
      "npm": "file:///path/to/opencode-claude-plugin/dist/index.js",
      "options": { "tools": "Bash,Read" },                       // optional; cliPath, systemPrompt too
      "models": {
        "haiku": { "name": "Haiku", "tool_call": true, "limit": { "context": 1000000, "output": 128000 } }
      }
    }
  }
}
```

Restart OpenCode after rebuilding; it caches the loaded plugin.

## Tests

```bash
bun run test        # offline, recorded stream + fake claude CLI
test/e2e.sh         # real opencode + Haiku
```

Live suites: `test/live_cases.py`, `test/live_api.py`, `test/live_switch.py`.

## Limits

A fork from an earlier message still gets the source's full Claude context. `--resume-session-at` is an undocumented Claude CLI flag; if a future CLI drops it, undo will fail loudly rather than silently keep stale context.

## License

MIT
