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
const WANT_VARIANTS = args.includes('--variants') || args.includes('--all');
if (!WANT_RENDER && !WANT_VISUAL && !WANT_VARIANTS) { console.error('headless-gate: pass --render, --visual, --variants or --all'); process.exit(1); }
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
const C_RED = '\x1b[31m', C_RESET = '\x1b[0m';
const report = {
    ok: true, gate: 'headless', viewport: VIEWPORT, seed: SEED,
    checks: { render: WANT_RENDER, visual: WANT_VISUAL, variants: WANT_VARIANTS },
    game: null, editor: null, variants: null, screenshots: [], failures: []
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
    protocolTimeout: 240000,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']
});

/** @type {{ page: any, errors: string[] } | null} */
let _shared = null;
// Every check navigates ONE page (game, each variant, editor): under a software GL a new
// target means a new WebGL context, and five of them in a row starve the browser.
const openPage = async (port, urlPath) => {
    if (!_shared) {
        const page = await browser.newPage();
        await page.setViewport(VIEWPORT);
        const errors = [];
        page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message).split('\n')[0]));
        page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200)); });
        _shared = { page, errors };
    }
    _shared.errors.length = 0;
    await _shared.page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return _shared;
};
// The page is shared: closing it between checks would kill the rest of the gate.
const closePage = async () => {};

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

// What one runtime instance must prove in the browser: the right projection for its profile,
// every logical entity bound to a visual, the HUD alive, a non-blank frame — and the SAME
// gameplay/save hashes as every other variant of the project.
const variantSmoke = (page) => page.evaluate(() => {
    World3D.renderFrame();
    World3D.renderFrame();
    const canvas = document.querySelector('#world3d');
    const c2 = document.createElement('canvas');
    c2.width = 160; c2.height = 90;
    const g = c2.getContext('2d');
    g.drawImage(canvas, 0, 0, 160, 90);
    const d = g.getImageData(0, 0, 160, 90).data;
    const uniq = new Set();
    let r = 0, gr = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; n++; uniq.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4)); }
    const cam = Camera.inspect();
    return {
        context: PlayArcRuntime.context(),
        profile: RenderProfile.id(),
        variant: Variant.currentId(),
        expectedProjection: RenderProfile.profile().projection,
        projection: cam.params.projection,
        cameraMode: cam.mode,
        orthoHeight: cam.params.projection === 'orthographic' ? cam.params.orthoHeightPx : null,
        lighting: Lighting.get().preset,
        entities: GameModel.entities.length,
        entityIds: GameModel.entities.map(e => e.id),
        bindings: VisualEntity.bindings().length,
        byType: VisualEntity.counts().byType,
        placeholders: VisualEntity.placeholders().length,
        sprites: Sprite2D.count(World3D.view),
        engineObjects: Visual3D.counts(),
        worldTiles: VisualEntity.worldBinding ? VisualEntity.worldBinding.tiles : 0,
        uiChildren: document.querySelectorAll('.arc-ui > *').length,
        uiSpace: UI.space,
        gameplayHash: GameModel.gameplayHash(),
        // The cross-instance invariant: gameplayHash covers LIVE model state, so two tabs of one
        // project diverge as soon as the game plays (a game mirrors its simulation into the model).
        contractHash: GameModel.contractHash ? GameModel.contractHash() : null,
        bootContractHash: (PlayArcRuntime.context() || {}).contractHash || null,
        selfPresented: GameModel.entities.filter(e => e.visualRequest(RenderProfile.id()).type === 'none').length,
        saveSchemaHash: Save.schemaHash(),
        budget: RenderProfile.checkBudget(RenderProfile.id()),
        uniqueColors16: uniq.size,
        mean: [r / n, gr / n, b / n],
        stats: Visual3D.stats(),
        animation: GameAnimation.inspect().playing
    };
});

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
        await closePage();
    }
    // --- every visual variant of the project, one runtime instance each --------
    if (WANT_VARIANTS) {
        // The same server serves every variant: only the query differs (one source tree).
        const fs0 = await import('node:fs');
        const pjFile = path.join(ROOT, 'project.json');
        const pj = fs0.existsSync(pjFile) ? JSON.parse(fs0.readFileSync(pjFile, 'utf8')) : { id: '', variants: [] };
        const list = (pj.variants || []).map(id => {
            const f = path.join(ROOT, 'presentation/variants', id + '.json');
            if (!fs0.existsSync(f)) return null;
            const v = JSON.parse(fs0.readFileSync(f, 'utf8'));
            return v.enabled === false ? null : { id: id, profile: v.profile };
        }).filter(Boolean);
        if (!list.length) failures.push('variants: project.json lists no enabled variant (node tools/variants.mjs create-all)');
        const results = [];
        let shared = null;
        for (const v of list) {
            const q = '/index.html' + (pj.id ? '?project=' + encodeURIComponent(pj.id) + '&variant=' : '?variant=') + encodeURIComponent(v.id);
            const { page, errors } = await openPage(8291, q);
            try {
                await page.waitForFunction(() => window.app && window.app.runtime && typeof PlayArcRuntime !== 'undefined' && PlayArcRuntime.started, { timeout: 60000 });
                await sleep(2500);
                const s = await variantSmoke(page);
                const bad = errors.filter(e => !/glReadPixels/.test(e));
                const problems = [];
                if (s.variant !== v.id) problems.push('the page presents ' + s.variant + ', not ' + v.id);
                if (s.profile !== v.profile) problems.push('profile ' + s.profile + ' != variant profile ' + v.profile);
                if (s.projection !== s.expectedProjection) problems.push('camera projection ' + s.projection + ' != ' + s.expectedProjection);
                if (!s.entities) problems.push('no logical entities');
                // A project may present its own entities (representation 'none': a view module on
                // the engine layer). Those count as presented — the pipeline must not double-draw.
                if (s.bindings < 1 && s.selfPresented < 1) problems.push('nothing is presented (' + s.bindings + ' visual bindings, ' + s.selfPresented + ' self-presented)');
                if (s.uniqueColors16 <= 4) problems.push('the frame looks blank (uniqueColors16 ' + s.uniqueColors16 + ')');
                if (s.uiChildren < 2) problems.push('the HUD is missing (' + s.uiChildren + ' elements)');
                if (bad.length) problems.push('console: ' + bad.slice(0, 2).join(' | '));
                const shareKey = s.contractHash || s.gameplayHash;
                if (!shared) shared = { contractHash: shareKey, saveSchemaHash: s.saveSchemaHash, entityIds: s.entityIds };
                else {
                    if (shared.contractHash !== shareKey) problems.push('game contract differs from ' + list[0].id + ' — the variants do not share one game');
                    if (shared.saveSchemaHash !== s.saveSchemaHash) problems.push('save schema differs — a save would not load in every variant');
                    if (JSON.stringify(shared.entityIds) !== JSON.stringify(s.entityIds)) problems.push('entity ids differ between variants');
                }
                for (const p of problems) failures.push('variant ' + v.id + ': ' + p);
                if (JSON_OUT) {
                    const shot = path.resolve(path.dirname(JSON_OUT), 'gate-variant-' + v.profile + '.png');
                    await page.screenshot({ path: shot });
                    report.screenshots.push(shot);
                }
                note('variant ' + v.id + ': ' + v.profile + ' ' + s.projection + '/' + s.cameraMode +
                    ' · entities ' + s.entities + ' · bindings ' + s.bindings + ' (' + JSON.stringify(s.byType) + ')' +
                    (s.selfPresented ? ' · self-presented ' + s.selfPresented : '') +
                    ' · tiles ' + s.worldTiles + ' · sprites ' + s.sprites + ' · lighting ' + s.lighting +
                    ' · colors ' + s.uniqueColors16 + (problems.length ? ' · ' + C_RED + problems.length + ' problem(s)' + C_RESET : ' · ok'));
                results.push({ id: v.id, profile: v.profile, ok: !problems.length, problems: problems, consoleErrors: bad, smoke: s });
            } catch (e) {
                failures.push('variant ' + v.id + ': ' + ((e && e.message) || e));
                results.push({ id: v.id, profile: v.profile, ok: false, problems: [String((e && e.message) || e)], consoleErrors: [], smoke: null });
            }
        }
        report.variants = { count: results.length, ok: results.every(r => r.ok), shared: shared, results: results.map(r => ({ id: r.id, profile: r.profile, ok: r.ok, problems: r.problems, smoke: r.smoke })) };
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
        await closePage();
    }
    edSrv.kill();
} finally {
    if (_shared && _shared.page) { try { await _shared.page.close(); } catch (e) { /* already gone */ } }
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
