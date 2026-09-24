// ============================================================================
//  Wanderburg — the input chain at REAL frame rate (browser loop, not stepped)
// ----------------------------------------------------------------------------
//  NODE_PATH=<puppeteer> node verify/input-live.mjs [url]
//      default url: the local dev server; WB_URL=… points it at a deployment
//
//  verify/input.mjs steps the simulation deterministically because headless Chrome can starve
//  requestAnimationFrame to ~1 Hz under software GL. This companion runs the OTHER way: the old
//  headless shell ("headless: 'shell'") produces frames as fast as the renderer can, so the whole
//  player chain is exercised untouched — trusted key events -> the game's listeners -> the rAF
//  loop -> the simulation -> the hull's position. If the arrows work for a player, they move the
//  hull here.
// ============================================================================
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const REMOTE = process.argv[2] || process.env.WB_URL || null;
const PORT = Number(process.env.WB_PORT || 8345);

let srv = null, BASE = REMOTE;
if (!BASE) {
    srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=' + PORT, '--no-open'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((res) => { srv.stdout.on('data', (d) => { if (String(d).includes('http://')) res(); }); setTimeout(res, 3000); });
    BASE = `http://127.0.0.1:${PORT}`;
}
BASE = BASE.replace(/\/$/, '');

const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200)); });
await page.goto(BASE + '/index.html?run=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.run && window.app.game.state === 'play', { timeout: 60000 });
await new Promise(r => setTimeout(r, 1000));

const fps = await page.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(n); };
    requestAnimationFrame(tick);
}));

const pos = () => page.evaluate(() => { const p = window.app.game.run.player; return { x: p.x, y: p.y, heading: p.heading, speed: Math.round(p.speed) }; });
const rows = [];
let failed = 0;
async function live(name, keys, seconds, check) {
    await page.evaluate(() => { const g = window.app.game; g._keys.clear(); const p = g.run.player; p.vx = 0; p.vy = 0; p.stun = 0; });
    const a = await pos();
    for (const k of keys) await page.keyboard.down(k);
    await new Promise(r => setTimeout(r, seconds * 1000));
    const b = await pos();
    for (const k of keys) await page.keyboard.up(k);
    await new Promise(r => setTimeout(r, 200));
    const m = { move: Math.round(Math.hypot(b.x - a.x, b.y - a.y)), speed: b.speed };
    let d = (b.heading - a.heading) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2;
    m.turnDeg = Math.round(d * 180 / Math.PI);
    const ok = check(m);
    if (!ok) failed++;
    rows.push([name, keys.join('+'), ok, m]);
}

// A sandbox without a GPU gets ~1-2 compositor frames per second for ANY WebGL scene (BeginFrame
// is on demand; swiftshader + an idle compositor starve rAF). Measuring "the keys" there would
// measure the sandbox. Below 20 fps the live check defers to verify/input.mjs (deterministic
// frames) instead of failing: on a player's machine, and in any GPU-backed CI, it runs for real.
if (fps < 20) {
    console.log('\n  Wanderburg — live frame loop at ' + BASE);
    console.log('  SKIPPED: rAF ' + fps + ' fps — this environment cannot sustain a real frame loop');
    console.log('  (no GPU: headless Chrome produces ~1-2 compositor frames per second for any WebGL scene).');
    console.log('  The deterministic contract is verify/input.mjs; re-run this file on a GPU-backed machine.\n');
    await browser.close();
    if (srv) srv.kill();
    process.exit(0);
}

const SECONDS = 2.5;
await live('gas ArrowUp (live loop)', ['ArrowUp'], SECONDS, (m) => m.move > 150);
await live('gas KeyW (live loop)', ['KeyW'], SECONDS, (m) => m.move > 150);
await live('reverse ArrowDown', ['ArrowDown'], SECONDS, (m) => m.move > 60);
await live('steer ArrowLeft', ['ArrowLeft'], 1.5, (m) => m.turnDeg < -15);
await live('steer ArrowRight', ['ArrowRight'], 1.5, (m) => m.turnDeg > 15);
await live('gas+boost Space', ['ArrowUp', 'Space'], SECONDS, (m) => m.speed > 220);

console.log('\n  Wanderburg — live frame loop at ' + BASE + ' (rAF ' + fps + ' fps, ' + SECONDS + ' s holds)');
for (const [name, keys, ok, m] of rows) {
    console.log('  ' + (ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m') + ' ' + name.padEnd(26) + '\x1b[2m' + keys.padEnd(16) + JSON.stringify(m) + '\x1b[0m');
}
if (errors.length) { console.log('  console errors:'); for (const e of errors.slice(0, 6)) console.log('    ' + e); failed++; }
else console.log('  console: clean');


await browser.close();
if (srv) srv.kill();
console.log(failed ? '\n  LIVE INPUT CHECK FAILED: ' + failed + '\n' : '\n  The arrows drive the hull in a real frame loop.\n');
process.exit(failed ? 1 : 0);
