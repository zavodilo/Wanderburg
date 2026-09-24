// ============================================================================
//  Wanderburg — A/B proof that the CC0 pack is actually ON the screen
// ----------------------------------------------------------------------------
//  NODE_PATH=<puppeteer> node verify/packdiff.mjs [url]
//
//  The pack is easy to not notice from a moving camera, so this drives the SAME seed through the
//  SAME scripted frames twice — with the baked Kenney geometry and with ?nopack=1 (procedural
//  only) — captures both frames with Debug3D.capture() and diffs them: numerically (a 64×36
//  downsample, mean absolute difference) and visually (verify/packdiff-pack.png vs
//  verify/packdiff-nopack.png). A pack change that does not move pixels fails here.
// ============================================================================
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const REMOTE = process.argv[2] || process.env.WB_URL || null;
const PORT = Number(process.env.WB_PORT || 8355);
const SEED = 7777;

let srv = null, BASE = REMOTE;
if (!BASE) {
    srv = spawn(process.execPath, ['tools/dev-server.mjs', '--port=' + PORT, '--no-open'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((res) => { srv.stdout.on('data', (d) => { if (String(d).includes('http://')) res(); }); setTimeout(res, 3000); });
    BASE = `http://127.0.0.1:${PORT}`;
}
BASE = BASE.replace(/\/$/, '');

// --- a minimal PNG reader (8-bit RGBA, non-interlaced): Chrome's toDataURL emits exactly that.
// The diff stays in node, so the game page never awaits an image decode (a hanging onload there
// used to get the evaluate's promise collected by CDP).
import zlib from 'node:zlib';
function pngGrid(buf, gw, gh) {
    let off = 8, idat = [], w = 0, h = 0, bitDepth = 0, colorType = 0;
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
        else if (type === 'IDAT') idat.push(data);
        off += 12 + len;
    }
    if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error('png: unsupported ' + bitDepth + '/' + colorType);
    const ch = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * ch;
    const img = Buffer.alloc(h * stride);
    let p = 0;
    for (let y = 0; y < h; y++) {
        const f = raw[p++];
        const row = img.subarray(y * stride, (y + 1) * stride);
        const prev = y ? img.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= ch ? row[x - ch] : 0, b = prev ? prev[x] : 0, c = (prev && x >= ch) ? prev[x - ch] : 0;
            let v = raw[p + x];
            if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
            row[x] = v & 255;
        }
        p += stride;
    }
    // mean RGB over a gw×gh grid
    const grid = new Array(gw * gh * 3);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
        let r = 0, g = 0, b = 0, n = 0;
        const y0 = Math.floor(gy * h / gh), y1 = Math.floor((gy + 1) * h / gh);
        const x0 = Math.floor(gx * w / gw), x1 = Math.floor((gx + 1) * w / gw);
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
            const i = y * stride + x * ch; r += img[i]; g += img[i + 1]; b += img[i + 2]; n++;
        }
        grid[(gy * gw + gx) * 3] = r / n; grid[(gy * gw + gx) * 3 + 1] = g / n; grid[(gy * gw + gx) * 3 + 2] = b / n;
    }
    return grid;
}

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']
});

// ONE page for both halves: under software GL every new target is a new WebGL context, and two
// of them in a row starve the browser (the kit's headless-gate learned this the same way).
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
async function shoot(mode) {
    const errors = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message).split('\n')[0]));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 160)); });
    const q = `/index.html?run=1&seed=${SEED}` + (mode === 'nopack' ? '&nopack=1' : '');
    await page.goto(BASE + q, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.app && window.app.game && window.app.game.run && window.app.game.state === 'play', { timeout: 60000 });
    const out = await page.evaluate(async () => {
        const g = window.app.game;
        // park the rAF loop and drive both halves identically: same seed, same inputs, same frames
        if (!g.__park) { g.__park = true; const o = g.update.bind(g); g.update = (dt) => (window.__parked ? undefined : o(dt)); }
        window.__parked = true;
        const app = window.app;
        // Stand the hull next to the nearest hamlet and look at it: this is a VISUAL A/B, not a
        // driving test — a teleport keeps both halves at the same lens, 240 px from the tents,
        // cottages, fences and campfires that the pack dresses a village with.
        const p0 = g.run.player;
        let tv = null, bd = 1e9;
        for (const e of g.run.region.entities) {
            if (e.dead || e.type !== 'village') continue;
            const d = Math.hypot(e.x - p0.x, e.y - p0.y);
            if (d < bd) { bd = d; tv = e; }
        }
        // The warden gatehouse is the pack's biggest statement: prefer it when it is nearer.
        const gate = g.run.region.gate;
        if (gate) {
            const dg = Math.hypot(gate.x - p0.x, gate.y - p0.y);
            if (dg < bd) { bd = dg; tv = gate; }
        }
        if (tv) {
            p0.x = tv.x - 240; p0.y = tv.y - 140; p0.vx = 0; p0.vy = 0;
            p0.heading = Math.atan2(tv.y - p0.y, tv.x - p0.x);
        }
        for (let i = 0; i < 90; i++) { g.update(1 / 60); app.location.update(1 / 60); app.camera.update(1 / 60); }
        g._keys.clear();
        if (tv) app.camera.lookAt(tv.x, tv.y);
        for (let i = 0; i < 40; i++) { g.update(1 / 60); app.location.update(1 / 60); app.camera.update(1 / 60); }
        window.__abd = tv ? Math.round(Math.hypot(tv.x - p0.x, tv.y - p0.y)) : -1;
        const cap = Debug3D.capture();
        return { dataUrl: cap.dataUrl, px: Math.round(g.run.player.x), py: Math.round(g.run.player.y), abd: window.__abd };
    });
    const file = path.join(ROOT, 'verify', 'packdiff-' + mode + '.png');
    const png = Buffer.from(out.dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(file, png);
    const grid = pngGrid(png, 128, 72);
    page.removeAllListeners('pageerror'); page.removeAllListeners('console');
    return { mode, file, grid, px: out.px, py: out.py, abd: out.abd, errors };
}

const a = await shoot('pack');
const b = await shoot('nopack');
let sum = 0, max = 0, changed = 0;
const CELLS = a.grid.length / 3;
for (let c = 0; c < CELLS; c++) {
    let d = 0;
    for (let k = 0; k < 3; k++) { const q = Math.abs(a.grid[c * 3 + k] - b.grid[c * 3 + k]); d += q; max = Math.max(max, q); }
    d /= 3;
    sum += d;
    if (d > 10) changed++;          // a cell the eye would call "different"
}
const mean = sum / CELLS;
const ratio = changed / CELLS;
console.log('\n  A/B pack proof at ' + BASE + ' (seed ' + SEED + ')');
  console.log('  player position: pack (' + a.px + ',' + a.py + ') vs nopack (' + b.px + ',' + b.py + '), lens on a hamlet at ' + a.abd + ' px');
console.log('  frames: verify/packdiff-pack.png | verify/packdiff-nopack.png');
console.log('  mean |ΔRGB| over 128×72: ' + mean.toFixed(2) + ' · changed cells ' + (ratio * 100).toFixed(1) + '% · max channel Δ ' + max.toFixed(0));
const errs = [...a.errors, ...b.errors];
if (errs.length) { console.log('  console errors:'); for (const e of errs.slice(0, 6)) console.log('    ' + e); }
else console.log('  console: clean in both modes');
await browser.close();
if (srv) srv.kill();
const sameRun = Math.abs(a.px - b.px) <= 2 && Math.abs(a.py - b.py) <= 2;
const ok = ratio > 0.04 && sameRun && !errs.length;   // >=4% of the frame visibly differs
console.log(ok ? '\n  The pack visibly changes ' + (ratio * 100).toFixed(1) + '% of the frame, and the simulation under it is identical.\n'
    : '\n  PACKDIFF FAIL: changed ' + (ratio * 100).toFixed(1) + '% of cells, mean Δ ' + mean.toFixed(2) + (!sameRun ? ' (simulation diverged!)' : '') + '\n');
process.exit(ok ? 0 : 1);
