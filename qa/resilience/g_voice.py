"""Criterion g: an unseen operator voice to one agent / selected agents / everyone reaches
only the recipients' knowledge (recorded experience) and their next decision packet."""
from __future__ import annotations

import json
import sys

from rlib import (Checks, chain_from_manifest, client, command, create_run, defaults, ensure_server, open_run, read_json,
                  read_knowledge_file, run_dir, stage, step_round, wait_idle)

ck = Checks("g_voice")
extra: dict = {}
ensure_server()
c = client()
req = defaults(c, 8)
req.update(name="res-g operator voice", play_delay_seconds=0.0)
summary = create_run(c, req)
run_id = summary["run_id"]
rd = run_dir(run_id)
extra["run_id"] = run_id
open_run(c, run_id)
step_round(c, run_id)
AG = [a["id"] for a in req["agents"]]
V = {
    "one": ("VOICE-ONE-7f3a hear me, a01", {"mode": "agents", "agent_ids": ["a01"]}, {"a01"}),
    "sel": ("VOICE-SEL-91bc a02 and a05 only", {"mode": "agents", "agent_ids": ["a02", "a05"]}, {"a02", "a05"}),
    "all": ("VOICE-ALL-c4d2 everyone listen", {"mode": "broadcast_all"}, set(AG)),
}
for key, (text, rcp, _) in V.items():
    r = stage(c, run_id, {"type": "voice", "recipients": rcp, "text": text})
    assert r.status_code == 201, r.text
command(c, run_id, "run_turn")
st = wait_idle(c, run_id)
T = st["current_turn_id"]
extra["effective_turn"] = T
evs = read_json(rd / "turns" / T / "events.json")
ov = [e for e in evs if e["kind"] == "operator_voice"]
got = {e["details"]["text"]: set(e["details"]["recipients"]) for e in ov}
ck.check("three operator_voice events with exactly the chosen recipients",
         all(got.get(text) == exp for text, _, exp in V.values()), {k: sorted(v) for k, v in got.items()})
ck.check("voice events are actor 'operator' (unseen sender)", all(e["actor"] == "operator" for e in ov), [e["actor"] for e in ov])

# knowledge at the effective turn
leak, missing = [], []
for aid in AG:
    kn = read_knowledge_file(rd, T, aid)  # resolves through world.json knowledge_files (unchanged stores)
    texts = [r["text"] for r in kn["records"] if r["kind"] == "operator_voice"]
    for key, (text, _, exp) in V.items():
        has = any(text in t for t in texts)
        if has and aid not in exp:
            leak.append((aid, key))
        if not has and aid in exp:
            missing.append((aid, key))
ck.check("each voice is in exactly its recipients' knowledge files (no leak, none missing)", not leak and not missing,
         {"leak": leak, "missing": missing})
kv = c.get(f"/runs/{run_id}/turns/{T}/agents/a01/knowledge").json()
rec = [r for r in kv["knowledge"]["records"] if r["kind"] == "operator_voice"]
extra["a01_voice_records"] = rec
ck.check("voice record has no visible sender (provenance source unknown, sender_visible false)",
         rec and all(r["provenance"]["source"] == "unknown" and r["provenance"]["sender_visible"] is False for r in rec), [(r["id"], r["provenance"], r["text"][:80]) for r in rec])
# next decision packet for every agent
step_round(c, run_id)
step_round(c, run_id)
chain = chain_from_manifest(rd)
after = chain[chain.index(T):]
pk_leak, pk_missing, first_packet = [], [], {}
for aid in AG:
    for t in after:
        if not t.endswith("_" + aid):
            continue
        files = list((rd / "turns" / t / "decision_packets").glob("*.json"))
        if not files:
            continue
        pk = read_json(files[0])
        blob = json.dumps(pk["messages"])
        first_packet[aid] = t
        for key, (text, _, exp) in V.items():
            if text in blob and aid not in exp:
                pk_leak.append((aid, key, t))
            if text not in blob and aid in exp:
                pk_missing.append((aid, key, t))
        break
extra["first_packet_after_voice"] = first_packet
ck.check("every agent had a later decision packet", len(first_packet) == len(AG), first_packet)
ck.check("each recipient's next packet contains its voice text; non-recipients' packets do not", not pk_leak and not pk_missing,
         {"leak": pk_leak, "missing": pk_missing})
# packet wording: how the voice is rendered
pk = read_json(next((rd / "turns" / first_packet["a01"] / "decision_packets").glob("*.json")))
line = [m["content"] for m in pk["messages"] if "VOICE-ONE-7f3a" in m["content"]]
snippet = ""
if line:
    i = line[0].find("VOICE-ONE-7f3a")
    snippet = line[0][max(0, i - 160): i + 60]
extra["a01_packet_snippet"] = snippet
vline = next((ln for ln in snippet.splitlines() if "VOICE-ONE-7f3a" in ln), "")
ck.check("rendered voice line in a01's packet shows 'source unknown' and no sender", "source unknown" in vline
         and "operator" not in vline.lower(), vline)
c.post(f"/runs/{run_id}/close")
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
