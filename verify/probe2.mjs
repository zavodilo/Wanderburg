import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=8313', '--no-open'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise(res => { srv.stdout.on('data', d => { if (String(d).includes('http://')) res(); }); setTimeout(res, 3000); });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 450 });
const errors = [];
page.on('pageerror', e => errors.push((e.message || '').slice(0, 80)));
page.on('console', m => { if (m.type() === 'error') errors.push('C:' + m.text().slice(0, 80)); });
await page.goto('http://127.0.0.1:8313/index.html?run=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.run, { timeout: 30000 });
await new Promise(r => setTimeout(r, 6000));
const dump = await page.evaluate(() => {
    const out = [];
    for (const layer of World3D.app.scene.layers.layerList) {
        const sc = layer.shadowCasters || [];
        if (!sc.length) continue;
        const inst = new Set(layer.instances || []);
        out.push({
            layer: layer.name, casters: sc.length,
            sample: sc.slice(0, 4).map(mi => ({
                node: mi.node ? mi.node.name : 'no-node',
                dead: !!(mi.node && mi.node._destroyed),
                cast: mi.castShadow,
                inInst: inst.has(mi),
                mesh: !!mi.mesh, meshDead: !!(mi.mesh && mi.mesh.destroyed),
                mat: mi.material ? mi.material.name : String(mi.material),
                shader: !!mi.shader
            }))
        });
    }
    return out;
});
console.log(JSON.stringify(dump, null, 1).slice(0, 3000));
console.log('errors', errors.slice(0, 3));
await browser.close(); srv.kill();
