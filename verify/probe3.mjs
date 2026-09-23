import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=8314', '--no-open'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise(res => { srv.stdout.on('data', d => { if (String(d).includes('http://')) res(); }); setTimeout(res, 3000); });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360 });
await page.goto('http://127.0.0.1:8314/index.html?run=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app && window.app.game, { timeout: 30000 });
// wrap renderFrame BEFORE the first crash: dump everything about the casters at crash time
const dump = await page.evaluate(() => {
    const out = { caught: 0, layers: [] };
    const orig = World3D.renderFrame.bind(World3D);
    World3D.renderFrame = () => {
        try { orig(); } catch (e) {
            out.caught++;
            if (out.caught === 1) {
                for (const layer of World3D.app.scene.layers.layerList) {
                    const sc = layer.shadowCasters || [];
                    out.layers.push({
                        name: layer.name, sc: sc.length, mi: (layer.meshInstances || []).length,
                        sample: sc.slice(0, 12).map(mi => ({
                            node: mi.node && mi.node.name, cast: mi.castShadow,
                            ib: !!(mi.mesh && mi.mesh.indexBuffer && mi.mesh.indexBuffer.length),
                            ib0: !!(mi.mesh && mi.mesh.indexBuffer && mi.mesh.indexBuffer[0]),
                            vb: !!(mi.mesh && mi.mesh.vertexBuffer),
                            style: mi.renderStyle, shaderFailed: !!(mi.shader && mi.shader.failed)
                        }))
                    });
                }
            }
            if (out.caught > 6) World3D.renderFrame = orig;   // stop wrapping
        }
    };
    return new Promise(res => setTimeout(() => res(out), 9000));
});
console.log(JSON.stringify(dump, null, 1).slice(0, 2600));
await browser.close(); srv.kill();
