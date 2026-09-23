// Scratch: force a full region flow (gate -> warden -> next region) and measure the boss fight.
import { loadScripts } from '../tests/browser-scripts.mjs';
const store = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const page = loadScripts(['js/Constants.js', 'libs/simplex-noise.js', 'js/Content.js', 'js/Logic.js'], { localStorage: store });
const WB = page.get('WB');
WB.Save.load();

const seed = Number(process.argv[2] || 5150);
const run = new WB.Run({ seed, region: 0 });
const p = run.player, r = run.region;

// Give the player a decent tier-4 loadout, as if he had eaten the whole valley.
p.mass = 1400; run.checkTier(p, { x: p.x, y: p.y });
if (run.draftPending) run.takeDraft(0);
for (const id of ['culverin', 'mortar', 'spire', 'workshop']) {
    if (p.modules.length < p.slots) p.modules.push({ mod: WB.moduleById(id), level: 2, slot: p.modules.length, aim: p.heading, cd: 0, mount: null });
}
WB.recompute(p); p.hp = p.maxHp;
console.log('player: tier', p.tier, 'hp', Math.round(p.hp), 'slots', p.slots,
    'modules', p.modules.map(m => m.mod.short + 'L' + m.level).join(','),
    '| dps-ish', p.modules.filter(m => m.mod.behavior === 'turret').map(m => (WB.moduleStat(m.mod, m.level, 'power') / WB.moduleStat(m.mod, m.level, 'rate')).toFixed(1)).join('+'));

// Kill the fortresses so the gate opens, then walk into it.
for (const c of [...r.castles]) if (c.kind === 'fortress') { c.hp = 1; run.damage(c, 9999, { source: p }); }
let guard = 0;
while (!r.gate.open && guard++ < 600) run.update(1 / 60, { throttle: 0, steer: 0 });
console.log('gate open:', r.gate.open, '| fortresses left:', run.fortressesLeft);

// Drive to the gate.
function toTarget(t) {
    const a = Math.atan2(t.y - p.y, t.x - p.x);
    const d = WB.M.angleDelta(p.heading, a);
    return { throttle: 1, steer: WB.M.clamp(d * 2, -1, 1), boost: false };
}
let bossT = -1, bossFrames = 0, dmgToBoss = 0, dmgToPlayer = 0;
const origDamage = run.damage.bind(run);
run.damage = (e, a, o) => {
    if (run.boss && e === run.boss) dmgToBoss += a;
    if (e === p) dmgToPlayer += a;
    return origDamage(e, a, o);
};
let state = 'toGate';
for (let i = 0; i < 60 * 300; i++) {
    let input;
    if (state === 'toGate') {
        input = toTarget(r.gate);
        if (WB.M.dist(p.x, p.y, r.gate.x, r.gate.y) < r.gate.r + p.r + 8) state = 'waitBoss';
    } else if (run.boss && run.boss.alive) {
        if (state !== 'fight') { state = 'fight'; bossT = run.time; console.log('BOSS:', run.boss.name, 'hp', Math.round(run.boss.hp), 'tier', run.boss.tier,
            'modules', run.boss.modules.map(m => m.mod.short + 'L' + m.level).join(',')); }
        // circle the boss at ~420 px
        const b = run.boss, d = WB.M.dist(p.x, p.y, b.x, b.y);
        const a = Math.atan2(b.y - p.y, b.x - p.x) + (d < 380 ? 1.3 : d > 520 ? 0 : 0.55);
        input = toTarget({ x: p.x + Math.cos(a), y: p.y + Math.sin(a) });
        bossFrames++;
    } else if (state === 'fight') { break; }
    else input = toTarget(r.gate);
    run.update(1 / 60, input);
    if (run.draftPending) run.takeDraft(run.draftPending.cards.findIndex(c => c.kind === 'upgrade') >= 0 ? run.draftPending.cards.findIndex(c => c.kind === 'upgrade') : 0);
    if (run.over) break;
}
console.log('boss fight:', bossFrames > 0 ? (bossFrames / 60).toFixed(1) + 's' : 'never started',
    '| damage dealt to boss', Math.round(dmgToBoss), '| damage taken', Math.round(dmgToPlayer),
    '| player hp', Math.round(p.hp) + '/' + p.maxHp, '| boss alive', !!(run.boss && run.boss.alive), '| run over', run.over);
console.log('regionCleared:', run.regionCleared, '| events seen:', [...new Set(run.events.map(e => e.type))].join(','));
console.log('totals:', JSON.stringify(run.totals));
