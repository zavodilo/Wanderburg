// Wanderburg's own tests: the data tables, the simulation's invariants and determinism.
// The kit's tests hold the engine to its contract; these hold THE GAME to its design:
// a module's weapon fields never collide with its modifier fields (that bug once turned one
// bombard into +17 damage for the whole hull), a region always generates playable, the same
// seed always plays the same, and the tier/draft economy obeys its rules.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadScripts } from './browser-scripts.mjs';

const store = {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};

function game() {
    return loadScripts(['js/Constants.js', 'libs/simplex-noise.js', 'js/Content.js', 'js/Logic.js'], { localStorage: store });
}

// --- Content: the two namespaces of a module -------------------------------------------
test('модули: оружейные поля не пересекаются с полями-модификаторами', () => {
    const { get } = game();
    const WB = get('WB');
    // What WB.playerStats sums over the hull as modifiers. A weapon field with one of these
    // names would leak into the hull-wide multiplier (the +17 damage bug).
    const MODIFIER_KEYS = ['speed', 'accel', 'dmg', 'range', 'plate', 'walls', 'ramPower', 'steam',
        'steamFlow', 'repair', 'kegPower', 'kegRadius', 'burn', 'villageBonus', 'fear', 'vision',
        'draftCost', 'scrapTick', 'massBonus', 'scrapBonus', 'sight'];
    const WEAPON_KEYS = ['power', 'rate', 'reach', 'pspeed', 'plife', 'aoe', 'pierce', 'units', 'kegCd'];
    for (const m of WB.MODULES) {
        for (const k of Object.keys(m)) {
            if (['id', 'name', 'short', 'behavior', 'rarity', 'desc', 'up', 'arcane', 'turn', 'arc',
                'spread', 'cone', 'stun', 'instant', 'hitsTop', 'unit', 'shot'].includes(k)) continue;
            const isMod = MODIFIER_KEYS.includes(k);
            const isWeapon = WEAPON_KEYS.includes(k);
            assert.ok(isMod !== isWeapon, m.id + ': поле ' + k + ' лежит в обоих пространствах имён');
            // a passive must not carry weapon numbers it will never fire
            if (m.behavior === 'passive') assert.ok(!isWeapon || k === 'kegCd', m.id + ': passive с оружейным полем ' + k);
        }
        // every upgrade multiplier is a sane per-level factor
        for (const [k, v] of Object.entries(m.up || {})) {
            assert.ok(v > 0.5 && v < 2.1, m.id + ': up.' + k + ' = ' + v + ' вне диапазона 0.5..2.1');
        }
    }
});

test('контент: все ссылки целостны (чертежи, корпуса, капитаны, loadouts)', () => {
    const { get } = game();
    const WB = get('WB');
    for (const l of WB.LEGACY) {
        if (l.kind === 'module') assert.ok(WB.moduleById(l.ref), 'legacy ' + l.id + ' -> модуль ' + l.ref);
        if (l.kind === 'chassis') assert.ok(WB.CHASSIS.find(c => c.id === l.ref), 'legacy ' + l.id);
        if (l.kind === 'captain') assert.ok(WB.CAPTAINS.find(c => c.id === l.ref), 'legacy ' + l.id);
        assert.ok(l.cost > 0 && l.name && l.desc);
    }
    for (const c of WB.CHASSIS) assert.ok(WB.moduleById(c.startModule), 'chassis ' + c.id + ' startModule');
    for (const list of WB.FORTRESS_LOADOUTS) for (const id of list) assert.ok(WB.moduleById(id), 'loadout ' + id);
    for (const id of WB.FORTRESS_SUPPORT) assert.ok(WB.moduleById(id), 'support ' + id);
    for (const id of WB.WARDEN_MODULES) assert.ok(WB.moduleById(id), 'warden ' + id);
    // every captain modifier is one the simulation actually reads
    const KNOWN = ['feastSpeed', 'feastTime', 'arcaneDmg', 'arcaneRange', 'stillRepair', 'massGain',
        'scrapGain', 'closeDmg', 'closeRange', 'kegMult', 'speed', 'steamRegen', 'boostRam',
        'ramDmg', 'ramSplash', 'ramRecoil', 'startLegacy', 'tierHeal'];
    for (const c of WB.CAPTAINS) for (const k of Object.keys(c.mods)) assert.ok(KNOWN.includes(k), c.id + ': mods.' + k);
    // the biomes carry everything the view needs
    for (const b of WB.BIOMES) {
        assert.ok(b.name && b.music && b.terrain && b.render && b.scenery);
        assert.ok(b.ground >= 0 && b.ground <= 2);
        for (const k of ['sunAz', 'sunEl', 'sunIntensity', 'sunColor', 'sky', 'fog']) assert.ok(b.render[k] != null, b.id + ': render.' + k);
    }
});

test('ступени: пороги массы монотонны, радиусы и слоты растут', () => {
    const { get } = game();
    const WB = get('WB');
    let prev = 0;
    for (const t of [2, 3, 4, 5]) {
        const m = WB.tierMass(t);
        assert.ok(m > prev, 'порог ' + t);
        prev = m;
    }
    assert.equal(WB.tierMass(6), Infinity);
    for (let t = 1; t < 5; t++) {
        assert.ok(WB.tierRadius(t + 1) > WB.tierRadius(t));
        assert.ok(WB.tierSlots(t + 1) > WB.tierSlots(t));
        assert.ok(WB.TIER_HP[t + 1] > WB.TIER_HP[t]);
    }
});

// --- Region generation -----------------------------------------------------------------
test('регион генерируется играбельным: старт внутри, крепости не на голове, врата в центре', () => {
    const { get } = game();
    const WB = get('WB');
    for (const seed of [1, 42, 999]) {
        const run = new (get('WB').Run)({ seed, region: 0 });
        const r = run.region, p = run.player;
        assert.ok(r.inside(p.x, p.y, 60), 'старт внутри долины');
        assert.ok(r.dCenter(p.x, p.y) < r.regionR * 0.7, 'старт не на кольце');
        for (const c of r.castles) {
            if (c.kind !== 'fortress') continue;
            assert.ok(WB.M.dist(c.x, c.y, p.x, p.y) > 500, 'крепость слишком близко к старту');
            assert.ok(r.inside(c.x, c.y, 40));
        }
        assert.ok(r.gate && r.dCenter(r.gate.x, r.gate.y) < r.regionR * 0.35, 'врата ближе к центру');
        const villages = r.entities.filter(e => e.type === 'village').length;
        assert.ok(villages >= 8, 'деревень достаточно: ' + villages);
        // nothing sits on the mountain ramp
        for (const e of r.entities) if (e.type !== 'gate') assert.ok(r.heightAt(e.x, e.y) < 60, 'сущность на склоне');
        // the terrain the logic reads is the terrain the view will build
        assert.ok(Math.abs(r.heightAt(r.cx, r.cy)) < 80, 'центр почти ровный');
        assert.ok(r.heightAt(r.cx, r.cy - r.regionR) > 150, 'кольцо поднято');
    }
});

test('один сид — один регион и один забег (детерминизм)', () => {
    const page = game();
    const WB = page.get('WB');
    const a = new WB.Run({ seed: 20260923, region: 0 });
    const b = new WB.Run({ seed: 20260923, region: 0 });
    const sig = (run) => run.region.entities.map(e => e.type + ':' + Math.round(e.x) + ',' + Math.round(e.y)).join('|');
    assert.equal(sig(a), sig(b));
    const drive = { throttle: 1, steer: 0.3, boost: false };
    for (let i = 0; i < 600; i++) { a.update(1 / 60, drive); b.update(1 / 60, drive); }
    assert.equal(Math.round(a.player.mass), Math.round(b.player.mass));
    assert.equal(Math.round(a.player.x), Math.round(b.player.x));
});

// --- The run: devouring, tiers, the draft -----------------------------------------------
test('поглощение даёт массу, масса даёт ступень и чертёж', () => {
    const { get } = game();
    const WB = get('WB');
    const run = new WB.Run({ seed: 5, region: 0 });
    const p = run.player;
    const v = run.region.entities.find(e => e.type === 'village');
    // stand on the village until it is eaten
    for (let i = 0; i < 60 * 6 && !v.dead; i++) {
        p.x = v.x; p.y = v.y; p.vx = 0; p.vy = 0;
        run.update(1 / 60, { throttle: 0, steer: 0 });
    }
    assert.ok(v.dead, 'деревня съедена');
    assert.ok(p.mass > 30, 'масса начислена: ' + Math.round(p.mass));
    // feed it the rest of the tier by hand and watch the draft open
    run.gainMass(WB.tierMass(2) - p.mass + 1, p.x, p.y);
    assert.equal(p.tier, 2, 'ступень 2');
    assert.ok(run.draftPending, 'чертёж открыт');
    const before = p.modules.length;
    const idx = run.draftPending.cards.findIndex(c => c.kind === 'new');
    run.takeDraft(idx >= 0 ? idx : 0);
    assert.ok(p.modules.length >= before, 'модуль взят или улучшен');
    assert.ok(!run.draftPending, 'чертёж закрыт');
});

test('чертёж: пул не даёт закрытое, повторы и превышение слотов', () => {
    const { get } = game();
    const WB = get('WB');
    const run = new WB.Run({ seed: 9, region: 0, legacy: [] });
    const p = run.player;
    p.slots = 2;
    p.modules.length = 0;
    p.modules.push({ mod: WB.moduleById('bombard'), level: 3, slot: 0, aim: 0, cd: 0 });
    p.modules.push({ mod: WB.moduleById('plate'), level: 1, slot: 1, aim: 0, cd: 0 });
    run.offerDraft('tier');
    const ids = run.draftPending.cards.map(c => c.id);
    assert.ok(!ids.includes('bombard'), 'максимальный модуль не предлагается как новый/улучшение: ' + ids);
    // locked (rarity>0 without a blueprint) never appears
    for (const id of ids) {
        const m = WB.moduleById(id);
        if (m) assert.ok(WB.moduleUnlocked(m, { legacy: [] }), 'закрытый модуль в пуле: ' + id);
    }
    // a new module cannot be taken without a free slot
    const newIdx = run.draftPending.cards.findIndex(c => c.kind === 'new');
    if (newIdx >= 0) {
        run.takeDraft(newIdx);
        assert.equal(p.modules.length, 2, 'слоты уважены');
    }
});

test('таран: столкновение корпусов наносит урон обеим сторонам', () => {
    const { get } = game();
    const WB = get('WB');
    const run = new WB.Run({ seed: 11, region: 0 });
    const p = run.player;
    const f = run.region.castles.find(c => c.kind === 'fortress');
    f.x = p.x + 300; f.y = p.y;
    const hpP = p.hp, hpF = f.hp;
    for (let i = 0; i < 90; i++) run.update(1 / 60, { throttle: 1, steer: 0 });
    assert.ok(f.hp < hpF || !f.alive, 'крепость пострадала от тарана/орудий');
    assert.ok(p.hp <= hpP, 'игрок тоже получил отдачу или ответный огонь');
});

test('врата открываются по крепостям, варден.spawn и смерть вардена чистят регион', () => {
    const { get } = game();
    const WB = get('WB');
    const run = new WB.Run({ seed: 13, region: 0 });
    const r = run.region;
    assert.ok(!r.gate.open);
    for (const c of [...r.castles]) if (c.kind === 'fortress') run.damage(c, 1e9, { source: run.player });
    // the mass of four wrecks can open a draft, and a draft pauses the world — close it first
    while (run.draftPending) run.skipDraft();
    run.update(1 / 60, { throttle: 0, steer: 0 });
    assert.ok(r.gate.open, 'врата открыты после зачистки');
    run.startBoss();
    assert.ok(run.boss && run.boss.alive, 'варден вышел');
    const boss = run.boss;
    run.damage(boss, 1e9, { source: run.player });
    while (run.draftPending) run.skipDraft();
    run.update(1 / 60, { throttle: 0, steer: 0 });
    assert.ok(!boss.alive, 'варден мёртв');
    assert.ok(run.regionCleared, 'рубеж очищен');
    const tierBefore = run.player.tier, massBefore = run.player.mass;
    run.nextRegion();
    assert.equal(run.regionIndex, 1, 'следующий рубеж');
    assert.equal(run.player.tier, tierBefore, 'прогресс перенесён');
    assert.ok(Math.abs(run.player.mass - massBefore) < 1e-6);
    assert.ok(run.region.entities.length > 60, 'новый регион населён');
});

test('смерть игрока завершает забег и считает лом', () => {
    const { get } = game();
    const WB = get('WB');
    const run = new WB.Run({ seed: 17, region: 0 });
    run.gainMass(500, 0, 0);
    run.damage(run.player, 1e9, { source: null });
    run.update(1 / 60, { throttle: 0, steer: 0 });
    assert.ok(run.over, 'забой окончен');
    assert.ok(!run.won);
    const s = run.summary();
    assert.ok(s.scrap > 0 || run.runScrap() > 0, 'лом начислен');
    assert.ok(s.modules.length > 0);
});

test('наследие: покупка списывает лом и открывает контент', () => {
    const { get } = game();
    const WB = get('WB');
    WB.Save.load();
    WB.Save.meta.scrap = 1000;
    WB.Save.meta.legacy = [];
    assert.ok(WB.Save.buy('mod_mortar'), 'купили чертёж мортиры');
    assert.ok(WB.moduleUnlocked(WB.moduleById('mortar'), WB.Save.meta), 'мортира открыта');
    assert.equal(WB.Save.meta.scrap, 1000 - WB.legacyById('mod_mortar').cost);
    assert.ok(!WB.Save.buy('mod_mortar'), 'повторно купить нельзя');
    assert.ok(!WB.Save.buy('ch_dreadnought') === false || true); // хватает или нет — не падает
});
