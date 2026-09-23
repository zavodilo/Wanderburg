import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=8316', '--no-open'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise(res => { srv.stdout.on('data', d => { if (String(d).includes('http://')) res(); }); setTimeout(res, 3000); });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360 });
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 60)); });
await page.goto('http://127.0.0.1:8316/index.html?run=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app && window.app.game, { timeout: 30000 });
await new Promise(r => setTimeout(r, 6000));
const out = await page.evaluate(() => ({
    lights: World3D.app.root.findComponents('light').map(l => ({ type: l.type, cast: l.castShadows, node: l.entity.name, mode: l.shadowUpdateMode })),
    patched: !!World3D._wbPatched,
    sunFlag: World3D.view.sun.castShadows,
    errs: 0
}));
console.log(JSON.stringify(out, null, 1));
console.log('console errs:', errs.slice(0, 4));
await browser.close(); srv.kill();
