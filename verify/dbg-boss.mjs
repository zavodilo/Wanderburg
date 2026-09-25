// Isolated boss-fight lab: same build/boss as the winrun traces, parameterized standoff.
// node verify/dbg-boss.mjs [standoff] [region] [seed]
import { loadScripts } from '../tests/browser-scripts.mjs';

const store = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const page = loadScripts(['js/Constants.js', 'libs/simplex-noise.js', 'js/Content.js', 'js/Logic.js'], { localStorage: store });
const WB = page.get('WB');
WB.Save.load();

const STANDOFF = Number(process.argv[2] || 620);
const REGION = Number(process.argv[3] || 0);
const SEED = Number(process.argv[4] || 59675);
const LEG = ['ch_dreadnought', 'cap_seraphine', 'mod_mortar', 'mod_nest', 'mod_tesla', 'mod_hive', 'mod_reliquary',
    'mod_furnace', 'mod_keg', 'mod_banner', 'mod_sail', 'mod_flame', 'extra_card', 'extra_reroll', 'second_wind',
    'tier_repair', 'long_shot', 'thick_walls', 'scavenger', 'fast_boiler'];

const run = new WB.Run({
    seed: SEED, region: REGION, legacy: LEG, meta: WB.Save.meta,
    chassis: WB.CHASSIS.find(c => c.id === 'dreadnought'), captain: WB.CAPTAINS.find(c => c.id === 'seraphine')
});
const p = run.player;
// the exact build of the losing traces
p.tier = 5; p.r = WB.tierRadius(5); p.slots = 10;
p.modules.length = 0;
const BUILD = (process.argv[5] || 'culverin1,plate1,mortar1,nest1,boiler2').split(',').map(s => [s.replace(/\d+$/, ''), Number(s.match(/\d+$/) || 1)]);
for (const [id, lvl] of BUILD) {
    p.modules.push({ mod: WB.moduleById(id), level: lvl, slot: 0, aim: 0, cd: 0, mount: null });
}
p.modules.forEach((m, i) => { m.slot = i; });
WB.recompute(p);
p.hp = p.maxHp; p.steam = p.stats.steamMax;

// spawn the warden at the gate, hull AT SPAWN CONTACT (devour-триггер ~152) — так бой
// начинается в настоящем прогоне: подъём из-под всех стволов, а не «уже на 300».
run.startBoss();
run.grace = 0;   // в настоящем бою врата трогают задолго после grace
const boss = run.boss;
const gOut = Math.atan2(run.region.gate.y - run.region.cy, run.region.gate.x - run.region.cx);
const START_D = Number(process.env.START_D || 145);
p.x = boss.x - Math.cos(gOut) * START_D; p.y = boss.y - Math.sin(gOut) * START_D;   // между вратами и центром
p.heading = Math.atan2(p.y - boss.y, p.x - boss.x);
// Реальный дэш касается врат НА СКОРОСТИ: стартуем с буст-равновесием наружу (к центру долины).
p.vx = -Math.cos(gOut) * 170; p.vy = -Math.sin(gOut) * 170;
p.steam = p.stats.steamMax;
console.log('build v=' + Math.min(p.stats.speed, p.stats.accel / 2.1).toFixed(0),
    'hp=' + p.maxHp, 'bossGuns=' + boss.modules.map(m => m.mod.id + m.level).join(','),
    'bossHp=' + Math.round(boss.hp), 'mortarReach=' + Math.max(...boss.modules.filter(m => m.mod.id === 'mortar').map(m => WB.moduleStat(m.mod, m.level, 'reach')), 0));

const guns = p.modules.filter(m => m.mod.power > 0).map(m => ({
    id: m.mod.id,
    reach: WB.reachOf(p, m.mod, m.level, p.stats),
    dps: WB.moduleStat(m.mod, m.level, 'power') / WB.moduleStat(m.mod, m.level, 'rate'),
    aoe: m.mod.aoe || 0, instant: !!m.mod.instant
}));
console.log('myGuns=' + guns.map(g => g.id + ':' + Math.round(g.reach) + ':' + g.dps.toFixed(1)).join(' '));
const myTop = guns.length ? Math.max(...guns.map(g => g.reach)) : 300;

// босс-стволы: dps с масштабом региона (fire(): dmg × scale × 0.9 для босса) и нашей бронёй
const bossGuns = boss.modules.filter(m => m.mod && m.mod.power > 0).map(m => ({
    id: m.mod.id,
    reach: WB.reachOf(boss, m.mod, m.level, WB.enemyStats(boss, run.scale)),
    dps: WB.moduleStat(m.mod, m.level, 'power') / WB.moduleStat(m.mod, m.level, 'rate') * run.scale * 0.9 * (1 - p.stats.armor),
    dodgeable: !m.mod.instant && !(m.mod.aoe >= 60) && !m.mod.cone
}));
const HARD = Math.max(
    ...bossGuns.filter(g => !g.dodgeable).map(g => g.reach), 0);   //instant/aoe — не уклониться
const HARD_FLOOR = HARD > 0 ? HARD * 1.06 + 30 : 0;

// позиция кольца: максимум (мой dps − входящий) по дистанциям [HARD_FLOOR+40 .. myTop-10]
function ringSpot(enr) {
    const rateMul = 1 + 0.18 * (enr || 0);
    let best = Math.max(HARD_FLOOR + 40, myTop - 60), bestNet = -1e9, bestMy = 0, bestIn = 0;
    for (let cand = HARD_FLOOR + 30; cand <= myTop + 30; cand += 20) {
        const my = guns.reduce((a, g) => a + (g.reach >= cand + 8 ? g.dps : 0), 0);
        const inD = bossGuns.reduce((a, g) => a + (g.reach >= cand ? g.dps * rateMul * (g.dodgeable ? 0.55 : 1) : 0), 0);
        if (my <= 0.1 && cand > myTop) continue;
        const net = my - inD;
        if (net > bestNet + 0.5 || (Math.abs(net - bestNet) <= 0.5 && cand > best && my >= bestMy)) { bestNet = net; best = cand; bestMy = my; bestIn = inD; }
    }
    return { d: best, my: bestMy, in: bestIn };
}
let RING = ringSpot(0);
console.log('ring: d=' + Math.round(RING.d) + ' myDps=' + RING.my.toFixed(1) + ' inDps=' + RING.in.toFixed(1) + ' hardFloor=' + Math.round(HARD_FLOOR) + ' myTop=' + Math.round(myTop));

// пар: sail1+seraphine+fast_boiler = реген 42.8 > дренаж 34 → ВЕЧНЫЙ буст
const INF_STEAM = p.stats.steamRegen >= WB.num('BOOST_DRAIN', 34);
console.log('steamRegen=' + p.stats.steamRegen.toFixed(1) + (INF_STEAM ? ' -> ВЕЧНЫЙ БУСТ' : ' -> циклы 45%'));

function orbitSideFor() {
    const n = Math.max(1, p.modules.length);
    let best = 1, bestVal = -1;
    for (const s of [1, -1]) {
        const rel = s === 1 ? -Math.PI / 2 : Math.PI / 2;
        let val = 0;
        p.modules.forEach((m, i) => {
            if (!m.mod || m.mod.turn || m.mod.behavior !== 'turret') return;
            const power = WB.moduleStat(m.mod, m.level, 'power') || 0;
            if (power <= 0) return;
            const dev = Math.abs(WB.M.angleDelta(WB.SLOT_ANGLE(i, n), rel));
            if (dev <= 75 * Math.PI / 180 - 0.22) val += power;
        });
        if (val > bestVal) { bestVal = val; best = s; }
    }
    return best;
}
let side = orbitSideFor(), escA = null, escT = 0;
// port dodge() из winrun: боковой шаг от снаряда с tti < window (баллистика босса —
// кулеврины/баллисты/бомбарды — уклоняема; AoE/мгновенное — нет)
function dodge(want, window) {
    let best = null, bestT = window || 0.55;
    for (const s of run.projectiles) {
        if (s.faction === p.faction || s.dead) continue;
        const dx = p.x - s.x, dy = p.y - s.y;
        const d = Math.hypot(dx, dy);
        if (d > 260 || d < 1) continue;
        const vx = s.vx || 0, vy = s.vy || 0;
        const sp = Math.hypot(vx, vy);
        if (sp < 40) continue;
        const closing = (vx * -dx + vy * -dy) / (sp * d);
        if (closing < 0.55) continue;
        const t = d / sp;
        if (t < bestT) { bestT = t; best = { dx: dx / d, dy: dy / d, vx: vx / sp, vy: vy / sp }; }
    }
    if (!best) return want;
    const px = -best.vy, py = best.vx;
    const sd = (px * best.dx + py * best.dy) > 0 ? 1 : -1;
    const ex = px * sd, ey = py * sd;
    return Math.atan2(Math.sin(want) * 0.55 + ey * 0.9, Math.cos(want) * 0.55 + ex * 0.9);
}

function corridorRay(away) {
    // Луч ухода: радиальная составляющая + жёсткий запрет внешней зоны (0.70R) + ВНУТРЕННИЙ
    // уклон во внешней половине — побег обязан вести через центр (диагональные пробеги дают
    // максимум отрыва: 122-142 против его 84), а не в кольцевую ловушку у стен, где
    // pure-pursuit садится в 0.55R за спиной (замер: dAvg 356 навсегда).
    const r = run.region;
    const dCnow = Math.hypot(p.x - r.cx, p.y - r.cy);
    const inward = dCnow > r.regionR * 0.62 ? 0.6 : 0;
    let bestA = away, bestSc = -1e9;
    for (const da of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.7, -1.7, 2.2, -2.2, 2.8, -2.8]) {
        const aa = away + da;
        const qx = p.x + Math.cos(aa) * 300, qy = p.y + Math.sin(aa) * 300;
        const dC = Math.hypot(qx - r.cx, qy - r.cy);
        const sc = Math.cos(da) * 60
            - Math.max(0, dC - r.regionR * 0.72) * 3.0
            + inward * (dCnow - dC)
            - Math.abs(da) * 5;
        if (sc > bestSc) { bestSc = sc; bestA = aa; }
    }
    return bestA;
}

function drive() {
    const r = run.region;
    const d = WB.M.dist(p.x, p.y, boss.x, boss.y);
    const toFoe = Math.atan2(boss.y - p.y, boss.x - p.x);
    const ai = boss.ai;
    // заряд: рывок медленный (77 px/s, 91 px) — уклон только когда достижим или мы в стане
    if ((ai.telegraph > 0 || ai.chargeT > 0) && (d <= 280 || p.stun > 0)) {
        const cd = ai.chargeDir;
        const pl = cd + Math.PI / 2, pr = cd - Math.PI / 2;
        const drift = Math.cos(pl) * p.vx + Math.sin(pl) * p.vy;
        const a = (Math.abs(drift) > 25 ? (drift >= 0 ? pl : pr) : (((p.x - boss.x) * Math.sin(cd) - (p.y - boss.y) * Math.cos(cd)) >= 0 ? pl : pr));
        const dh = WB.M.angleDelta(p.heading, a);
        return { throttle: 1, steer: WB.M.clamp(dh * 2.4, -1, 1), boost: p.steam > 12 };
    }
    // цель — точка кольца (пересчёт на enrage: темп его стволов растёт)
    const R = (Math.abs((ai.enrage || 0) - (RING.enr == null ? (RING.enr = 0, 0) : RING.enr)) > 0) ? (RING = ringSpot(ai.enrage || 0), RING.enr = ai.enrage || 0, RING) : RING;
    const target = R.d;
    const err = d - target;
    let a;
    if (err < -40) {
        // КОММИТ луча на 1.2 s: непрерывное переруливание (dodge-отклонения + inward-уклон
        // каждый кадр) уводило курс на 83°+ от луча — тяга выключалась, корпус вставал в
        // спираль «нет курса → нет буста → нет скорости → новый стан» (трейс: bst=n при stm=109,
        // d топчется 380-440). Прямые отрезки бьют виляние: батч-политика с коммитом 1.5 s
        // держала dAvg 470-501 там, где лаба ложилась на 380.
        const away = toFoe + Math.PI;
        run.__escT = (run.__escT || 0) - 1 / 60;
        if (run.__escT <= 0 || run.__escA == null || Math.abs(WB.M.angleDelta(run.__escAway || away, away)) > 1.2) {
            run.__escT = 1.2; run.__escAway = away; run.__escA = corridorRay(away);
        }
        // dodge — только вне глубокой гауптвахты: там каждое уклонение ломает коммит курса,
        // а цена секунды под стволами выше цены одного ядра.
        a = (d < HARD_FLOOR) ? run.__escA : dodge(run.__escA, 0.4);
    } else if (err > 40) {
        a = toFoe;                                  // подходим в кольцо
        const qx = p.x + Math.cos(a) * 200, qy = p.y + Math.sin(a) * 200;
        if (Math.hypot(qx - r.cx, qy - r.cy) > r.regionR * 0.70) a = corridorRay(toFoe + Math.PI);
    } else {
        // удержание: лёгкая тангенциальная (0.25) — pure-pursuit садится в 0.55R за круглящим,
        // но на вечном бусте (160 против 84) ему нас не догнать — тангенциал лишь держит геометрию
        const tang = toFoe + Math.PI / 2 * side;
        const corr = WB.M.clamp(err / 120, -1, 1);
        a = Math.atan2(Math.sin(tang) * 0.25 + Math.sin(toFoe) * corr, Math.cos(tang) * 0.25 + Math.cos(toFoe) * corr);
    }
    // в глубоком подъёме dodge-окно узкое: непрерывные отклонения луча не дают курсу
    // стабилизироваться, а в стане (руль ×0.35) рассогласование >109° выключает тягу —
    // спираль «нет курса → нет буста → нет скорости → новый стан» (трейс 59675: bst=n при stm=123).
    const deepClimb = err < -200;
    // окно 0.45 в подъёме: 87% урона спавн-мили — баллистика (гатлинг/кулеврины/бомбарды),
    // она уклоняема; 0.35 не успевал ловить быстрые ядра (888 px/s), 0.55 размывал курс.
    a = dodge(a, deepClimb ? 0.45 : 0.55);
    const dh = WB.M.angleDelta(p.heading, a);
    // пар: (1) в СТАНЕ тяга обязательна — без неё drag 4.0 роняет скорость до 44 и босс
    // догоняет (стен: dh велик, руль в стане ×0.35 — cos(109°) всё ещё толкает вперёд);
    // (2) гистерезис вместо микроциклов на steam≈6: крупные окна буста/остывания;
    // (3) sail-реген (42.8 > 34 дренаж) = duty ~56% бесконечно, бак не важен — всё равно жжём.
    // Подъём = непрерывная тяга (каждая секунда под стволами стоит 200-450 hp); гистерезис
    // нужен только кольцу (экономия для танца). В стане тяга обязательна: drag 4.0 без буста
    // роняет скорость до 44, и босс (84) догоняет.
    if (run.__bst == null) run.__bst = true;
    const lo = INF_STEAM ? 18 : 8, hi = INF_STEAM ? 45 : 55;
    if (run.__bst && p.steam < lo) run.__bst = false;
    else if (!run.__bst && p.steam > hi) run.__bst = true;
    const climb = err < -60;
    const boost = climb ? (p.steam > 8 && Math.abs(dh) < 1.57) || (p.stun > 0 && p.steam > 4 && Math.abs(dh) < 1.9)
        : (err < -20 && (run.__bst || p.steam > hi));
    return { throttle: 1, steer: WB.M.clamp(dh * (deepClimb ? 4.2 : 2.4), -1, 1), boost };
}

let t = 0, dead = false, won = false, shotCount = 0;
let stunT = 0, instT = 0, lowT = 0, sumK = 0, revives = 0;
let hpPrev = p.hp, bossPrev = boss.hp, wT = 0, wIn = 0, wOut = 0, wD = 0, wN = 0;
const INST_FLOOR = 560;   // tesla3 (502) + запас
const t0 = Date.now();
while (t < 900 && !dead && !won) {
    const inp = drive();
    run.update(1 / 60, inp);
    t += 1 / 60;
    if (process.env.TRACE && t < Number(process.env.TRACE) && Math.round(t * 240) % 60 === 0) {
        const dd = WB.M.dist(p.x, p.y, boss.x, boss.y);
        const awayA = Math.atan2(p.y - boss.y, p.x - boss.x);
        console.log('tr t=' + t.toFixed(2) + ' d=' + dd.toFixed(0) + ' v=' + Math.hypot(p.vx, p.vy).toFixed(0) +
            ' toBoss=' + (WB.M.angleDelta(p.heading, Math.atan2(boss.y - p.y, boss.x - p.x)) * 57.3).toFixed(0) +
            ' vAway=' + ((p.vx * Math.cos(awayA) + p.vy * Math.sin(awayA))).toFixed(0) +
            ' stun=' + (p.stun > 0 ? 'Y' : 'n') + ' stm=' + p.steam.toFixed(0) + ' bst=' + (inp.boost ? 'Y' : 'n') +
            ' thr=' + inp.throttle + ' hp=' + p.hp.toFixed(0) +
            ' bossSt=' + (boss.ai.state || '?') + ' bossV=' + Math.hypot(boss.vx || 0, boss.vy || 0).toFixed(0) +
            ' dC=' + Math.hypot(p.x - run.region.cx, p.y - run.region.cy).toFixed(0) + ' R=' + run.region.regionR.toFixed(0));
    }
    for (const ev of run.events) {
        if (ev.type === 'shot' && ev.faction === 'player') shotCount++;
        if (ev.type === 'secondWind') revives++;
        if (ev.type === 'summon') sumK++;
    }
    if (p.stun > 0) stunT += 1 / 60;
    const dNow = WB.M.dist(p.x, p.y, boss.x, boss.y);
    if (dNow < INST_FLOOR) instT += 1 / 60;
    if (Math.hypot(p.vx, p.vy) < 60) lowT += 1 / 60;
    // окно 10 s: входящий/исходящий dps и средняя дистанция
    wT += 1 / 60; wD += dNow; wN++;
    const inD = Math.max(0, hpPrev - (p.hp < hpPrev ? p.hp : p.hp)), dIn = Math.max(0, hpPrev - p.hp), dOut = Math.max(0, bossPrev - boss.hp);
    wIn += dIn; wOut += dOut; hpPrev = p.hp; bossPrev = boss.hp;
    if (wT >= 10) {
        console.log('w t=' + t.toFixed(0) + 's dAvg=' + Math.round(wD / wN) + ' inDps=' + (wIn / wT).toFixed(0) + ' myDps=' + (wOut / wT).toFixed(1) + ' hp=' + Math.round(p.hp) + ' boss=' + Math.round(boss.hp) + ' stm=' + Math.round(p.steam));
        wT = 0; wIn = 0; wOut = 0; wD = 0; wN = 0;
    }
    if (!p.alive) dead = true;
    if (!boss.alive) won = true;
    if (Math.round(t * 60) % 600 === 0) {
        const aim = p.modules.map(m => m.mod.id + ':cd' + (m.cd || 0).toFixed(1) + ':aim' + Math.round((m.aim || 0) * 57.3) + ':dev' + Math.round(WB.M.angleDelta(p.heading + WB.SLOT_ANGLE(m.slot, p.modules.length), m.aim || 0) * 57.3)).join(' ');
        console.log('t=' + t.toFixed(1) + ' hp=' + Math.round(p.hp) + ' boss=' + Math.round(boss.hp) +
            ' d=' + Math.round(WB.M.dist(p.x, p.y, boss.x, boss.y)) +
            ' dmg=' + Math.round(run.totals.damage) + ' shots=' + shotCount +
            ' toBoss=' + Math.round(WB.M.angleDelta(p.heading, Math.atan2(boss.y - p.y, boss.x - p.x)) * 57.3) + '°');
        console.log('    ' + aim);
    }
}
console.log((won ? 'BOSS DOWN' : dead ? 'PLAYER DOWN' : 'TIMEOUT') + ' at t=' + Math.round(t) + 's standoff=' + STANDOFF + ' region=' + REGION + ' (' + (Date.now() - t0) + 'ms)');
console.log('  телеметрия: stun=' + stunT.toFixed(1) + 's под-inst=' + instT.toFixed(1) + 's lowV=' + lowT.toFixed(1) + 's саммонов=' + sumK + ' воскрешений=' + revives + ' hpFin=' + Math.round(p.hp) + '/' + p.maxHp + ' bossFin=' + Math.round(Math.max(0, boss.hp)));
