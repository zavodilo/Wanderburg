import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=8315', '--no-open'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise(res => { srv.stdout.on('data', d => { if (String(d).includes('http://')) res(); }); setTimeout(res, 3000); });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360 });
await page.goto('http://127.0.0.1:8315/index.html?run=1', { waitUntil: 'domcontentloaded' });
// install the trap BEFORE the game scripts run
await page.evaluateOnNewDocument(() => {
    const wait = setInterval(() => {
        if (typeof pc === 'undefined' || !pc.MeshInstance) return;
        clearInterval(wait);
        const proto = pc.MeshInstance.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'castShadow') ||
            Object.getOwnPropertyDescriptor(new pc.MeshInstance(new pc.Mesh(window.app ? window.app.graphicsDevice : null), null, null), 'castShadow');
        window.__castSets = [];
        if (desc && desc.set) {
            const origSet = desc.set, origGet = desc.get;
            Object.defineProperty(proto, 'castShadow', {
                get: origGet,
                set(v) {
                    if (v === true && window.__castSets.length < 6) {
                        window.__castSets.push({ node: this.node && this.node.name, stack: new Error().stack.split('\n').slice(1, 5).join(' | ') });
                    }
                    return origSet.call(this, v);
                },
                configurable: true
            });
        } else {
            window.__castSets = [{ note: 'no setter on prototype (own field)', hasOwn: !!desc }];
        }
    }, 5);
});
await page.waitForFunction(() => window.app && window.app.game, { timeout: 30000 });
await new Promise(r => setTimeout(r, 7000));
const out = await page.evaluate(() => ({ sets: window.__castSets, desc: !!Object.getOwnPropertyDescriptor(pc.MeshInstance.prototype, 'castShadow') }));
console.log(JSON.stringify(out, null, 1).slice(0, 2500));
await browser.close(); srv.kill();
