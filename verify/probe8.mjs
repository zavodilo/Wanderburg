import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=8321', '--no-open'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise(res => { srv.stdout.on('data', d => { if (String(d).includes('http://')) res(); }); setTimeout(res, 3000); });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto('http://127.0.0.1:8321/index.html?run=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.run, { timeout: 30000 });
await new Promise(r => setTimeout(r, 4000));
// hide the peak batches and report where a peak entity actually stands
const info = await page.evaluate(() => {
    const g = window.app.game, v = g.view;
    const peaks = v.scenery.filter(s => s.key.startsWith('peak'));
    const sample = peaks.slice(0, 3).map(s => { const p = s.root.getPosition(); return { x: Math.round(-p.x), y: Math.round(p.z), h: Math.round(p.y), enabled: s.root.enabled }; });
    for (const s of peaks) s.root.enabled = false;
    const r = g.run.region;
    return { peaks: peaks.length, sample, wallAt1000: Math.round(r.wallAt(r.cx, r.cy - 1000)), heightAt1000: Math.round(r.heightAt(r.cx, r.cy - 1000)) };
});
console.log(JSON.stringify(info));
await new Promise(r => setTimeout(r, 1500));
await page.screenshot({ path: 'verify/nopeaks.png' });
await browser.close(); srv.kill();
console.log('shot verify/nopeaks.png');
