#!/usr/bin/env python3
"""Live cases for Stop and for switching between claude-native and another provider (both ways), with compaction.

Private `opencode serve` per case, real claude Haiku, plus an OpenAI-compatible model (default: the local Ornith on
gpu4; set OCN_OTHER_URL / OCN_OTHER_MODEL). Loads the server plugin from dist/plugin.
Usage: python3 test/live_switch.py [CASE ...]
"""
import base64, json, os, re, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_api as L  # noqa: E402

OTHER_URL = os.environ.get("OCN_OTHER_URL", "http://localhost:8000/v1")
OTHER_ID = os.environ.get("OCN_OTHER_MODEL", "Ornith-1.5-35B-A3B-NVFP4")
OTHER = {"providerID": "other", "id": OTHER_ID}
HAIKU = L.MODEL


class Server(L.Server):
    def __init__(self):
        super().__init__()  # writes the claude-native config and starts; restart with the full config
        self.close()
        cfg = json.load(open(f"{self.d}/opencode.json"))
        cfg["provider"]["other"] = {"name": "other", "npm": "@ai-sdk/openai-compatible", "options": {"baseURL": OTHER_URL},
                                    "models": {OTHER_ID: {"name": "other", "tool_call": True,
                                                          "limit": {"context": 131072, "output": 8192}}}}
        cfg["plugins"] = [f"{L.ROOT}/dist/plugin"]
        json.dump(cfg, open(f"{self.d}/opencode.json", "w"))
        env = dict(os.environ, PWD=self.d, XDG_DATA_HOME=f"{self.d}/data",
                   OPENCODE_CLAUDE_NATIVE_STORE=f"{self.d}/sessions.json", OCN_DUMP=f"{self.d}/dump.jsonl")
        for k in ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"):
            env.pop(k, None)
        self.log = open(f"{self.d}/serve.log", "w")
        self.p = subprocess.Popen(["opencode", "serve", "--hostname", "127.0.0.1", "--port", str(self.port)],
                                  cwd=self.d, env=env, stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(60):
            time.sleep(0.5)
            m = re.search(r"server password (\S+)", open(f"{self.d}/serve.log").read())
            if m:
                self.auth = "Basic " + base64.b64encode(f"opencode:{m.group(1)}".encode()).decode()
                return
        raise RuntimeError("opencode serve did not start")

    def switch(self, ses, model):
        self.call("POST", f"/api/session/{ses}/model", {"model": model})

    def say(self, ses, text):
        self.prompt(ses, text)
        self.wait(ses)
        time.sleep(1)
        return L.texts(self.messages(ses))[-1]

    def errors(self, ses):  # failures, not the mark a stopped turn gets
        return [e for m in self.messages(ses) if m.get("type") == "assistant" and m.get("error")
                for e in [m["error"].get("message", "")[:160]] if "interrupted" not in e.lower()]

    def claude_prompts(self):  # text claude-native agent turns got, oldest first
        return [x for x in self.dump() if "prompt" in x and x.get("maxOutputTokens") and "Working directory" in json.dumps(x["prompt"][:1])]

    def dump(self):  # requests and trace lines
        f = f"{self.d}/dump.jsonl"
        return [json.loads(l) for l in open(f)] if os.path.exists(f) else []

    def file(self, name):
        p = f"{self.d}/{name}"
        return open(p).read().strip() if os.path.exists(p) else None


def last_input(s, ses):
    """The last user input in the session's Claude transcript (what the plugin really sent to Claude)."""
    cid = s.store().get(ses)
    users = [json.loads(l) for l in (L.transcript(cid) if cid else "").splitlines() if json.loads(l).get("type") == "user"]
    users = [u for u in users if "tool_result" not in json.dumps(u["message"].get("content", ""))]
    return json.dumps(users[-1]["message"]["content"]) if users else ""


def claude_got(s, cid, word):
    """True if the word reached Claude's transcript as user input."""
    return any(word in json.dumps(json.loads(l).get("message", {}).get("content", ""))
               for l in L.transcript(cid).splitlines() if json.loads(l).get("type") == "user")


def case_SW1(s):  # claude (with a tool) -> other -> claude
    ses = s.session()
    a = s.say(ses, "Remember code word ALPHA. Run the shell command `echo hello-from-claude > a.txt`. Reply OK.")
    cid = s.store().get(ses)
    s.switch(ses, OTHER)
    b = s.say(ses, "Which code word did I give earlier, and what text did the earlier shell command write to a.txt? "
                   "Then remember a second code word BRAVO and run `echo hi > b.txt` with your shell tool. Be brief.")
    s.switch(ses, HAIKU)
    c = s.say(ses, "From memory of this conversation only, no tools: list both code words and the files created.")
    errs = s.errors(ses)
    same = s.store().get(ses) == cid
    ok = (not errs and "ALPHA" in b.upper() and "hello-from-claude" in b and s.file("b.txt") == "hi"
          and "ALPHA" in c.upper() and "BRAVO" in c.upper() and same and claude_got(s, cid, "BRAVO"))
    return ok, f"errors={errs} other={b[-200:]!r} claude={c[-200:]!r} same-claude-session={same}"


def case_SW2(s):  # other first (no Claude session yet) -> claude -> other -> claude
    ses = s.session()
    s.switch(ses, OTHER)
    s.say(ses, "Remember code word CEDAR. Reply OK.")
    s.switch(ses, HAIKU)
    a = s.say(ses, "What code word did I give? Then remember a second one: DELTA. Reply briefly.")
    s.switch(ses, OTHER)
    b = s.say(ses, "List every code word so far. Then remember ECHO too. Reply briefly.")
    s.switch(ses, HAIKU)
    c = s.say(ses, "List every code word so far, in order.")
    errs = s.errors(ses)
    ok = not errs and "CEDAR" in a.upper() and "DELTA" in b.upper() and all(w in c.upper() for w in ("CEDAR", "DELTA", "ECHO"))
    return ok, f"errors={errs} claude1={a[-120:]!r} other={b[-120:]!r} claude2={c[-160:]!r}"


def case_SW3(s):  # claude -> other -> compaction by other -> claude
    ses = s.session()
    s.say(ses, "Remember code word FOXTROT. Reply OK.")
    s.switch(ses, OTHER)
    s.say(ses, "Remember a second code word GOLF. Reply OK.")
    s.call("POST", f"/api/session/{ses}/compact", {})
    s.wait(ses)
    s.switch(ses, HAIKU)
    c = s.say(ses, "List both code words.")
    errs = s.errors(ses)
    upd = last_input(s, ses)
    ok = not errs and "FOXTROT" in c.upper() and "GOLF" in c.upper() and "conversation-update" in upd
    return ok, f"errors={errs} claude={c[-160:]!r} update-sent={'conversation-update' in upd}"


def case_SW4(s):  # compaction by claude while up to date: the next turn does not resend the summary
    ses = s.session()
    s.say(ses, "Remember code word HOTEL. Reply OK.")
    s.call("POST", f"/api/session/{ses}/compact", {})
    s.wait(ses)
    c = s.say(ses, "What is the code word? Only the word.")
    upd = last_input(s, ses)
    ok = not s.errors(ses) and "HOTEL" in c.upper() and "conversation-update" not in upd
    return ok, f"errors={s.errors(ses)} claude={c!r} update-sent={'conversation-update' in upd}"


def case_SW5(s):  # claude -> other -> back to claude -> compaction by claude -> claude
    ses = s.session()
    s.say(ses, "Remember code word INDIA. Reply OK.")
    s.switch(ses, OTHER)
    s.say(ses, "Remember a second code word JULIET. Reply OK.")
    s.switch(ses, HAIKU)
    s.call("POST", f"/api/session/{ses}/compact", {})
    s.wait(ses)
    c = s.say(ses, "List both code words.")
    ok = not s.errors(ses) and "INDIA" in c.upper() and "JULIET" in c.upper()
    return ok, f"errors={s.errors(ses)} claude={c[-160:]!r}"


def running_claude(s):
    out = subprocess.run(["ps", "-eo", "pid,args"], capture_output=True, text=True).stdout
    pids = [l.split()[0] for l in out.splitlines() if "stream-json" in l and "claude" in l]
    return [p for p in pids if os.path.exists(f"/proc/{p}/cwd") and os.path.realpath(f"/proc/{p}/cwd").startswith(s.d)]


def wait_for(pred, t=120):
    for _ in range(int(t / 0.5)):
        if pred():
            return True
        time.sleep(0.5)
    return False


def assistant_chars(s, ses):
    return sum(len(c.get("text", "")) for m in s.messages(ses) if m.get("type") == "assistant"
               for c in m.get("content", []) if c.get("type") == "text")


def has_tool(s, ses, name=None):
    return any(c.get("type") == "tool" and (name is None or c.get("name") == name)
               for m in s.messages(ses) if m.get("type") == "assistant" for c in m.get("content", []))


def case_ST1(s):  # Stop while Claude writes text, then send at once: same Claude session, interrupt recorded
    ses = s.session()
    s.prompt(ses, "Write a 1500 word story about a lighthouse keeper. No tools.")
    # opencode's API shows text only when a block ends; the plugin's trace says when Claude starts writing
    wait_for(lambda: any(x.get("event") == "block" and x.get("kind") == "text" for x in s.dump()))
    time.sleep(2)
    s.call("POST", f"/api/session/{ses}/interrupt")
    cid = s.store().get(ses)
    ans = s.say(ses, "Reply with the single word PONG and nothing else.")
    t = L.transcript(cid) if cid else ""
    gone = wait_for(lambda: not running_claude(s), 15)
    first = [json.loads(l) for l in t.splitlines()]
    stops = [j["message"].get("stop_reason") for j in first if j.get("type") == "assistant"]
    results = [x for x in s.dump() if x.get("event") == "result"]
    stopped = bool(results) and results[0].get("subtype") != "success"  # the first turn ended by the interrupt
    ok = cid and s.store().get(ses) == cid and stopped and "PONG" in ans.upper() and gone \
        and "Earlier conversation" not in json.dumps(s.claude_prompts()[-1]["prompt"])
    return ok, (f"claude-id-saved-at-stop={bool(cid)} same={s.store().get(ses) == cid} "
                f"first-turn-result={results[0] if results else None} stop-reasons={stops} answer={ans!r} no-claude-left={gone}")


def case_ST2(s):  # Stop during a subagent: claude exits, nothing keeps running
    ses = s.session()
    s.prompt(ses, "Use the Agent tool (general-purpose subagent) to run the shell command "
                  "`python3 -c 'import time; time.sleep(40)' && echo done > sub.txt` and report back.")
    started = wait_for(lambda: has_tool(s, ses, "subagent"), 90)
    time.sleep(4)
    s.call("POST", f"/api/session/{ses}/interrupt")
    gone = wait_for(lambda: not running_claude(s), 15)
    time.sleep(40)
    ok = started and gone and s.file("sub.txt") is None
    return ok, f"subagent-started={started} claude-exited={gone} sub.txt={s.file('sub.txt')!r}"


def case_ST3(s):  # Stop during a Claude shell tool, then switch to the other provider at once
    ses = s.session()
    s.prompt(ses, "Run this bash command in the foreground: python3 -c 'import time; time.sleep(30)' && echo done > m.txt")
    wait_for(lambda: has_tool(s, ses, "shell"), 90)
    time.sleep(2)
    s.call("POST", f"/api/session/{ses}/interrupt")
    s.switch(ses, OTHER)
    b = s.say(ses, "Was the previous shell command finished or stopped? One short sentence.")
    time.sleep(30)
    ok = not s.errors(ses) and b.strip() and s.file("m.txt") is None
    return ok, f"errors={s.errors(ses)} other={b[-200:]!r} m.txt={s.file('m.txt')!r}"


CASES = {k[5:]: v for k, v in globals().items() if k.startswith("case_")}

if __name__ == "__main__":
    subprocess.run(["bun", "run", "build"], cwd=L.ROOT, check=True, capture_output=True)
    picked = sys.argv[1:] or list(CASES)
    results = {}
    for name in picked:
        s = Server()
        t0 = time.time()
        try:
            ok, ev = CASES[name](s)
        except Exception as e:  # noqa: BLE001 - report and go on
            ok, ev = False, f"{type(e).__name__}: {e}"
        finally:
            s.close()
        results[name] = bool(ok)
        print(f"{'PASS' if ok else 'FAIL'} {name} ({time.time() - t0:.0f}s) dir={s.d}: {ev}", flush=True)
    sys.exit(0 if all(results.values()) else 1)
