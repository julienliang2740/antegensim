import { chromium } from 'playwright';
import fs from 'node:fs';
export const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
export const API = process.env.API_URL || 'http://127.0.0.1:8000';
const STATE = new URL('./state.json', import.meta.url).pathname;
const LOG = new URL('./log.txt', import.meta.url).pathname;
export function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
export function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }
export function log(...a) { const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(line); fs.appendFileSync(LOG, line + '\n'); }
export async function api(path, opts = {}) {
  const r = await fetch(API + '/api' + path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
export async function launch(vp = '1440x900') {
  const [w, h] = vp.split('x').map(Number);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('console', m => { if (m.type() === 'error') log('  [console.error]', m.text().slice(0, 300)); });
  page.on('pageerror', e => log('  [pageerror]', String(e).slice(0, 300)));
  return { browser, page };
}
export async function shot(page, name, opts = {}) {
  const p = new URL(`./shots/${name}.png`, import.meta.url).pathname;
  await page.screenshot({ path: p, ...opts });
  log('  shot:', p);
  return p;
}
export async function text(page, sel) { return (await page.locator(sel).first().innerText().catch(() => '')).trim(); }
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function status(runId) { return (await api(`/runs/${runId}/status`)).body; }
export function stamp() { return new Date().toISOString().slice(11, 23); }
