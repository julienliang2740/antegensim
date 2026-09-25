"""Criterion i: one active writer.  A second backend process (port RES_PORT2, default 8021, same worlds dir)
opening a run held open by the first is refused with 409; history reads still work; once
the first closes (or is killed -9) the second can open, and then the first is refused."""
from __future__ import annotations

import sys
import time

from rlib import (OUT, PORT2, Checks, client, command, create_run, current_pid, defaults, ensure_server, kill9, open_run, run_dir,
                  start_server, step_round, stop_server)

ck = Checks("i_one_writer")
extra: dict = {}
ensure_server()
c1 = client()
req = defaults(c1, 8)
req.update(name="res-i one writer", play_delay_seconds=0.0)
run_id = create_run(c1, req)["run_id"]
extra["run_id"] = run_id
open_run(c1, run_id)
step_round(c1, run_id)

pid2 = start_server(port=PORT2, log=OUT / f"server{PORT2}.log", pid_file=OUT / f"server{PORT2}.pid")
extra["second_server_pid"] = pid2
c2 = client(PORT2)
r = c2.post(f"/runs/{run_id}/open")
ck.check("second process: open of a run held by the first is 409 illegal_command",
         r.status_code == 409 and r.json()["error"] == "illegal_command" and "another process" in (r.json()["detail"] or ""),
         {"status": r.status_code, "body": r.json()})
h = c2.get(f"/runs/{run_id}/turns")
t = c2.get(f"/runs/{run_id}/turns/r00001_end")
ck.check("second process can still read history (read-only routes)", h.status_code == 200 and t.status_code == 200,
         {"turns": h.status_code, "turn view": t.status_code, "n_turns": len(h.json())})
cm = c2.post(f"/runs/{run_id}/commands", json={"command": "run_turn"})
ck.check("second process cannot drive the run (409 run_not_open)", cm.status_code == 409 and cm.json()["error"] == "run_not_open",
         cm.json())
st = c1.get(f"/runs/{run_id}/status").json()
ck.check("first process still owns the run and is unaffected", st["state"] == "paused", st["state"])
iv = c2.post(f"/runs/{run_id}/interventions", json={"type": "voice", "recipients": {"mode": "broadcast_all"}, "text": "x"})
ck.check("second process cannot stage edits either (409)", iv.status_code == 409, iv.json())
rl = c2.post(f"/runs/{run_id}/working/reload")
ck.check("second process cannot reload working files (409)", rl.status_code == 409, rl.json())
cont = c2.post(f"/runs/{run_id}/continuations", json={"from_turn_id": "r00001_end"})
extra["continuation_from_second_process"] = {"status": cont.status_code, "body": cont.json()}

# first closes -> second may open; then the first is refused
c1.post(f"/runs/{run_id}/close")
time.sleep(0.5)
r = c2.post(f"/runs/{run_id}/open")
ck.check("after the first process closes the run, the second can open it", r.status_code == 200 and r.json()["state"] == "paused",
         {"status": r.status_code})
r1 = c1.post(f"/runs/{run_id}/open")
ck.check("now the first process is refused with 409", r1.status_code == 409 and r1.json()["error"] == "illegal_command", r1.json())
# the second writer drives a turn
command(c2, run_id, "run_turn")
time.sleep(1.0)
# kill -9 the holder: the lock must be released with the process
kill9(pid2)
time.sleep(0.3)
r1 = c1.post(f"/runs/{run_id}/open")
ck.check("after kill -9 of the holder, the first process can open (flock released by the OS)",
         r1.status_code == 200 and r1.json()["state"] == "paused", {"status": r1.status_code, "current": r1.json().get("current_turn_id")})
c1.post(f"/runs/{run_id}/close")
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
