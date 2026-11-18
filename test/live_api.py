#!/usr/bin/env python3
"""Live cases from test.md that need opencode's HTTP API (interrupt, steer, move, compact, generate).

Starts a private `opencode serve` on a scratch project with real claude Haiku, drives it over the API and checks
the opencode DB, the plugin's session map and the Claude transcripts. Usage: python3 test/live_api.py [CASE ...]
"""
import base64, json, os, re, socket, subprocess, sys, tempfile, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR", os.path.expanduser("~/.claude"))
MODEL = {"providerID": "claude-native", "id": "haiku"}


class Server:
    def __init__(self):
        self.d = tempfile.mkdtemp(prefix="ocn-api-")
        subprocess.run(["git", "init", "-q", self.d], check=True)
        json.dump({"provider": {"claude-native": {"name": "Claude Native", "npm": f"file://{ROOT}/dist/index.js",
                   "models": {"haiku": {"name": "haiku", "tool_call": True, "limit": {"context": 200000, "output": 8192}}}}}},
                  open(f"{self.d}/opencode.json", "w"))
        s = socket.socket(); s.bind(("127.0.0.1", 0)); self.port = s.getsockname()[1]; s.close()
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

    def call(self, method, path, body=None, directory=None, timeout=300):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"authorization": self.auth, "content-type": "application/json",
                                              "x-opencode-directory": directory or self.d})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else None

    def session(self):
        return self.call("POST", "/api/session", {"model": MODEL})["data"]["id"]

    def prompt(self, ses, text, **kw):
        return self.call("POST", f"/api/session/{ses}/prompt", {"text": text, **kw})

    def wait(self, ses):
        self.call("POST", f"/api/experimental/session/{ses}/wait")

    def messages(self, ses):
        return self.call("GET", f"/api/session/{ses}/message")["data"]

    def store(self):
        return json.load(open(f"{self.d}/sessions.json")) if os.path.exists(f"{self.d}/sessions.json") else {}

    def dump(self):
        return [x for x in map(json.loads, open(f"{self.d}/dump.jsonl")) if "prompt" in x] if os.path.exists(f"{self.d}/dump.jsonl") else []

    def close(self):
        self.p.terminate()
        try: self.p.wait(10)
        except subprocess.TimeoutExpired: self.p.kill()


def texts(msgs):
    out = []
    for m in sorted(msgs, key=lambda m: m.get("time", {}).get("created", 0)):  # the API lists newest first
        if m.get("type") == "assistant":
            out.append("".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text"))
    return out


def transcript(cid):
    for root, _, files in os.walk(f"{CLAUDE_DIR}/projects"):
        if f"{cid}.jsonl" in files:
            return open(os.path.join(root, f"{cid}.jsonl")).read()
    return ""


def claude_children(port_dir):
    out = subprocess.run(["ps", "-eo", "pid,args"], capture_output=True, text=True).stdout
    return [l for l in out.splitlines() if "stream-json" in l and "claude" in l and port_dir in l]


def log_has(s, pattern):
    logs = os.path.join(s.d, "data/opencode/log")
    return any(re.search(pattern, open(os.path.join(logs, f), errors="replace").read()) for f in os.listdir(logs)) or \
        bool(re.search(pattern, open(f"{s.d}/serve.log", errors="replace").read()))


def case_AB(s):  # interrupt: no uncaught error; goes through Claude's interrupt; next turn knows
    ses = s.session()
    s.prompt(ses, "Run this bash command exactly, in the foreground: python3 -c 'import time; time.sleep(30)' && echo done > marker.txt")
    for _ in range(120):  # wait until the shell tool is running
        time.sleep(0.5)
        if any(c.get("type") == "tool" for m in s.messages(ses) if m.get("type") == "assistant" for c in m.get("content", [])):
            break
    time.sleep(2)
    r = s.call("POST", f"/api/session/{ses}/interrupt")
    s.wait(ses)
    time.sleep(4)  # marker would appear 30 s after start if the command were not stopped
    marker = os.path.exists(f"{s.d}/marker.txt")
    uncaught = log_has(s, r"uncaught|Controller is already closed")
    cid = s.store().get(ses)
    t = transcript(cid) if cid else ""
    s.prompt(ses, "Was your last command interrupted? Answer yes or no, one sentence.")
    s.wait(ses)
    ans = texts(s.messages(ses))[-1]
    time.sleep(26)
    marker = marker or os.path.exists(f"{s.d}/marker.txt")
    ok = r.get("interrupted") and not uncaught and "interrupted by user" in t and not marker and "yes" in ans.lower()
    return ok, f"interrupt={r} uncaught={uncaught} transcript-interrupt={'interrupted by user' in t} marker={marker} answer={ans!r}"


def case_H(s):  # messages typed during a turn all arrive
    ses = s.session()
    s.prompt(ses, "Run this bash command: sleep 15 && echo ok. Then reply with the output.")
    time.sleep(6)
    s.prompt(ses, "First extra: also say APPLE.", delivery="steer")
    s.prompt(ses, "Second extra: also say BANANA.", delivery="steer")
    s.wait(ses)
    time.sleep(2)
    s.wait(ses)
    allt = " ".join(texts(s.messages(ses))).upper()
    both_in_one = any("APPLE" in json.dumps(x["prompt"]) and "BANANA" in json.dumps(x["prompt"]) for x in s.dump())
    return "APPLE" in allt and "BANANA" in allt, f"replies={texts(s.messages(ses))!r} both-in-one-request={both_in_one}"


def case_J(s):  # directory change follows opencode's session move
    ses = s.session()
    s.prompt(ses, "Reply OK.")
    s.wait(ses)
    other = f"{s.d}/other"
    os.makedirs(other, exist_ok=True)
    open(f"{other}/where.txt", "w").write("OTHER\n")
    s.call("POST", f"/api/session/{ses}/move", {"directory": other})
    s.prompt(ses, "Read the file where.txt in the current directory and print its content only.", )
    s.wait(ses)
    ans = texts(s.messages(ses))[-1]
    return "OTHER" in ans, f"answer={ans!r}"


def case_P(s):  # bug 5: compaction is a tool-free fork; the Claude transcript does not get the summary prompt
    ses = s.session()
    s.prompt(ses, "Remember the code word MANGO. Reply OK.")
    s.wait(ses)
    cid = s.store()[ses]
    before = transcript(cid)
    s.call("POST", f"/api/session/{ses}/compact", {})
    s.wait(ses)
    time.sleep(2)
    after = transcript(cid)
    comp = [x for x in s.dump() if "Do not continue the task or call tools" in json.dumps(x["prompt"])]
    msgs = s.messages(ses)
    summary = [m for m in msgs if m.get("type") not in ("user", "assistant")]
    s.prompt(ses, "What is the code word? Only the word.")
    s.wait(ses)
    ans = texts(s.messages(ses))[-1]
    ok = comp and after == before and s.store()[ses] == cid and "MANGO" in ans.upper()
    return ok, (f"compaction-requests={len(comp)} transcript-grew-by={len(after) - len(before)} "
                f"summary-prompt-in-transcript={'structured summary' in after} same-claude={s.store()[ses] == cid} "
                f"other-msg-types={[m.get('type') for m in summary]} answer={ans!r}")


def case_Gen(s):  # bug 5: session generate does not touch the Claude session
    ses = s.session()
    s.prompt(ses, "Remember the code word KIWI. Reply OK.")
    s.wait(ses)
    cid = s.store()[ses]
    before = transcript(cid)
    r = s.call("POST", f"/api/session/{ses}/generate", {"prompt": "What code word did I give? Only the word."})
    after = transcript(cid)
    text = r["data"]["text"]
    ok = "KIWI" in text.upper() and after == before and s.store()[ses] == cid
    return ok, f"text={text!r} transcript-unchanged={after == before}"


CASES = {k[5:]: v for k, v in globals().items() if k.startswith("case_")}

if __name__ == "__main__":
    subprocess.run(["bun", "run", "build"], cwd=ROOT, check=True, capture_output=True)
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
