// Scratch: drive the real game in Chrome (with ?run=1 it skips the menus), feed it keys and
// take screenshots + a console-error dump. This is how the game gets LOOKED at.
//   NODE_PATH=<puppeteer> node verify/shots.mjs [seconds] [outPrefix]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const seconds = Number(process.argv[2] || 25);
const prefix = process.argv[3] || 'verify/play';

const srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=8311', '--no-open'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res) => {
    srv.stdout.on('data', (d) => { if (String(d).includes('http://')) res(); });
    setTimeout(res, 3000);
});

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message).split('\n').slice(0, 6).join(' | ')));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 220)); });
await page.goto('http://127.0.0.1:8311/index.html?run=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.run, { timeout: 30000 });

// A simple autopilot IN THE PAGE: it presses the same keys a player would, through the game's
// own input state (Game.readInput reads Game._keys), so the whole input path is exercised.
await page.evaluate(() => {
    window.__wbDrive = true;
    const g = window.app.game;
    let t = 0;
    const step = () => {
        if (!window.__wbDrive) return;
        t += 1 / 60;
        const run = g.run, p = run && run.player;
        if (!p) { requestAnimationFrame(step); return; }
        // pick a target: the boss, else the nearest food, else the gate
        let target = null, best = -1;
        const r = run.region;
        if (run.boss && run.boss.alive) target = run.boss;
        else {
            for (const e of r.entities) {
                if (e.dead) continue;
                if (e.type !== 'village' && e.type !== 'node' && e.type !== 'herd' && e.type !== 'chunk') continue;
                const d = Math.hypot(e.x - p.x, e.y - p.y);
                if (best < 0 || d < best) { best = d; target = e; }
            }
            if (!target) target = r.gate;
        }
        const dC = Math.hypot(p.x - r.cx, p.y - r.cy);
        let want;
        if (dC > r.regionR - 190) want = Math.atan2(r.cy - p.y, r.cx - p.x);
        else want = Math.atan2(target.y - p.y, target.x - p.x);
        let d = (want - p.heading) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        const K = g._keys;
        K.clear();
        // align first, then drive: a human does the same, and it does not oscillate
        if (Math.abs(d) > 0.5) { K.add(Math.abs(d) > 2.6 ? 'back' : 'fwd'); }
        else K.add('fwd');
        if (d < -0.06) K.add('left'); else if (d > 0.06) K.add('right');
        if (best > 340 && Math.abs(d) < 0.3) K.add('boost');
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
});

const shots = [];
for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, (seconds / 4) * 1000));
    const file = prefix + '-' + i + '.png';
    await page.screenshot({ path: path.join(ROOT, file) });
    shots.push(file);
    const s = await page.evaluate(() => {
        const g = window.app.game, run = g.run, p = run.player;
        return {
            state: g.state, region: run.regionIndex, tier: p.tier, hp: Math.round(p.hp), maxHp: p.maxHp,
            mass: Math.round(p.mass), mods: p.modules.length, x: Math.round(p.x), y: Math.round(p.y),
            over: run.over, draft: !!run.draftPending, entities: run.region.entities.length,
            fps: Math.round(World3D.fps())
        };
    });
    console.log('t=' + Math.round((seconds / 4) * (i + 1)) + 's', JSON.stringify(s));
}
console.log('console errors:\n' + (errors.length ? errors.slice(0, 6).join('\n---\n') : 'none'));
fs.writeFileSync(path.join(ROOT, 'verify/shots-errors.json'), JSON.stringify(errors, null, 2));
await browser.close();
srv.kill();
console.log('shots:', shots.join(' '));
