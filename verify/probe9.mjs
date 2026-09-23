import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=8322', '--no-open'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise(res => { srv.stdout.on('data', d => { if (String(d).includes('http://')) res(); }); setTimeout(res, 3000); });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto('http://127.0.0.1:8322/index.html?run=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.run, { timeout: 30000 });
await new Promise(r => setTimeout(r, 4000));
const info = await page.evaluate(() => {
    const g = window.app.game, r = g.run.region, cam = g.camera;
    // stand inside the valley looking at the north rim from close range, low pitch
    cam.follow(null);
    cam.lookAt(r.cx, r.cy - 700, 120);
    cam.pitch = 0.35;   // radians? CameraController keeps radians internally
    cam.zoomTarget = 0.5;
    const t = r.heightAt(r.cx, r.cy - 1000);
    const peaks = r.scenery.filter(s => s.kind === 'peak').slice(0, 4).map(s => ({ x: Math.round(s.x), y: Math.round(s.y), h: Math.round(s.h), s: +s.s.toFixed(2) }));
    return { rimHeight: Math.round(t), peaks };
});
console.log(JSON.stringify(info));
await new Promise(r => setTimeout(r, 2500));
await page.screenshot({ path: 'verify/rim.png' });
await browser.close(); srv.kill();
console.log('shot verify/rim.png');
