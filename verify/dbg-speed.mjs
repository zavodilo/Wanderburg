import { loadScripts } from '../tests/browser-scripts.mjs';
const store = { _d: {}, getItem(k){return this._d[k]??null}, setItem(k,v){this._d[k]=String(v)}, removeItem(k){delete this._d[k]} };
const page = loadScripts(['js/Constants.js','libs/simplex-noise.js','js/Content.js','js/Logic.js'], { localStorage: store });
const WB = page.get('WB');
const LEG = (process.argv[2]||'').split(',').filter(Boolean);
const ser = WB.CAPTAINS.find(c=>c.id==='seraphine');
for (const chId of ['timber','dreadnought']) {
    const run = new WB.Run({ seed: 4242, region: 0, legacy: LEG, chassis: WB.CHASSIS.find(c=>c.id===chId), captain: ser });
    const p = run.player;
    p.tier = 5; p.mass = 2000; WB.recompute(p); p.hp = p.maxHp;
    // прямая в центре долины (плоско), throttle 1
    p.x = run.region.cx; p.y = run.region.cy; p.heading = 0; p.vx = p.vy = 0;
    let vMax = 0, vBoost = 0;
    for (let i = 0; i < 60*6; i++) { run.update(1/60, { throttle: 1, steer: 0, boost: false }); vMax = Math.max(vMax, Math.hypot(p.vx,p.vy)); }
    p.steam = p.stats.steamMax;
    for (let i = 0; i < 60*6; i++) { run.update(1/60, { throttle: 1, steer: 0, boost: true }); vBoost = Math.max(vBoost, Math.hypot(p.vx,p.vy)); }
    console.log(chId, 't5: cap=' + Math.round(p.stats.speed), 'accel=' + Math.round(p.stats.accel),
        'cruise=' + Math.round(vMax), 'boost=' + Math.round(vBoost), 'hp=' + p.maxHp, 'armor=' + Math.round(p.stats.armor*100)/100);
}
// босс-варден: его крейсерская
{
    const run = new WB.Run({ seed: 4242, region: 2, legacy: [] });
    run.startBoss();
    const b = run.boss;
    b.x = run.region.cx; b.y = run.region.cy + 200;
    let v = 0;
    for (let i = 0; i < 60*4; i++) { run.update(1/60, { throttle: 0, steer: 0, boost: false }); v = Math.max(v, Math.hypot(b.vx||0, b.vy||0)); }
    console.log('warden r2: speedBase=' + Math.round(b.speedBase), 'max v=' + Math.round(v), 'hp=' + Math.round(b.hp), 'guns:', b.modules.map(m=>m.mod.id+m.level).join(','));
}
