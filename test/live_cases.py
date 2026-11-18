#!/usr/bin/env python3
"""Live cases from test.md that `opencode run` can drive: real opencode (standalone) + real claude Haiku.

Usage: python3 test/live_cases.py [CASE ...]   (default: all). Needs `claude` on PATH (or OCN_CLI) and bun.
Each case gets its own scratch project and opencode data dir. Prints PASS/FAIL per case with the evidence.
"""
import json, os, sqlite3, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR", os.path.expanduser("~/.claude"))


def project(models=("haiku", "claude-haiku-5-5"), options=None):
    d = tempfile.mkdtemp(prefix="ocn-live-")
    subprocess.run(["git", "init", "-q", d], check=True)
    provider = {"name": "Claude Native", "npm": f"file://{ROOT}/dist/index.js",
                "models": {m: {"name": m, "tool_call": True, "limit": {"context": 200000, "output": 8192}} for m in models}}
    if options:
        provider["options"] = options
    json.dump({"provider": {"claude-native": provider}}, open(f"{d}/opencode.json", "w"))
    return d


def env(d):
    # opencode run takes its directory from $PWD, not the process cwd
    e = dict(os.environ, PWD=d, XDG_DATA_HOME=f"{d}/data", OPENCODE_CLAUDE_NATIVE_STORE=f"{d}/sessions.json", OCN_DUMP=f"{d}/dump.jsonl")
    for k in ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"):
        e.pop(k, None)
    return e


def run(d, msg, *flags, model="haiku", timeout=240):
    cmd = ["opencode", "run", "--standalone", "-m", f"claude-native/{model}", *flags, msg]
    p = subprocess.run(cmd, cwd=d, env=env(d), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    return p.stdout + p.stderr


def db(d):
    return sqlite3.connect(f"{d}/data/opencode/opencode.db")


def sessions(d):
    return [r[0] for r in db(d).execute("select id from session_v2 order by time_created")]


def store(d):
    return json.load(open(f"{d}/sessions.json")) if os.path.exists(f"{d}/sessions.json") else {}


def reply(d, ses):
    rows = db(d).execute("select data from session_message where session_id=? and type='assistant' order by seq", (ses,)).fetchall()
    last = json.loads(rows[-1][0])
    return "".join(c.get("text", "") for c in last["content"] if c["type"] == "text")


def dump(d):
    return [x for x in map(json.loads, open(f"{d}/dump.jsonl")) if "prompt" in x] if os.path.exists(f"{d}/dump.jsonl") else []


def transcript(cid):
    for root, _, files in os.walk(f"{CLAUDE_DIR}/projects"):
        if f"{cid}.jsonl" in files:
            return open(os.path.join(root, f"{cid}.jsonl")).read()
    return ""


def case_E():
    d = project()
    run(d, "Say ONE.")
    run(d, "Say TWO.")
    s, st = sessions(d), store(d)
    ok = len(s) == 2 and set(st) == set(s) and len(set(st.values())) == 2 and not any("::" in k for k in st)
    return ok, f"sessions={s} store={st}"


def case_F():
    d = project()
    run(d, "Remember the word PINEAPPLE. Reply OK.")
    ses = sessions(d)[0]
    before = store(d)[ses]
    run(d, "What word did I ask you to remember? Only the word.", "-s", ses, model="claude-haiku-5-5")
    a1 = reply(d, ses)
    after = store(d)[ses]
    run(d, "Name the word again. Only the word.", "-s", ses)
    a2 = reply(d, ses)
    t = transcript(before)
    ok = "PINEAPPLE" in a1.upper() and "PINEAPPLE" in a2.upper() and before == after == store(d)[ses] and len(store(d)) == 1
    return ok, f"a1={a1!r} a2={a2!r} claude={before} unchanged={before == after == store(d)[ses]} transcript-has-full-id={'claude-haiku-5-5' in t}"


def case_G():
    d = project()
    run(d, "Remember the number 41. Reply OK.")
    S = sessions(d)[0]
    run(d, "Add 1 to the number and remember the result. Reply with the result only.", "-s", S, "--fork")
    F = [s for s in sessions(d) if s != S][0]
    run(d, "What number do you remember? Only the number.", "-s", S)
    run(d, "What number do you remember now? Only the number.", "-s", F)
    aS, aF, st = reply(d, S), reply(d, F), store(d)
    leak = "Add 1 to the number" in transcript(st[S])
    ok = "41" in aS and "42" in aF and st[S] != st[F] and not leak
    return ok, f"S={aS!r} F={aF!r} store={st} step3-in-source={leak}"


def case_I():
    d = project()
    run(d, "Create a file plan-test.txt that contains hello.", "--agent", "plan")
    made_in_plan = os.path.exists(f"{d}/plan-test.txt")
    ses = sessions(d)[0]
    run(d, "Create a file plan-test.txt that contains hello.", "-s", ses, "--agent", "build")
    made_in_build = os.path.exists(f"{d}/plan-test.txt")
    return (not made_in_plan and made_in_build), f"plan-made-file={made_in_plan} build-made-file={made_in_build}"


def case_K():
    d = project()
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (480, 160), "white")
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 96)
    except OSError:
        font = ImageFont.load_default(size=96)
    ImageDraw.Draw(img).text((20, 20), "ZEBRA", fill="black", font=font)
    img.save(f"{d}/word.png")
    out = run(d, "What word is in the attached image? Only the word.", "-f", f"{d}/word.png")
    a = reply(d, sessions(d)[0])
    return "ZEBRA" in a.upper(), f"answer={a!r} out-tail={out[-200:]!r}"


def case_C():
    d = project(options={"cliPath": "/nonexistent/claude"})
    t0 = time.time()
    out = run(d, "Say hi.", timeout=200)
    turns = [x for x in dump(d) if x.get("maxOutputTokens")]
    secs = time.time() - t0
    return ("cannot run /nonexistent/claude" in out and len(turns) == 1), f"agent-requests={len(turns)} secs={secs:.0f} out-tail={out[-300:]!r}"


def case_R():  # bug 11: claude fails before output -> one attempt, one prompt in the transcript
    d = project(models=("no-such-model",))
    t0 = time.time()
    out = run(d, "Say hi.", model="no-such-model", timeout=200)
    turns = [x for x in dump(d) if x.get("maxOutputTokens")]
    secs = time.time() - t0
    return len(turns) == 1, f"agent-requests={len(turns)} secs={secs:.0f} out-tail={out[-300:]!r}"


def case_T():  # bug 14: Claude's title lands as the opencode title, quickly
    d = project()
    t0 = time.time()
    run(d, "Explain in one sentence what a binary search tree is.")
    secs = time.time() - t0
    title = db(d).execute("select title from session_v2").fetchone()[0]
    ai = '"ai-title"' in transcript(list(store(d).values())[0])
    return bool(title) and not title.startswith("New session") and secs < 60, f"title={title!r} claude-ai-title={ai} secs={secs:.0f}"


def case_L():
    p = subprocess.run(["bash", f"{ROOT}/test/e2e.sh"], capture_output=True, text=True, timeout=400, stdin=subprocess.DEVNULL)
    return "OK opencode" in p.stdout, (p.stdout + p.stderr)[-400:]


CASES = {k[5:]: v for k, v in globals().items() if k.startswith("case_")}

if __name__ == "__main__":
    subprocess.run(["bun", "run", "build"], cwd=ROOT, check=True, capture_output=True)
    picked = sys.argv[1:] or list(CASES)
    results = {}
    for name in picked:
        t0 = time.time()
        try:
            ok, ev = CASES[name]()
        except Exception as e:  # noqa: BLE001 - report and go on
            ok, ev = False, f"{type(e).__name__}: {e}"
        results[name] = ok
        print(f"{'PASS' if ok else 'FAIL'} {name} ({time.time() - t0:.0f}s): {ev}", flush=True)
    sys.exit(0 if all(results.values()) else 1)
