// ============================================================================
//  Wanderburg — can the machine WIN? (a playing agent, not a balance probe)
// ----------------------------------------------------------------------------
//  node verify/winrun.mjs [seedFirst] [runs] [legacyIds]
//
//  verify/smoke.mjs measures the pace of a run; this one tries to CLOSE it: four valleys and the
//  Iron Crown. The driver plays like a person who has read the design doc —
//    * farm phase: eat the valley to tier 3+ before picking a fight with an armed hull;
//    * duel phase: orbit at the reach of our own longest gun, never inside the enemy's;
//    * shells: a projectile whose time-to-impact is under a second gets a perpendicular step aside;
//    * hurt: break line of sight, run for the open valley, let the crew patch the hull;
//    * draft: cards are scored (damage/range/repair/slots), not taken in a fixed order;
//    * boss: kite the warden at max reach, boost out of his charge telegraph.
//  Everything below reads the SAME public simulation the browser runs (WB.Run.update), so a win
//  here is a win of the shipped game, at 60 Hz, with no cheats and no god-mode.
// ============================================================================
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

const seed0 = Number(process.argv[2] || 4242);
const runs = Number(process.argv[3] || 4);
const legacy = (process.argv[4] || '').split(',').filter(Boolean);

// --- knowledge -------------------------------------------------------------------------------
const reachOf = (c) => Math.max(60, ...c.modules.map(m => WB.moduleStat(m.mod, m.level, 'reach') || 0));
// rate is SECONDS BETWEEN SHOTS (Content.js), so dps = power / rate.
const dpsOf = (c) => c.modules.reduce((a, m) => {
    const power = WB.moduleStat(m.mod, m.level, 'power') || 0;
    const rate = Math.max(0.05, WB.moduleStat(m.mod, m.level, 'rate') || 1);
    return a + power / rate;
}, 0);

// A perpendicular step aside from anything that will land on us within `window` seconds.
function dodge(run, want) {
    const p = run.player;
    let best = null, bestT = 0.9;
    for (const s of run.projectiles) {
        if (s.faction === p.faction || s.dead) continue;
        const dx = p.x - s.x, dy = p.y - s.y;
        const d = Math.hypot(dx, dy);
        if (d > 260 || d < 1) continue;
        const vx = s.vx || 0, vy = s.vy || 0;
        const sp = Math.hypot(vx, vy);
        if (sp < 40) continue;
        const closing = (vx * -dx + vy * -dy) / (sp * d);      // >0: flying toward us
        if (closing < 0.55) continue;
        const t = d / sp;
        if (t < bestT) { bestT = t; best = { dx: dx / d, dy: dy / d, vx: vx / sp, vy: vy / sp }; }
    }
    if (!best) return want;
    // step to the side of the shell's flight, to the nearer hand
    const px = -best.vy, py = best.vx;
    const side = (px * best.dx + py * best.dy) > 0 ? 1 : -1;
    const ex = px * side, ey = py * side;
    const cur = Math.cos(want) * 0.55 + ex * 0.9, cur2 = Math.sin(want) * 0.55 + ey * 0.9;
    return Math.atan2(cur2, cur);
}

function turnTo(p, a, boost) {
    const d = WB.M.angleDelta(p.heading, a);
    return {
        throttle: Math.abs(d) > 2.5 ? -0.7 : 1,
        steer: WB.M.clamp(d * 2.1, -1, 1),
        boost: !!boost && Math.abs(d) < 0.55
    };
}

// --- the draft: score the offer ---------------------------------------------------------------
function pickCard(run) {
    const cards = run.draftPending.cards;
    const p = run.player;
    const freeSlots = p.slots - p.modules.length;
    const hurt = p.hp < p.maxHp * 0.7;
    const score = (c) => {
        if (c.kind === 'repair') return hurt ? 60 + (1 - p.hp / p.maxHp) * 80 : 6;
        if (c.kind === 'scrap') return 10 + (run.totals.scrap > 120 ? 8 : 0);
        if (c.kind === 'upgrade') {
            const m = p.modules[c.index != null ? c.index : 0] || p.modules[0];
            if (!m) return 20;
            const power = WB.moduleStat(m.mod, c.level || m.level + 1, 'power') || 0;
            const reach = WB.moduleStat(m.mod, c.level || m.level + 1, 'reach') || 0;
            const def = (m.mod.id === 'plate' || m.mod.id === 'masonry') ? (hurt ? 45 : 25) + run.regionIndex * 12 : 0;
            return 40 + power * 0.25 + def + reach * 0.05;
        }
        if (c.kind === 'new') {
            if (freeSlots <= 0) return 4;
            const mod = c.mod;
            const power = WB.moduleStat(mod, 1, 'power') || 0;
            const reach = WB.moduleStat(mod, 1, 'reach') || 0;
            const util = WB.moduleStat(mod, 1, 'repair') || WB.moduleStat(mod, 1, 'steamRegen') || 0;
            return 30 + power * 0.3 + reach * 0.08 + util * 0.4 + (mod.rarity || 0) * 6;
        }
        return 1;
    };
    let bi = 0, bs = -1;
    cards.forEach((c, i) => { const s = score(c); if (s > bs) { bs = s; bi = i; } });
    return bi;
}

// --- the driver --------------------------------------------------------------------------------
let committed = null;
function drive(run) {
    const p = run.player, r = run.region;
    if (!p || !p.alive) return { throttle: 0, steer: 0, boost: false };
    const dCenter = Math.hypot(p.x - r.cx, p.y - r.cy);
    // The mountain ring is a slope trap: heading straight up it nets negative acceleration, so a
    // driver that aims at the centre from the rim stalls forever (found by trace: 500 s frozen at
    // d=856). Ride the CONTOUR instead — tangentially, to the shallower hand — until we are back
    // on the valley floor.
    if (dCenter > r.regionR * 0.78) {
        const radial = Math.atan2(p.y - r.cy, p.x - r.cx);
        const hands = [radial + Math.PI / 2, radial - Math.PI / 2];
        const cost = (a) => {
            const ex = p.x + Math.cos(a) * 120, ey = p.y + Math.sin(a) * 120;
            return Math.abs(r.slopeAt(ex, ey, a)) * 3 + Math.hypot(ex - r.cx, ey - r.cy) / r.regionR;
        };
        // A desired heading recomputed every frame oscillates on the rim (the slope noise flips
        // the choice), and a spinning thrust averages to zero: the hull shivers in place at the
        // clamp radius. Commit to a course for a second at a time.
        run.__rimT = (run.__rimT || 0) - 1 / 60;
        if (run.__rimT <= 0 || run.__rimA == null) {
            run.__rimT = 1.2;
            const c0 = cost(hands[0]), c1 = cost(hands[1]);
            if (run.__side == null) run.__side = c0 <= c1 ? 0 : 1;
            else if (run.__side === 0 && c1 < c0 - 0.3) run.__side = 1;
            else if (run.__side === 1 && c0 < c1 - 0.3) run.__side = 0;
            // lean INWARD: from the +90° tangent that is +0.6, from the -90° tangent that is -0.6
            run.__rimA = hands[run.__side] + (run.__side === 0 ? 0.6 : -0.6);
        }
        const d = WB.M.angleDelta(p.heading, run.__rimA);
        run.__why = 'contour d=' + Math.round(dCenter);
        return { throttle: 1, steer: WB.M.clamp(d * 2.1, -1, 1), boost: false };
    }

    const myReach = reachOf(p), myDps = dpsOf(p);
    const threat = run.threat(900);
    const boss = run.boss && run.boss.alive ? run.boss : null;
    // Enemy hull and damage scale by 1.38 per region: what was brave in the Marches is suicide in
    // the Crown. The caution line (retreat below, re-engage above) climbs with the region index.
    const caution = 0.45 + Math.min(0.3, run.regionIndex * 0.09);

    // 1) the hull is failing: break off and patch
    const hurt = p.hp < p.maxHp * (threat.near || boss ? caution : 0.26);
    if (hurt && !boss) {
        const from = threat.near || p;
        const away = Math.atan2(p.y - from.y, p.x - from.x);
        run.__why = 'hurt';
        return turnTo(p, dodge(run, away), p.steam > 30);
    }

    // 2) the warden: a fight of three phases, not a brawl.
    //    * HURT  (<45%): break off to the open valley and let the crew patch the hull past 70%
    //      (out-of-combat regen starts after HULL_REGEN_DELAY, so the break must be real);
    //    * CHARGE (telegraph): sidestep hard, then punish the recovery window with steam;
    //    * ELSE: orbit inside [0.75, 0.95] of our own longest gun — his mortars miss an orbiting
    //      hull, our culverins do not miss him.
    if (boss) {
        const d = WB.M.dist(p.x, p.y, boss.x, boss.y);
        const telegraph = boss.ai && boss.ai.telegraph > 0;
        const hpFrac = p.hp / p.maxHp;
        if (run.__bossRetreat == null) run.__bossRetreat = false;
        if (hpFrac < caution) run.__bossRetreat = true;
        else if (hpFrac > caution + 0.3) run.__bossRetreat = false;
        let a, boost = false;
        if (run.__bossRetreat) {
            a = Math.atan2(p.y - boss.y, p.x - boss.x);
            boost = p.steam > 30;
        } else if (telegraph && d < 560) {
            a = Math.atan2(p.y - boss.y, p.x - boss.x) + 1.35;                          // sidestep the charge
            boost = p.steam > 25;
        } else if (telegraph) {
            a = Math.atan2(p.y - boss.y, p.x - boss.x) + 0.9;
        } else if (d < myReach * 0.75) {
            a = Math.atan2(p.y - boss.y, p.x - boss.x) + 1.15;                          // too close: circle out
        } else if (d > myReach * 0.95) {
            a = Math.atan2(boss.y - p.y, boss.x - p.x);                                 // too far: close in
            boost = p.steam > 60;
        } else {
            a = Math.atan2(boss.y - p.y, boss.x - p.x) + 0.85;                          // the orbit
        }
        run.__why = 'boss d=' + Math.round(d) + (run.__bossRetreat ? ' RETREAT' : telegraph ? ' sidestep' : ' orbit');
        return turnTo(p, dodge(run, a), boost);
    }

    // 3) farm until we are a hull, not a cart: tier 3 and four guns before picking duels
    const armed = p.tier >= 3 && p.modules.length >= 4;
    const hunter = threat.near && threat.dist < (armed ? 760 : 620);
    // With the gate open and no warden up yet, the OBJECTIVE beats duels: a knight camping the
    // courtyard used to hold the driver in a forever-duel while the gate waited ten metres away
    // (trace: gateOpen at 52s, bossSpawn never). Ride through, take the boss.
    const gateFirst = r.gate.open && !run.bossActive;
    if (hunter && (!gateFirst || threat.dist < 220 || p.hp < p.maxHp * caution) && (!r.gate.open || threat.dist < 380 || p.hp < p.maxHp * (caution + 0.12) || gateFirst)) {
        const foe = threat.near;
        const dFoe = threat.dist;
        const foeReach = reachOf(foe);
        let a;
        if (!armed && dFoe < 460) a = Math.atan2(p.y - foe.y, p.x - foe.x);       // too weak: run
        else if (dFoe < myReach * 0.7 || dFoe < foeReach * 0.6 && myDps < dpsOf(foe)) a = Math.atan2(p.y - foe.y, p.x - foe.x) + 1.2;
        else if (dFoe > myReach * 0.95) a = Math.atan2(foe.y - p.y, foe.x - p.x);
        else a = Math.atan2(foe.y - p.y, foe.x - p.x) + 0.8;                      // orbit at our reach
        run.__why = (armed ? 'duel' : 'flee') + ' d=' + Math.round(threat.dist);
        return turnTo(p, dodge(run, a), dFoe > 500 && p.steam > 45);
    }

    // 4) the objective: fortresses while the gate is shut, the gate once it opens
    let target = null, best = -1;
    if (r.gate && r.gate.open) {
        target = r.gate; best = WB.M.dist(p.x, p.y, r.gate.x, r.gate.y);
    } else if (armed) {
        if (committed && committed.alive && committed.kind === 'fortress') target = committed;
        else {
            let weak = 1e9;
            for (const c of r.castles) {
                if (!c.alive || c.kind !== 'fortress') continue;
                const w = c.hp - dpsOf(c) * 2;
                if (w < weak) { weak = w; target = c; }
            }
            if (target) committed = target;
        }
    }
    if (!target) {
        // Farm where the enemy hulls are NOT: food inside an enemy castle's pocket costs more
        // hull than it is worth (early deaths all happened eating under a fortress's guns).
        const foes = r.castles.filter(c => c.alive && c.faction !== p.faction);
        const foeGap = (e) => {
            let g = 1e9;
            for (const c of foes) g = Math.min(g, WB.M.dist(e.x, e.y, c.x, c.y));
            return g;
        };
        for (const e of r.entities) {
            if (e.dead) continue;
            if (e.type !== 'village' && e.type !== 'node' && e.type !== 'chunk' && e.type !== 'herd' && e.type !== 'wagon') continue;
            let d = WB.M.dist(p.x, p.y, e.x, e.y) * (e.type === 'chunk' ? 0.5 : 1);
            const gap = foeGap(e);
            if (gap < 520 && e.type !== 'chunk') d += (520 - gap) * 2.5;
            if (best < 0 || d < best) { best = d; target = e; }
        }
    }
    if (!target) target = r.gate || p;
    run.__why = (target === r.gate ? 'gate' : target.type || target.kind || '?') + ' d=' + Math.round(WB.M.dist(p.x, p.y, target.x || 0, target.y || 0));
    const lead = target.vx || target.vy ? WB.M.dist(p.x, p.y, target.x, target.y) / 220 : 0;
    const a = Math.atan2((target.y || 0) + (target.vy || 0) * lead - p.y, (target.x || 0) + (target.vx || 0) * lead - p.x);
    return turnTo(p, a, best > 320 && p.steam > 55);
}

// --- play ---------------------------------------------------------------------------------------
let wins = 0;
const table = [];
const r0 = (run) => run.region;
for (let n = 0; n < runs; n++) {
    const seed = seed0 + n * 7919;
    committed = null;
    const run = new WB.Run({ seed, region: 0, legacy, meta: WB.Save.meta });
    const t0 = Date.now();
    let frames = 0;
    const log = [];
    const tierAt = [];
    let lastTier = run.player.tier;
    while (!run.over && frames < 60 * 60 * 22) {
        run.update(1 / 60, drive(run));
        frames++;
        if (run.player.tier !== lastTier) { tierAt.push('T' + run.player.tier + '@' + Math.round(run.time) + 's'); lastTier = run.player.tier; }
        for (const ev of run.events) {
            if (['fortressDown', 'gateOpen', 'bossSpawn', 'bossDown', 'playerDown', 'regionClear'].includes(ev.type)) {
                log.push(Math.round(run.time) + 's ' + ev.type + (ev.left != null ? ':' + ev.left : ''));
            }
        }
        if (run.draftPending) run.takeDraft(pickCard(run));
        if (run.regionCleared) { log.push(Math.round(run.time) + 's ->R' + (run.regionIndex + 1)); run.nextRegion(); committed = null; }
        if (process.env.TRACE && frames % 1200 === 0) {
            const p = run.player;
            console.log('   t=' + Math.round(run.time) + 's ' + (run.__why || '-') +
                ' hp=' + Math.round(p.hp) + '/' + p.maxHp + ' dC=' + Math.round(Math.hypot(p.x - run.region.cx, p.y - run.region.cy)) +
                ' x=' + Math.round(p.x) + ' y=' + Math.round(p.y) + ' gate=' + (run.region.gate.open ? 'open' : 'shut') +
                ' boss=' + (run.bossActive ? 'yes' : 'no') + ' forts=' + run.fortressesLeft);
        }
    }
    if (!run.won && process.env.TRACE) {
        console.log('   last events: ' + run.events.slice(-8).map(e => e.type + (e.source ? '/' + e.source : '') + (e.kind ? '/' + e.kind : '')).join(' '));
        console.log('   end: hp=' + Math.round(run.player.hp) + ' dC=' + Math.round(Math.hypot(run.player.x - r0(run).cx, run.player.y - r0(run).cy)) + ' why=' + run.__why);
    }
    const s = run.summary();
    if (run.won) wins++;
    table.push([seed, run.won, run.regionIndex, s.tier, s.kills, Math.round(run.time), Date.now() - t0, s.modules.map(m => m.id + m.level).join(',')]);
    console.log('seed ' + seed + ' | ' + (run.won ? 'ПОБЕДА' : 'поражение') + ' | регион ' + run.regionIndex +
        ' | tier ' + s.tier + ' | kills ' + s.kills + ' | ' + Math.round(run.time) + 's sim / ' + (Date.now() - t0) + 'ms wall');
    console.log('   ' + tierAt.join(' ') + ' | ' + log.join(' '));
}
console.log('\n  итог: ' + wins + ' побед из ' + runs);
for (const [seed, won, region, tier, kills, t, ms, mods] of table) {
    console.log('  ' + (won ? '\x1b[32mWIN \x1b[0m' : '\x1b[31mloss\x1b[0m') + ' seed ' + seed + ' region ' + region + ' tier ' + tier + ' kills ' + kills + ' ' + t + 's (' + ms + 'ms) ' + mods);
}
process.exit(wins ? 0 : 1);
