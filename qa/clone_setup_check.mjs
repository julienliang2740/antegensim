/** Clone setup: real UI/API, temporary fake-model sessions only; no model turns.
 * DOCS: select one session, edit its original setup, validate/create a fresh world; archive/error paths.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const apiBase = process.env.API_URL ?? 'http://127.0.0.1:8000';
async function api(method, path, body) {
  const response = await fetch(`${apiBase}/api${path}`, {method, headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return response.status === 204 ? null : response.json();
}
const created = [];
const browser = await chromium.launch({headless:true,args:['--disable-gpu','--disable-webgl']});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const errors = [];
page.on('pageerror',error=>errors.push(error.message));
try {
  const request = await api('GET','/defaults?agent_count=16');
  Object.assign(request,{name:`Clone QA ${Date.now()}`,seed:391,default_model_key:'fake-heuristic',world_id:`world_clone_qa_${Date.now()}`});
  request.agents.forEach(card=>card.model_key=null);
  Object.assign(request.agents[0],{persona:'Preserve this original persona.',notebook:'Original notebook.',model_key:'fake-heuristic'});
  const source = await api('POST','/runs',request); created.push(source.run_id);
  await api('POST',`/runs/${source.run_id}/close`);
  const second = await api('POST','/runs',{...request,name:`${request.name} second`}); created.push(second.run_id);
  await api('POST',`/runs/${second.run_id}/close`);
  const sourceSetup = await api('GET',`/runs/${source.run_id}/setup`);
  const sourceSummary = await api('GET',`/runs/${source.run_id}`);
  const writes = [];
  page.on('request',req=>{if(req.method()==='POST' && /\/api\/runs(?:$|\/.*\/(open|commands)$)/.test(new URL(req.url()).pathname)) writes.push(req.url());});
  await page.goto(`${base}/#/resume`);
  await page.getByLabel('Filter by name or id').fill(request.name);
  const select = page.getByRole('checkbox',{name:`Select ${request.name}`,exact:true});
  await select.check();
  const clone = page.getByRole('button',{name:'Clone setup',exact:true});
  assert.ok(await clone.isEnabled());
  await page.getByRole('checkbox',{name:`Select ${second.name}`,exact:true}).click({modifiers:['Control']});
  assert.ok(await clone.isDisabled(),'multiple selected sessions cannot be cloned together');
  await page.getByRole('checkbox',{name:`Select ${second.name}`,exact:true}).click({modifiers:['Control']});
  await page.evaluate(()=>sessionStorage.setItem('empyrean.assistant.setupDraft.v1',JSON.stringify({agent_count:6,partial:{name:'Unrelated assistant draft'},source:'another proposal'})));
  await clone.click();
  await page.getByText('Cloned setup',{exact:true}).waitFor();
  assert.ok(page.url().includes(`clone=${source.run_id}`));
  assert.equal(await page.getByLabel('Run name',{exact:true}).inputValue(),`${request.name} (copy)`);
  assert.equal(await page.getByLabel('Seed',{exact:true}).inputValue(),'391');
  assert.deepEqual(writes,[],'opening a cloned form neither opens a source worker nor creates a run');
  await page.reload();
  await page.getByText('Cloned setup',{exact:true}).waitFor();
  await page.getByLabel('Run name',{exact:true}).fill(`${request.name} edited`);
  await page.getByLabel('Seed',{exact:true}).fill('392');
  const validationRequest = page.waitForRequest(req=>req.url().endsWith('/api/runs/validate') && req.method()==='POST');
  await page.getByRole('button',{name:'Validate setup',exact:true}).first().click();
  const submitted = (await validationRequest).postDataJSON();
  assert.deepEqual(submitted,{...sourceSetup,name:`${request.name} edited`,seed:392},'every original setting and all 16 agent cards survive without merging defaults');
  await page.getByText('Setup is valid.',{exact:true}).first().waitFor();
  const createResponse = page.waitForResponse(res=>new URL(res.url()).pathname==='/api/runs' && res.request().method()==='POST');
  await page.getByRole('button',{name:'Create and open',exact:true}).first().click();
  const result = await (await createResponse).json(); created.push(result.run_id);
  assert.notEqual(result.world_id,source.world_id);
  assert.notEqual(result.run_id,source.run_id);
  assert.equal(result.current_turn_id,'r00000_init');
  assert.equal(result.parent,null);
  await page.waitForURL(`**/#/run/${result.run_id}`);
  assert.deepEqual(await api('GET',`/runs/${source.run_id}/setup`),sourceSetup);
  assert.deepEqual(await api('GET',`/runs/${source.run_id}`),sourceSummary);
  assert.ok(!writes.some(url=>url.includes(`/runs/${source.run_id}/`)),'source never opened or commanded');
  await page.goto(`${base}/#/resume`);
  await api('POST',`/runs/${source.run_id}/archive`);
  await page.getByRole('button',{name:'Refresh list',exact:true}).click();
  await page.getByRole('button',{name:/^Archived runs/}).click();
  await page.getByRole('checkbox',{name:`Select ${request.name}`,exact:true}).check();
  await page.getByRole('button',{name:'Clone setup',exact:true}).click();
  await page.getByText('Cloned setup',{exact:true}).waitFor();
  assert.equal((await api('GET',`/runs/${source.run_id}`)).archived,true);
  await page.goto(`${base}/#/new?clone=missing_clone_qa`);
  await page.getByText(/Could not load this session’s original setup/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Create and open',exact:true}).count(),0);
  await page.goto(`${base}/#/new`);
  await page.getByText('Prefilled by the assistant',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Run name',{exact:true}).inputValue(),'Unrelated assistant draft');
  assert.deepEqual(errors,[]);
  console.log('PASS: single selection, exact original setup, editable clone, validation, fresh world, source unchanged, archive, reload, missing source, assistant draft isolation.');
} finally {
  await page.goto('about:blank').catch(()=>{});
  await browser.close();
  for(const id of created.reverse()) {
    await fetch(`${apiBase}/api/runs/${id}/close`,{method:'POST'});
    await api('DELETE',`/runs/${id}`);
  }
}
