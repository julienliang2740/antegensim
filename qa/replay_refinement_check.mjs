// Read-only replay regression. Uses recorded B2v2 turns by default; never posts commands.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const api = process.env.API_URL ?? 'http://127.0.0.1:8000';
const run = process.env.QA_RUN_ID ?? 'run_20260927_071445_7748';
const turns = await (await fetch(`${api}/api/runs/${run}/turns`)).json();
const at = turns.findIndex(t => t.turn_id === 'r00017_t28_a22');
const start = turns[Math.max(1, at)].turn_id;
const next = turns[Math.max(1, at) + 1].turn_id;
const after = turns[Math.max(1, at) + 2].turn_id;
const browser = await chromium.launch({headless:true, args:['--disable-gpu','--disable-webgl']});
const page = await browser.newPage({viewport:{width:1600,height:1000}});
const errors = []; const commands = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => {if (r.method() === 'POST' && /\/commands$/.test(r.url())) commands.push(r.url());});
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const shown = () => page.locator('.insp-marks').getAttribute('data-turn-id');
async function open(id) {
 await page.goto(`${base}/#/run/${run}?turn=${id}`);
 await page.locator('.insp-marks').waitFor();
 await page.waitForFunction(id => document.querySelector('.insp-marks')?.getAttribute('data-turn-id')===id,id);
}
try {
 await open(start);
 const initialBoard = await page.locator('.insp-map-viewport').boundingBox();
 assert.ok(initialBoard.width > 1600 * 0.9 && initialBoard.height > 1000 * 0.55, 'board occupies the primary workspace');
 await page.getByRole('button',{name:'Inspector & tools',exact:true}).click();
 assert.deepEqual(await page.locator('.insp-map-viewport').boundingBox(),initialBoard,'utility panels do not compress the board');
 await page.getByRole('button',{name:'Close inspector panel',exact:true}).click();
 assert.equal(await page.getByRole('region',{name:'Run controls', exact:true}).getByRole('button').count(),3);
 const zoom = page.locator('.insp-zoom-level');
 const before = parseInt(await zoom.textContent());
 const board = page.locator('.insp-map-svg');
 const bounds = await board.boundingBox();
 await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
 const scroll = await page.evaluate(()=>scrollY);
 await page.mouse.wheel(0,-150); await wait(150);
 assert.ok(parseInt(await zoom.textContent())>before,'wheel up zooms in');
 await page.mouse.wheel(0,150); await wait(150);
 assert.equal(parseInt(await zoom.textContent()),before,'wheel down restores zoom');
 assert.equal(await page.evaluate(()=>scrollY),scroll,'board wheel does not scroll page');
 await page.getByRole('button',{name:'Replay this turn',exact:true}).click();
 await wait(200);
 assert.ok(await page.locator('.turn-cue').count()>0,'action cues rendered');
 assert.ok(await page.locator('.turn-cue-impact').first().evaluate(e=>Number(getComputedStyle(e).opacity))>0,'action cue visibly animates');
 await fs.mkdir('/tmp/empyrean-replay-check',{recursive:true});
 await page.screenshot({path:'/tmp/empyrean-replay-check/2d.png'});
 // Delay next checkpoint beyond the playback tempo: do not skip its animation slot.
 let held = false; let released = false;
 await page.route(`**/turns/${next}`, async route => { held=true; await wait(2200); released=true; await route.continue(); });
 await page.getByLabel('Replay tempo',{exact:true}).selectOption('1300');
 await page.getByRole('button',{name:'Replay from here',exact:true}).click();
 await page.waitForFunction(() => document.querySelector('.saved-replay-note')?.textContent?.includes('Waiting'),null,{timeout:8000});
 await wait(400);
 assert.ok(held && !released,'next checkpoint is still loading');
 assert.equal(await shown(),start,'previous board remains while loading');
 await page.waitForFunction(id=>document.querySelector('.insp-marks')?.getAttribute('data-turn-id')===id,next,{timeout:8000});
 await wait(350); assert.equal(await shown(),next,'loaded checkpoint receives its own playback time');
 await page.waitForFunction(id=>document.querySelector('.insp-marks')?.getAttribute('data-turn-id')===id,after,{timeout:8000});
 await page.getByRole('button',{name:'Stop replay',exact:true}).click();
 const stopped = await shown(); await wait(1600); assert.equal(await shown(),stopped,'stop holds current turn');
 await page.unroute(`**/turns/${next}`);
 // Opening a profile suspends playback so reading details cannot silently skip turns.
 await page.getByRole('button',{name:'Replay from here',exact:true}).click();
 await page.getByRole('button',{name:'Session & agents',exact:true}).click();
 await page.locator('.roster-row').first().click();
 await page.locator('.profile-card').waitFor();
 const inspected = await shown(); await wait(1600);
 assert.equal(await shown(),inspected,'profile inspector suspends replay');
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Close inspector panel',exact:true}).click();
 await page.getByRole('button',{name:'Stop replay',exact:true}).click();
 // A direct round jump stops playback and chooses that round's first turn.
 await page.getByRole('button',{name:'Replay from here',exact:true}).click();
 await page.getByLabel('Jump to round',{exact:true}).selectOption('2');
 const firstRound = turns.find(t=>t.round===2).turn_id;
 await page.waitForFunction(id=>document.querySelector('.insp-marks')?.getAttribute('data-turn-id')===id,firstRound);
 assert.equal(await page.getByRole('button',{name:'Stop replay',exact:true}).count(),0);
 // Same-run route navigation also cancels the old replay queue.
 await page.getByRole('button',{name:'Replay from here',exact:true}).click();
 await page.evaluate(({run,after})=>{ location.hash=`/run/${run}?turn=${after}`; },{run,after});
 await page.waitForFunction(id=>document.querySelector('.insp-marks')?.getAttribute('data-turn-id')===id,after);
 assert.equal(await page.getByRole('button',{name:'Stop replay',exact:true}).count(),0);
 // End-of-record playback remains in history and creates no new simulation turns.
 await open(turns.at(-2).turn_id);
 await page.getByLabel('Replay tempo',{exact:true}).selectOption('1300');
 await page.getByRole('button',{name:'Replay from here',exact:true}).click();
 await page.getByRole('button',{name:'Stop replay',exact:true}).waitFor({state:'hidden',timeout:12000});
 assert.equal(await shown(),turns.at(-1).turn_id);
 assert.equal(await page.locator('.timeline .mode-badge').textContent(),'HISTORY');
 await open(start);
 await page.getByRole('radio',{name:'3D view',exact:true}).check();
 await page.locator('.map3d[data-ready="1"]').waitFor();
 await page.locator('.map3d-help').getByRole('button',{name:'Close',exact:true}).click({timeout:1000}).catch(()=>{});
 await page.getByRole('button',{name:'Replay this turn',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.map3d')?.getAttribute('data-animating')==='1');
 assert.equal(await page.locator('.map3d').getAttribute('data-rendering'),'cpu-canvas');
 await wait(300); await page.screenshot({path:'/tmp/empyrean-replay-check/3d.png'});
 await page.waitForFunction(()=>document.querySelector('.map3d')?.getAttribute('data-animating')==='0');
 await page.getByRole('button',{name:'Replay this turn',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.map3d')?.getAttribute('data-animating')==='1');
 // Reduced motion leaves static annotations while suppressing transient 2D cues.
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.getByRole('radio',{name:'2D map',exact:true}).check();
 await page.getByRole('button',{name:'Replay this turn',exact:true}).click();
 assert.equal(await page.locator('.turn-cue-impact').first().evaluate(e=>getComputedStyle(e).animationName),'none');
 assert.equal(await page.locator('.turn-cue-impact').first().evaluate(e=>getComputedStyle(e).opacity),'0');
 await page.setViewportSize({width:390,height:844});
 await page.locator('.saved-replay').scrollIntoViewIfNeeded();
 assert.ok(await page.getByRole('button',{name:'Replay from here',exact:true}).isVisible());
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),'mobile has no horizontal overflow');
 await page.screenshot({path:'/tmp/empyrean-replay-check/mobile.png'});
 assert.deepEqual(commands,[],'saved playback sends no simulation commands');
 assert.deepEqual(errors,[],'no page errors');
 console.log('PASS: wheel zoom, visible action cues, replay loading/stop/navigation/end, CPU 3D replay, reduced motion, mobile layout; no simulation commands.');
} finally { await browser.close(); }
