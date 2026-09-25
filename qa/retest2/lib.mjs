// Browser re-test helpers (retest2: final re-test after the reload-order fix pass). Run scripts from qa/ so 'playwright' resolves.
import { chromium } from 'playwright';
import fs from 'node:fs';
export const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
export const API = process.env.API_URL || 'http://127.0.0.1:8000';
const HERE = new URL('.', import.meta.url).pathname;
const STATE = HERE + 'state.json';
const LOG = HERE + 'log.txt';
export const SHOTS = HERE + 'shots/';
export const EVIDENCE = '/home/ubuntu/antegensim/docs/evidence/screenshots/';
export function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
export function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }
export function log(...a) { const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(line); fs.appendFileSync(LOG, line + '\n'); }
export async function api(path, opts = {}) {
  const r = await fetch(API + '/api' + path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
export async function status(runId) { return (await api(`/runs/${runId}/status`)).body; }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitIdle(runId, timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const s = await status(runId); if (['paused', 'error', 'finished'].includes(s.state) && !s.active_command && !s.play_loop) return s; await sleep(200); }
  throw new Error('run never idle ' + runId);
}
export async function launch(vp = '1440x900') {
  const [w, h] = vp.split('x').map(Number);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('console', (m) => { if (m.type() === 'error') log('  [console.error]', m.text().slice(0, 300)); });
  page.on('pageerror', (e) => log('  [pageerror]', String(e).slice(0, 300)));
  return { browser, page };
}
export async function shot(page, name, opts = {}) {
  const p = SHOTS + name + '.png';
  await page.screenshot({ path: p, ...opts });
  log('  shot:', p);
  return p;
}
/** Save a curated evidence screenshot (docs/evidence/screenshots/<name>.png) and a copy in shots/. */
export async function evidence(page, name, opts = {}) {
  const p = EVIDENCE + name + '.png';
  await page.screenshot({ path: p, ...opts });
  fs.copyFileSync(p, SHOTS + 'EV-' + name + '.png');
  log('  evidence:', p);
  return p;
}
export async function text(page, sel) { return (await page.locator(sel).first().innerText().catch(() => '')).trim(); }
export async function statusText(page) { return (await page.getByRole('region', { name: 'Run status' }).innerText().catch(() => '')).replace(/\n+/g, ' | '); }
/** Wait until the UI shows the run idle again (status bar settles). */
export async function uiSettle(page, ms = 1500) { await page.waitForTimeout(ms); }
/** Box of a locator rounded, or null. */
export async function box(loc) { const b = await loc.boundingBox().catch(() => null); return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.x + b.width), b: Math.round(b.y + b.height) }; }
