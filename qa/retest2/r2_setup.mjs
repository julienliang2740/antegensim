// Main run for checks (2)-(7): 8 agents, 3 rounds via the API, then two crowded cells staged
// (the placement form itself is exercised through the UI in r1): cell A = an agent's cell with
// fruit/seed/residue added (about 8 occupants), cell B = 16 placed entities (scroll cue).
import { log, api, waitIdle, loadState, saveState } from './lib.mjs';
const st = loadState();
const d = (await api('/defaults?agent_count=8')).body;
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
d.name = `retest2 main ${stamp}`; d.play_delay_seconds = 0;
const runId = (await api('/runs', { method: 'POST', body: d })).body.run_id;
await api(`/runs/${runId}/open`, { method: 'POST' });
log(`=== R2 setup ${runId}`);
for (let i = 0; i < 3; i++) { await api(`/runs/${runId}/commands`, { method: 'POST', body: { command: 'step_round' } }); const s = await waitIdle(runId); log('  step_round ->', s.state, s.current_turn_id); }
const live = (await api(`/runs/${runId}/state`)).body;
// agent with the most observation sightings
let best = null;
for (const id of Object.keys(live.entities.agents)) {
  const kv = (await api(`/runs/${runId}/agents/${id}/knowledge`)).body;
  const n = (kv.observed_entities || []).length;
  log('  ', id, 'observed_entities', n, 'believed', JSON.stringify(kv.believed_self?.position), 'true', JSON.stringify(live.entities.agents[id].position));
  if (!best || n > best.n) best = { id, n };
}
const A = live.entities.agents[best.id].position;
const land = (p) => live.map.terrain?.[`${p.x},${p.y}`] ?? null;
log('  chosen agent', best.id, 'at', A);
const place = async (ent) => { const r = await api(`/runs/${runId}/interventions`, { method: 'POST', body: { type: 'place_entity', entity: ent, origin: 'ui' } }); if (r.status >= 300) log('  place failed', JSON.stringify(r.body).slice(0, 300)); };
for (const c of [25, 40, 12.5]) await place({ kind: 'fruit', id: '', position: A, available_compute: c, available_essence: 0 });
await place({ kind: 'seed', id: '', position: A, species: 'fruit_tree', germinates_round: 99 });
await place({ kind: 'residue', id: '', position: A, available_compute: 5, available_essence: 2, source_id: 'a99', source_kind: 'agent' });
// cell B: a land cell 2 steps from A without occupants, 16 entities
const occ = live.map.occupants;
let B = null;
for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [3, 0], [0, 3]]) { const p = { x: A.x + dx, y: A.y + dy }; if (!(occ[`${p.x},${p.y}`]?.length) && live.map.region && p.x >= live.map.region.min_x && p.x <= live.map.region.max_x && p.y >= live.map.region.min_y && p.y <= live.map.region.max_y) { B = p; break; } }
log('  cell B', B);
for (let i = 0; i < 8; i++) await place({ kind: 'fruit', id: '', position: B, available_compute: 10 + i, available_essence: 0 });
for (let i = 0; i < 4; i++) await place({ kind: 'seed', id: '', position: B, species: 'fruit_tree', germinates_round: 50 + i });
for (let i = 0; i < 4; i++) await place({ kind: 'residue', id: '', position: B, available_compute: 3 + i, available_essence: 1, source_id: `a9${i}`, source_kind: 'agent' });
const staged = (await api(`/runs/${runId}/interventions`)).body.staged;
log('  staged', staged.length, staged.filter((x) => x.ok === false).length);
await api(`/runs/${runId}/commands`, { method: 'POST', body: { command: 'run_turn' } });
const s = await waitIdle(runId);
const tv = (await api(`/runs/${runId}/turns/${s.current_turn_id}`)).body;
log('  applied at', s.current_turn_id, 'failed:', tv.turn.interventions.filter((r) => !r.ok).map((r) => r.error));
const live2 = (await api(`/runs/${runId}/state`)).body;
const counts = Object.entries(live2.map.occupants).sort((a, b) => b[1].length - a[1].length).slice(0, 4).map(([k, v]) => `${k}:${v.length}`);
log('  most crowded cells', counts, 'agent now at', JSON.stringify(live2.entities.agents[best.id].position));
st.main = { runId, agent: best.id, A, B, keyA: `${A.x},${A.y}`, keyB: `${B.x},${B.y}`, occA: live2.map.occupants[`${A.x},${A.y}`], occB: live2.map.occupants[`${B.x},${B.y}`] };
saveState(st);
log('  state', st.main);
