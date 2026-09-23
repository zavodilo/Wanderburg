// Scratch: the boss chain end-to-end in node — force the warden, fight it with the autopilot,
// then walk into the next region. Proves startBoss/bossDown/regionClear/nextRegion and the
// region-1 generation, without a browser.
import { loadScripts } from '../tests/browser-scripts.mjs';
const store = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const page = loadScripts(['js/Constants.js', 'libs/simplex-noise.js', 'js/Content.js', 'js/Logic.js'], { localStorage: store });
const WB = page.get('WB');
WB.Save.load();

const seed = Number(process.argv[2] || 777);
const run = new WB.Run({ seed, region: 0 });
const p = run.player;
// a believable mid-run loadout: tier 4 with five modules
p.mass = 1400; run.checkTier(p, { x: p.x, y: p.y });
for (const id of ['culverin', 'spire', 'workshop']) {
    if (p.modules.length < p.slots) p.modules.push({ mod: WB.moduleById(id), level: 2, slot: p.modules.length, aim: 0, cd: 0, mount: null });
}
WB.recompute(p); p.hp = p.maxHp;
console.log('player tier', p.tier, 'hp', p.maxHp, 'modules', p.modules.map(m => m.mod.short + m.level).join(','));

let committed = null;
function drive() {
    const r = run.region;
    const boss = run.boss && run.boss.alive ? run.boss : null;
    let target = boss || (r.gate.open ? r.gate : null);
    if (!target) {
        if (committed && committed.alive) target = committed;
        else {
            let tier = 99;
            for (const c of r.castles) if (c.alive && c.kind === 'fortress' && c.tier < tier) { tier = c.tier; target = c; }
            committed = target;
        }
    }
    if (!target) target = r.entities.find(e => !e.dead && e.type === 'village') || r.gate;
    const d = WB.M.dist(p.x, p.y, target.x, target.y);
    let want;
    if (boss) {
        want = Math.atan2(boss.y - p.y, boss.x - p.x) + (d < 340 ? 1.25 : d > 560 ? 0 : 0.55);
    } else want = Math.atan2(target.y - p.y, target.x - p.x);
    let delta = (want - p.heading) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return {
        throttle: Math.abs(delta) > 2.5 ? -0.5 : 1,
        steer: WB.M.clamp(delta * 1.9, -1, 1),
        boost: boss ? d > 620 : d > 340 && Math.abs(delta) < 0.3
    };
}

// force the warden out after 20 s of clearing
let bossAt = 20, frames = 0, regionChanges = 0;
const t0 = Date.now();
while (!run.over && frames < 60 * 60 * 10) {
    run.update(1 / 60, drive());
    frames++;
    const t = run.time;
    if (t > bossAt && !run.bossActive && !run.regionCleared) { run.startBoss(); bossAt = 1e9; console.log('t=' + Math.round(t) + 's BOSS SPAWNED: ' + run.boss.name + ' hp ' + Math.round(run.boss.hp)); }
    if (run.boss && frames % 600 === 0) console.log('   t=' + Math.round(t) + 's boss hp ' + Math.max(0, Math.round(run.boss.hp)) + '/' + Math.round(run.boss.maxHp) + ' | player ' + Math.round(p.hp) + '/' + p.maxHp);
    for (const ev of run.events) {
        if (['bossDown', 'regionClear', 'playerDown', 'chargeTelegraph'].includes(ev.type)) console.log('   t=' + Math.round(t) + 's ' + ev.type);
    }
    if (run.draftPending) run.takeDraft(run.draftPending.cards.findIndex(c => c.kind === 'upgrade') >= 0 ? run.draftPending.cards.findIndex(c => c.kind === 'upgrade') : 0);
    if (run.regionCleared) {
        regionChanges++;
        console.log('t=' + Math.round(t) + 's REGION CLEAR -> next');
        run.nextRegion();
        p.hp = p.maxHp;
        if (regionChanges >= 1) break;
    }
}
// a few seconds inside region 1 to prove it simulates
for (let i = 0; i < 60 * 8; i++) { run.update(1 / 60, drive()); if (run.draftPending) run.takeDraft(0); }
console.log('--- after hop: region', run.regionIndex, run.region.biome.name, '| entities', run.region.entities.length,
    '| player tier', p.tier, 'hp', Math.round(p.hp) + '/' + p.maxHp, 'modules', p.modules.length,
    '| wall-clock', ((Date.now() - t0) / 1000).toFixed(1) + 's');
