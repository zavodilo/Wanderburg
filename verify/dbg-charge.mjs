import { loadScripts } from '../tests/browser-scripts.mjs';
const store = { _d: {}, getItem(k){return this._d[k]??null}, setItem(k,v){this._d[k]=String(v)}, removeItem(k){delete this._d[k]} };
const page = loadScripts(['js/Constants.js','libs/simplex-noise.js','js/Content.js','js/Logic.js'], { localStorage: store });
const WB = page.get('WB');
const LEG = (process.argv[2]||'').split(',').filter(Boolean);
const REGION = Number(process.argv[3] || 3);
const run = new WB.Run({ seed: 4242, region: REGION, legacy: LEG, chassis: WB.CHASSIS.find(c=>c.id==='dreadnought'), captain: WB.CAPTAINS.find(c=>c.id==='seraphine') });
const p = run.player; p.tier = 5; WB.recompute(p); p.hp = p.maxHp;
run.grace = 0; run.startBoss();
const b = run.boss;
// заряжаем: игрок на 400px, потом убираем на 3000 (заряд идёт по зафиксированному лучу)
b.x = run.region.cx; b.y = run.region.cy; b.vx = b.vy = 0;
p.x = run.region.cx + 400; p.y = run.region.cy; p.hp = p.maxHp; p.alive = true;
b.ai.chargeCd = 0; b.ai.telegraph = 0; b.ai.chargeT = 0; b.hp = b.maxHp;
let phase = 'wait', vMax = 0, dashDist = 0, dashT = 0, sx = 0, sy = 0;
for (let i = 0; i < 60*10 && phase !== 'done'; i++) {
    run.over = false; p.alive = true; p.hp = p.maxHp;   // бессмертный манекен — замер механики босса
    if (b.ai.telegraph > 0 && phase === 'wait') { phase = 'tele'; p.x = run.region.cx + 3000; p.y = run.region.cy; }
    if (b.ai.chargeT > 0 && phase !== 'dash') { phase = 'dash'; sx = b.x; sy = b.y; }
    run.update(1/60, { throttle: 0, steer: 0, boost: false });
    p.x = run.region.cx + 3000; p.y = run.region.cy; p.vx = p.vy = 0;
    if (phase === 'dash') {
        const v = Math.hypot(b.vx||0, b.vy||0);
        vMax = Math.max(vMax, v); dashT += 1/60; dashDist = Math.hypot(b.x-sx, b.y-sy);
        if (b.ai.chargeT <= 0) phase = 'done';
    }
}
console.log('charge: vMax=' + vMax.toFixed(0), 'dist=' + dashDist.toFixed(0), 't=' + dashT.toFixed(2), 'avg=' + (dashDist/Math.max(dashT,0.01)).toFixed(0));
// hunt-скорость чисто (игрок далеко в aggro, бессмертный, телепорт на 850 каждый кадр)
for (const en of [0,1,2]) {
    b.hp = en===0 ? b.maxHp*0.9 : en===1 ? b.maxHp*0.5 : b.maxHp*0.2;
    b.x = run.region.cx; b.y = run.region.cy; b.vx = b.vy = 0;
    b.ai.telegraph = 0; b.ai.chargeT = 0; b.ai.chargeCd = 999; b.ai.state='patrol';
    let v = 0;
    for (let i = 0; i < 60*5; i++) {
        run.over = false; p.alive = true; p.hp = p.maxHp;
        p.x = run.region.cx + 850; p.y = run.region.cy; p.vx = p.vy = 0;
        run.update(1/60, { throttle: 0, steer: 0, boost: false });
        v = Math.max(v, Math.hypot(b.vx||0, b.vy||0));
    }
    console.log('enrage', en, 'hunt vMax=' + v.toFixed(0), 'bossD=' + Math.round(Math.hypot(b.x-run.region.cx, b.y-run.region.cy)));
}
