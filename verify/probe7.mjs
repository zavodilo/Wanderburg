import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=8318', '--no-open'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise(res => { srv.stdout.on('data', d => { if (String(d).includes('http://')) res(); }); setTimeout(res, 3000); });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360 });
await page.evaluateOnNewDocument(() => {
    const iv = setInterval(() => {
        if (typeof World3D === 'undefined' || !World3D.app) return;
        clearInterval(iv);
        const app = World3D.app;
        const orig = app.render.bind(app);
        window.__err = [];
        window.__bad = [];
        app.render = (...a) => {
            try { return orig(...a); } catch (e) {
                if (window.__err.length < 2) {
                    window.__err.push(e.stack || e.message);
                    for (const layer of app.scene.layers.layerList) {
                        for (const list of [layer.opaqueMeshInstances, layer.transparentMeshInstances]) {
                            if (!list) continue;
                            for (const mi of list) {
                                const dead = !mi.mesh || mi.mesh.destroyed ||
                                    !mi.mesh.indexBuffer || !mi.mesh.indexBuffer[0] || !mi.mesh.indexBuffer[0].impl ||
                                    !mi.mesh.vertexBuffer || !mi.mesh.vertexBuffer.impl;
                                if (dead) window.__bad.push({
                                    layer: layer.name, node: mi.node && mi.node.name,
                                    meshDestroyed: !!(mi.mesh && mi.mesh.destroyed),
                                    ib: !!(mi.mesh && mi.mesh.indexBuffer && mi.mesh.indexBuffer[0]),
                                    ibImpl: !!(mi.mesh && mi.mesh.indexBuffer && mi.mesh.indexBuffer[0] && mi.mesh.indexBuffer[0].impl),
                                    vbImpl: !!(mi.mesh && mi.mesh.vertexBuffer && mi.mesh.vertexBuffer.impl),
                                    mat: mi.material && mi.material.name
                                });
                            }
                        }
                    }
                }
                throw e;
            }
        };
    }, 8);
});
await page.goto('http://127.0.0.1:8318/index.html?run=1', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 8000));
const err = await page.evaluate(() => window.__err || []);
const bad = await page.evaluate(() => window.__bad || []);
console.log(err.length ? err[0].split('\n').slice(0, 6).join('\n') : 'app.render never threw');
console.log('BAD MIs:', JSON.stringify(bad.slice(0, 10), null, 1));
await browser.close(); srv.kill();
