import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=8323', '--no-open'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise(res => { srv.stdout.on('data', d => { if (String(d).includes('http://')) res(); }); setTimeout(res, 3000); });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360 });
await page.goto('http://127.0.0.1:8323/index.html?run=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.run, { timeout: 30000 });
await new Promise(r => setTimeout(r, 3500));
const out = await page.evaluate(() => {
    const g = window.app.game, v = g.view;
    const res = [];
    for (const s of v.scenery) {
        if (!s.key.startsWith('peak')) continue;
        for (const mi of v.view.meshInstancesOf(s.root)) {
            const pos = mi.mesh.positions || (mi.mesh.vertexBuffer && null);
            if (!pos) { res.push({ key: s.key, noPositions: true, vb: !!mi.mesh.vertexBuffer }); continue; }
            let ymin = 1e9, ymax = -1e9;
            for (let i = 1; i < pos.length; i += 3) { ymin = Math.min(ymin, pos[i]); ymax = Math.max(ymax, pos[i]); }
            res.push({ key: s.key.slice(0, 14), verts: pos.length / 3, ymin: Math.round(ymin), ymax: Math.round(ymax) });
        }
        if (res.length > 5) break;
    }
    // also a raw recipe check
    const raw = WanderMesh.peak(12345, 0x7c7f84, 1.2, 0xeaf0f4);
    let rmin = 1e9, rmax = -1e9;
    for (const p of raw[0].geo) { /* flat array */ }
    const g0 = raw[0].geo;
    for (let i = 1; i < g0.length; i += 3) { rmin = Math.min(rmin, g0[i]); rmax = Math.max(rmax, g0[i]); }
    return { res, rawRock: { ymin: Math.round(rmin), ymax: Math.round(rmax), n: g0.length / 3 } };
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); srv.kill();
