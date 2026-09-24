// ============================================================================
//  Wanderburg — input contract in a REAL browser (the player's hands, not the model)
// ----------------------------------------------------------------------------
//  NODE_PATH=<puppeteer> node verify/input.mjs [holdSec]
//
//  Trusted keyboard events (page.keyboard — the same path a player's keyboard takes) feed the
//  game's own listeners; then the SIMULATION is advanced deterministically (N frames of 1/60 s
//  through game.update, exactly what the rAF loop does at 60 Hz) and the hull's answer is
//  measured. Deterministic stepping is the point: headless Chrome may starve requestAnimationFrame
//  to ~1 Hz under software GL, and a starved loop must not be reported as "the keys are broken"
//  (regression: «не мог двигаться стрелками»). DIAG=1 prints the loop's own numbers instead.
//
//  Contract: W/S and ↑/↓ drive the hull, A/D and ←/→ steer it, Shift and Space stoke the boiler,
//  Esc/P pause and resume, Tab hides the HUD.
// ============================================================================
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const SECONDS = Number(process.argv[2] || 1.2);
const PORT = Number(process.env.WB_PORT || 8327);
// WB_URL points the contract at a DEPLOYMENT (GitHub Pages, a hosting): trusted keys over the
// wire, no dev server. Without it the driver serves the working tree itself.
const REMOTE = process.env.WB_URL || null;

let srv = null;
if (!REMOTE) {
    srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=' + PORT, '--no-open'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((res) => {
        srv.stdout.on('data', (d) => { if (String(d).includes('http://')) res(); });
        setTimeout(res, 3000);
    });
}
const BASE = REMOTE || `http://127.0.0.1:${PORT}`;

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200)); });
await page.goto(BASE.replace(/\/$/, '') + '/index.html?run=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.run && window.app.game.state === 'play', { timeout: 30000 });
await new Promise(r => setTimeout(r, 600));

// A fixed seed and an eternal grace period: the contract is about the KEYS, not about whether a
// knight happened to stun the hull this run (a roguelike world is noisy by design).
await page.evaluate(() => {
    const g = window.app.game;
    g.run = new WB.Run({ seed: 4242, region: 0, chassis: WB.CHASSIS[0], captain: WB.CAPTAINS[0], legacy: [], meta: WB.Save.meta });
    g.view.setRun(g.run);
    g.camera.follow(g.run.player);
    g.state = 'play';
    g.run.grace = 1e9;
    Hud.show('play');
});
await new Promise(r => setTimeout(r, 300));

// The rAF loop must not race the measurement: park it, we step the simulation ourselves.
// (game.update is the loop's first call each frame; the view follows the model, so stepping
// update alone is enough to measure the hull's answer to the keys.)
await page.evaluate(() => {
    const g = window.app.game;
    window.__parked = false;
    if (!g.__loopParked) {
        g.__loopParked = true;
        const orig = g.update.bind(g);
        g.update = (dt) => (window.__parked ? undefined : orig(dt));
    }
});

const sample = () => page.evaluate(() => {
    const g = window.app.game, p = g.run.player;
    return { x: p.x, y: p.y, heading: p.heading, speed: Math.round(p.speed), state: g.state, hud: !g._hudHidden, keys: [...g._keys] };
});
/** Advance the simulation n frames of dt seconds, exactly like the frame loop would. */
const step = (seconds) => page.evaluate((sec) => {
    const g = window.app.game;
    window.__parked = false;
    const n = Math.round(sec * 60);
    for (let i = 0; i < n; i++) {
        g.update(1 / 60);
        // The debris vacuum keeps feeding mass while we measure, so a tier-up can open the draft
        // mid-case: that is the game being a roguelike, not the keys failing. Close it and carry on.
        if (g.state !== 'play' && g.state !== 'pause') { if (g.closeDraft) g.closeDraft(); g.state = 'play'; }
    }
    window.__parked = true;
}, seconds);
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const dAng = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

await page.evaluate(() => { window.__parked = true; });

const rows = [];
let failed = 0;
const record = (name, keys, ok, m) => { if (!ok) failed++; rows.push([name, keys, ok, m]); };

// Between cases the hull must be still and the game must be in 'play': a tier-up opens the
// draft overlay (the hull eats whatever the previous case drove it into), and a coasting hull
// steers the other way — both are the simulation being right, not the keys being wrong.
async function settle() {
    await page.evaluate(() => {
        const g = window.app.game;
        g._keys.clear();
        if (g.state !== 'play') { g.closeDraft && g.closeDraft(); g.state = 'play'; }
        if (g.run) {
            g.run.paused = false; g.run.draftPending = null;
            const p = g.run.player;
            // Every case starts from the same spot: cases that drift into the warden courtyard
            // would measure the gate barrier, not the keys.
            const sp = g.run.region.spawn || { x: p.x, y: p.y, heading: p.heading };
            p.x = sp.x; p.y = sp.y; p.heading = sp.heading;
            p.vx = 0; p.vy = 0; p.stun = 0;
        }
        window.__parked = true;
    });
    await step(0.6);
}
async function hold(keys, seconds) {
    await settle();
    const a = await sample();
    for (const k of keys) await page.keyboard.down(k);
    const held = await sample();                       // the listener saw the key
    await step(seconds);
    const b = await sample();
    for (const k of keys) await page.keyboard.up(k);
    await step(0.3);
    return { a, held, b, move: dist(a, b), turn: dAng(a.heading, b.heading) };
}

// --- forward / reverse: WASD and the arrows must drive the hull the same way -----------------
for (const [name, key] of [['gas W', 'KeyW'], ['gas ArrowUp', 'ArrowUp'], ['reverse S', 'KeyS'], ['reverse ArrowDown', 'ArrowDown']]) {
    const r = await hold([key], SECONDS);
    const ok = r.held.keys.length === 1 && r.move > 40 && r.b.state === 'play';
    record(name, key, ok, { seen: r.held.keys, move: Math.round(r.move), speed: r.b.speed });
}
// --- steering: the heading must rotate the right way -----------------------------------------
for (const [name, key, sign] of [['turn A (left)', 'KeyA', -1], ['turn ArrowLeft', 'ArrowLeft', -1], ['turn D (right)', 'KeyD', 1], ['turn ArrowRight', 'ArrowRight', 1]]) {
    const r = await hold([key], SECONDS);
    const ok = r.held.keys.length === 1 && Math.abs(r.turn) > 0.3 && Math.sign(r.turn) === sign && r.b.state === 'play';
    record(name, key, ok, { seen: r.held.keys, turnDeg: Math.round(r.turn * 180 / Math.PI) });
}
// --- combined: gas + steer draws an arc, not a line --------------------------------------------
{
    const r = await hold(['ArrowUp', 'ArrowRight'], SECONDS);
    const ok = r.move > 40 && Math.abs(r.turn) > 0.3;
    record('gas+steer together', 'ArrowUp+ArrowRight', ok, { move: Math.round(r.move), turnDeg: Math.round(r.turn * 180 / Math.PI) });
}
// --- boost: the same gas with steam must be faster --------------------------------------------
const plain = await hold(['KeyW'], SECONDS);
const boostShift = await hold(['KeyW', 'ShiftLeft'], SECONDS);
const boostSpace = await hold(['KeyW', 'Space'], SECONDS);
record('boost on Shift', 'KeyW+ShiftLeft', boostShift.b.speed > plain.b.speed * 1.2, { plain: plain.b.speed, boosted: boostShift.b.speed });
record('boost on Space', 'KeyW+Space', boostSpace.b.speed > plain.b.speed * 1.2, { plain: plain.b.speed, boosted: boostSpace.b.speed });
// --- state keys -------------------------------------------------------------------------------
await settle();
await page.keyboard.press('Escape');
const paused = await sample();
record('Esc pauses', 'Escape', paused.state === 'pause', { state: paused.state });
await page.keyboard.press('KeyP');
const resumed = await sample();
record('P resumes', 'KeyP', resumed.state === 'play', { state: resumed.state });
await page.keyboard.press('Tab');
const hudOff = await sample();
await page.keyboard.press('Tab');
const hudOn = await sample();
record('Tab hides/shows the HUD', 'Tab', hudOff.hud === false && hudOn.hud === true, { off: hudOff.hud, on: hudOn.hud });

console.log('\n  Wanderburg — input contract (' + BASE + ', trusted keys + ' + SECONDS + ' s of deterministic frames)');
for (const [name, keys, ok, m] of rows) {
    console.log('  ' + (ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m') + ' ' + name.padEnd(26) + '\x1b[2m' + String(keys).padEnd(20) + JSON.stringify(m) + '\x1b[0m');
}
if (errors.length) { console.log('  console errors:'); for (const e of errors.slice(0, 8)) console.log('    ' + e); }
else console.log('  console: clean');

await browser.close();
if (srv) srv.kill();
console.log(failed ? '\n  INPUT CONTRACT BROKEN: ' + failed + ' case(s)\n' : '\n  Input contract holds.\n');
process.exit(failed ? 1 : 0);
