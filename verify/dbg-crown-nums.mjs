// Измерения для доктрины Crown: крейсерская/буст по котлам, hunt-скорость босса по enrage,
// рывок заряда, паровая экономика. Всё через публичный update() — никаких читов.
import { loadScripts } from '../tests/browser-scripts.mjs';
const store = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const page = loadScripts(['js/Constants.js', 'libs/simplex-noise.js', 'js/Content.js', 'js/Logic.js'], { localStorage: store });
const WB = page.get('WB');

const LEG = (process.argv[2] || '').split(',').filter(Boolean);
const ser = WB.CAPTAINS.find(c => c.id === 'seraphine');
const dread = WB.CHASSIS.find(c => c.id === 'dreadnought');

function measure(buildStr) {
    const run = new WB.Run({ seed: 4242, region: 0, legacy: LEG, chassis: dread, captain: ser });
    const p = run.player;
    p.tier = 5; p.r = WB.tierRadius(5); WB.recompute(p);
    p.modules.length = 0;
    for (const s of buildStr.split(',')) {
        const id = s.replace(/\d+$/, ''), lvl = Number(s.match(/\d+$/) || 1);
        p.modules.push({ mod: WB.moduleById(id), level: lvl, slot: 0, aim: 0, cd: 0, mount: null });
    }
    p.modules.forEach((m, i) => { m.slot = i; });
    WB.recompute(p);
    p.hp = p.maxHp; p.steam = p.stats.steamMax;
    // плоская прямая в центре
    p.x = run.region.cx; p.y = run.region.cy; p.heading = 0; p.vx = p.vy = 0;
    let vCruise = 0;
    for (let i = 0; i < 60 * 8; i++) { run.update(1 / 60, { throttle: 1, steer: 0, boost: false }); vCruise = Math.max(vCruise, Math.hypot(p.vx, p.vy)); }
    p.steam = p.stats.steamMax;
    let vBoost = 0;
    for (let i = 0; i < 60 * 8; i++) { run.update(1 / 60, { throttle: 1, steer: 0, boost: true }); vBoost = Math.max(vBoost, Math.hypot(p.vx, p.vy)); }
    const st = p.stats;
    const guns = p.modules.filter(m => m.mod.power > 0).map(m => m.mod.id + m.level + ':' + Math.round(WB.reachOf(p, m.mod, m.level, st)));
    console.log(buildStr.padEnd(46), 'v=' + vCruise.toFixed(0), 'vBoost=' + vBoost.toFixed(0),
        'hp=' + st.maxHp, 'armor=' + st.armor.toFixed(2), 'steam=' + st.steamMax + '+' + st.steamRegen.toFixed(1) + '/s',
        'guns[' + guns.join(' ') + ']');
    return { vCruise, vBoost, st };
}

console.log('=== dreadnought+seraphine T5, LEG2 ===');
measure('culverin1,plate1,boiler1');
measure('culverin1,plate1,boiler2');
measure('culverin1,plate1,boiler3');
measure('culverin1,plate1,mortar1,nest1,boiler1');
measure('culverin1,plate1,mortar1,nest1,boiler2');
measure('culverin1,plate1,mortar1,nest1,boiler3');
measure('culverin1,plate1,mortar2,nest1,boiler2');
measure('culverin1,plate1,mortar1,nest2,boiler2');

console.log('=== Crown: hunt speed / charge / enrage ===');
{
    const run = new WB.Run({ seed: 4242, region: 3, legacy: LEG, chassis: dread, captain: ser });
    const p = run.player;
    p.tier = 5; WB.recompute(p); p.hp = p.maxHp;
    run.grace = 0;
    run.startBoss();
    const b = run.boss;
    console.log('crown guns:', b.modules.map(m => m.mod.id + m.level).join(','), 'hp=' + Math.round(b.hp),
        'r=' + Math.round(b.r), 'speedBase=' + (b.speedBase || '?'), 'aggro=' + b.ai.aggro);
    const est = WB.enemyStats(b, run.scale);
    console.log('estats:', JSON.stringify({ dmg: est.dmg, range: est.range, armor: est.armor, repair: est.repair }));
    for (const en of [0, 1, 2]) {
        // ставим hp в нужный диапазон enrage, игрока — на 500 px (внутри aggro, вне charge? charge<700 — будет charge)
        b.hp = en === 0 ? b.maxHp * 0.9 : en === 1 ? b.maxHp * 0.5 : b.maxHp * 0.2;
        b.x = run.region.cx; b.y = run.region.cy;
        p.x = run.region.cx + 850; p.y = run.region.cy;   // вне charge (>=700), внутри aggro
        p.vx = p.vy = 0; p.alive = true; p.hp = p.maxHp;
        b.ai.telegraph = 0; b.ai.chargeT = 0; b.ai.chargeCd = 99;   // только hunt, без заряда
        let vMax = 0;
        for (let i = 0; i < 60 * 4; i++) {
            run.update(1 / 60, { throttle: 0, steer: 0, boost: false });
            p.x = run.region.cx + 850; p.y = run.region.cy; p.vx = p.vy = 0;  // держим дистанцию (телепорт игрока — только замер босса)
            vMax = Math.max(vMax, Math.hypot(b.vx || 0, b.vy || 0));
        }
        console.log('enrage', en, 'hunt vMax=' + vMax.toFixed(0), 'd=' + Math.round(WB.M.dist(p.x, p.y, b.x, b.y)));
    }
    // рывок заряда
    b.hp = b.maxHp * 0.5; b.ai.enrage = 1;
    b.x = run.region.cx; b.y = run.region.cy;
    p.x = run.region.cx + 400; p.y = run.region.cy; p.vx = p.vy = 0; p.hp = p.maxHp;
    b.ai.telegraph = 0; b.ai.chargeT = 0; b.ai.chargeCd = 0;
    let vCharge = 0, tCharge = -1, d0 = 400;
    for (let i = 0; i < 60 * 6; i++) {
        run.update(1 / 60, { throttle: 0, steer: 0, boost: false });
        const v = Math.hypot(b.vx || 0, b.vy || 0);
        if (b.ai.chargeT > 0) { vCharge = Math.max(vCharge, v); if (tCharge < 0) tCharge = i / 60; }
        p.x = run.region.cx + 400; p.y = run.region.cy; p.vx = p.vy = 0; p.hp = p.maxHp;   // неподвижная мишень
    }
    console.log('charge vMax=' + vCharge.toFixed(0), 'start t=' + tCharge.toFixed(2));
}

console.log('=== паровая экономика ===');
{
    const run = new WB.Run({ seed: 4242, region: 0, legacy: LEG, chassis: dread, captain: ser });
    const p = run.player;
    p.tier = 5; WB.recompute(p);
    const st = p.stats;
    const drain = WB.num('BOOST_DRAIN', 34);
    console.log('steamMax=' + st.steamMax, 'regen=' + st.steamRegen.toFixed(1), 'drain=' + drain,
        'duty=' + (st.steamRegen / drain * 100).toFixed(0) + '%',
        'fullTankBoost=' + (st.steamMax / drain).toFixed(1) + 's');
}
