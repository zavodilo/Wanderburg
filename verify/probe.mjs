import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=8312', '--no-open'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise(res => { srv.stdout.on('data', d => { if (String(d).includes('http://')) res(); }); setTimeout(res, 3000); });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 540 });
const errors = [];
page.on('pageerror', e => errors.push((e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
await page.goto('http://127.0.0.1:8312/index.html?run=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.run, { timeout: 30000 });
// PROBE: never destroy shared ink/outline meshes (they are cached per source mesh and shared
// by every entity built from the same recipe). Leak instead of crash.
await page.evaluate(() => {
    const origInk = World3D.inkRemove.bind(World3D);
    World3D.inkRemove = (view, mi) => { const rec = view && view._inks; const e = rec && rec.get(mi); if (!e) return; view.dropFromLayers(e.mi); rec.delete(mi); };
    const origOut = World3D.outlineRemove.bind(World3D);
    World3D.outlineRemove = (view, mi) => { const rec = view && view._outlines; const e = rec && rec.get(mi); if (!e) return; view.dropFromLayers(e); rec.delete(mi); };
    // drive: eat things so entities actually die
    window.__t = 0;
    const g = window.app.game;
    const step = () => {
        const run = g.run, p = run && run.player;
        if (p) {
            let target = null, best = -1;
            for (const e of run.region.entities) {
                if (e.dead || (e.type !== 'village' && e.type !== 'node' && e.type !== 'knight' && e.type !== 'herd')) continue;
                const d = Math.hypot(e.x - p.x, e.y - p.y);
                if (best < 0 || d < best) { best = d; target = e; }
            }
            if (target) {
                const want = Math.atan2(target.y - p.y, target.x - p.x);
                let d = (want - p.heading) % (Math.PI * 2); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
                const K = g._keys; K.clear(); K.add('fwd');
                if (d < -0.08) K.add('left'); else if (d > 0.08) K.add('right');
            }
        }
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
});
await new Promise(r => setTimeout(r, 30000));
const scan = await page.evaluate(() => {
    const bad = [];
    const instSet = new Set();
    for (const layer of World3D.app.scene.layers.layerList) for (const mi of (layer.instances || [])) instSet.add(mi);
    for (const layer of World3D.app.scene.layers.layerList) {
        const sc = layer.shadowCasters || [];
        for (const mi of sc) {
            const inInst = instSet.has(mi);
            const broken = !mi.mesh || !mi.material || (mi.node && mi.node._destroyed);
            if (broken || !inInst) bad.push({ layer: layer.name, broken, inInst, hasMesh: !!mi.mesh, hasMat: !!mi.material, nodeDead: !!(mi.node && mi.node._destroyed), name: mi.node ? mi.node.name : null });
        }
    }
    return { bad: bad.slice(0, 8), badCount: bad.length, state: window.app.game.state, mass: Math.round(window.app.game.run.player.mass) };
});
console.log('scan:', JSON.stringify(scan));
console.log('errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close(); srv.kill();
