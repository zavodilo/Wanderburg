// ============================================================================
//  ArcEngine — headless render & visual gate (ROADMAP phase B+)
// ----------------------------------------------------------------------------
//  node tools/headless-gate.mjs --render     boot game + editor, console/pageerror gate
//  node tools/headless-gate.mjs --visual     + pixel/DOM smoke (ground visible, HUD alive,
//                                            editor panes present), fixed seed/viewport
//  node tools/headless-gate.mjs --all        both
//
//  Dev-only: needs puppeteer in node_modules or on NODE_PATH (the kit runtime stays
//  zero-npm; this gate is tooling). Without it the gate exits with code 2 and a hint —
//  `check.mjs --all` treats that as a failure in release environments.
//
//  Determinism: viewport 1280x720, Scene.seed(42) before the scenarios, terrain from
//  TERRAIN_NOISE_SEED (constant). Evidence for PRs: paste the command + this output.
// ============================================================================
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const jsonArg = args.find(a => a.startsWith('--json='));
const JSON_OUT = jsonArg ? jsonArg.slice(7) : null;
const WANT_RENDER = args.includes('--render') || args.includes('--all');
const WANT_VISUAL = args.includes('--visual') || args.includes('--all');
if (!WANT_RENDER && !WANT_VISUAL) { console.error('headless-gate: pass --render, --visual or --all'); process.exit(1); }
// The screenshots land next to the report: create that directory up front, or the first
// page.screenshot() dies with ENOENT long before the report itself is written.
if (jsonArg) {
    const fs0 = await import('node:fs');
    fs0.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
}

let puppeteer;
try {
    puppeteer = createRequire(import.meta.url)('puppeteer');
} catch {
    try {
        puppeteer = createRequire(path.join(process.cwd(), 'noop.js'))('puppeteer');
    } catch {
        console.error('headless-gate: puppeteer not found (dev-only gate). Install it in your verify workspace: npm i puppeteer');
        process.exit(2);
    }
}

const VIEWPORT = { width: 1280, height: 720 };
const SEED = 42;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const failures = [];
const note = (m) => console.log('  ' + m);
const report = {
    ok: true, gate: 'headless', viewport: VIEWPORT, seed: SEED,
    checks: { render: WANT_RENDER, visual: WANT_VISUAL },
    game: null, editor: null, screenshots: [], failures: []
};

const serve = (script, port) => {
    const srv = spawn(process.execPath, [script, '--port=' + port, '--no-open'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((res) => {
        srv.stdout.on('data', (d) => { if (String(d).includes('http://')) res(srv); });
        setTimeout(() => res(srv), 3000);
    });
};

let smokeEd = null;
const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']
});

const openPage = async (port, urlPath) => {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const errors = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message).split('\n')[0]));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200)); });
    await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { page, errors };
};

// pixel/DOM smoke of the current frame, evaluated in the page
const smoke = (page) => page.evaluate((seed) => {
    if (typeof Scene !== 'undefined') Scene.seed(seed);
    const canvas = document.querySelector('#world3d') || document.querySelector('#view-canvas');
    if (!canvas) return { ok: false, why: 'no canvas' };
    if (typeof World3D !== 'undefined' && World3D.renderFrame) { World3D.renderFrame(); World3D.renderFrame(); }
    const c2 = document.createElement('canvas');
    c2.width = 160; c2.height = 90;
    const ctx = c2.getContext('2d');
    ctx.drawImage(canvas, 0, 0, 160, 90);
    const d = ctx.getImageData(0, 0, 160, 90).data;
    let r = 0, g = 0, b = 0, n = 0; const uniq = new Set();
    for (let i = 0; i < d.length; i += 4) {
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        uniq.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
    }
    const mean = [r / n, g / n, b / n];
    const ui = document.querySelector('.arc-ui');
    return {
        ok: true,
        uniqueColors16: uniq.size,
        mean,
        groundish: mean[1] > mean[2] - 8,          // green-ish ground, not a bare sky frame
        uiChildren: ui ? ui.children.length : -1,
        sceneObjects: typeof Scene !== 'undefined' ? Scene.query().length : -1
    };
}, SEED);

try {
    // --- game -----------------------------------------------------------------
    const gameSrv = await serve('tools/dev-server.mjs', 8291);
    {
        const { page, errors } = await openPage(8291, '/index.html');
        await page.waitForFunction(() => window.app && window.app.location && typeof Scene !== 'undefined', { timeout: 30000 });
        await sleep(4000);
        let smokeGame = null;
        if (WANT_VISUAL) {
            const s = await smoke(page);
            smokeGame = s;
            note('game smoke: ' + JSON.stringify(s));
            if (!s.ok) failures.push('game: ' + s.why);
            // A dark but alive frame (night, fog of war, a menu over a dim world) can fill
            // few color buckets; a boot failure fills ONE. groundish/HUD/console catch the rest.
            if (s.uniqueColors16 <= 4) failures.push('game: frame looks blank (uniqueColors16 ' + s.uniqueColors16 + ')');
            if (!s.groundish) failures.push('game: ground not visible (mean ' + s.mean.map(v => Math.round(v)).join(',') + ')');
            if (s.uiChildren < 2) failures.push('game: HUD missing (' + s.uiChildren + ' elements)');
        }
        const bad = errors.filter(e => !/glReadPixels/.test(e));
        if (WANT_RENDER && bad.length) failures.push('game console: ' + bad.slice(0, 3).join(' | '));
        note('game: ' + (bad.length ? 'ERRORS ' + bad.length : 'console clean'));
        if (JSON_OUT) {
            const shot = path.resolve(path.dirname(JSON_OUT), 'gate-game.png');
            await page.screenshot({ path: shot });
            report.screenshots.push(shot);
        }
        report.game = { consoleErrors: bad, smoke: smokeGame };
        await page.close();
    }
    gameSrv.kill();

    // --- editor ---------------------------------------------------------------
    const edSrv = await serve('_utils/editor/server.mjs', 8292);
    {
        const { page, errors } = await openPage(8292, '/_utils/editor/');
        await page.waitForFunction(() => typeof Lab !== 'undefined' && Lab.location, { timeout: 30000 });
        await sleep(4000);
        if (WANT_VISUAL) {
            const s = await smoke(page);
            const panes = await page.evaluate(() => document.querySelectorAll('#pane-tabs [data-tab], .pane-panel').length);
            smokeEd = Object.assign({ panes }, s);
            note('editor smoke: ' + JSON.stringify(s) + ' panes:' + panes);
            if (!s.ok) failures.push('editor: ' + s.why);
            if (s.uniqueColors16 <= 4) failures.push('editor: view looks blank');
            if (panes < 3) failures.push('editor: panes missing (' + panes + ')');
        }
        const bad = errors.filter(e => !/glReadPixels/.test(e));
        if (WANT_RENDER && bad.length) failures.push('editor console: ' + bad.slice(0, 3).join(' | '));
        note('editor: ' + (bad.length ? 'ERRORS ' + bad.length : 'console clean'));
        if (JSON_OUT) {
            const shot = path.resolve(path.dirname(JSON_OUT), 'gate-editor.png');
            await page.screenshot({ path: shot });
            report.screenshots.push(shot);
        }
        report.editor = { consoleErrors: bad, smoke: smokeEd };
        await page.close();
    }
    edSrv.kill();
} finally {
    await browser.close();
}

report.ok = failures.length === 0;
report.failures = failures;
if (JSON_OUT) {
    const fs = await import('node:fs');
    fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(report, null, 2));
    note('report: ' + path.resolve(JSON_OUT));
}
if (failures.length) {
    console.error('headless-gate: FAIL\n  ' + failures.join('\n  '));
    process.exit(1);
}
console.log('headless-gate: OK (render' + (WANT_VISUAL ? ' + visual' : '') + ', viewport ' + VIEWPORT.width + 'x' + VIEWPORT.height + ', seed ' + SEED + ')');
