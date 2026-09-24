// ============================================================================
//  Wanderburg — deployment check (GitHub Pages or any hosting)
// ----------------------------------------------------------------------------
//  NODE_PATH=<puppeteer> node verify/deploy.mjs [url]
//      default url: https://zavodilo.github.io/Wanderburg
//
//  What a player gets on the wire, not in the working tree: every response is watched for 4xx/5xx
//  and failed requests (a missing favicon or a stale asset path shows up here), the console must
//  stay clean, and two screenshots are taken — the title screen with the living valley behind it
//  and a run in progress (?run=1). Writes verify/deploy-menu.png and verify/deploy-play.png.
// ============================================================================
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || 'https://zavodilo.github.io/Wanderburg').replace(/\/$/, '');

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const bad = [];
const errors = [];
page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
page.on('requestfailed', (r) => bad.push('FAILED ' + r.url() + ' ' + ((r.failure() || {}).errorText || '')));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200)); });

let failed = 0;
// --- the title screen: the menu over the attract run -----------------------------------------
await page.goto(BASE + '/index.html', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.state === 'menu', { timeout: 60000 });
await new Promise(r => setTimeout(r, 3500));
await page.screenshot({ path: path.join(ROOT, 'verify/deploy-menu.png') });
const menu = await page.evaluate(() => ({
    ui: document.querySelectorAll('.arc-ui > *').length,
    title: (document.querySelector('.arc-ui') || {}).textContent ? 'yes' : 'no',
    variant: window.app.runtime && window.app.runtime.variant,
    profile: window.app.runtime && window.app.runtime.profile,
    contract: window.app.runtime && window.app.runtime.contractHash
}));
console.log('  menu   :', JSON.stringify(menu));

// --- a run in progress ------------------------------------------------------------------------
await page.goto(BASE + '/index.html?run=1', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.run && window.app.game.state === 'play', { timeout: 60000 });
await new Promise(r => setTimeout(r, 4000));
// the hull must actually drive on the deployment: trusted ArrowUp for a second of game frames
const drove = await page.evaluate(async () => {
    const g = window.app.game, p0 = g.run.player;
    const a = { x: p0.x, y: p0.y };
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
    for (let i = 0; i < 60; i++) g.update(1 / 60);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true }));
    const p = g.run.player;
    return Math.round(Math.hypot(p.x - a.x, p.y - a.y));
});
await page.screenshot({ path: path.join(ROOT, 'verify/deploy-play.png') });
console.log('  drive  : ArrowUp for 1 s of game frames moved the hull ' + drove + ' px');
if (drove < 30) { console.log('  FAIL: the hull does not obey the arrows on the deployment'); failed++; }

if (bad.length) { console.log('  FAIL: bad responses:'); for (const b of bad) console.log('    ' + b); failed++; }
else console.log('  network: no 4xx/5xx, no failed requests');
if (errors.length) { console.log('  FAIL: console errors:'); for (const e of errors.slice(0, 8)) console.log('    ' + e); failed++; }
else console.log('  console: clean');

await browser.close();
console.log(failed ? '\n  DEPLOYMENT CHECK FAILED (' + failed + ')\n' : '\n  Deployment at ' + BASE + ' is playable.\n');
process.exit(failed ? 1 : 0);
