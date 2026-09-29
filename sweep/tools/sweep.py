#!/usr/bin/env python3
"""Scenario sweep tool: dry-run, launch, watch, measure and cut Empyrean runs through the public API.

No engine code is touched: scenarios are run_sim-style overlays (world/rules/context deep-merged onto
GET /api/defaults, every other top-level key replaces the default, `agents` is the full card list).

Commands (run with /home/ubuntu/antegensim/.venv/bin/python):
  dryrun  <scenario.json> [--rounds 3]      free check: same overlay, every agent forced to fake-heuristic, private worlds dir
  launch  <scenario.json>                   create the live run on :8000, open it, play; records it in sweep/registry.json
  status  [TAG ...]                         one line per registered run (TAG = e.g. A1 or A1v2; default all)
  metrics <TAG|run_id> [--samples N]        interest metrics for one run (JSON-ish text)
  cut     <TAG> <reason ...>                pause + close the run and mark it cut in the registry
  park    <TAG> <reason ...>                pause + close without a verdict; resume <TAG> [port] puts it back (watchdog opens it)
  wait    <TAG ...> --round R [--max-min 9] block until every listed run reached round R, finished or was cut (max 9.5 min)
  watchdog                                  daemon: keeps every registry run with status 'running' playing
Scenario files live in /home/ubuntu/antegensim/sweep/scenarios/<TAG>.json with TAG like A1v1."""
import copy, fcntl, glob, json, os, subprocess, sys, time, urllib.error, urllib.request

# DOCS: operator tool for live scenario sweeps over the public API (sweep/BRIEF.md); never touches engine code; dryrun forces fake-heuristic.
from collections import Counter, defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # the repository root
SWEEP = f"{REPO}/sweep"
REG = f"{SWEEP}/registry.json"
BACKENDS = [8001, 8002, 8003]  # one backend process per port, same worlds dir (a run is owned by one process at a time);
# 8000 is the operator's UI backend and is left alone.  2026-09-29 model comparison: 8001 Haiku, 8002 GPT-6 Luna,
# 8003 DeepSeek V4 Flash (its Azure deployment allows 125 requests and 125K tokens per minute, hence concurrency 1 and one run at a time: ds_driver.py)
MAX_PER_BACKEND = 4      # live runs per backend process (memory grows with runs x rounds; one hit 11.8 GB and was OOM-killed)
RSS_LIMIT_KB = 7 * 1024 * 1024  # the watchdog restarts a backend above this resident size (runs reopen and resume)
BACKEND_ENV = {"EMPYREAN_FSYNC": "0", "EMPYREAN_MODEL_CONCURRENCY": "12", "EMPYREAN_STORYBOOK_AUTO": "off", "EMPYREAN_MODELS_FILE": f"{REPO}/sweep/models.sweep.json"}
PORT_ENV = {8002: {"EMPYREAN_MODEL_CONCURRENCY": "5"}, 8003: {"EMPYREAN_MODEL_CONCURRENCY": "1"}}  # per-backend overrides of BACKEND_ENV (Azure token-per-minute quotas: Luna 1M, DeepSeek 125K)
TOOLS = os.path.dirname(os.path.abspath(__file__))
LIVE_KEYS = {"claude-cli-haiku", "claude-cli-sonnet", "azure-gpt6-luna", "azure-deepseek-v4-flash"}
MAX_CONCURRENT = MAX_PER_BACKEND * len(BACKENDS)
MAX_ROUNDS = 100  # hard cap (operator: 80 on 2026-09-27, raised to 100 for the showcase runs on 2026-09-28)


def call(method, path, body=None, timeout=60, port=8000):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api" + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except Exception:
            return e.code, None
    except (urllib.error.URLError, OSError, ValueError) as e:
        return 0, str(e)


def deep_merge(base, over):
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


class Registry:
    """sweep/registry.json guarded by an flock so parallel sub-agents can edit it."""
    def __enter__(self):
        self.fh = open(REG + ".lock", "w")
        fcntl.flock(self.fh, fcntl.LOCK_EX)
        self.data = json.load(open(REG)) if os.path.exists(REG) else {"runs": {}}
        return self.data

    def __exit__(self, *exc):
        if exc[0] is None:
            tmp = REG + ".tmp"
            json.dump(self.data, open(tmp, "w"), indent=1)
            os.replace(tmp, REG)
        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()


def read_registry():
    return json.load(open(REG)) if os.path.exists(REG) else {"runs": {}}


def tag_of(path):
    return os.path.splitext(os.path.basename(path))[0]


def load_scenario(path):
    sc = json.load(open(path))
    tag = tag_of(path)
    if not sc.get("name", "").startswith(f"SWEEP-{tag} "):
        raise SystemExit(f"scenario name must start with 'SWEEP-{tag} ' (got {sc.get('name')!r})")
    if not isinstance(sc.get("agents"), list) or not sc["agents"]:
        raise SystemExit("scenario needs a full 'agents' list")
    for a in sc["agents"]:
        if a.get("model_key") not in LIVE_KEYS:
            raise SystemExit(f"agent {a.get('id')} model_key must be one of {sorted(LIVE_KEYS)} (got {a.get('model_key')!r})")
    if not (1 <= int(sc.get("max_rounds", 0)) <= MAX_ROUNDS):
        raise SystemExit(f"max_rounds must be 1..{MAX_ROUNDS} (operator budget rule)")
    return sc


def build_request(sc, defaults):
    req = copy.deepcopy(defaults)
    for k, v in sc.items():
        if k.startswith("_"):
            continue  # _design notes etc. stay in the file only
        if k in ("world", "rules", "context") and isinstance(v, dict):
            req[k] = deep_merge(req.get(k) or {}, v)
        else:
            req[k] = copy.deepcopy(v)
    req["play_delay_seconds"] = 0.0
    return req


def cmd_dryrun(path, rounds=3):
    sc = load_scenario(path)
    fake = copy.deepcopy(sc)
    fake["default_model_key"] = "fake-heuristic"
    fake["real_budget_usd"] = None
    for a in fake["agents"]:
        a["model_key"] = "fake-heuristic"
    for k in [k for k in fake if k.startswith("_")]:
        del fake[k]
    assert all(a["model_key"] == "fake-heuristic" for a in fake["agents"])
    tag = tag_of(path)
    over = f"{TOOLS}/dry/{tag}.overlay.json"
    json.dump(fake, open(over, "w"), indent=1)
    env = {k: v for k, v in os.environ.items() if k not in ("EMPYREAN_ALLOW_LIVE", "EMPYREAN_LIVE_TESTS")}
    wd = f"{TOOLS}/dry/worlds_{tag}"
    p = subprocess.run([f"{REPO}/.venv/bin/python", f"{REPO}/scripts/run_sim.py", "--request", over, "--rounds", str(rounds),
                        "--agents", str(min(64, max(6, len(fake["agents"])))), "--worlds-dir", wd, "--name", fake["name"] + " (dry)",
                        "--seed", str(fake.get("seed", 1))], cwd=REPO, env=env, capture_output=True, text=True, timeout=1800)
    out = p.stdout + p.stderr
    lines = out.splitlines()
    keep = [l for l in lines if any(s in l for s in ("round ", "created", "Actions", "by kind", "by result", "other:", "Deaths", "RUN ERROR", "Error", "error", "rror:", "warnings", "moved from"))]
    print("\n".join(keep[:60]) or out[-3000:])
    print(f"dryrun exit {p.returncode}")
    if p.returncode:
        print(out[-4000:])
    subprocess.run(["rm", "-rf", wd])
    return p.returncode


def cmd_launch(path):
    sc = load_scenario(path)
    tag = tag_of(path)
    reg = read_registry()
    running = [t for t, r in reg["runs"].items() if r["status"] == "running"]
    if tag in reg["runs"]:
        raise SystemExit(f"{tag} already launched as {reg['runs'][tag]['run_id']}; bump the version (e.g. {tag[:-1]}{int(tag[-1]) + 1})")
    if len(running) >= MAX_CONCURRENT:
        raise SystemExit(f"{len(running)} runs already running (cap {MAX_CONCURRENT}); cut or wait")
    load = Counter(r.get("port", 8000) for r in reg["runs"].values() if r["status"] == "running")
    ports = [p for p in BACKENDS if call("GET", "/models", port=p, timeout=10)[0] == 200] or [8000]
    port = min(ports, key=lambda p: (load.get(p, 0), p))
    if load.get(port, 0) >= MAX_PER_BACKEND:
        raise SystemExit(f"every backend already has {MAX_PER_BACKEND} running runs; park or cut one first")
    c, defaults = call("GET", f"/defaults?agent_count={min(64, max(6, len(sc['agents'])))}", port=port)
    if c != 200:
        raise SystemExit(f"defaults failed {c} {defaults}")
    req = build_request(sc, defaults)
    c, v = call("POST", "/runs/validate", req, port=port)
    if c != 200 or (isinstance(v, dict) and v.get("ok") is False):
        raise SystemExit(f"validate failed {c}: {json.dumps(v)[:3000]}")
    c, s = call("POST", "/runs", req, timeout=120, port=port)
    if c != 201:
        raise SystemExit(f"create failed {c}: {json.dumps(s)[:3000]}")
    run_id = s["run_id"]
    c, st = call("POST", f"/runs/{run_id}/open", port=port, timeout=120)
    c2, st2 = call("POST", f"/runs/{run_id}/commands", {"command": "play"}, port=port)
    with Registry() as r:
        r["runs"][tag] = {"run_id": run_id, "world_id": s.get("world_id"), "name": sc["name"], "scenario": path,
                          "status": "running", "port": port, "agents": len(sc["agents"]), "max_rounds": sc["max_rounds"],
                          "launched": time.strftime("%Y-%m-%d %H:%M:%S"), "notes": []}
    print(f"launched {tag} -> {run_id} on :{port} (open {c}, play {c2}: {st2.get('state') if isinstance(st2, dict) else st2})")


def run_dir(run_id):
    g = glob.glob(f"{REPO}/worlds/*/runs/{run_id}")
    return g[0] if g else None


def resolve(ref):
    reg = read_registry()["runs"]
    if ref in reg:
        return ref, reg[ref]
    for t, r in reg.items():
        if r["run_id"] == ref:
            return t, r
    raise SystemExit(f"unknown run {ref}")


def events_of(rd):
    evs = []
    for f in sorted(glob.glob(f"{rd}/turns/*/events.json")):
        try:
            evs += json.load(open(f))
        except Exception:
            pass
    return evs


def metrics(tag, entry, samples=6):
    rd = run_dir(entry["run_id"])
    evs = events_of(rd)
    req = json.load(open(f"{rd}/run_request.json"))
    n = len(req["agents"])
    names = {a["id"]: a.get("name", a["id"]) for a in req["agents"]}
    models = Counter(a.get("model_key") for a in req["agents"])
    rounds = max([e["round"] for e in evs if e["kind"] == "round_ended"] or [0])
    living_by_round = {e["round"]: len(e["details"]["living_agents"]) for e in evs if e["kind"] == "round_ended"}
    acts = [e for e in evs if e["kind"] == "action"]
    kind = Counter(e["details"]["action"]["name"] for e in acts)
    okk = Counter(e["details"]["action"]["name"] for e in acts if e["details"]["result"]["ok"])
    via_skill = sum(1 for e in acts if e["details"].get("via_skill"))
    deaths = [e for e in evs if e["kind"] == "death" and e["details"].get("kind") == "agent"]
    death_causes = Counter(e["details"].get("cause") for e in deaths)
    death_rounds = [e["round"] for e in deaths]
    dmg = [e for e in evs if e["kind"] == "damage" and e["details"].get("cause") == "attack"]
    attackers = Counter(e["actor"] for e in dmg)
    upgrades = Counter(e["details"]["action"]["args"].get("attribute") for e in acts if e["details"]["action"]["name"] == "upgrade" and e["details"]["result"]["ok"])
    saved = [e for e in evs if e["kind"] == "skill_saved"]
    started = [e for e in evs if e["kind"] == "skill_started"]
    skill_users = {e["actor"] for e in started}
    msgs = [e for e in acts if e["details"]["action"]["name"] in ("send", "broadcast") and e["details"]["result"]["ok"]]
    transfers = [e for e in acts if e["details"]["action"]["name"] == "transfer" and e["details"]["result"]["ok"]]
    calls_ok = sum(1 for e in evs if e["kind"] == "model_call_completed")
    calls_bad = sum(1 for e in evs if e["kind"] == "model_call_failed")
    skipped = sum(1 for e in evs if e["kind"] == "resource_skip")
    cost = 0.0
    for e in evs:
        if e["kind"] in ("model_call_completed", "model_call_failed"):
            cost += float(e["details"].get("provider_cost_usd") or 0.0)
    turns_with_agent = sum(1 for e in evs if e["kind"] == "turn_started")
    decisions = sum(1 for e in evs if e["kind"] == "decision")
    last_round_actions = Counter()
    recent = [e for e in acts if e["round"] > rounds - 10]
    recent_kind = Counter(e["details"]["action"]["name"] for e in recent)
    st = call("GET", f"/runs/{entry['run_id']}/status", port=entry.get("port", 8000))[1]
    out = {
        "tag": tag, "name": entry["name"], "run_id": entry["run_id"], "registry_status": entry["status"],
        "server_state": st.get("state") if isinstance(st, dict) else st, "round": rounds, "max_rounds": entry["max_rounds"],
        "agents": n, "models": dict(models), "living_now": living_by_round.get(rounds, n),
        "living_curve_every5": {r: living_by_round[r] for r in sorted(living_by_round) if r % 5 == 0 or r == rounds},
        "deaths": len(deaths), "death_causes": dict(death_causes), "death_rounds": death_rounds,
        "actions": len(acts), "actions_by_kind": dict(kind), "ok_by_kind": dict(okk),
        "recent10_rounds_actions": dict(recent_kind),
        "via_skill_actions": via_skill, "via_skill_share": round(via_skill / len(acts), 3) if acts else 0,
        "skills_saved": len(saved), "skill_runs_started": len(started), "agents_running_skills": len(skill_users),
        "attack_hits": len(dmg), "attack_damage_total": round(sum(e["details"]["amount"] for e in dmg), 1),
        "distinct_attackers": len(attackers), "kills": death_causes.get("attack", 0),
        "messages_ok": len(msgs), "distinct_messengers": len({e["actor"] for e in msgs}),
        "transfers_ok": len(transfers), "upgrades": dict(upgrades),
        "agent_turns": turns_with_agent, "model_decisions": decisions, "model_calls_ok": calls_ok, "model_calls_failed": calls_bad,
        "resource_skips": skipped, "provider_cost_usd": round(cost, 3),
    }
    # flavour samples: recent messages and recent kills
    def short(e):
        return f"r{e['round']} {e['summary'][:220]}"
    out["sample_messages"] = [short(e) for e in msgs[-samples:]]
    out["sample_attacks"] = [short(e) for e in dmg[-samples:]]
    out["sample_skill_saves"] = [short(e) for e in saved[-samples:]]
    thoughts = [e for e in evs if e["kind"] == "decision"][-samples:]
    out["sample_decisions"] = [f"r{e['round']} {e['summary'][:260]}" for e in thoughts]
    return out


def cmd_metrics(ref, samples=6):
    tag, entry = resolve(ref)
    m = metrics(tag, entry, samples)
    for k, v in m.items():
        print(f"{k}: {json.dumps(v) if not isinstance(v, str) else v}")


def cmd_status(tags):
    reg = read_registry()["runs"]
    du = subprocess.run(["df", "-h", "/"], capture_output=True, text=True).stdout.splitlines()[-1]
    print(f"disk: {du}")
    for t, r in sorted(reg.items()):
        if tags and not any(t == x or t.startswith(x) for x in tags):
            continue
        c, st = call("GET", f"/runs/{r['run_id']}/status", port=r.get("port", 8000))
        if isinstance(st, dict) and "state" in st:
            s = f"{st.get('state')} {st.get('current_turn_id')} living {st.get('living_agent_count')}"
        else:
            s = f"status {c} {str(st)[:80]}"
        print(f"{t:8} {r['status']:9} :{r.get('port', 8000)} {r['run_id']} {s} | {r['name']}")


def cmd_cut(tag, reason):
    tag, entry = resolve(tag)
    rid = entry["run_id"]
    port = entry.get("port", 8000)
    call("POST", f"/runs/{rid}/commands", {"command": "pause"}, port=port)
    for _ in range(60):
        c, st = call("GET", f"/runs/{rid}/status", port=port)
        if not isinstance(st, dict) or st.get("state") != "running":
            break
        time.sleep(2)
    c, st = call("POST", f"/runs/{rid}/close", port=port)
    with Registry() as r:
        r["runs"][tag]["status"] = "cut"
        r["runs"][tag]["notes"].append(f"{time.strftime('%H:%M')} cut: {reason}")
    print(f"cut {tag} ({rid}): close {c}")


def cmd_move(tag, new_port):
    """Operator only: hand a running run to another backend process (pause, close, open there, play)."""
    tag, entry = resolve(tag)
    rid, old = entry["run_id"], entry.get("port", 8000)
    if old == new_port:
        print("already there"); return
    with Registry() as r:
        r["runs"][tag]["moving"] = True
    try:
        call("POST", f"/runs/{rid}/commands", {"command": "pause"}, port=old)
        for _ in range(120):
            c, st = call("GET", f"/runs/{rid}/status", port=old)
            if not isinstance(st, dict) or st.get("state") not in ("running", "turn_active", "waiting_model"):
                break
            time.sleep(2)
        c1, _ = call("POST", f"/runs/{rid}/close", port=old, timeout=120)
        for _ in range(60):
            c2, st2 = call("POST", f"/runs/{rid}/open", port=new_port, timeout=120)
            if c2 == 200:
                break
            time.sleep(3)
        c3, _ = call("POST", f"/runs/{rid}/commands", {"command": "play"}, port=new_port)
        print(f"moved {tag} :{old} -> :{new_port} (close {c1}, open {c2}, play {c3})")
        if c2 == 200:
            with Registry() as r:
                r["runs"][tag]["port"] = new_port
    finally:
        with Registry() as r:
            r["runs"][tag].pop("moving", None)


def cmd_park(tag, reason):
    """Pause + close a run without judging it; `resume` puts it back on a backend later."""
    tag, entry = resolve(tag)
    rid, port = entry["run_id"], entry.get("port", 8000)
    call("POST", f"/runs/{rid}/commands", {"command": "pause"}, port=port)
    for _ in range(90):
        c, st = call("GET", f"/runs/{rid}/status", port=port)
        if not isinstance(st, dict) or st.get("state") not in ("running", "turn_active", "waiting_model"):
            break
        time.sleep(2)
    c, _ = call("POST", f"/runs/{rid}/close", port=port, timeout=120)
    with Registry() as r:
        r["runs"][tag]["status"] = "parked"
        r["runs"][tag]["notes"].append(f"{time.strftime('%H:%M')} parked: {reason}")
    print(f"parked {tag} (close {c})")


def cmd_resume(tag, port=None):
    """Mark a parked run running on a backend with a free slot; the watchdog opens it and plays."""
    tag, entry = resolve(tag)
    reg = read_registry()["runs"]
    load = Counter(r.get("port", 8000) for r in reg.values() if r["status"] == "running")
    port = port or min(BACKENDS, key=lambda p: (load.get(p, 0), p))
    if load.get(port, 0) >= MAX_PER_BACKEND:
        raise SystemExit(f":{port} already has {load.get(port, 0)} running runs")
    with Registry() as r:
        r["runs"][tag]["status"] = "running"
        r["runs"][tag]["port"] = port
        r["runs"][tag]["notes"].append(f"{time.strftime('%H:%M')} resumed on :{port}")
    print(f"{tag} marked running on :{port}; the watchdog opens and plays it")


def backend_pid(port):
    out = subprocess.run(["ss", "-ltnpH", f"sport = :{port}"], capture_output=True, text=True).stdout
    import re
    m = re.search(r"pid=(\d+)", out)
    return int(m.group(1)) if m else None


def rss_kb(pid):
    try:
        for line in open(f"/proc/{pid}/status"):
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except OSError:
        return 0
    return 0


def start_backend(port):
    env = {**os.environ, **BACKEND_ENV, **PORT_ENV.get(port, {}), "EMPYREAN_API_PORT": str(port)}
    env.pop("EMPYREAN_ALLOW_LIVE", None)
    log = open(f"{TOOLS}/backend{port}.log", "a")
    subprocess.Popen([f"{REPO}/.venv/bin/python", "-m", "empyrean.main"], cwd=f"{REPO}/backend", env=env,
                     stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    for _ in range(60):
        if call("GET", "/models", port=port, timeout=5)[0] == 200:
            return True
        time.sleep(1)
    return False


def stop_backend(port):
    import signal
    pid = backend_pid(port)
    if not pid:
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(60):
        if not os.path.exists(f"/proc/{pid}"):
            return
        time.sleep(1)
    os.kill(pid, signal.SIGKILL)
    time.sleep(2)


def cmd_note(tag, text):
    tag, entry = resolve(tag)
    with Registry() as r:
        r["runs"][tag]["notes"].append(f"{time.strftime('%H:%M')} {text}")
    print("noted")


def cmd_wait(tags, target_round, max_min=9.0):
    deadline = time.time() + min(max_min, 9.5) * 60
    while True:
        reg = read_registry()["runs"]
        pending = []
        for t in tags:
            tag, e = resolve(t)
            if e["status"] != "running":
                continue
            c, st = call("GET", f"/runs/{e['run_id']}/status", port=e.get("port", 8000))
            if isinstance(st, dict) and st.get("state") == "finished":
                continue
            cur = (st.get("current_turn_id") or "") if isinstance(st, dict) else ""
            rnd = int(cur[1:6]) if cur.startswith("r") and cur[1:6].isdigit() else 0
            done = rnd if cur.endswith("_end") else rnd - 1  # rounds fully completed
            if done < target_round:
                pending.append(f"{tag}@r{max(done, 0)}done")
        if not pending:
            print(f"all reached round {target_round} (or finished/cut)")
            return
        if time.time() > deadline:
            print(f"timeout; still below round {target_round}: {' '.join(pending)}")
            return
        time.sleep(20)


def cmd_watchdog():
    """Keep every 'running' registry run playing; mark finished runs; log to sweep_tools/watchdog.log."""
    recov = defaultdict(int)
    err_turn: dict = {}
    log = open(f"{TOOLS}/watchdog.log", "a")
    def say(m):
        log.write(time.strftime("%H:%M:%S ") + m + "\n"); log.flush()
    say("watchdog start")
    down = defaultdict(int)
    while True:
        for port in BACKENDS:
            pid = backend_pid(port)
            if pid and rss_kb(pid) > RSS_LIMIT_KB:
                say(f":{port} pid {pid} rss {rss_kb(pid) // 1024} MB over limit: restarting it")
                stop_backend(port)
                say(f":{port} restarted -> {start_backend(port)}")
                continue
            if call("GET", "/models", port=port, timeout=15)[0] != 200:
                down[port] += 1
                if down[port] >= 3 and not backend_pid(port):
                    say(f":{port} down for 3 polls: starting it")
                    say(f":{port} started -> {start_backend(port)}")
                    down[port] = 0
            else:
                down[port] = 0
        for t, e in read_registry()["runs"].items():
            if e["status"] != "running":
                continue
            rid = e["run_id"]
            port = e.get("port", 8000)
            if e.get("moving"):
                continue
            c, st = call("GET", f"/runs/{rid}/status", port=port)
            if c == 409 and isinstance(st, dict) and st.get("error") == "run_not_open":
                c, st = call("POST", f"/runs/{rid}/open", port=port, timeout=120)
                say(f"{t} reopened on :{port} -> {c} {'' if c == 200 else str(st)[:120]}")
                if c == 200 and st.get("state") == "paused":
                    say(f"{t} play -> {call('POST', f'/runs/{rid}/commands', {'command': 'play'}, port=port)[0]}")
                continue
            if c != 200 or not isinstance(st, dict):
                continue
            s = st.get("state")
            if s == "finished":
                with Registry() as r:
                    r["runs"][t]["status"] = "finished"
                    r["runs"][t]["notes"].append(f"{time.strftime('%H:%M')} finished at {st.get('current_turn_id')}")
                say(f"{t} finished at {st.get('current_turn_id')}")
            elif s == "paused":
                say(f"{t} paused at {st.get('current_turn_id')} -> play {call('POST', f'/runs/{rid}/commands', {'command': 'play'}, port=port)[0]}")
            elif s == "error":
                where = st.get("current_turn_id")
                if err_turn.get(t) != where:  # a new failing turn: the limit counts retries of one turn
                    err_turn[t] = where
                    recov[t] = 0
                recov[t] += 1
                say(f"{t} error #{recov[t]} at {st.get('current_turn_id')}: {str(st.get('last_error'))[:200]}")
                if recov[t] <= 25:
                    call("POST", f"/runs/{rid}/commands", {"command": "pause"}, port=port)
                    time.sleep(3)
                    say(f"{t} play -> {call('POST', f'/runs/{rid}/commands', {'command': 'play'}, port=port)[0]}")
        time.sleep(20)


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(__doc__); sys.exit(0)
    c = a[0]
    if c == "dryrun":
        r = int(a[a.index("--rounds") + 1]) if "--rounds" in a else 3
        sys.exit(cmd_dryrun(a[1], r))
    elif c == "launch":
        cmd_launch(a[1])
    elif c == "status":
        cmd_status(a[1:])
    elif c == "metrics":
        cmd_metrics(a[1], int(a[a.index("--samples") + 1]) if "--samples" in a else 6)
    elif c == "cut":
        cmd_cut(a[1], " ".join(a[2:]) or "no reason given")
    elif c == "move":
        cmd_move(a[1], int(a[2]))
    elif c == "park":
        cmd_park(a[1], " ".join(a[2:]) or "no reason given")
    elif c == "resume":
        cmd_resume(a[1], int(a[2]) if len(a) > 2 else None)
    elif c == "backend-start":
        print(start_backend(int(a[1])))
    elif c == "note":
        cmd_note(a[1], " ".join(a[2:]))
    elif c == "wait":
        i = a.index("--round")
        mm = float(a[a.index("--max-min") + 1]) if "--max-min" in a else 9.0
        cmd_wait([x for x in a[1:i]], int(a[i + 1]), mm)
    elif c == "watchdog":
        cmd_watchdog()
    else:
        print(__doc__); sys.exit(2)
