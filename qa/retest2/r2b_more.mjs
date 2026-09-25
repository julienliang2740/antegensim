import { log, api, waitIdle, loadState, saveState } from './lib.mjs';
const st = loadState(); const runId = st.main.runId;
await api(`/runs/${runId}/commands`, { method: 'POST', body: { command: 'step_round' } }); const s = await waitIdle(runId);
log('  step_round ->', s.state, s.current_turn_id, 'next', JSON.stringify(s.next_round_order));
const live = (await api(`/runs/${runId}/state`)).body;
for (const id of Object.keys(live.entities.agents)) {
  const a = live.entities.agents[id];
  const kv = (await api(`/runs/${runId}/agents/${id}/knowledge`)).body;
  log('  ', id, 'pos', JSON.stringify(a.position), 'observed', kv.observed_entities.length, 'last action', JSON.stringify(a.last_action ?? a.last_result ?? null)?.slice(0, 160));
}
