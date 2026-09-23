// Scratch smoke driver: a goal-directed autopilot plays full runs so the balance can be
// measured (not shipped; `node verify/smoke.mjs [seed] [runs] [legacyIds]`).
import { loadScripts } from '../tests/browser-scripts.mjs';

const store = {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};

const page = loadScripts(['js/Constants.js', 'libs/simplex-noise.js', 'js/Content.js', 'js/Logic.js'], { localStorage: store });
const WB = page.get('WB');
WB.Save.load();

const seed0 = Number(process.argv[2] || 20260923);
const runs = Number(process.argv[3] || 1);
const legacy = (process.argv[4] || '').split(',').filter(Boolean);

// --- the autopilot ---------------------------------------------------------------------
// Priorities: (1) run away when badly hurt and hunted, (2) the boss when it is up,
// (3) the fortress that is hunting us, (4) the nearest fortress while the gate is shut,
// (5) food, (6) the gate.
let committed = null;
function drive(run) {
    const p = run.player, r = run.region;
    if (!p || !p.alive) return { throttle: 0, steer: 0, boost: false };
    const turnTo = (a, boost) => {
        const d = WB.M.angleDelta(p.heading, a);
        return { throttle: Math.abs(d) > 2.4 ? -0.6 : 1, steer: WB.M.clamp(d * 1.9, -1, 1), boost: !!boost && Math.abs(d) < 0.6 };
    };
    // 1) stay off the mountains
    const dCenter = Math.hypot(p.x - r.cx, p.y - r.cy);
    if (dCenter > r.regionR - 170) return turnTo(Math.atan2(-p.y, -p.x), false);

    const threat = run.threat(760);
    const hurt = p.hp < p.maxHp * (threat.near ? 0.55 : 0.3);
    // 2) disengage: run at the open valley and let the crew patch the hull
    if (hurt && !run.bossActive) {
        const away = Math.atan2(p.y - (threat.near ? threat.near.y : 0), p.x - (threat.near ? threat.near.x : 0));
        const a = dCenter > r.regionR * 0.55 ? away + Math.PI * 0.5 : away;
        return turnTo(a, p.steam > 35);
    }
    // 3) the boss
    if (run.boss && run.boss.alive) {
        const b = run.boss;
        const d = WB.M.dist(p.x, p.y, b.x, b.y);
        // keep just inside our own longest gun and circle it
        const a = Math.atan2(b.y - p.y, b.x - p.x) + (d < 330 ? 1.25 : d > 560 ? 0 : 0.5);
        return turnTo(a, d > 620 && p.steam > 40);
    }
    // 4) whoever is hunting us — but once the gate is open the objective wins unless the
    //    hunter is already on top of us or the hull is failing
    if (threat.near && (!r.gate.open || threat.dist < 380 || p.hp < p.maxHp * 0.5)) {
        return turnTo(Math.atan2(threat.near.y - p.y, threat.near.x - p.x), threat.dist > 420 && p.steam > 40);
    }
    // 5) the objective: fortresses while the gate is shut, otherwise food
    let target = null, best = -1;
    if (r.gate && r.gate.open && !run.bossActive) {
        target = r.gate; best = WB.M.dist(p.x, p.y, r.gate.x, r.gate.y);
    } else if (!r.gate.open) {
        // commit to the weakest alive fortress until it dies: switching targets mid-fight
        // is how a driver wastes ten minutes
        if (committed && committed.alive && committed.kind === 'fortress') target = committed;
        else {
            let tier = 99;
            for (const c of r.castles) {
                if (!c.alive || c.kind !== 'fortress') continue;
                if (c.tier < tier) { tier = c.tier; target = c; }
            }
            if (target) committed = target;
        }
    }
    if (!target) {
        for (const e of r.entities) {
            if (e.dead) continue;
            if (e.type !== 'village' && e.type !== 'node' && e.type !== 'chunk' && e.type !== 'herd') continue;
            const d = WB.M.dist(p.x, p.y, e.x, e.y) * (e.type === 'chunk' ? 0.55 : 1);
            if (best < 0 || d < best) { best = d; target = e; }
        }
    }
    if (!target) target = r.gate;
    if (!target) return turnTo(p.heading, false);
    const lead = target.vx ? WB.M.dist(p.x, p.y, target.x, target.y) / 200 : 0;
    return turnTo(Math.atan2(target.y + (target.vy || 0) * lead - p.y, target.x + (target.vx || 0) * lead - p.x),
        best > 300 && p.steam > 50);
}

function pickCard(run) {
    const cards = run.draftPending.cards;
    const order = ['new', 'upgrade', 'repair', 'scrap'];
    for (const kind of order) {
        const i = cards.findIndex(c => c.kind === kind);
        if (i >= 0) return i;
    }
    return 0;
}

for (let n = 0; n < runs; n++) {
    const seed = seed0 + n * 7717;
    const run = new WB.Run({ seed, region: 0, legacy });
    let frames = 0;
    const t0 = Date.now();
    const tierAt = [];
    let lastTier = run.player.tier;
    const regionLog = [];
    while (!run.over && frames < 60 * 60 * 14) {
        run.update(1 / 60, drive(run));
        frames++;
        if (run.player.tier !== lastTier) { tierAt.push(run.player.tier + '@' + Math.round(run.time) + 's'); lastTier = run.player.tier; }
        for (const ev of run.events) {
        if (['fortressDown', 'gateOpen', 'bossSpawn', 'bossDown', 'playerDown', 'regionClear', 'devoured'].includes(ev.type)) {
            console.log('   t=' + Math.round(run.time) + 's ' + ev.type + (ev.name ? ' ' + ev.name : '') + (ev.left != null ? ' left=' + ev.left : ''));
        }
    }
    if (run.draftPending) run.takeDraft(pickCard(run));
        if (run.regionCleared) {
            regionLog.push('R' + run.regionIndex + ' ' + Math.round(run.time) + 's tier' + run.player.tier +
                ' mods' + run.player.modules.length + ' hp' + Math.round(run.player.hp));
            run.nextRegion();
        }
    }
    const s = run.summary();
    console.log('seed ' + seed + ' | ' + (frames / 60).toFixed(0) + 's sim / ' + (Date.now() - t0) + 'ms wall | won=' + run.won +
        ' region=' + run.regionIndex + ' tier=' + s.tier + ' mass=' + s.mass + ' scrap=' + run.runScrap() +
        ' kills=' + s.kills + ' dmg=' + s.damage);
    console.log('   tiers: ' + tierAt.join(' ') + ' | modules: ' + s.modules.map(m => m.name + m.level).join(','));
    console.log('   regions: ' + (regionLog.join(' | ') || '(none cleared)') + ' | end hp ' + Math.round(run.player.hp) + '/' + run.player.maxHp);
}
