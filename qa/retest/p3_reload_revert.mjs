// Minimal repro: a staged voice / placement followed by a working/ reload in the same boundary.
import fs from 'node:fs';
import path from 'node:path';
import { log, api, waitIdle } from './lib.mjs';
async function scenario(order) {
  const d = (await api('/defaults?agent_count=6')).body;
  d.name = `retest reload-revert repro (${order})`; d.play_delay_seconds = 0;
  const runId = (await api('/runs', { method: 'POST', body: d })).body.run_id;
  await api(`/runs/${runId}/open`, { method: 'POST' });
  const sum = (await api(`/runs/${runId}`)).body;
  const stageUi = async () => {
    await api(`/runs/${runId}/interventions`, { method: 'POST', body: { type: 'voice', recipients: { mode: 'agents', agent_ids: ['a01'] }, text: 'repro voice', origin: 'ui' } }).then((r) => r.status >= 300 && log('voice stage failed', JSON.stringify(r.body).slice(0, 300)));
    await api(`/runs/${runId}/interventions`, { method: 'POST', body: { type: 'place_entity', entity: { kind: 'fruit', id: '', position: { x: 0, y: 0 }, available_compute: 33, available_essence: 0 }, origin: 'ui' } });
  };
  const reload = async () => {
    const p = path.join(sum.run_dir, 'working', 'entities', 'agents', 'a05.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8')); j.stats.health = 77; fs.writeFileSync(p, JSON.stringify(j, null, 2));
    const r = await api(`/runs/${runId}/working/reload`, { method: 'POST' });
    log('  reload', r.body.ok, JSON.stringify(r.body.changes?.map((c) => `${c.path}: ${c.before} -> ${c.after}`)));
  };
  if (order === 'ui-then-file') { await stageUi(); await reload(); } else { await reload(); await stageUi(); }
  log('  staged', (await api(`/runs/${runId}/interventions`)).body.staged.map((x) => x.type).join(', '));
  await api(`/runs/${runId}/commands`, { method: 'POST', body: { command: 'run_turn' } });
  const s = await waitIdle(runId);
  const tv = (await api(`/runs/${runId}/turns/${s.current_turn_id}`)).body;
  const recs = tv.turn.interventions.map((r) => `${r.intervention.type}:${r.ok ? 'ok' : 'FAILED ' + r.error}`);
  const kn = (await api(`/runs/${runId}/turns/${s.current_turn_id}/agents/a01/knowledge`)).body.knowledge.records;
  const voiceRec = kn.filter((r) => r.kind === 'operator_voice').length;
  const fruit33 = Object.values(tv.entities.fruits).filter((f) => f.available_compute === 33).length;
  log(`  [${order}] records: ${recs.join(' | ')} -> a01 operator_voice records: ${voiceRec}, placed fruit present: ${fruit33}, a05 health: ${tv.entities.agents.a05.stats.health}`);
  await api(`/runs/${runId}/close`, { method: 'POST' });
  return runId;
}
log('=== P3 reload-revert repro');
for (const order of ['ui-then-file', 'file-then-ui']) log('  run', await scenario(order));
