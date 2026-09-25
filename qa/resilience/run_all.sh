#!/usr/bin/env bash
# Runs every resilience / completion-criteria scenario against a fresh backend started by rlib.
# Defaults: port 8020, worlds dir qa/resilience/worlds, output qa/resilience/out/<scenario>.{log,json}.
# Overrides (env): RES_PORT, RES_PORT2 (second writer, default RES_PORT+1), RES_WORLDS, RES_OUT, RES_LOG.
#   e.g. RES_PORT=8040 RES_WORLDS=$PWD/worlds-final RES_OUT=$PWD/out-final RES_LOG=$PWD/out-final/server.log ./run_all.sh
# Restarts only the PID recorded in qa/resilience/server.pid (never the dev servers).
set -u
cd /home/ubuntu/antegensim/qa/resilience
PY=/home/ubuntu/antegensim/.venv/bin/python
OUT_DIR="${RES_OUT:-$PWD/out}"
mkdir -p "$OUT_DIR"
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null && \
   grep -q "empyrean.main" "/proc/$(cat server.pid)/cmdline" 2>/dev/null; then
  kill "$(cat server.pid)"; sleep 2
fi
$PY -c "import rlib; print('server pid', rlib.start_server(), 'port', rlib.PORT, 'worlds', rlib.WORLDS)"
{
  echo "port: ${RES_PORT:-8020}  worlds: ${RES_WORLDS:-$PWD/worlds}  out: $OUT_DIR"
  echo "source hash at start: $(cat ../../backend/empyrean/*.py | sha256sum | cut -c1-12)"
} | tee "$OUT_DIR/run_all.meta"
for s in a_crash_resume a2_kill_stress b_controls c_playback d_invalid e_skill_vs_direct f_context_settings g_voice h_working_continuation i_one_writer j_storage k_other_bullets l_reload_order; do
  start=$(date +%s)
  timeout 1200 $PY $s.py > "$OUT_DIR/$s.log" 2>&1
  rc=$?
  echo "$s exit=$rc secs=$(( $(date +%s) - start )) pass=$(grep -c '^\[PASS\]' "$OUT_DIR/$s.log") fail=$(grep -c '^\[FAIL\]' "$OUT_DIR/$s.log")" | tee -a "$OUT_DIR/run_all.meta"
done
echo "source hash at end: $(cat ../../backend/empyrean/*.py | sha256sum | cut -c1-12)" | tee -a "$OUT_DIR/run_all.meta"
