#!/usr/bin/env bash
# E2E: real opencode (standalone) + real claude Haiku. Checks tool parts land in opencode's store,
# files change in the project dir, and a 2nd opencode turn resumes the same Claude session.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); (cd "$ROOT" && bun run build >/dev/null)
D=$(mktemp -d); cd "$D"
cat > opencode.json <<J
{"provider":{"claude-native":{"name":"Claude Native","npm":"file://$ROOT/dist/index.js",
 "models":{"haiku":{"name":"Haiku","tool_call":true,"limit":{"context":200000,"output":8192}}}}}}
J
export OPENCODE_CLAUDE_NATIVE_STORE="$D/sessions.json"
# private data dir: fast startup (the real opencode.db is 3 GB) and no test sessions in the user's history
export XDG_DATA_HOME="$D/data"
opencode run --standalone -m claude-native/haiku </dev/null \
  "Use bash to run: echo hi. Then write f.txt containing x, read f.txt, edit f.txt changing x to y, and webfetch https://example.com. Reply DONE." > t1.txt
SES=$(python3 -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('select id from session_v2 order by time_created desc limit 1').fetchone()[0])" "$D/data/opencode/opencode.db")
opencode run --standalone -m claude-native/haiku -s "$SES" "What does f.txt contain? One character only." </dev/null > t2.txt
python3 - "$D" "$SES" <<'PY'
import json, sqlite3, sys, os
d, ses = sys.argv[1:]
c = sqlite3.connect(os.path.join(d, "data/opencode/opencode.db"))
rows = c.execute("select data from session_message where session_id=? and type='assistant' order by seq", (ses,)).fetchall()
tools = [x for r in rows for x in json.loads(r[0])["content"] if x["type"] == "tool"]
first = [t for t in tools if t["id"] in {t2["id"] for t2 in json.loads(rows[0][0])["content"] if t2["type"] == "tool"}]
got = [(t["name"], t["state"]["status"], t["executed"]) for t in first]
print("stored tool parts:", got)
names = {g[0] for g in got}
assert {"shell", "write", "read", "edit", "webfetch"} <= names, got  # Haiku may retry or reorder; each tool must surface
assert all(g[2] for g in got), got  # every one is marked executed-by-provider
# opencode 2 reads input.path for read/write/edit (TUI shows blank paths otherwise)
assert all(t["state"]["input"].get("path", "").endswith("f.txt") for t in first if t["name"] in ("read", "write", "edit")), first
assert first[0]["name"] == "shell" and first[0]["state"]["content"][0]["text"].strip() == "hi", first[0]
assert open(f"{d}/f.txt").read().strip() == "y"
store = json.load(open(f"{d}/sessions.json")); assert store[ses], store
assert "y" in open(f"{d}/t2.txt").read(), open(f"{d}/t2.txt").read()
print("OK opencode", ses, "-> claude", store[ses])
PY
