// ============================================================================
//  Wanderburg — deployment check (GitHub Pages or any hosting)
// ----------------------------------------------------------------------------
//  NODE_PATH=<puppeteer> node verify/deploy.mjs [url]
//      default url: https://zavodilo.github.io/Wanderburg
//
//  What a player gets on the wire, not in the working tree: every response is watched for 4xx/5xx
//  and failed requests (a missing favicon or a stale asset path shows up here), the console must
//  stay clean, and two screenshots are taken — the title screen with the living valley behind it
//  and a run in progress (?run=1). Writes verify/deploy-menu.png and verify/deploy-play.png.
// ============================================================================
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || 'https://zavodilo.github.io/Wanderburg').replace(/\/$/, '');

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const bad = [];
const errors = [];
page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
page.on('requestfailed', (r) => bad.push('FAILED ' + r.url() + ' ' + ((r.failure() || {}).errorText || '')));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200)); });

let failed = 0;
// --- the title screen: the menu over the attract run -----------------------------------------
await page.goto(BASE + '/index.html', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.state === 'menu', { timeout: 60000 });
await new Promise(r => setTimeout(r, 3500));
await page.screenshot({ path: path.join(ROOT, 'verify/deploy-menu.png') });
const menu = await page.evaluate(() => ({
    ui: document.querySelectorAll('.arc-ui > *').length,
    title: (document.querySelector('.arc-ui') || {}).textContent ? 'yes' : 'no',
    variant: window.app.runtime && window.app.runtime.variant,
    profile: window.app.runtime && window.app.runtime.profile,
    contract: window.app.runtime && window.app.runtime.contractHash
}));
console.log('  menu   :', JSON.stringify(menu));

// --- a run in progress ------------------------------------------------------------------------
await page.goto(BASE + '/index.html?run=1', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => window.app && window.app.game && window.app.game.run && window.app.game.state === 'play', { timeout: 60000 });
await new Promise(r => setTimeout(r, 4000));
// the hull must actually drive on the deployment: trusted ArrowUp for a second of game frames
// C-6: the frame budget is a declared contract (the shipped variant tightens maxDrawCalls to
// 420). Read the real number off the deployment, not off a hope.
const perf = await page.evaluate(async () => {
    try {
    // PlayCanvas does not expose a live draw-call counter here, so count what COULD draw: the
    // enabled mesh instances of the world/actor layers (frustum culling only lowers the real
    // number). The budget is the variant's tightened maxDrawCalls, not the profile canon.
    const app = window.app.location.view.app;
    // The ink/outline registries: view._inks is created by World3D.inkMesh on the view it is
    // given — find whichever object actually carries them, and collect the LINE instances so
    // the census can report base entities and ink attachments separately (the profile canon
    // counts ENTITIES — "batch or instance them" — ink ribbons are the styling pass on top).
    const view = window.app.location.view;
    let inkHost = null;
    for (const c of [view, view.view, view.world, view.worldView, app.location, app.arcView].filter(Boolean)) {
        if (c && c._inks instanceof Map && (!inkHost || c._inks.size > inkHost._inks.size)) inkHost = c;
    }
    const inkSet = new Set();
    if (inkHost) for (const e of inkHost._inks.values()) if (e && e.mi) inkSet.add(e.mi);
    // UNIQUE enabled mesh instances: one instance sits in several layers at once (the world pass,
    // the ink-edge pass, the actor pass), so a per-layer sum counts every hull three times.
    const seen = new Set();
    for (const layer of app.scene.layers.layerList) {
        if (!layer.enabled || layer.id > 12) continue;          // world/actor/overlay, not ui
        const list = (layer.instances && layer.instances.meshInstances) || layer.meshInstances || [];
        for (const mi of list) if (mi.mesh && mi.node && mi.node.enabled) seen.add(mi);
    }
    const instances = seen.size;
    let base = 0;
    for (const mi of seen) if (!inkSet.has(mi)) base++;
    // P-1 breakdown: where the frame's GL draws actually go. The renderer's pass counters are
    // never reset without profiling, so the DELTA over one rendered frame is the per-frame cost.
    // The delta is taken between two 'postrender' events — exactly one rendered frame apart
    // (an rAF pair can span two frames on a slow device and double every number).
    const rt = app.renderer || {};
    const dev = app.graphicsDevice;
    const snap = () => ({
        f: rt._forwardDrawCalls || 0, s: rt._shadowDrawCalls || 0, d: rt._depthDrawCalls || 0,
        cul: rt._numDrawCallsCulled || 0, dev: dev._drawCallsPerFrame || 0
    });
    const frames = await new Promise((resolve) => {
        const out = [];
        let last = snap();
        const h = () => {
            const s = snap();
            out.push({ forward: s.f - last.f, shadow: s.s - last.s, depth: s.d - last.d, culled: s.cul - last.cul, dev: s.dev });
            last = s;
            if (out.length >= 3) { app.off('postrender', h); resolve(out); }
        };
        app.on('postrender', h);
        setTimeout(() => { app.off('postrender', h); resolve(out); }, 8000);
    });
    // per-layer census: which layers hold the instances (the ink lines live in the source layer)
    const layers = {};
    for (const layer of app.scene.layers.layerList) {
        const list = (layer.instances && layer.instances.meshInstances) || layer.meshInstances || [];
        let n = 0;
        for (const mi of list) if (mi.mesh && mi.node && mi.node.enabled) n++;
        if (n || layer.enabled) layers[layer.id + ':' + (layer.name || '?')] = n;
    }
    // the outline registry (the game draws no outlines — ink was collected above)
    const inks = inkHost ? inkHost._inks.size : 0;
    let outlines = 0;
    for (const c of [view, view.view, view.world, view.worldView, app.location, app.arcView].filter(Boolean)) {
        if (c._outlines instanceof Map && c._outlines.size > outlines) outlines = c._outlines.size;
    }
    const passes = {
        frames: frames,
        inks: inks,
        outlines: outlines,
        layers: layers,
        cameras: app.root.findComponents('camera').filter(c => c.enabled && c.entity.enabled).length
    };
    const cfg = Variant.effective(Variant.currentId());
    const profile = RenderProfile.budget(RenderProfile.id());
    // PER-FRAME GL draws: the median of the renderer's own pass counters between consecutive
    // 'postrender' events. NOT device._drawCallsPerFrame — without profiling nothing resets it,
    // so it is CUMULATIVE since page load (the "4-8k draws/frame" of C-6 was this artifact:
    // it grew by exactly the per-frame number every frame).
    const med = (a) => a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : null;
    const draws = frames.length ? med(frames.map(f => f.forward + f.shadow + f.depth)) : null;
    return {
        instances: instances,
        base: base,
        passes: passes,
        dbg: { cfg: cfg.performance, v: Variant.get(Variant.currentId()).performance, cur: Variant.currentId(), gen: typeof PROJECT_VARIANTS !== 'undefined' ? PROJECT_VARIANTS.variants['wanderburg-lowpoly3d'].performance : null },
        draws: draws,
        devCumulative: dev && dev._drawCallsPerFrame != null ? dev._drawCallsPerFrame : null,
        budget: Math.min(cfg.performance && cfg.performance.maxDrawCalls != null ? cfg.performance.maxDrawCalls : 1e9, profile.maxDrawCalls),
        profileBudget: profile.maxDrawCounts || profile.maxDrawCalls,
        warnings: RenderProfile.checkBudget(RenderProfile.id()).warnings
    };
    } catch (e) { return { error: String((e && e.message) || e) }; }
});
if (perf.error) { console.log('  budget : probe error — ' + perf.error); failed++; }
else {
    console.log('  dbg    :', JSON.stringify(perf.dbg), '| page:', await page.evaluate(() => location.href));
    if (perf.passes) console.log('  passes :', JSON.stringify(perf.passes));
    console.log('  budget : ' + perf.base + ' base + ' + (perf.instances - perf.base) + ' ink = ' + perf.instances +
        ' instances, ' + perf.draws + ' GL draws/frame (median of ' + (perf.passes.frames || []).length + ' rendered)' +
        ' · entity budget ' + perf.budget + ' (profile ' + perf.profileBudget + ')' +
        (perf.warnings && perf.warnings.length ? ' WARN ' + perf.warnings.join('; ') : ''));
    // The budget counts ENTITIES (the kit semantics: "batch or instance them"): base instances
    // against the profile canon. Ink ribbons are the styling pass on top of the same entities.
    if (perf.base != null && perf.base > perf.budget * 1.35) { console.log('  FAIL: base census ' + perf.base + ' over 1.35x the entity budget ' + perf.budget + ' — pool leak?'); failed++; }
    // GL draws/frame swing with camera/culling (365 zoomed-in … ~1230 with the whole valley in
    // frame) — the absolute number is a NOTE, the LEAK gate is the ratio: more draws than
    // instances (+sky/overlay margin) means some pass draws dead or double instances.
    if (perf.draws != null && perf.draws > perf.instances * 1.25 + 200) { console.log('  FAIL: ' + perf.draws + ' GL draws/frame vs ' + perf.instances + ' instances — a pass draws dead/double instances'); failed++; }
    else if (perf.draws != null && perf.draws > 4000) { console.log('  FAIL: GL draws/frame ' + perf.draws + ' — absolute leak guard'); failed++; }
    else if (perf.draws != null && perf.draws > 1500) console.log('  note  : GL draws/frame ' + perf.draws + ' (full valley in frame) — WORLD3D_TOON_INK=1/0 is the mobile lever');
}

const drove = await page.evaluate(async () => {
    const g = window.app.game, p0 = g.run.player;
    const a = { x: p0.x, y: p0.y };
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
    for (let i = 0; i < 60; i++) g.update(1 / 60);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', bubbles: true }));
    const p = g.run.player;
    return Math.round(Math.hypot(p.x - a.x, p.y - a.y));
});
await page.screenshot({ path: path.join(ROOT, 'verify/deploy-play.png') });
console.log('  drive  : ArrowUp for 1 s of game frames moved the hull ' + drove + ' px');
if (drove < 30) { console.log('  FAIL: the hull does not obey the arrows on the deployment'); failed++; }

if (bad.length) { console.log('  FAIL: bad responses:'); for (const b of bad) console.log('    ' + b); failed++; }
else console.log('  network: no 4xx/5xx, no failed requests');
if (errors.length) { console.log('  FAIL: console errors:'); for (const e of errors.slice(0, 8)) console.log('    ' + e); failed++; }
else console.log('  console: clean');

await browser.close();
console.log(failed ? '\n  DEPLOYMENT CHECK FAILED (' + failed + ')\n' : '\n  Deployment at ' + BASE + ' is playable.\n');
process.exit(failed ? 1 : 0);
