// ============================================================================
//  Wanderburg — can the machine WIN? (a playing agent, not a balance probe)
// ----------------------------------------------------------------------------
//  node verify/winrun.mjs [seedFirst] [runs] [legacyIds] [chassisId] [captainId]
//
//  verify/smoke.mjs measures the pace of a run; this one tries to CLOSE it: four valleys and the
//  Iron Crown. The driver plays like a person who has read the design doc —
//    * farm phase: eat the valley to tier 3+ before picking a fight with an armed hull, and never
//      eat inside a foe's gun reach (enemy castles fire regardless of their AI state);
//    * drafts are the whole build (only 3-4 per run!): every card is scored against the SIEGE
//      doctrine below, and trash offers get rerolled while mass allows;
//    * SIEGE DOCTRINE (the heart of it): the top-speed stat is a cap — the accel/drag equilibrium
//      gives EVERY hull ~83 px/s cruise, so speed kiting is fiction. What is real: enemy shells
//      lead by only 0.35 and the AI reacts only inside tti 1.1 s, so SOLID shot misses a moving
//      hull past ~400-500 px — but AoE shells (mortar, spire) and instant tesla do not miss.
//      The foe's effective reach is thus max(aoe reach, tesla reach, solid-shot safe distance);
//      we stand 90 px outside THAT, inside our own longest gun, and shell him for free;
//    * fixed mounts (mortar/tesla) fire in ±75° cones — the orbit side is chosen so our own
//      mortar actually covers the foe, else the siege gun never fires;
//    * the valley is only 900 px across: wall-avoidance outranks the orbit, and a foe that
//      out-reaches us gets the decisive max-dps brawl distance plus retreat-and-patch cycles;
//    * charges: the telegraph locks chargeDir 1.5 s ahead and the lunge covers ~380 px — step
//      perpendicular to THE LINE on steam, but only while it can actually reach us.
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
// A veteran's loadout is a choice, not a cheat: the chassis/captain must be unlocked by the
// legacy list passed in (ch_*/cap_*), exactly as a player's save would unlock them.
// dreadnought+seraphine is the siege hull: cruise speed is the SAME ~83 px/s for every chassis
// (the accel/drag equilibrium — the speed stat is a cap nobody reaches), so the light hulls buy
// nothing and the dreadnought's 3021 hp + 0.14 armor wins the trades that decide boss fights;
// Seraphine's steam regen pays for the boost dodges and the disengages.
const chassisId = process.argv[5] || 'dreadnought';
const captainId = process.argv[6] || 'seraphine';

// --- knowledge -------------------------------------------------------------------------------
/** Weapon-like modules of a hull with their EFFECTIVE reach (hull range mods + Vex per-module). */
function gunsOf(c, st) {
    const s = st || c.stats || c.estats || null;
    const out = [];
    for (const m of c.modules) {
        if (!m.mod) continue;
        const reach = WB.reachOf(c, m.mod, m.level, s);
        const power = WB.moduleStat(m.mod, m.level, 'power') || 0;
        const rate = Math.max(0.05, WB.moduleStat(m.mod, m.level, 'rate') || 1);
        if (reach > 0 && power > 0) {
            out.push({
                id: m.mod.id, level: m.level, reach, dps: power / rate,
                instant: !!m.mod.instant, aoe: m.mod.aoe || 0, pspeed: m.mod.pspeed || 600
            });
        }
    }
    return out;
}
const reachOf = (c) => Math.max(60, ...gunsOf(c).map(g => g.reach));
// rate is SECONDS BETWEEN SHOTS (Content.js), so dps = power / rate.
const dpsOf = (c) => gunsOf(c).reduce((a, g) => a + g.dps, 0);

/** Cached longest gun of an AI castle (its estats never change after spawn). */
function maxReachOf(c, scale) {
    if (c.__maxReach == null) {
        const gs = gunsOf(c, c.estats || WB.enemyStats(c, scale || 1));
        c.__maxReach = gs.length ? Math.max(...gs.map(g => g.reach)) : 200;
    }
    return c.__maxReach;
}

/** The distance inside which this castle's guns are a problem for a hull cruising at v. */
function floorOf(c, scale, v) {
    const key = Math.round(v / 10);
    if (c.__floorKey !== key) {
        const th = threatFloor(c, v, c.estats || WB.enemyStats(c, scale || 1));
        c.__floor = Math.max(th.inst, th.soft);
        c.__floorKey = key;
    }
    return c.__floor;
}

/**
 * While the warden still sleeps and the hull is not battle-ready, the OPEN GATE is a landmine:
 * touching it spawns the boss. Bend any course away from it until patched to 97% (or the patch
 * cap expired — a stalled approach is worse than a rough fight). Trace: wandered in at 83%
 * mid-duel, the Crown spawned on top of the hull, 2361 hp evaporated in five seconds of
 * point-blank L3 volleys.
 */
function gateGuard(run, a) {
    const p = run.player, r = run.region;
    if (!r.gate || !r.gate.open || run.bossActive) return a;
    // The guard is OFF only in the entry window itself: gate armed (build ready, last fortress
    // dead) AND patched to 97% (or the patch cap expired). Every other frame, touching the gate
    // is an accident — and accidents spawned a warden onto a T4 hull (trace 107189: bossSpawn the
    // same second the gate opened) and onto a 1-vs-2 with the last fortress still alive (67594).
    const armedEntry = run.__gateArmed && (p.hp >= p.maxHp * 0.97 || (run.__gatePatch || 0) >= 60);
    if (armedEntry) return a;
    const dg = WB.M.dist(p.x, p.y, r.gate.x, r.gate.y);
    if (dg > 430) return a;
    const gA = Math.atan2(p.y - r.gate.y, p.x - r.gate.x);
    const w = 1 - dg / 430;
    const ux = Math.cos(a) * (1 - w) + Math.cos(gA) * w * 1.6;
    const uy = Math.sin(a) * (1 - w) + Math.sin(gA) * w * 1.6;
    return Math.atan2(uy, ux);
}

/**
 * The direction whose 320 px lookahead lands OUTSIDE every nearby gun's reach and inside the
 * valley. The old inverse-square repulsion fled one castle straight into another's volley
 * (trace r3: 700 hp gone in 10 s of "disengage" through overlapping L3 pockets) — with eight
 * fortresses in the Crown valley, "away from him" is not a plan; "away from everybody" is.
 */
function escapeDir(run, foes) {
    const p = run.player, r = run.region;
    const st = p.stats;
    const v = Math.min(st.speed, st.accel / 2.1);
    const all = r.castles.filter(c => c.alive && c !== p && c.faction !== p.faction);
    const away = foes && foes.length
        ? Math.atan2(p.y - foes[0].y, p.x - foes[0].x)
        : Math.atan2(r.cy - p.y, r.cx - p.x);
    let bestA = away, bestSc = -1e9;
    for (let i = 0; i < 12; i++) {
        const a = i / 12 * Math.PI * 2;
        const qx = p.x + Math.cos(a) * 320, qy = p.y + Math.sin(a) * 320;
        let sc = 0;
        for (const c of all) {
            const f = floorOf(c, run.scale, v);
            sc += Math.min(260, WB.M.dist(qx, qy, c.x, c.y) - f) * 0.7;
        }
        const dC = Math.hypot(qx - r.cx, qy - r.cy);
        const dCnow2 = Math.hypot(p.x - r.cx, p.y - r.cy);
        const cap2 = dCnow2 > r.regionR * 0.55 ? Math.min(r.regionR * 0.78, dCnow2 + 120) : r.regionR * 0.78;
        sc -= Math.max(0, dC - cap2) * 6;
        if (r.gate && r.gate.open && !run.bossActive) {
            const dGate = WB.M.dist(qx, qy, r.gate.x, r.gate.y);
            if (dGate < 300) sc -= (300 - dGate) * 3;
        }
        sc -= Math.abs(WB.M.angleDelta(a, away)) * 25;    // решительность: прочь от главной угрозы
        if (sc > bestSc) { bestSc = sc; bestA = a; }
    }
    return bestA;
}

/**
 * How close a foe's guns actually hurt a hull cruising at `mySpeed`:
 *  * instant weapons (tesla): no dodging — hard floor at their reach;
 *  * AoE shells (mortar 168, spire 92): a sidestep at realistic cruise speed (~83 px/s — the
 *    top-speed stat is a CAP the accel/drag equilibrium never reaches) cannot clear the blast
 *    inside the shell's flight time — treat them as threatening to their full reach;
 *  * solid shot (ball/bolt/bullet, aoe 0): leads by 0.35 only, and the AI's dodgeShells needs
 *    tti<1.1 s to react — past safeD = 26·pspeed/(v·0.65·slack) they miss a moving hull.
 */
function threatFloor(foe, mySpeed, estats) {
    let inst = 0, soft = 0;
    for (const g of gunsOf(foe, estats || foe.estats)) {
        if (g.instant) { inst = Math.max(inst, g.reach); continue; }
        if (g.aoe >= 60) { soft = Math.max(soft, g.reach); continue; }   // blast: no outrunning it
        const safeD = 26 * g.pspeed / Math.max(40, mySpeed * 0.85 * 0.65);
        soft = Math.max(soft, Math.min(g.reach, safeD * 1.08));
    }
    return { inst: inst > 0 ? inst * 1.06 + 30 : 0, soft };
}

/**
 * Orbit side for FIXED mounts: the player's mortar/tesla fire only inside ±75° of their slot
 * angle (FIRE_CONE_DEG), and while orbiting, the foe sits ~90° off the heading — on the RIGHT
 * for side +1, on the LEFT for side −1. Pick the side the heaviest fixed guns actually cover,
 * or the siege mortar never fires (slot order shifts as drafts are taken).
 */
function orbitSideFor(p) {
    const n = Math.max(1, p.modules.length);
    let best = 1, bestVal = -1;
    for (const side of [1, -1]) {
        const rel = side === 1 ? -Math.PI / 2 : Math.PI / 2;
        let val = 0;
        p.modules.forEach((m, i) => {
            if (!m.mod || m.mod.turn) return;
            if (m.mod.behavior !== 'turret') return;
            const power = WB.moduleStat(m.mod, m.level, 'power') || 0;
            if (power <= 0) return;
            const mount = WB.SLOT_ANGLE(i, n);
            const dev = Math.abs(WB.M.angleDelta(mount, rel));
            if (dev <= 75 * Math.PI / 180 - 0.22) val += power;
        });
        if (val > bestVal) { bestVal = val; best = side; }
    }
    return best;
}

/** The fighting band against one foe: [dFloor, dCeil] and where to stand in it. */
function bandOf(run, p, foe) {
    const st = p.stats;
    // Honest cruise speed: the top-speed stat is a cap; the accel/drag equilibrium (~accel/2.1
    // on valley terrain) is what the hull actually sustains — measured 83 px/s at tier 5 for
    // BOTH chassis, and ~79-94 for wardens. Kiting by speed is fiction; kiting by REACH is not.
    const v = Math.min(st.speed, st.accel / 2.1);
    const th = threatFloor(foe, v, foe.estats || WB.enemyStats(foe, run.scale));
    // The duel target is not alone: in the late regions every L3 mortar within earshot keeps
    // firing regardless of its AI state — the floor is the COLLECTIVE floor of everything near.
    let coll = 0;
    for (const c of run.region.castles) {
        if (!c.alive || c === p || c.faction === p.faction) continue;
        const f = floorOf(c, run.scale, v);
        if (WB.M.dist(p.x, p.y, c.x, c.y) < f + 300) coll = Math.max(coll, f);
    }
    const dFloor = Math.max(th.inst, th.soft, coll, 300);
    const myGuns = gunsOf(p, st);
    const myTop = myGuns.length ? Math.max(...myGuns.map(g => g.reach)) : 280;
    const dCeil = myTop - 10;                       // orbit wobble stays inside our own reach
    let desired, safe;
    const sniper = myGuns.some(g => g.reach >= dFloor + 25);
    // THE DEADLOCK: a boss hunts only inside aggro (900) and charges only inside 700. A hull
    // that is FASTER than the enemy cruise (~94 — every AI hull shares accel 188/drag) and
    // out-guns 900+ stands at 940 forever: the boss gives up, patrols, and eats our mortar
    // shells without ever charging. Boilers are what makes a hull faster (accel IS cruise).
    if (v > 98 && myTop >= 975 && dFloor <= 880) {
        desired = Math.max(dFloor + 90, 940);
        safe = true;
    } else if (dCeil >= dFloor + 55) {
        // THE SIEGE: stand where nothing of his reaches (blast shells included) and our longest
        // guns do. +90 of margin absorbs his patrol drift and our orbit wobble — but pull in to
        // floor+40 when a real broadside fires there and the far perch would leave one gun:
        // versus the Crown (6833 hp) 33 dps from 910 beats 13 dps of "clean" from 960.
        desired = Math.min(dFloor + 90, dCeil);
        const minD = Math.max(dFloor + 40, 300);
        if (minD <= dCeil) {
            // +8 firing margin, not +25: a culverin-1 with nest+long_shot reaches 872 — six px
            // short of the old floor+40+25 gate, which left a 26.7 dps siege firing with 13.1
            // and tripled every boss fight (the 1226-2088 s marathons in regions 1-2). A gun at
            // the edge of its reach flickers with the orbit wobble; half uptime still doubles dps.
            const dpsMin = myGuns.reduce((a, g) => a + (g.reach >= minD + 8 ? g.dps : 0), 0);
            const dpsFar = myGuns.reduce((a, g) => a + (g.reach >= desired + 8 ? g.dps : 0), 0);
            if (dpsMin > dpsFar * 1.15) desired = minD;
        }
        safe = true;
    } else if (sniper && dCeil >= dFloor - 40) {
        // THIN-MARGIN SNIPING: our longest gun barely matches his floor (mortar 851 vs his 813).
        // Standing at our own ceiling trades rare wobble-hits for near-zero incoming — the
        // workshop/regen attrition wins it. Diving to the max-dps brawl instead lost every race
        // (trace: "band[813,826]->535 UNSAFE" — 55-70 dps incoming at 535, dead in 50 s).
        desired = dCeil;
        safe = true;
    } else {
        // Out-reached: NO passive standoff (a bombard-only orbit stale-mated a fortress for 640 s —
        // both hulls repaired faster than they traded). Pick the distance where OUR guns sum to
        // the most dps and settle it decisively; the retreat-and-patch loop covers the trades.
        let bestD = Math.max(300, dCeil), bestScore = -1;
        const cands = myGuns.map(g => g.reach * 0.92).concat([300, 420, 540]);
        for (const cd of cands) {
            if (cd > Math.max(dCeil, 300)) continue;
            const dps = myGuns.reduce((a, g) => a + (g.reach >= cd ? g.dps : 0), 0);
            const score = dps * 1000 - cd * 0.05;                 // ties: the farther stance is safer
            if (score > bestScore) { bestScore = score; bestD = cd; }
        }
        // ...but NEVER inside an instant weapon's reach: a tesla stuns (0.7 s), and a stunned hull
        // is a standing hull — a double-tesla warden once stun-locked a gatling build to death.
        desired = Math.max(300, bestD, th.inst + 30);
        safe = false;
    }
    // hopeless: our longest gun cannot even reach past his instant weapons — this fight cannot
    // be won with this build; the driver hovers out of reach and patches instead of feeding.
    return { dFloor, dCeil, desired, safe, inst: th.inst, soft: th.soft, hopeless: th.inst > 0 && dCeil < th.inst };
}

/**
 * RING-позиция против Железного Венца: дистанция максимума ЧИСТОГО dps (наш − входящий).
 * Его долина мала (R=900): «вечный стэндофф 905» геометрически мёртв — pure-pursuit босс
 * садится в 0.55×R за круглящим корпусом (лаба: 880→420 за 10 s), а спавн-контакт — это
 * 400-500 dps по 7 стволам L3 с множителем региона ×2.365. Выигрывает не поза, а КОЛЬЦО:
 * точка, где его арсенал не достаёт (или достаёт меньше всего), а наши самые длинные стволы
 * ещё бьют — 839 (ролл без мортир: mortar+culverin 26.7 против 0) или 958 (mortar3-ролл:
 * 13.1 против 0). Входящий считаем на cand−45 (люфт погони/орбиты), баллистику — с
 * коэффициентом уклонения 0.55, instant/AoE — целиком; темп его стволов растёт с enrage.
 */
function ringSpotFor(run, p, foe, b) {
    const st = p.stats;
    const armorMul = 1 - WB.M.clamp(st.armor, -0.3, 0.75);
    const scaleMul = run.scale * 0.9 * armorMul;
    const myGuns = gunsOf(p, st);
    const foeGuns = gunsOf(foe, foe.estats || WB.enemyStats(foe, run.scale));
    const rateMul = 1 + 0.18 * ((foe.ai && foe.ai.enrage) || 0);
    const lo = Math.max(b.inst + 55, 520);
    const hi = Math.max(lo + 60, b.dCeil + 30);
    const pts = [];
    for (let cand = lo; cand <= hi; cand += 18) {
        const my = myGuns.reduce((a, g) => a + (g.reach >= cand + 8 ? g.dps : 0), 0);
        if (my <= 0.1) continue;
        // Коэффициенты калиброваны по двум живым боям Венца: 186379 (dAvg 583: in 44
        // против модельных 62 при «AoE=1.0») и 170541 (dAvg 630: in 32 против 37). Медленная
        // AoE-мортира (pspeed 460, aoe 168) частично переживается манёвром (0.8), spire
        // (aoe 92, pspeed 665) — больше (0.65), instant — весь (1.0), баллистика — 0.55.
        const inD = foeGuns.reduce((a, g) => a + (g.reach >= cand - 45
            ? g.dps * scaleMul * rateMul * (g.instant ? 1 : g.aoe >= 150 ? 0.8 : g.aoe >= 60 ? 0.65 : 0.55) : 0), 0);
        const net = my - inD;
        pts.push({ cand, my, inD, net, ratio: my / (inD + 2) });
    }
    if (!pts.length) return null;
    // Цель — чистый net (my − in): ratio-эксперимент (батч10) утаскивал гонки ближе и
    // стоил 5 смертей в r0 против 1. Ближайшая точка максимума net: дальше — тот же ноль,
    // но меньше маржа под мортиру и патрульный дрифт.
    let best = null;
    for (const q of pts) if (!best || q.net > best.net + 0.5) best = q;
    return { d: best.cand, net: best.net };
}

// A perpendicular step aside from anything that will land on us within `window` seconds.
function dodge(run, want, window) {
    const p = run.player;
    let best = null, bestT = window || 0.9;
    for (const s of run.projectiles) {
        if (s.faction === p.faction || s.dead) continue;
        const dx = p.x - s.x, dy = p.y - s.y;
        const d = Math.hypot(dx, dy);
        const vx = s.vx || 0, vy = s.vy || 0;
        const sp = Math.hypot(vx, vy);
        if (sp < 40) continue;
        if (d > 260 || d < 1) continue;
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

function steerToDir(p, a, boost) {
    const d = WB.M.angleDelta(p.heading, a);
    const sp = Math.hypot(p.vx || 0, p.vy || 0);
    return {
        throttle: (Math.abs(d) > 2.6 && sp < 50) ? -0.6 : 1,
        steer: WB.M.clamp(d * 2.1, -1, 1),
        boost: !!boost && Math.abs(d) < 0.7
    };
}

/**
 * The wall-aware escape ray (shared by the deep-escape state and the far-telegraph run).
 * Rim-locked (dC > 0.78R): ride the contour — straight-away is the mountain, through-boss
 * oscillates into ram-stalls, and the tangential keeps 70+ px/s until the geometry opens.
 * Otherwise: sample rays, score landing outside the foe's guns, never past the fight-zone cap.
 */
function escapeRay(run, p, r, foe, floor, away, wallCapFrac) {
    const dCnow = Math.hypot(p.x - r.cx, p.y - r.cy);
    if (dCnow > r.regionR * 0.78) {
        const radial = Math.atan2(p.y - r.cy, p.x - r.cx);
        const t1 = radial + Math.PI / 2, t2 = radial - Math.PI / 2;
        const tang = Math.abs(WB.M.angleDelta(t1, away)) < Math.abs(WB.M.angleDelta(t2, away)) ? t1 : t2;
        const side = WB.M.angleDelta(radial, tang) > 0 ? 1 : -1;
        // Lean INWARD (sign-checked!): tang + 0.55·side sits ~121° off the outward radial, so the
        // radial component is −0.52 — a spiral into the valley. The old "tang − 0.4·side" leaned
        // OUTWARD (+0.39) and every rim-locked fight ground the hull into the wall clamp at
        // v≈10-30 while the boss fed (trace 123027: 107 s pinned at dC 830-849).
        return tang + 0.55 * side;
    }
    const cap = dCnow > r.regionR * 0.55 ? Math.min(r.regionR * wallCapFrac, dCnow + 120) : r.regionR * wallCapFrac;
    let bestA = away, bestSc = -1e9;
    for (const da of [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.4, -2.4, 3.1, -3.1]) {
        const a = away + da;
        const qx = p.x + Math.cos(a) * 300, qy = p.y + Math.sin(a) * 300;
        const dF = Math.hypot(qx - r.cx, qy - r.cy);
        let sc = Math.min(300, WB.M.dist(qx, qy, foe.x, foe.y) - floor) * 0.5
            - Math.max(0, dF - cap) * 6
            - Math.abs(da) * 25;
        // Склоны жрут скорость (slowFactor при height>40): луч через низину быстрее луча
        // вдоль холма — рим-смерти 170541 (rim=15 s) были именно замедлением на подъёме.
        if (r.heightAt) sc -= Math.max(0, r.heightAt(qx, qy) - 30) * 1.5;

        if (r.gate && r.gate.open && !run.bossActive) {
            const dGate = WB.M.dist(qx, qy, r.gate.x, r.gate.y);
            if (dGate < 300) sc -= (300 - dGate) * 3;    // never escape THROUGH the gate
        }
        if (run.__escSide != null && da * run.__escSide > 0) sc += 20;   // side commitment
        if (sc > bestSc) { bestSc = sc; bestA = a; run.__escSide = da === 0 ? (run.__escSide || 1) : Math.sign(da); }
    }
    return bestA;
}

// --- the band fight: one function for a fortress duel and for the warden -------------------------
function fightCastle(run, foe, isBoss) {
    const p = run.player, r = run.region;
    const b = bandOf(run, p, foe);
    const d = WB.M.dist(p.x, p.y, foe.x, foe.y);
    const toFoe = Math.atan2(foe.y - p.y, foe.x - p.x);
    const hpFrac = p.hp / p.maxHp;
    // ЧЕСТНЫЕ СКОРОСТИ из самой симуляции. Формула min(speed, accel/2.1) занижает равновесие
    // игрока (83-95 «на бумаге» против измеренных 101-106 на плоскаче у дредноута+Серафины) и
    // завышает погоню Crown (замер verify/dbg-charge.mjs: hunt 81-84 px/s при любом enrage —
    // крупный корпус медленнее крепостных ~94; рывок заряда и вовсе проходит 91 px за 1.7 s).
    // Меряем максимум с медленным распадом: игрок — без буста/стана, противник — в погоне.
    const pv = Math.hypot(p.vx || 0, p.vy || 0);
    if (!p.boost && !(p.stun > 0) && pv > 5) run.__myV = Math.max(pv, (run.__myV || 0) - 0.12);
    const fai = foe.ai || {};
    if (fai.state === 'hunt' || fai.chargeT > 0) {
        const fv = Math.hypot(foe.vx || 0, foe.vy || 0);
        run.__foeV = Math.max(fv, (run.__foeV || 0) - 0.12);
    }
    const vMine = run.__myV || Math.min(p.stats.speed, p.stats.accel / 2.1);
    const vFoe = run.__foeV || (foe.kind === 'crown' ? 84 : 94);
    // A fortress duel is won by whoever patches between the acts: break off earlier than from a
    // boss (the boss must be finished; a fortress can be left for a full-hull second visit).
    const caution = isBoss ? 0.5 + Math.min(0.3, run.regionIndex * 0.1) : 0.6;

    // Retreat hysteresis: below caution we widen until the crew can patch, above caution+0.3 the
    // band fight resumes. Out-of-combat regen needs 7 clean seconds — the band provides them.
    if (run.__retreat == null) run.__retreat = false;
    if (hpFrac < caution) run.__retreat = true;
    else if (hpFrac > Math.min(0.95, caution + (isBoss ? 0.3 : 0.28))) run.__retreat = false;

    // --- desired standoff: the band, widened while patching
    let desired = b.desired;
    if (run.__retreat && !isBoss) {
        // Patch window (дуэли с крепостями): полностью вне его стволов — regen 10/s требует
        // 7 чистых секунд; «стреляющий отход» на floor+40 у стены не давал ни одного.
        desired = Math.max(desired, Math.min(b.dCeil + 100, Math.max(b.dFloor + 120, 620)), 620);
    }
    if (isBoss && b.hopeless) desired = Math.min(880, Math.max(b.dFloor + 160, 700));
    // BOSS STANCE MATRIX (лаба verify/dbg-boss.mjs + dbg-charge убили красивые теории):
    //  * ЖЕЛЕЗНЫЙ ВЕНЕЦ → RING (ringSpotFor): его долина R=900, «вечный стэндофф 905»
    //    геометрически мёртв (pure-pursuit садится в 0.55R за круглящим корпусом), а RACE на
    //    inst+50 — это 400-500 входящих dps по семи L3-стволам с множителем региона ×2.365
    //    (трейсы 194298/202217: 12-50 s). Кольцо = точка максимального чистого dps: 839+
    //    (ролл без мортир: наш mortar+culverin 26.7 против 0) или 958+ (mortar3-ролл: 13.1
    //    против 0); его заряд — выпад 91 px, hunt 81-87 медленнее наших буст-циклов 123-142.
    //  * ВАРДЕН → RACE на max(inst+50, 520): обмен ударами, где наша бортовая 60-90 dps бьёт
    //    его 2600×scale, — стэндофф-905 против вардена ПРОИГРЫВАЛ (его заряд — рывок 213 px
    //    каждые 11 s, стаскивающий корпус под mortar2 813; трейс 51756: r1 175 s, r2 смерть).
    //  * остальное: floor+90 siege, как посчитано bandOf.
    if (isBoss && !b.hopeless) {
        if (foe.kind === 'crown') {
            // RING: у Венца своя геометрия (см. ringSpotFor) — ни стэндофф 905, ни RACE на
            // inst+50 (трейсы 194298/202217: 12-50 s, inDps 126-250) не работали; точка
            // максимального чистого dps и удержание её буст-циклами — да. Его заряд — медленный
            // выпад (77 px/s, ~91 px за рывок, замер dbg-charge): кольцо он не срывает.
            const ring = ringSpotFor(run, p, foe, b);
            desired = ring ? ring.d : Math.min(b.dCeil, Math.max(b.dFloor + 40, 905));
        } else if (b.dFloor >= 700) {
            // THE RACE: его мортиры покрывают всё — обмен на дистанции, где наша бортовая
            // отвечает, а его тесла нет (inst+50). Но формула смотрит только на instant-пол:
            // ролл [mortar+tesla+ballista] накрывает баллистой 572 позицию 555 (трейс 99270:
            // inDps 58, обмен 0.55) — сканер чистого dps знает, где обмен выше (620: 1.9),
            // поэтому для дальнобойных билдов берём его позицию, для ближних — формулу.
            const race = WB.M.clamp(Math.max(b.inst + 50, 520), 340, Math.max(b.dCeil, 520));
            const ring = ringSpotFor(run, p, foe, b);
            desired = Math.max(race, ring ? Math.min(ring.d, b.dCeil) : 0);
        } else if (b.soft >= 400) {
            // spire/ballista floors: stand just OUTSIDE them — the race is free there.
            desired = WB.M.clamp(Math.max(b.inst + 50, b.soft + 50, 520), 340, Math.max(b.dCeil, 520));
        }
    }
    if (isBoss && !b.hopeless && run.__retreat) {
        // SHADOW-RETREAT: держимся сразу за его полом, но ВНУТРИ своей дальней пушки —
        // regen (10/s чистыми + workshop) идёт, пока mortar/culverin продолжают бить; когда
        // hunt срывается (900+) и он бредёт домой, следуем за ним — бесплатное окно урона и
        // лечения 20-30 s за цикл. Старый блок расширения стоял ДО stance-матрицы и ею
        // перезаписывался — фактически disengage у боссов не работал никогда.
        const myTop = b.dCeil + 10;
        desired = WB.M.clamp(Math.max(b.dFloor + 120, 620, desired), 620, Math.max(620, myTop - 15));
    }
    // FIGHT-ZONE CAP: every lost race ended the same way — escape pushed the hull onto the rim
    // (dC 700-830), the wall slope ate its speed, and the boss walked in for the execution
    // (traces 59675/138865/115108). Races and brawls are fought inside the CENTRE circle
    // (dC ≤ 0.64R) where a hull keeps 90+ px/s and the orbit works; only the standoff stances
    // (desired ≥ 850 — the Crown climb) may use the outer ring, and only where geometry allows.
    // Венцу — вся долина: кольцо 836-996 и подъём живут на полном диаметре; кап 0.64R
    // запирал подъём в коротком коридоре, где тангенциаль = ловушка pure-pursuit (0.55×r).
    // Венцу — 0.78R: замер батчей — тесный коридор 0.70R давил бой до 25 s (босс прижимал
    // корпус к склонам), а 0.78R держал обмен 2:1 на 95 s (89% hp Венца, трейс 170541).
    const wallCap = (desired >= 850 || (isBoss && foe.kind === 'crown')) ? 0.78 : 0.64;

    // --- the charge: telegraph locks chargeDir 1.5 s ahead and the lunge covers ~380 px.
    //     CLOSE (≤460): a hard committed sidestep off THE LINE — a per-frame side choice
    //     flip-flops and the hull treads water at v≈26 (trace: pinned mid-dodge, bolts landing).
    //     FAR: the lunge falls short on its own — keep escaping/standing off and merely DRIFT
    //     off the line; a full sidestep there cancelled the separation boost and let a slower
    //     hull be walked back into mortar range every charge cycle (trace 91351: 35 s death).
    const ai = foe.ai || {};
    if (isBoss && (ai.telegraph > 0 || ai.chargeT > 0)) {
        // Замер рывка (verify/dbg-charge.mjs, регионы 0-3, enrage 0-2): vMax 77-82, путь
        // 91-94 px за 1.7 s — «380 px» старой доктрины не существует. Уходящий корпус
        // (101-174) рывок не догоняет НИКОГДА дальше ~250 px, а телеграф (1.5 s, босс
        // стоит) — это бесплатные +150 px отрыва. Сайдстеп на 400-520 px сжигал окно
        // стоянием на месте: спавн-подъём под Венцом получал 3.2 s сайдстепа каждые
        // 6-8.5 s — «под inst» 18 s и смерть на 13-25 s (лаба r1-r8, трейсы 194298/202217).
        // Сайдстеп — только когда рывок физически достижим (краш ~136 + 94 + запас) или
        // мы в стане вплотную (уклоняться всё равно нечем — руль ×0.35).
        const cd = ai.chargeDir != null ? ai.chargeDir : toFoe;
        // Венец: рывок 91 px — сайдстеп только в зоне его физической достижимости, выше —
        // ЧИСТЫЙ подъём (телеграф 1.5 s = бесплатные +150 px). Варден: старая проверенная
        // семантика — с паром уходим лучом на любой дистанции (рывок 94 px не догоняет
        // уходящий корпус), сайдстеп только без пара или в стане вплотную.
        // Единый порог для всех боссов: рывок = 91-94 px за 1.7 s при vMax 77-82 (замер
        // dbg-charge, регионы 0-3) — уходящий корпус (101-142) не догоняется НИКОГДА дальше
        // ~250 px. Сайдстеп на 300-520 px стоил −300 px дистанции за цикл (босс подходит
        // 3.2 s телеграфа+рывка, пока корпус топчется боком): пила dAvg 450-500 и смерти в
        // inst-поле (батч10: 59675/83432). Телеграф для уходящего — БЕСПЛАТНЫЕ +150 px.
        const sidestepZone = d <= 280 || (p.stun > 0 && d < 340);
        if (!sidestepZone) {
            const away = Math.atan2(p.y - foe.y, p.x - foe.x);
            const ray = escapeRay(run, p, r, foe, b.dFloor, away, wallCap);
            const pl = cd + Math.PI / 2;
            const drift = Math.cos(pl) * (p.vx || 0) + Math.sin(pl) * (p.vy || 0);
            const sideSign = drift >= 0 ? 1 : -1;
            const perp = cd + Math.PI / 2 * sideSign;
            const ea = Math.atan2(Math.sin(ray) + Math.sin(perp) * 0.25, Math.cos(ray) + Math.cos(perp) * 0.25);
            run.__why = 'boss CHARGE-RUN d=' + Math.round(d);
            const dh = WB.M.angleDelta(p.heading, dodge(run, ea, 0.45));
            // в гаунтлете (<560) тяга жжётся до дна; в стане — обязательна (drag 4.0)
            const bst = p.stun > 0 ? (p.steam > 4 && Math.abs(dh) < 1.9)
                : (p.steam > (d < 560 ? 8 : 30) && Math.abs(dh) < 1.4);
            return { throttle: 1, steer: WB.M.clamp(dh * 2.4, -1, 1), boost: bst };
        }
        // Ближний сайдстеп: перпендикуляр к ЗАФИКСИРОВАННОЙ линии рывка, в сторону текущего
        // движения (снап-разворот в 90° стоит 1.3 s при v≈20 — ровно столько длится выпад).
        const pl = cd + Math.PI / 2, pr = cd - Math.PI / 2;
        const drift = Math.cos(pl) * (p.vx || 0) + Math.sin(pl) * (p.vy || 0);
        const cross = (p.x - foe.x) * Math.sin(cd) - (p.y - foe.y) * Math.cos(cd);
        const sideSign = (Math.abs(drift) > 25 ? (drift >= 0 ? 1 : -1) : (cross >= 0 ? 1 : -1));
        const perp = cd + Math.PI / 2 * sideSign;
        run.__dodgeT = (run.__dodgeT || 0) - 1 / 60;
        if (run.__dodgeT <= 0 || run.__dodgeCd !== cd || run.__dodgeA == null) {
            run.__dodgeT = 0.8; run.__dodgeCd = cd;
            const room = (aa) => {
                const dd = Math.hypot(p.x + Math.cos(aa) * 280 - r.cx, p.y + Math.sin(aa) * 280 - r.cy);
                return dd > r.regionR * wallCap ? 1e9 : dd;    // the wall side is not a side
            };
            const a = room(pl) < room(pr) ? pr : pl;
            let ex = Math.cos(a), ey = Math.sin(a);
            if (d < 320) { const aw = Math.atan2(p.y - foe.y, p.x - foe.x); ex = ex * 0.7 + Math.cos(aw) * 0.55; ey = ey * 0.7 + Math.sin(aw) * 0.55; }
            run.__dodgeA = Math.atan2(ey, ex);
        }
        run.__why = 'boss CHARGE-DODGE d=' + Math.round(d);
        const dh = WB.M.angleDelta(p.heading, dodge(run, run.__dodgeA, 0.4));
        return { throttle: 1, steer: WB.M.clamp(dh * 2.4, -1, 1), boost: p.steam > 12 && Math.abs(dh) < 1.4 };
    }

    // The separation boost: a boss cruises at ~79-94 — OUR cruise is 83, so without steam a
    // boss that glued itself (spawn touch, a brawl we lost) is never shaken off and the whole
    // siege collapses into a knife fight at d=260 (trace: hp 2254→0 while "band[813,979]->903").
    // Boost (153 px/s) is the only real speed difference that exists in this game — but keep a
    // reserve for charge dodges: spend it on separation only above 35 steam.
    const infSteamOrbit = p.stats.steamRegen >= WB.num('BOOST_DRAIN', 34);
    const boost = (d < desired - 120 && p.steam > (infSteamOrbit ? 8 : 35)) ||
        (!b.safe && p.steam > (infSteamOrbit ? 8 : 40) && d < b.dFloor + 80);

    // --- INSIDE HIS FLOOR: escaping takes absolute priority (in the SAFE band only — an unsafe
    //     brawl lives inside the floor by definition). Orbiting at 250 px traded blows and lost
    //     by 138 boss hp (trace 59675): boss cruise ~94 > our ~83, so once glued, only boost
    //     (153) creates separation. Straight line, full steam, committed course, until the siege
    //     distance is back — a boss that cannot reach us cannot win the race.
    //     The escape ray never points AT the foe (ramming him trades a hull for a lunge) and is
    //     scored by WALL CLEARANCE: pinned to the rim, "away" is into the mountain — the ray that
    //     keeps the most valley ahead wins, which naturally becomes a tangential wall-slide until
    //     the geometry opens (the pinned-at-the-wall death of trace 59675: v≈10, dC≈840, mortars).
    // Escape is for DEEP penetration (a charge or a stun dropped us inside his guns): the line
    // sits below whichever of floor/desired the stance lives at, with hysteresis on the exit.
    const escLine = Math.min(b.dFloor, desired) - 80;
    const escaping = (d < escLine) || (run.__escaping && d < escLine + 90);
    run.__escaping = escaping;
    if (escaping) {
        const away = Math.atan2(p.y - foe.y, p.x - foe.x);
        run.__escT = (run.__escT || 0) - 1 / 60;
        // Long commits: at 0.7 s the away-vector rotation (both hulls circling at the rim) kept
        // re-picking rays and the hull spin-walked in place at v≈1 while mortars landed.
        if (run.__escT <= 0 || run.__escA == null || Math.abs(WB.M.angleDelta(run.__escAway || away, away)) > 1.2) {
            run.__escT = 1.5; run.__escAway = away;
            run.__escA = escapeRay(run, p, r, foe, b.dFloor, away, wallCap);
        }
        // tight dodge window while escaping: a full 0.9 s window let every distant bolt veto the
        // escape course frame-by-frame and the hull shuddered in place at v≈0 under the mortars.
        const want = dodge(run, isBoss ? run.__escA : gateGuard(run, run.__escA), 0.45);
        const dh = WB.M.angleDelta(p.heading, want);
        run.__why = (isBoss ? 'boss' : 'duel') + ' ESCAPE d=' + Math.round(d) + ' fl=' + Math.round(b.dFloor);
        // Steam discipline: the climb out of his guns is worth the whole tank — the standoff
        // refills it for free afterwards (seraphine+fast_boiler: 27.6/s).
        // Steam discipline: boost in bursts, keep a reserve for the climb/dodges — a continuous
        // boost empties the tank in 3 s and the coast that follows lets the boss walk back in.
        // НО с sail-регеном (steamRegen ≥ дренаж 34: sail1+Серафина+fast_boiler = 42.8/s) пар
        // не кончается — подъём жжём непрерывно (каждая секунда под стволами L3 стоит 200-450 hp),
        // а в стане тяга обязательна: без неё drag 4.0 роняет скорость до 44 и босс (84) догоняет.
        const infSteam = p.stats.steamRegen >= WB.num('BOOST_DRAIN', 34);
        const boostNow = infSteam
            ? (p.steam > 8 && Math.abs(dh) < (p.stun > 0 ? 1.9 : 1.57))
            : ((p.steam > 55 || d < 340 || p.steam > 20 && d < 520 ||
                (isBoss && foe.kind === 'crown' && p.steam > 25 && d < 720) ||
                (p.stun > 0 && p.steam > 8)) && Math.abs(dh) < 1.35);
        return { throttle: 1, steer: WB.M.clamp(dh * 2.4, -1, 1), boost: boostNow };
    }

    // --- desired direction: tangent orbit + radial band correction + knight slide + wall room.
    //     The orbit side is chosen so the FIXED mounts (mortar/tesla: ±75° firing cones) actually
    //     cover the foe — recomputed when the module layout or the foe changes, then committed.
    run.__orbitT = (run.__orbitT || 0) + 1;
    if (run.__orbitSide == null || run.__orbitN !== p.modules.length || run.__orbitFoe !== foe || run.__orbitT > 120) {
        run.__orbitSide = orbitSideFor(p);
        run.__orbitN = p.modules.length;
        run.__orbitFoe = foe;
        run.__orbitT = 0;   // аптайм мортиры в гонке ~61% (трейс 59675: myDps 20 из 32.7) —
        // сторона орбиты устаревает по мере того, как босс ходит вокруг корпуса
    }
    const tang = toFoe + Math.PI / 2 * run.__orbitSide;
    const err = d - desired;
    // Soft gain on approach (at /90 the correction saturated and the hull dove through the
    // standoff ring: 1099 -> 462 in seconds, straight under an L3 mortar floor), HARD gain when
    // more than 60 px too close — inside a floor, every metre is incoming damage. Deep inside,
    // the course goes mostly radial: tangential weight is what kept the deadlock climb at 40°
    // and let the charge cycle outpace it (trace 59675: 127 s of "ESCAPE" that never escaped).
    const corr = WB.M.clamp(err / (err < -60 ? 70 : 180), -1, 1);
    // Удержание кольца против Венца — РАДИАЛЬНОЕ: тангенциальная орбита вокруг преследователя
    // даёт равновесие pure-pursuit 0.55×r (замер лабы: 880→420 за 10 s) — прямые, пока он в
    // hunt; тангенциал можно, только когда он патрулирует у врат (не догоняет).
    const crownHunt = isBoss && foe.kind === 'crown' && (foe.ai || {}).state === 'hunt';
    const tangW = crownHunt ? 0.3 : 0.95 - 0.7 * Math.min(1, Math.abs(err) / 260);
    let ux = Math.cos(tang) * tangW + Math.cos(toFoe) * corr;
    let uy = Math.sin(tang) * tangW + Math.sin(toFoe) * corr;

    // Knights: our guns out-rank them (castles first) but their lances land — a summoned pack
    // adds 25-30 dps of pure chip inside the brawl. Slide off harder and earlier.
    let kn = null, knD = isBoss ? 240 : 190;
    for (const e of r.entities) {
        if (e.dead || e.type !== 'knight' || e.faction === p.faction) continue;
        const dd = WB.M.dist(p.x, p.y, e.x, e.y);
        if (dd < knD) { knD = dd; kn = e; }
    }
    if (kn) {
        const a = Math.atan2(p.y - kn.y, p.x - kn.x);
        const kw = (1 - knD / (isBoss ? 240 : 190)) * 0.5 + 0.8;
        ux += Math.cos(a) * kw; uy += Math.sin(a) * kw;
    }

    // The mountain ring ends fights: keep a full second of headroom, inward beats orbit.
    const spd = Math.max(140, Math.hypot(p.vx || 0, p.vy || 0));
    const un = Math.hypot(ux, uy) || 1;
    const qx = p.x + (ux / un) * spd * 1.0, qy = p.y + (uy / un) * spd * 1.0;
    const dN = Math.hypot(qx - r.cx, qy - r.cy);
    const wallAt = r.regionR * (wallCap - 0.06);
    if (dN > wallAt) {
        const w = WB.M.clamp((dN - wallAt) / (r.regionR * 0.14), 0, 1) * 3.2;
        const inw = Math.atan2(r.cy - p.y, r.cx - p.x);
        ux += Math.cos(inw) * w; uy += Math.sin(inw) * w;
    }

    // The open gate is a LANDMINE until the entry is armed: the boss spawns ON CONTACT. The soft
    // 430 px gateGuard blend lost to momentum (trace 115108: touched at hp 726 mid-duel with the
    // last fortress alive — Crown + fortress 1-vs-2, dead in 2 s). Hard repulsion inside 300 px.
    if (r.gate && r.gate.open && !run.bossActive &&
        !(run.__gateArmed && p.hp >= p.maxHp * 0.97)) {
        const dg = WB.M.dist(p.x, p.y, r.gate.x, r.gate.y);
        if (dg < 300) {
            const gA = Math.atan2(p.y - r.gate.y, p.x - r.gate.x);
            const w = (1 - dg / 300) * 3.2 + 0.4;
            ux += Math.cos(gA) * w; uy += Math.sin(gA) * w;
        }
    }

    run.__band = b;
    run.__why = (isBoss ? 'boss' : 'duel') + ' d=' + Math.round(d) + ' band[' + Math.round(b.dFloor) +
        ',' + Math.round(b.dCeil) + ']->' + Math.round(desired) + (b.safe ? '' : ' UNSAFE') +
        (run.__retreat ? ' RETREAT' : '');
    return steerToDir(p, dodge(run, isBoss ? Math.atan2(uy, ux) : gateGuard(run, Math.atan2(uy, ux))), boost);
}

// --- the draft: 3-4 drafts decide the whole build; score every card against the band ------------
function scoreCard(run, c) {
    const p = run.player, st = p.stats;
    const freeSlots = p.slots - p.modules.length;
    const hurt = p.hp < p.maxHp * 0.7;
    // The boss of THIS run's horizon: wardens carry level-2 mortars (reach 813), the Iron Crown
    // level-3 (870). "Band ok" = our longest gun already over-reaches that line.
    const need = run.regionIndex >= WB.BIOMES.length - 1 ? 870 : 813;
    const guns = gunsOf(p, st);
    const myTop = guns.length ? Math.max(...guns.map(g => g.reach)) : 200;
    const bandOk = myTop >= need + 90;
    // At tier 5 the entry window patches to 97% for free — a repair card there is a wasted pick
    // (trace 91351: took repair(105) over rerolling toward a boiler/mortar with free rerolls left).
    if (c.kind === 'repair') return p.tier >= 5 ? (hurt ? 34 : 5) : hurt ? 70 + (1 - p.hp / p.maxHp) * 90 : 6;
    if (c.kind === 'scrap') return 8;
    if (c.kind === 'upgrade') {
        const m = p.modules.find(x => x.mod.id === c.id);
        if (!m) return 20;
        const lvl = c.level || m.level + 1;
        const power = WB.moduleStat(m.mod, lvl, 'power') || 0;
        const reachNow = WB.reachOf(p, m.mod, m.level, st);
        const reachNew = WB.reachOf(p, m.mod, lvl, st);
        const def = (m.mod.id === 'plate' || m.mod.id === 'masonry') ? (hurt ? 48 : 26) : 0;
        let s = 34 + power * 0.22 + def + run.regionIndex * power * 0.04;
        if (m.mod.aoe || m.mod.instant || m.mod.cone) s += 10;        // blast/beam never miss a dodger
        s += Math.max(0, reachNew - reachNow) * 0.10;
        if (reachNew >= need + 60 && reachNow < need + 60) s += 30;   // the upgrade crosses the boss line
        // nests ARE the band — но АПГРЕЙД гнезда ценен только как достройка полосы к мортире
        // (mortar1: 896→959 с nest2); без мортира nest2 поднимает culverin 872→894 — ничто
        // (трейс 83432: T3 nest2↑, T4 nest3↑ против двойного mortar2 — myDps 18, смерть в 80 s).
        if (m.mod.id === 'nest') s = bandOk ? 58 : (p.modules.some(x => x.mod.id === 'mortar') ? 96 : 44);
        // Мортира L2 на стэндоффе — +45% к единственному стволу, который достаёт с 905+
        // (13.1 → 19 dps: Железный Венец падает за ~360 s вместо ~520 — меньше окон под
        // саммоны и патрульный дрифт). Лучшая карта T5, когда полоса уже собрана.
        if (m.mod.id === 'mortar' && reachNew >= 955 && run.player.tier >= 3) s = Math.max(s, 112);
        if (m.mod.id === 'mortar' && reachNew >= 955 && run.player.tier >= 4) s = Math.max(s, 130);
        if (m.mod.id === 'mortar' && bandOk && run.player.tier >= 5) s = Math.max(s, 132);
        if (m.mod.id === 'boiler') s += 20;                           // accel IS cruise speed here
        // The Crown engine: at tier 5 with the range built, lifting cruise past the AI's 94
        // (boiler L2 ≈ 97) is what turns the Iron Crown from a knife race into a deadlocked
        // artillery execution — worth hunting through every T5 reroll.
        if (m.mod.id === 'boiler' && run.player.tier >= 5 && myTop >= 930) s = Math.max(s, 118);
        if (m.mod.id === 'workshop') s += hurt ? 22 : 8;              // in-fight patching vs the burn
        if (m.mod.id === 'gatling' || m.mod.id === 'flame') s -= 18;  // short guns: the band never uses them
        return s;
    }
    if (c.kind === 'new') {
        if (freeSlots <= 0) return 4;
        const mod = c.mod;
        const reach = WB.reachOf(p, mod, 1, st);
        const power = WB.moduleStat(mod, 1, 'power') || 0;
        // dodgeShells is the boss's answer to solid shot: every AI castle sidesteps an incoming
        // ball/bolt/bullet inside 260 px (lab: five straight culverin misses at d=252, boss hp
        // flat for 20 s). BLAST and INSTANT weapons ignore the sidestep — mortar (168 aoe),
        // spire (92), tesla (instant+stun), flame (cone) are the guns that actually kill wardens;
        // culverin/ballista remain valuable for reach, fortresses and the ~50% they do land.
        const BASE = {
            culverin: 85, nest: 112, mortar: 118, ballista: 70, spire: 110, bombard: 55,
            tesla: 70, boiler: 96, furnace: 78, workshop: 62, masonry: 60, plate: 58,
            keg: 36, hive: 40, sail: 16, banner: 20, reliquary: 24, ram: 12, gatling: 28, flame: 26
        };
        let s = BASE[mod.id] != null ? BASE[mod.id] : 30 + power * 0.3 + reach * 0.05;
        // Boiler is THE module of the late game: accel is cruise speed here (the speed stat is a
        // cap the drag equilibrium never reaches), and cruise 98 > boss 94 means the siege
        // distance holds WITHOUT steam; every region from the Steppe up has L2-L3 mortars.
        if (mod.id === 'boiler' && run.regionIndex >= 1) s += 14;
        if (mod.id === 'boiler' && !p.modules.some(x => x.mod.id === 'boiler')) {
            s += run.player.tier >= 4 ? 24 : 10;   // первый котёл — до любой экзотики: cruise 81→95+
        }
        if (mod.id === 'boiler' && run.player.tier >= 4 && !p.modules.some(x => x.mod.id === 'boiler')) s = Math.max(s, 165);   // T4+: двигатель или смерть (v81 не поднимется из спавн-мили никогда)
        const isGun = power > 0 && reach > 0;
        const haveWorkshop = p.modules.some(m => m.mod && m.mod.id === 'workshop');
        const haveBoiler = p.modules.some(m => m.mod && m.mod.id === 'boiler');
        // The tier-5 draft is the LAST pick: it finishes the build, it does not start one. With
        // the range piece already drafted (a gun over the boss's mortar line), the engine room
        // beats another gun: boiler lifts cruise past the enemy 94 (the chase problem dies),
        // workshop turns every standoff into an attrition we win.
        if (run.player.tier >= 5 && myTop >= need + 60) {
            if (mod.id === 'boiler' && !haveBoiler) s += 30;
            if (mod.id === 'workshop' && !haveWorkshop) s += 26;
        }
        // The furnace trap: its 1 hp/s burn re-arms regenDelay every tick, so HULL_REGEN (10/s)
        // never runs — without a workshop the hull has NO regeneration at all, and the late-game
        // war of attrition is unwinnable. With a workshop it is pure +26% dps.
        if (mod.id === 'furnace') s = haveWorkshop ? 92 : 38;
        if (mod.id === 'workshop') s += run.regionIndex * 14;         // attrition insurance
        // The nest is the band itself: without one, a mortar-warden (floor 813) out-reaches every
        // gun we can draft and every fight becomes a lost knife race (trace 59675: myTop 739).
        // гнездо: на T2-T3 — 100 (ранняя полоса не кормит: варденов бьёт бортовой dps,
        // трейсы 83432/59675: nest/spire-рань без котла = v81 и смерть в r0-r1); с T4 — 126.
        if (mod.id === 'nest') {
            const haveMortar = p.modules.some(x => x.mod.id === 'mortar');
            s = bandOk ? 56 : (run.player.tier >= 4 ? (haveMortar ? 158 : 126) : 100);
        }
        // Арканный Парус — двигатель королевской доктрины: sail1 с Серафиной (+30%) и
        // fast_boiler (+25%) даёт реген 42.8/s ≥ дренажа 34/s — буст перестаёт быть ресурсом
        // (duty ~56% → средняя 129-142 px/s против hunt 84 у Венца): подъём из спавн-мили
        // и удержание кольца становятся физикой, а не удачей. Плюс −15% к цене рероллов.
        if (mod.id === 'sail') {
            const haveB = p.modules.some(x => x.mod.id === 'boiler');
            s = Math.max(s, run.regionIndex >= 2 ? 118
                : (run.regionIndex >= 1 || p.tier >= 4) ? (haveB ? 104 : 88)
                : (haveB ? 84 : 56));
            // T4+ без двигателя — смертный приговор под Венцом (v81: подъём из спавн-мили
            // математически невозможен, трейс 170541 батча8: 13 s, dAvg 356, inDps 228).
            if (run.player.tier >= 4 && !haveB) s = Math.max(s, 160);   // выше nest(158)/mortar(162 почти): сначала двигатель
        }
        if (mod.id === 'mortar') s = bandOk ? 110 : (run.player.tier >= 4 && p.modules.some(x => x.mod.id === 'nest') ? 158 : 122);
        if (bandOk) {
            if (mod.id === 'culverin') s = 92;                        // a second long gun is pure dps
        } else {
            if (reach >= need + 60) s += 18;                          // a gun that over-reaches the boss
            // The band is NOT built: a gun in hand beats a trinket. Junk passives lost runs
            // (reliquary+ram+workshop versus a double-tesla warden: no gun reached past 505).
            if (isGun && mod.id !== 'gatling' && mod.id !== 'flame') s += 22;
            if (!isGun && !['boiler', 'workshop', 'masonry', 'plate', 'furnace', 'nest', 'sail'].includes(mod.id)) s -= 14;
            if (guns.length < 2 && isGun) s += 14;                    // a hull with one gun is a cart
        }
        if (hurt && (mod.id === 'masonry' || mod.id === 'plate' || mod.id === 'workshop')) s += 22;
        if (run.regionIndex >= 1 && (mod.id === 'gatling' || mod.id === 'flame' || mod.id === 'ram')) s -= 12;
        return s;
    }
    return 1;
}

// Take the draft — or reroll the whole offer while the mass allows. Before tier 5 mass IS the
// tier clock, so early rerolls only spend genuine surplus; the tier-5 draft rerolls freely.
// T5 rerolls are free (mass is capped at the tier) and the hand is the LAST pick of the run:
// hunt the keystone (a mortar, a long-gun upgrade, a second nest) instead of settling for 80.
const REROLL_WORTH_LATE = 125;
function handleDraft(run) {
    if (run.__draftSeen !== run.draftPending) { run.__draftSeen = run.draftPending; run.__rr = 0; }
    run.__draftLog = run.__draftLog || [];
    const name = (c) => c.kind + ':' + c.id + (c.level ? 'L' + c.level : '');
    const offer = run.draftPending.cards.map(name).join(' ');
    let guard = 0;
    while (run.draftPending && guard++ < 22) {
        const cards = run.draftPending.cards;
        let bi = 0, bs = -1;
        cards.forEach((c, i) => { const s = scoreCard(run, c); if (s > bs) { bs = s; bi = i; } });
        const late = run.player.tier >= 5;
        // Полоса к Crown: mortar+nest дают myTop ~1004 (единственная дистанция, где Железный
        // Венец не достаёт ничем). На T4 небанд-карта (баллиста 92) БОЛЬШЕ не повод перестать
        // крутить: трейс 194298 взял на T4 баллисту вместо охоты за гнездом → myTop 851 <
        // soft 870 → гонка на 470 px и смерть в 25 s. Бесплатный реролл на охоту дешевле.
        const gunsNow = gunsOf(run.player, run.player.stats);
        const bandNow = gunsNow.length > 0 && Math.max(...gunsNow.map(g => g.reach)) >= 960;
        const worth = late ? REROLL_WORTH_LATE : run.player.tier >= 4 ? (bandNow ? 58 : 100) : 45;
        const cost = run.rerollCost();
        const surplus = late ? run.player.mass - cost * 2 : run.player.mass - WB.tierMass(run.player.tier + 1);
        const rrCap = late ? 14 : 2;
        if (bs < worth && run.__rr < rrCap && (run.rerollsLeft > 0 || surplus > cost + (late ? 40 : 120))) {
            run.__rr++;
            run.takeDraft('reroll');
            continue;
        }
        const taken = run.takeDraft(bi);   // 0-based like every caller of takeDraft
        run.__draftLog.push('T' + run.player.tier + ' [' + offer + '] rr=' + run.__rr +
            ' -> ' + (taken ? name(taken) : '?') + ' (' + Math.round(bs) + ')');
        break;
    }
    if (run.draftPending) run.takeDraft(0);   // never stall the run on a draft
}

// --- the driver --------------------------------------------------------------------------------
let committed = null;
function drive(run) {
    const p = run.player, r = run.region;
    if (!p || !p.alive) return { throttle: 0, steer: 0, boost: false };
    const dCenter = Math.hypot(p.x - r.cx, p.y - r.cy);
    const boss = run.boss && run.boss.alive ? run.boss : null;
    const threat = run.threat(900);
    const armed = p.tier >= 3 && p.modules.length >= 4;
    const caution = 0.5 + Math.min(0.3, run.regionIndex * 0.1);
    // A fresh valley is for eating, not duelling: region 2+ fortresses hit ~1.9x, and walking in
    // at 80% hull straight into a patrol is how the region-2 entries died. 25 s of farming first.
    const fresh = (run.time - (run.__regionAt || 0)) < 25 && run.regionIndex >= 1;
    // The warden spawns on gate contact: the gate is only worth touching with a finished build
    // or an empty valley. Tier 5 IS the finished build — drafts only come on tier-ups, so past
    // T5 no further modules will ever arrive, and waiting for a sixth slot waits forever.
    // The mass watchdog catches the other stall: the last villages flee at hull speed, and a
    // driver chasing an uncatchable herd for 90 s starves — better take the boss on a full hull.
    if (run.__massAt == null) { run.__massAt = run.totals.mass; run.__massT = run.time; }
    if (run.totals.mass !== run.__massAt) { run.__massAt = run.totals.mass; run.__massT = run.time; }
    const starving = run.time - (run.__massT || 0) > 120;
    const foodLeft = r.entities.filter(e => !e.dead &&
        (e.type === 'village' || e.type === 'node' || e.type === 'herd' || e.type === 'wagon')).length;
    const buildReady = p.tier >= 5 || starving;
    const goNow = r.gate.open && (buildReady || foodLeft <= 2);
    // The gate may be touched ONLY through the entry window: build ready (or valley empty) AND
    // the last fortress dead (a warden+fortress 1-vs-2 at the courtyard is unwinnable) — every
    // other course near the gate is bent away by gateGuard.
    const liveFortsTop = r.castles.filter(c => c.alive && c.kind === 'fortress' && c.faction !== p.faction);
    // Игра открывает врата при GATE_FORTRESSES=1 — седьмая осада не обязательна. Оставленная
    // крепость ДОЛЬШЕ 1150 от врат не дотягивается до боя с боссом (bandOf.coll это учитывает),
    // а пропущенная осада экономит 500-1500 hp и 40-90 s — это весь бюджет подъёма из
    // спавн-мили Венца. Риск: 1-вр-2 у ворот — поэтому только дальняя и только при armed-билде.
    const gateKeep = liveFortsTop.length <= Math.min(WB.num('GATE_FORTRESSES', 2), Math.max(1, (r.fortressesTotal || 4) - 1)) &&
        liveFortsTop.every(c => r.gate && WB.M.dist(c.x, c.y, r.gate.x, r.gate.y) > 1150);
    run.__gateArmed = goNow && (liveFortsTop.length === 0 || gateKeep || !armed);
    // With the gate open and no warden up yet, the OBJECTIVE beats duels: a knight camping the
    // courtyard used to hold the driver in a forever-duel while the gate waited ten metres away.
    const gateFirst = goNow && !run.bossActive;

    // 1) the warden / the Iron Crown: the band fight, charge dodges and patch windows
    if (boss) return fightCastle(run, boss, true);

    // 1.5) 1-vs-2 is how region-0 runs died (six simultaneous ball volleys = overlapping fortress
    //      pockets): with two or more hunters no duel is worth it — full disengage on steam
    //      until only one is left. Fortress hunt states expire (8 s / leash), so this ends.
    const huntList = r.castles.filter(c => c.alive && c !== p && c.faction !== p.faction &&
        c.ai && c.ai.state === 'hunt' && WB.M.dist(p.x, p.y, c.x, c.y) < 950);
    if (huntList.length >= 2) {
        run.__why = 'disengage n=' + huntList.length;
        run.__duel = null;
        return steerToDir(p, dodge(run, escapeDir(run, huntList)), p.steam > 20);
    }

    // 2) a hunting fortress: band fight when armed; when gateFirst only if it blocks the gate
    let hunterFoe = threat.near;
    if (run.__duel && run.__duel.alive && run.__duel !== hunterFoe && run.__duel.ai &&
        run.__duel.ai.state === 'hunt' && WB.M.dist(p.x, p.y, run.__duel.x, run.__duel.y) < 950) {
        hunterFoe = run.__duel;                                    // finish the duel we started
    }
    const hunterDist = hunterFoe ? WB.M.dist(p.x, p.y, hunterFoe.x, hunterFoe.y) : 1e9;
    const hunter = hunterFoe && hunterDist < (fresh ? 380 : (armed ? 780 : 620));
    // While holding for the boss patch, only defend against what is genuinely close — a duel at
    // 800 px drags the hull around the courtyard and ends in an accidental gate touch.
    const patchHold = goNow && !run.bossActive && p.hp < p.maxHp * 0.97 && (run.__gatePatch || 0) < 60;
    if (hunter && !patchHold && (!gateFirst || hunterDist < 260 || p.hp < p.maxHp * caution)) {
        run.__duel = hunterFoe;
        if (!armed && hunterDist < 460) {
            // Flee toward the OPEN valley, not into the mountain: a rim-pinned hull is a dead hull.
            let ax = p.x - hunterFoe.x, ay = p.y - hunterFoe.y;
            const an = Math.hypot(ax, ay) || 1; ax /= an; ay /= an;
            const dC = Math.hypot(p.x - r.cx, p.y - r.cy);
            if (dC > r.regionR * 0.58) {
                const w = WB.M.clamp((dC - r.regionR * 0.58) / (r.regionR * 0.22), 0, 1);
                const inx = (r.cx - p.x) / (dC || 1), iny = (r.cy - p.y) / (dC || 1);
                ax = ax * (1 - w) + inx * w * 1.4; ay = ay * (1 - w) + iny * w * 1.4;
            }
            run.__why = 'flee d=' + Math.round(hunterDist);
            return steerToDir(p, dodge(run, Math.atan2(ay, ax)), p.steam > 30);
        }
        return fightCastle(run, hunterFoe, false);
    }
    if (!hunter) run.__duel = null;

    // 2.5) taking fire without a duel: enemy castles shoot from their AI-state-independent gun
    //      reach (a region-2 fortress outranges 870 px while merely rolling to eat a village).
    //      ONE shooter: slide out of its reach. TWO+: commit to a full disengage for 2.5 s —
    //      half-hearted repositioning between overlapping pockets bled 2400 hp in 38 s in the
    //      Crown valley (trace 75513) while the objective kept pulling the hull back in.
    if (p.regenDelay > 0.5 && !(p.stats && p.stats.burn > 0) && !boss && !hunter) {
        const shooters = r.castles.filter(c => c.alive && c !== p && c.faction !== p.faction &&
            WB.M.dist(p.x, p.y, c.x, c.y) < maxReachOf(c, run.scale) + 220);
        if (shooters.length >= 2 || (shooters.length === 1 && p.hp < p.maxHp * 0.6)) {
            if (shooters.length >= 2) run.__disUntil = run.time + 2.5;
            run.__why = 'reposition n=' + shooters.length;
            committed = null;                                       // drop the siege target: survive first
            return steerToDir(p, dodge(run, escapeDir(run, shooters), 0.45), p.steam > 40);
        }
        if (shooters.length) {
            run.__why = 'reposition n=1';
            return steerToDir(p, dodge(run, escapeDir(run, shooters), 0.45), p.steam > 55);
        }
    }
    if (run.__disUntil && run.time < run.__disUntil && !boss) {
        // committed disengage: no objectives, no duels — just out, until the commit expires
        const shooters = r.castles.filter(c => c.alive && c !== p && c.faction !== p.faction &&
            WB.M.dist(p.x, p.y, c.x, c.y) < maxReachOf(c, run.scale) + 260);
        if (shooters.length) {
            run.__why = 'DISENGAGE n=' + shooters.length;
            return steerToDir(p, dodge(run, escapeDir(run, shooters), 0.45), p.steam > 30);
        }
        run.__disUntil = 0;
    }

    // 3) the mountain ring & stalled hulls: the rim is a slope trap — heading straight up it nets
    //    negative acceleration (trace: a hull pinned at dC=856, v≈3, for 600 s "driving" to the
    //    gate). Ride the CONTOUR — tangentially, committed for a second at a time — until back on
    //    the valley floor. The stall guard sends slope-pinned hulls inside the valley here too.
    const moved = WB.M.dist(p.x, p.y, run.__lastX == null ? p.x : run.__lastX, run.__lastY == null ? p.y : run.__lastY);
    run.__lastX = p.x; run.__lastY = p.y;
    if (!boss && !hunter) {
        if (moved < 0.55) run.__stallT = (run.__stallT || 0) + 1 / 60;
        else run.__stallT = 0;
        if (run.__stallT > 1.1) { run.__breakUntil = run.time + 2.5; run.__stallT = 0; }
    }
    if (dCenter > r.regionR * 0.80 || (run.__breakUntil && run.time < run.__breakUntil)) {
        const radial = Math.atan2(p.y - r.cy, p.x - r.cx);
        const hands = [radial + Math.PI / 2, radial - Math.PI / 2];
        const cost = (a) => {
            const ex = p.x + Math.cos(a) * 120, ey = p.y + Math.sin(a) * 120;
            return Math.abs(r.slopeAt(ex, ey, a)) * 3 + Math.hypot(ex - r.cx, ey - r.cy) / r.regionR;
        };
        run.__rimT = (run.__rimT || 0) - 1 / 60;
        if (run.__rimT <= 0 || run.__rimA == null) {
            run.__rimT = 2.0;
            const c0 = cost(hands[0]), c1 = cost(hands[1]);
            if (run.__side == null) run.__side = c0 <= c1 ? 0 : 1;
            else if (run.__side === 0 && c1 < c0 - 0.3) run.__side = 1;
            else if (run.__side === 1 && c0 < c1 - 0.3) run.__side = 0;
            // a shallow lean: 0.6 rad pointed the hull up-slope on the steep rings (frost amp 58)
            // and it ground to v≈1 for 15 s at a time; 0.35 keeps the contour actually ridable.
            run.__rimA = hands[run.__side] + (run.__side === 0 ? 0.35 : -0.35);
        }
        const d = WB.M.angleDelta(p.heading, run.__rimA);
        run.__why = 'contour d=' + Math.round(dCenter);
        return { throttle: 1, steer: WB.M.clamp(d * 2.1, -1, 1), boost: false };
    }

    // 4) the objective: the LAST FORTRESS first (never fight the warden and a fortress at the
    //    same time — trace: boss + two bombardiers = six-ball volleys at the gate), then the
    //    gate. A fortress we choose to kill gets the same band treatment — out-range, never brawl.
    if (run.__gateArmed) {
        const g = r.gate;
        const dg = WB.M.dist(p.x, p.y, g.x, g.y);
        // A warden fight entered at half hull is a lost warden fight (trace: bossSpawn at 44 s
        // with hp=114/1301 — dead in 25 s). Hover out of the courtyard and let the crew patch
        // first — CAPPED at 40 s: an entry window that stalls is its own dead end.
        const hpFrac = p.hp / p.maxHp;
        if (hpFrac >= 0.7) run.__gatePatch = 0;
        else run.__gatePatch = (run.__gatePatch || 0) + 1 / 60;
        if (!run.bossActive && hpFrac < 0.97 && run.__gatePatch < 60) {
            // Hold on the RIM side of the gate: after the touch-through the escape runway is
            // whatever lies AHEAD of our momentum. Rim-side hover → the dash crosses the gate
            // toward the CENTRE → runway = the full diameter (в долине Венца 190+702 ≈ 890 px);
            // центр-сторона выбрасывала корпус на короткий рим-поводок 300-500 px, где сэмплер
            // ухода вырождается в тангенциальную спираль и босс заходит пешком (батчи 10-11:
            // подъёмы Венца 6-34 s, inDps 91-471 при том же билде, что в батче7 дрался 100 s).
            const gOut2 = Math.atan2(g.y - r.cy, g.x - r.cx);
            const hx = g.x + Math.cos(gOut2) * 470, hy = g.y + Math.sin(gOut2) * 470;
            const dH = WB.M.dist(p.x, p.y, hx, hy);
            const toH = Math.atan2(hy - p.y, hx - p.x);
            const corr = WB.M.clamp((dH - 60) / 120, -1, 1);
            const tang = toH + Math.PI / 2 * (run.__orbitSide || 1);
            let ux = Math.cos(tang) * 0.55 + Math.cos(toH) * corr;
            let uy = Math.sin(tang) * 0.55 + Math.sin(toH) * corr;
            const spd = Math.max(140, Math.hypot(p.vx || 0, p.vy || 0));
            const un = Math.hypot(ux, uy) || 1;
            const dN = Math.hypot(p.x + (ux / un) * spd - r.cx, p.y + (uy / un) * spd - r.cy);
            if (dN > r.regionR * 0.74) {
                const w = WB.M.clamp((dN - r.regionR * 0.74) / (r.regionR * 0.14), 0, 1) * 2.6;
                const inw = Math.atan2(r.cy - p.y, r.cx - p.x);
                ux += Math.cos(inw) * w; uy += Math.sin(inw) * w;
            }
            run.__why = 'gatePatch d=' + Math.round(dg) + ' hp=' + Math.round(hpFrac * 100) + '%';
            return steerToDir(p, dodge(run, Math.atan2(uy, ux)), false);
        }
        run.__why = 'gate d=' + Math.round(dg);
        // Aim at the gate ITSELF: devour needs contact (d ≤ r + 46 + 4 ≈ 152), and a point 260 px
        // past the gate turned the dash into a 200-500 s loiter in front of it (the marathon
        // runs: gate d=215-331 at full hp, region waiting). The boost pass carries the hull
        // through contact and out the other side — that overshoot IS the spawn runway.
        // Runway = what lies AHEAD of the momentum: from the RIM side the pass-through carries
        // us across the full diameter (~890 px in the Crown valley); a centre-side touch dumps
        // the escape onto the 300-500 px rim leash with the tangential-spiral trap at its end.
        // So detour to the rim-side approach point whenever we sit between the gate and centre.
        const gOutv = Math.atan2(g.y - r.cy, g.x - r.cx);
        const ax = g.x + Math.cos(gOutv) * 470, ay = g.y + Math.sin(gOutv) * 470;
        const onCentreSide = (p.x - g.x) * Math.cos(gOutv) + (p.y - g.y) * Math.sin(gOutv) < -60;
        const dApp = WB.M.dist(p.x, p.y, ax, ay);
        if (onCentreSide && dApp > 130) {
            run.__why = 'gate detour d=' + Math.round(dg);
            return steerToDir(p, dodge(run, Math.atan2(ay - p.y, ax - p.x)), p.steam > 60);
        }
        const a = Math.atan2(g.y - p.y, g.x - p.x);
        return steerToDir(p, a, dg < 520 && p.steam > 15);
    }
    if (armed) {
        if (!(committed && committed.alive && committed.kind === 'fortress')) {
            // Isolation beats weakness: in the Crown valley eight L3 mortars overlap, and a duel
            // inside the pack is a volley festival. The target with the fewest friends within
            // earshot dies first — the collective floor (and the incoming) stays halved.
            let weak = 1e9; committed = null;
            for (const c of r.castles) {
                if (!c.alive || c.kind !== 'fortress') continue;
                let near = 0;
                for (const o of r.castles) {
                    if (o === c || !o.alive || o.faction === p.faction || o.kind !== 'fortress') continue;
                    if (WB.M.dist(c.x, c.y, o.x, o.y) < 1150) near++;
                }
                const dGate = r.gate ? WB.M.dist(c.x, c.y, r.gate.x, r.gate.y) : 0;
                const w = c.hp + near * 700 - dpsOf(c) * 2 - dGate * 0.35;
                if (w < weak) { weak = w; committed = c; }
            }
        }
        if (committed && committed.alive) {
            const dF = WB.M.dist(p.x, p.y, committed.x, committed.y);
            const bF = bandOf(run, p, committed);
            // Sieges are won with a full hull: a fortress does not heal fast between visits, we
            // do not get cheaper. Patch first (out of every gun's reach), then execute — but only
            // while patching WORKS: a furnace burns the hull every tick, which keeps regenDelay
            // pinned and blocks HULL_REGEN entirely; without a workshop there is nothing to wait
            // for, and the hover becomes an infinite loop. Capped at 45 s regardless.
            run.__siegePatchT = p.hp < p.maxHp * 0.85 ? (run.__siegePatchT || 0) + 1 / 60 : 0;
            const canPatch = (p.stats.repair || 0) > 0.5 || (p.stats.burn || 0) <= 0;
            if (p.hp < p.maxHp * 0.85 && canPatch && run.__siegePatchT < 90 &&
                dF < maxReachOf(committed, run.scale) + 400) {
                run.__why = 'patchBeforeSiege hp=' + Math.round(p.hp / p.maxHp * 100) + '%';
                const shooters = r.castles.filter(c => c.alive && c !== p && c.faction !== p.faction &&
                    WB.M.dist(p.x, p.y, c.x, c.y) < maxReachOf(c, run.scale) + 220);
                return steerToDir(p, dodge(run, gateGuard(run, escapeDir(run, shooters.length ? shooters : [committed]))), false);
            }
            if (dF < Math.max(bF.dCeil + 120, bF.desired + 160)) return fightCastle(run, committed, false);
            run.__why = 'toFortress d=' + Math.round(dF);
            const lead = dF / 220;
            const a = Math.atan2(committed.y + (committed.vy || 0) * lead - p.y, committed.x + (committed.vx || 0) * lead - p.x);
            return steerToDir(p, dodge(run, gateGuard(run, a)), dF > 420 && p.steam > 55);
        }
    }

    // 5) the hurt hull with nobody hunting: open ground, let the crew patch while we reposition.
    if (p.hp < p.maxHp * 0.3) {
        const inw = Math.atan2(r.cy - p.y, r.cx - p.x);
        run.__why = 'patch d=' + Math.round(dCenter);
        return steerToDir(p, dCenter > r.regionR * 0.5 ? inw : inw + 1.2, false);
    }

    // 6) farm where the enemy hulls CANNOT SHOOT: enemy castles fire from their gun reach
    //    regardless of AI state, so "safe food" is food outside every foe's reach + margin
    //    (the flat 520 px pocket was sized for region-0 bombard reach — a region-2 fortress
    //    out-reaches it by 300 px and chewed the hull through every "safe" village meal).
    let target = null, best = -1;
    const foes = r.castles.filter(c => c.alive && c.faction !== p.faction);
    const foeGap = (e) => {
        let g = 1e9;
        for (const c of foes) g = Math.min(g, WB.M.dist(e.x, e.y, c.x, c.y) - maxReachOf(c, run.scale));
        return g;
    };
    for (const e of r.entities) {
        if (e.dead) continue;
        if (e.type !== 'village' && e.type !== 'node' && e.type !== 'chunk' && e.type !== 'herd' && e.type !== 'wagon') continue;
        let d = WB.M.dist(p.x, p.y, e.x, e.y) * (e.type === 'chunk' ? 0.5 : 1);
        const gap = foeGap(e);
        if (gap < 160 && e.type !== 'chunk') d += (160 - gap) * 2.5;
        if (best < 0 || d < best) { best = d; target = e; }
    }
    if (!target) target = r.gate || p;
    run.__why = (target === r.gate ? 'gate' : target.type || target.kind || '?') + ' d=' + Math.round(WB.M.dist(p.x, p.y, target.x || 0, target.y || 0));
    const lead = target.vx || target.vy ? WB.M.dist(p.x, p.y, target.x, target.y) / 220 : 0;
    const a = Math.atan2((target.y || 0) + (target.vy || 0) * lead - p.y, (target.x || 0) + (target.vx || 0) * lead - p.x);
    return steerToDir(p, a, best > 320 && p.steam > 55);
}

/** Close out the current fight telemetry (called when the boss dies AND when the run ends). */
function flushFight(run, fightStats) {
    const F = run.__fight;
    if (!F || !F.log) { run.__fight = null; return; }
    fightStats.push({
        region: run.regionIndex, t: Math.round(F.t), dAvg: Math.round(F.dSum / Math.max(1, F.n)),
        rim: Math.round(F.rimT), lowV: Math.round(F.lowVT),
        myDps: Math.round((F.b0 - (F.log.alive ? F.log.hp : 0)) / Math.max(1, F.t)),
        inDps: Math.round((F.hp0 - run.player.hp) / Math.max(1, F.t)),
        bossHp: Math.round(F.log.alive ? F.log.hp : 0), won: !F.log.alive,
        guns: F.log.modules.filter(m => m.mod.power).map(m => m.mod.id).join('+')
    });
    run.__fight = null;
}

// --- play ---------------------------------------------------------------------------------------
let wins = 0;
const table = [];
const r0 = (run) => run.region;
for (let n = 0; n < runs; n++) {
    const seed = seed0 + n * 7919;
    committed = null;
    const chassis = (legacy.includes('ch_' + chassisId) && WB.CHASSIS.find(c => c.id === chassisId)) || WB.CHASSIS[0];
    const captain = (legacy.includes('cap_' + captainId) && WB.CAPTAINS.find(c => c.id === captainId)) || WB.CAPTAINS[0];
    const run = new WB.Run({ seed, region: 0, legacy, meta: WB.Save.meta, chassis, captain });
    const t0 = Date.now();
    let frames = 0;
    const fightStats = [];
    run.__fight = null;
    const log = [];
    const tierAt = [];
    let lastTier = run.player.tier;
    let lastHp = run.player.hp, deathCauses = [];
    while (!run.over && frames < 60 * 60 * 60) {
        run.update(1 / 60, drive(run));
        frames++;
        // what actually kills us: the events of the frames where the hull lost hp
        if (run.player.hp < lastHp - 0.01) {
            const src = run.events.filter(e => e.source || e.kind).map(e => (e.kind || e.source || e.type));
            deathCauses.push(src.join('+') || 'unknown');
            if (deathCauses.length > 40) deathCauses.shift();
        }
        lastHp = run.player.hp;
        if (run.player.tier !== lastTier) { tierAt.push('T' + run.player.tier + '@' + Math.round(run.time) + 's'); lastTier = run.player.tier; }
        // --- fight telemetry: per-boss aggregates (stance, effective dps both ways) ---
        const bossNow = run.boss && run.boss.alive ? run.boss : null;
        if (bossNow) {
            const F = run.__fight || (run.__fight = { t: 0, dSum: 0, n: 0, hp0: 0, b0: 0, rimT: 0, lowVT: 0, log: null });
            if (!F.log) { F.log = bossNow; F.t = 0; F.dSum = 0; F.n = 0; F.hp0 = run.player.hp; F.b0 = bossNow.hp; }
            F.t += 1 / 60; F.n++;
            F.dSum += WB.M.dist(run.player.x, run.player.y, bossNow.x, bossNow.y);
            if (Math.hypot(run.player.x - run.region.cx, run.player.y - run.region.cy) > run.region.regionR * 0.74) F.rimT += 1 / 60;
            if (Math.hypot(run.player.vx, run.player.vy) < 50) F.lowVT += 1 / 60;
        } else if (run.__fight && run.__fight.log) {
            flushFight(run, fightStats);
        }
        for (const ev of run.events) {
            if (['fortressDown', 'gateOpen', 'bossSpawn', 'bossDown', 'playerDown', 'regionClear'].includes(ev.type)) {
                log.push(Math.round(run.time) + 's ' + ev.type + (ev.left != null ? ':' + ev.left : ''));
                if (ev.type === 'bossSpawn' && run.boss) {
                    const gs = gunsOf(run.boss, run.boss.estats || WB.enemyStats(run.boss, run.scale));
                    const th = threatFloor(run.boss, run.player.stats.speed, run.boss.estats);
                    log.push('(boss guns ' + gs.map(g => g.id + g.level + ':' + Math.round(g.reach)).join(' ') +
                        ' floor inst=' + Math.round(th.inst) + ' soft=' + Math.round(th.soft) + ')');
                }
                if (ev.type === 'bossDown' || ev.type === 'playerDown') {
                    log.push('(build ' + run.player.modules.map(m => m.mod.id + m.level).join(',') + ')');
                }
            }
        }
        if (run.draftPending) handleDraft(run);
        if (run.regionCleared) { log.push(Math.round(run.time) + 's ->R' + (run.regionIndex + 1)); run.nextRegion(); committed = null; run.__regionAt = run.time; run.__orbitSide = 1; }
        if (process.env.TRACE && frames % (Number(process.env.TRACE_EVERY) || 1200) === 0) {
            const p = run.player;
            const b = run.__band;
            console.log('   t=' + Math.round(run.time) + 's ' + (run.__why || '-') +
                ' hp=' + Math.round(p.hp) + '/' + p.maxHp + ' v=' + Math.round(Math.hypot(p.vx || 0, p.vy || 0)) +
                ' dC=' + Math.round(Math.hypot(p.x - run.region.cx, p.y - run.region.cy)) +
                ' gate=' + (run.region.gate.open ? 'open' : 'shut') +
                ' boss=' + (run.bossActive ? (run.boss ? Math.round(run.boss.hp) + '/' + Math.round(run.boss.maxHp) : 'yes') : 'no') +
                ' forts=' + run.fortressesLeft + (b ? ' rng=' + Math.round(p.stats.range * 100) / 100 : '') +
                ' stm=' + Math.round(p.steam || 0) + (p.stun > 0 ? ' STUN' : '') + (p.boost ? ' bst' : ''));
        }
    }
    if (!run.won && process.env.TRACE) {
        console.log('   last events: ' + run.events.slice(-8).map(e => e.type + (e.source ? '/' + e.source : '') + (e.kind ? '/' + e.kind : '')).join(' '));
        console.log('   end: hp=' + Math.round(run.player.hp) + ' dC=' + Math.round(Math.hypot(run.player.x - r0(run).cx, run.player.y - r0(run).cy)) + ' why=' + run.__why);
    }
    flushFight(run, fightStats);
    if (!run.won) console.log('   смерть: ' + (run.__why || '?') + ' hp=' + Math.round(run.player.hp) + ' t=' + Math.round(run.time) + 's');
    const s = run.summary();
    if (run.won) wins++;
    table.push([seed, run.won, run.regionIndex, s.tier, s.kills, Math.round(run.time), Date.now() - t0, s.modules.map(m => m.id + m.level).join(',')]);
    console.log('seed ' + seed + ' | ' + (run.won ? 'ПОБЕДА' : 'поражение') + ' | регион ' + run.regionIndex +
        ' | tier ' + s.tier + ' | kills ' + s.kills + ' | ' + Math.round(run.time) + 's sim / ' + (Date.now() - t0) + 'ms wall | ' + chassisId + '+' + captainId);
    console.log('   ' + tierAt.join(' ') + ' | ' + log.join(' '));
    if (run.__draftLog && run.__draftLog.length) console.log('   drafts: ' + run.__draftLog.join(' | '));
    for (const f of fightStats) {
        console.log('   fight r' + f.region + (f.won ? ' WON ' : ' LOST') + ' in ' + f.t + 's [' + f.guns + '] dAvg=' + f.dAvg +
            ' rim=' + f.rim + 's lowV=' + f.lowV + 's myDps=' + f.myDps + ' inDps=' + f.inDps + ' bossLeft=' + f.bossHp);
    }
    if (!run.won && deathCauses.length) {
        const tally = {};
        for (const c of deathCauses) tally[c] = (tally[c] || 0) + 1;
        console.log('   урон: ' + Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + '×' + v).join(', '));
    }
}
console.log('\n  итог: ' + wins + ' побед из ' + runs);
for (const [seed, won, region, tier, kills, t, ms, mods] of table) {
    console.log('  ' + (won ? '\x1b[32mWIN \x1b[0m' : '\x1b[31mloss\x1b[0m') + ' seed ' + seed + ' region ' + region + ' tier ' + tier + ' kills ' + kills + ' ' + t + 's (' + ms + 'ms) ' + mods);
}
process.exit(wins ? 0 : 1);
