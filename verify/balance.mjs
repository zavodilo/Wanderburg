// Scratch balance harness: a careful autopilot + a full trace of one run.
//   node verify/balance.mjs [seed] [traceSeconds]
import { loadScripts } from '../tests/browser-scripts.mjs';
const store = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const page = loadScripts(['js/Constants.js', 'libs/simplex-noise.js', 'js/Content.js', 'js/Logic.js'], { localStorage: store });
const WB = page.get('WB');
WB.Save.load();

const seed = Number(process.argv[2] || 20260923);
const run = new WB.Run({ seed, region: 0 });
const p = run.player, r = run.region;

// A careful driver: eat, fight only what it can beat, run when hurt, never touch the rim.
function drive() {
    const turnTo = (a, boost) => {
        const d = WB.M.angleDelta(p.heading, a);
        return { throttle: Math.abs(d) > 2.5 ? -0.6 : 1, steer: WB.M.clamp(d * 2, -1, 1), boost: !!boost && Math.abs(d) < 0.5 };
    };
    const dCenter = Math.hypot(p.x - r.cx, p.y - r.cy);
    if (dCenter > r.regionR - 180) return turnTo(Math.atan2(r.cy - p.y, r.cx - p.x), false);

    const th = run.threat(700);
    // Run when hurt AND something is hunting us. Straight away from it, with steam.
    if (p.hp < p.maxHp * 0.5 && th.near) {
        const a = Math.atan2(p.y - th.near.y, p.x - th.near.x);
        // steer the escape toward the valley centre when we are near the rim
        const escape = dCenter > r.regionR * 0.6 ? Math.atan2(-p.y, -p.x) * 0.5 + a * 0.5 : a;
        return turnTo(escape, p.steam > 25);
    }
    // Fight only a fortress we can beat: our tier >= its tier - 1, and we are healthy.
    let prey = null, preyD = -1;
    if (!r.gate.open) {
        for (const c of r.castles) {
            if (!c.alive || c.kind !== 'fortress') continue;
            if (c.tier > p.tier + 1) continue;
            if (p.hp < p.maxHp * 0.7) continue;
            const d = WB.M.dist(p.x, p.y, c.x, c.y);
            if (preyD < 0 || d < preyD) { preyD = d; prey = c; }
        }
    }
    if (run.boss && run.boss.alive && p.hp > p.maxHp * 0.6) { prey = run.boss; preyD = WB.M.dist(p.x, p.y, prey.x, prey.y); }
    // Otherwise: the nearest food (villages first — the best mass per second).
    let food = null, foodD = -1;
    for (const e of r.entities) {
        if (e.dead) continue;
        if (e.type !== 'village' && e.type !== 'node' && e.type !== 'herd' && e.type !== 'chunk') continue;
        const d = WB.M.dist(p.x, p.y, e.x, e.y) * (e.type === 'chunk' ? 0.5 : e.type === 'village' ? 0.85 : 1);
        if (foodD < 0 || d < foodD) { foodD = d; food = e; }
    }
    const target = prey || food || r.gate;
    if (!target) return turnTo(p.heading, false);
    const d = prey ? preyD : foodD;
    const a = Math.atan2(target.y - p.y, target.x - p.x);
    return turnTo(a, d > 320 && p.steam > 55);
}

function pickCard() {
    const cards = run.draftPending.cards;
    for (const kind of ['new', 'upgrade', 'repair', 'scrap']) {
        const i = cards.findIndex(c => c.kind === kind);
        if (i >= 0) return i;
    }
    return 0;
}

const bySrc = {};
const origDamage = run.damage.bind(run);
run.damage = (e, a, o) => { if (e === p) { const k = (o && o.kind) || '?'; bySrc[k] = (bySrc[k] || 0) + a; } return origDamage(e, a, o); };

let frames = 0;
const tierAt = [];
let lastTier = p.tier;
const t0 = Date.now();
while (!run.over && frames < 60 * 60 * 12) {
    run.update(1 / 60, drive());
    frames++;
    if (p.tier !== lastTier) { tierAt.push('T' + p.tier + '@' + Math.round(run.time) + 's'); lastTier = p.tier; }
    if (run.draftPending) run.takeDraft(pickCard());
    if (run.regionCleared) {
        console.log('  >> region ' + run.regionIndex + ' cleared at ' + Math.round(run.time) + 's | tier ' + p.tier +
            ' | modules ' + p.modules.length + ' | hp ' + Math.round(p.hp) + '/' + p.maxHp);
        run.nextRegion();
    }
    if (frames % 300 === 0) {
        const th = run.threat(900);
        console.log('t=' + String(Math.round(frames / 60)).padStart(3) + 's hp ' + String(Math.round(p.hp)).padStart(4) + '/' + p.maxHp +
            ' tier ' + p.tier + ' mass ' + String(Math.round(p.mass)).padStart(4) + ' mods ' + String(p.modules.length).padStart(2) +
            ' | R' + run.regionIndex + ' pos ' + Math.round(p.x) + ',' + Math.round(p.y) +
            ' | hunters ' + th.hunters + (th.near ? ' nearest ' + th.near.kind + '@' + th.dist : '') +
            ' | food ' + r.entities.filter(e => !e.dead && (e.type === 'village' || e.type === 'node')).length +
            ' forts ' + r.castles.filter(c => c.alive && c.kind === 'fortress').length);
    }
}
console.log('--- seed', seed, '| survived', (frames / 60).toFixed(0) + 's | wall', Date.now() - t0, 'ms | won', run.won, '| region', run.regionIndex);
console.log('    tiers:', tierAt.join(' ') || '(none)');
console.log('    modules:', p.modules.map(m => m.mod.short + 'L' + m.level).join(', '), '| slots', p.slots);
console.log('    totals:', JSON.stringify(run.totals), '| scrap', run.runScrap());
console.log('    damage taken by kind:', Object.entries(bySrc).sort((a, b) => b[1] - a[1]).map(e => e[0] + '=' + Math.round(e[1])).join(' '));
