// Wanderburg on the unified visual pipeline: the contract between the game's own modules and the
// kit's semantic layer. The kit's tests hold the ENGINE to its rules; tests/wanderburg.test.mjs
// holds the SIMULATION to its design; this file holds the BRIDGE to honesty:
//
//   * GAME_SPEC describes the same game Constants.js/Content.js/Logic.js implement (no drift);
//   * the semantic UI/scene/asset/audio blocks reference things that actually exist;
//   * the five variants are one project (one contract hash, one save schema);
//   * the shipped variant pins exactly the look Constants.js authors (camera, toon, ink, outline);
//   * the simulation layer stays renderer-free, and the game declares how it presents itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bootPipeline, collectPresentation, scanAssets, ROOT } from '../tools/headless.mjs';
import { loadScripts } from './browser-scripts.mjs';

const kit = bootPipeline({ files: scanAssets(ROOT), quiet: true });
const { GameModel, Variant, RenderProfile, AssetRegistry, Save } = kit;
const SPEC = kit.GAME_SPEC;
kit.PlayArcRuntime.start({ variants: collectPresentation(ROOT), apply: false });

const store = {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};
const sim = loadScripts(['js/Constants.js', 'libs/simplex-noise.js', 'js/Content.js', 'js/Logic.js'], { localStorage: store });
const WB = sim.get('WB');
const CFG = sim.get('WANDER_CFG');
const LAYOUT = loadScripts(['js/Constants.js', 'js/UILayout.js'], {}).get('UI_LAYOUT');
const layoutIds = new Set(LAYOUT.map(e => e.id));

// --- the spec mirrors the balance constants ------------------------------------------------
// One game, two canons by design: Constants.js is what the simulation reads at runtime, GAME_SPEC
// is what an agent, the editor and a migration read. They must not drift — the pairs below are the
// whole numeric surface of the run.
const NUM = {
    'hull.movement': {
        maxSpeed: 'MAX_SPEED', speedPerTier: 'SPEED_PER_TIER', accel: 'ACCEL', reverseFactor: 'REVERSE_FACTOR',
        drag: 'DRAG', turnRate: 'TURN_RATE', turnPerTier: 'TURN_PER_TIER', slopeDrag: 'SLOPE_DRAG'
    },
    'hull.tiers': {
        tier2Mass: 'TIER_MASS_2', tier3Mass: 'TIER_MASS_3', tier4Mass: 'TIER_MASS_4', tier5Mass: 'TIER_MASS_5',
        tier1Slots: ['WB', () => WB.TIER_SLOTS[1]], tier5Slots: ['WB', () => WB.TIER_SLOTS[5]],
        tier1Hull: ['WB', () => WB.TIER_HP[1]], tier5Hull: ['WB', () => WB.TIER_HP[5]]
    },
    'hull.steam': {
        max: 'STEAM_MAX', regen: 'STEAM_REGEN', boostDrain: 'BOOST_DRAIN',
        boostSpeed: 'BOOST_SPEED', boostAccel: 'BOOST_ACCEL', boostRam: 'BOOST_RAM'
    },
    'combat.ram': {
        minSpeed: 'RAM_MIN_SPEED', damage: 'RAM_DMG', refSpeed: 'RAM_REF_SPEED', cooldown: 'RAM_COOLDOWN',
        selfDamage: 'RAM_SELF', knockSelf: 'RAM_KNOCK_SELF', knockOther: 'RAM_KNOCK_OTHER'
    },
    'combat.gunnery': {
        critChance: 'CRIT_CHANCE', critMult: 'CRIT_MULT', targetLead: 'TARGET_LEAD',
        projectileStepMax: 'PROJECTILE_STEP_MAX', fireConeDeg: 'FIRE_CONE_DEG', turretTurn: 'TURRET_TURN',
        hullRegen: 'HULL_REGEN', hullRegenDelay: 'HULL_REGEN_DELAY'
    },
    'devour.mass': {
        pull: 'DEVOUR_PULL', pullRadius: 'DEVOUR_PULL_R', massPerHp: 'MASS_PER_HP',
        scatterMass: 'SCATTER_MASS', healOnDevour: 'HEAL_ON_DEVOUR', chunkShare: ['WB', () => WB.CHUNK_SHARE]
    },
    'economy.scrap': {
        perMass: 'SCRAP_PER_MASS', fortress: 'SCRAP_FORTRESS', warden: 'SCRAP_WARDEN',
        crown: 'SCRAP_CROWN', region: 'SCRAP_REGION'
    },
    'progression.draft': {
        cards: 'DRAFT_CARDS', rerollCost: 'DRAFT_REROLL_COST', skipHeal: 'DRAFT_SKIP_HEAL',
        maxModuleLevel: ['WB', () => WB.MOD_MAX_LEVEL]
    },
    'region.valley': {
        radius: 'REGION_R', wallRadius: 'WALL_R', wallHeight: 'WALL_H', wallStart: 'WALL_START',
        spawnRadius: 'SPAWN_R', count: 'REGION_COUNT', gateFortresses: 'GATE_FORTRESSES',
        enemyScale: 'ENEMY_SCALE', endlessScale: 'ENDLESS_SCALE', sceneryTrees: 'SCENERY_TREES',
        seed: 'SCATTER_SEED', graceSec: ['WB', () => WB.GRACE_SEC]
    },
    'view.budget': {
        radius: 'VIEW_RADIUS', particles: 'PARTICLE_MAX', projectiles: 'PROJECTILE_MAX',
        floatTexts: 'FLOAT_TEXT_MAX', minimapSize: 'MINIMAP_SIZE',
        damageFlash: 'DAMAGE_FLASH', shakeRam: 'SHAKE_RAM', shakeBoom: 'SHAKE_BOOM'
    }
};

test('GAME_SPEC.rules — те же числа, что читает симуляция (no drift)', () => {
    for (const [ruleId, params] of Object.entries(NUM)) {
        const rule = SPEC.rules[ruleId];
        assert.ok(rule, 'правило ' + ruleId + ' объявлено в GAME_SPEC');
        for (const [param, src] of Object.entries(params)) {
            if (!src) continue;
            const want = Array.isArray(src) ? src[1]() : CFG[src];
            assert.equal(rule.params[param], want,
                ruleId + '.' + param + ': GAME_SPEC=' + rule.params[param] + ', источник=' + (Array.isArray(src) ? 'WB' : src) + '=' + want);
        }
    }
});

test('GAME_SPEC.world — геометрия региона из Constants, навигация непрерывная', () => {
    const w = SPEC.world;
    assert.equal(w.size.width, sim.get('LOCATION_WIDTH'));
    assert.equal(w.size.height, sim.get('LOCATION_HEIGHT'));
    const valley = w.zones.find(z => z.id === 'valley-floor');
    const ring = w.zones.find(z => z.id === 'mountain-ring');
    assert.ok(valley && ring, 'долина и горное кольцо описаны зонами');
    assert.equal(valley.data.radius, CFG.REGION_R);
    assert.equal(ring.data.outerRadius, CFG.WALL_R);
    assert.equal(ring.data.height, CFG.WALL_H);
    assert.equal(w.navigation.grid, false, 'долина непрерывна: тайловой сетки у забега нет');
    assert.equal(w.tiles.length, 0, 'тайлы не объявлены — мир симуляции, а не грид');
});

test('семантический UI и сцены ссылаются на существующие элементы UILayout.js', () => {
    for (const el of SPEC.ui.elements) {
        assert.ok(layoutIds.has(el.id), 'GAME_SPEC.ui.elements: нет элемента ' + el.id + ' в js/UILayout.js');
    }
    const sceneIds = new Set(SPEC.scenes.map(s => s.id));
    for (const sc of SPEC.scenes) {
        for (const id of sc.ui || []) assert.ok(layoutIds.has(id), 'сцена ' + sc.id + ': нет элемента ' + id + ' в js/UILayout.js');
        for (const id of sc.entities || []) assert.ok(SPEC.entities.some(e => e.id === id), 'сцена ' + sc.id + ': нет сущности ' + id);
    }
    for (const e of SPEC.entities) {
        if (e.scene) assert.ok(sceneIds.has(e.scene), 'сущность ' + e.id + ': неизвестная сцена ' + e.scene);
    }
    // the gameplay scene follows the player castle — the semantic camera has a real target
    const gameplay = SPEC.scenes.find(s => s.id === 'gameplay');
    assert.equal(gameplay.camera.follow, 'castle');
});

test('аудио-кью и роли реестра: файлы существуют, роли полны по профилям', () => {
    const files = new Set(scanAssets(ROOT));
    for (const cue of SPEC.audio.cues) {
        assert.ok(files.has(cue.asset), 'кью ' + cue.id + ': нет файла ' + cue.asset);
    }
    for (const role of SPEC.assets) {
        for (const [pid, v] of Object.entries(role.variants || {})) {
            if (v.asset) assert.ok(files.has(v.asset), role.role + '[' + pid + ']: нет файла ' + v.asset);
        }
        assert.ok(role.placeholder && role.placeholder.kind, role.role + ': заглушка описана (миграция не упадёт на отсутствии арта)');
    }
    // no imported unit art: the three ground textures are the only files the roles know
    const withFiles = SPEC.assets.filter(r => Object.values(r.variants || {}).some(v => v.asset));
    const roles = new Set(withFiles.map(r => r.role));
    for (const want of ['world.ground.grass.visual', 'world.ground.sand.visual', 'world.ground.snow.visual',
        'prop.tree.visual', 'prop.rock.visual', 'prop.bush.visual', 'structure.village.visual', 'world.gate.visual']) {
        assert.ok(roles.has(want), want + ': роль обеспечена файлом');
    }
    // 3D profiles resolve the flora/gate roles to the CC0 pack, not to a placeholder
    for (const pid of ['isometric3d', 'lowpoly3d', 'full3d']) {
        assert.equal(AssetRegistry.resolve('prop.tree.visual', pid, { entityType: 'prop' }).resolvedBy, 'variant', pid);
    }
});

test('пять вариантов — один проект: contract hash и схема сохранений общие', () => {
    const ids = Variant.ids().sort();
    assert.equal(JSON.stringify(ids),
        JSON.stringify(['2.5d', '2d', 'full3d', 'isometric3d', 'lowpoly3d'].map(p => 'wanderburg-' + p).sort()));
    assert.equal(Variant.defaultId(), 'wanderburg-lowpoly3d', 'отгружаемая презентация — lowpoly3d');
    const contract = GameModel.contractHash();
    const schema = Save.schemaHash();
    for (const id of ids) {
        Variant.activate(id, { apply: false });
        assert.equal(GameModel.contractHash(), contract, id + ': другой контракт — это другая игра');
        assert.equal(Save.schemaHash(), schema, id + ': схема сохранений общая');
        assert.ok(RenderProfile.info(Variant.profileOf(id)), id);
    }
    Variant.activate('wanderburg-lowpoly3d', { apply: false });
});

test('отгружаемый вариант повторяет авторский вид из Constants.js (камера, шейдинг)', () => {
    const v = Variant.get('wanderburg-lowpoly3d');
    assert.equal(v.camera.azimuthDeg, sim.get('CAMERA_AZIMUTH_DEG'));
    assert.equal(v.camera.elevationDeg, sim.get('CAMERA_PITCH_DEG'));
    assert.equal(v.camera.fovDeg, sim.get('CAMERA_FOV_DEG'));
    assert.equal(v.camera.zoomMin, sim.get('CAMERA_ZOOM_MIN'));
    assert.equal(v.camera.zoomMax, sim.get('CAMERA_ZOOM_MAX'));
    assert.equal(v.camera.zoom, undefined, 'zoom остаётся за игрой (CAMERA_ZOOM / CAMERA_ZOOM_MOBILE)');
    assert.equal(v.camera.follow, null, 'follow ведёт Game.js (камера — хозяин оркестратор)');
    assert.equal(v.lighting.toon, sim.get('WORLD3D_TOON'));
    assert.equal(v.lighting.ink, sim.get('WORLD3D_TOON_INK'));
    assert.equal(v.lighting.outline, sim.get('WORLD3D_TOON_OUTLINE'));
    assert.equal(v.lighting.shadows, 0, 'карты теней нет: у корпусов свои blob-тени (WanderView)');
    assert.equal(v.environment.flatten, 0, 'горное кольцо — часть геймплея: ни один профиль не плоскает мир');
    // applying it must not move the authored look: the effective shading equals the constants
    const cfg = Variant.effective('wanderburg-lowpoly3d');
    assert.equal(cfg.lighting.preset, 'lowpoly');
});

test('симуляция не знает рендера, картина не знает симуляцию изнутри', () => {
    const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, ''));
    const logic = code('js/Logic.js');
    const content = code('js/Content.js');
    for (const [name, lines] of [['Logic.js', logic], ['Content.js', content]]) {
        for (const bad of ['pc.', 'World3D.', 'Location3D.', 'Terrain3D.', 'document.', 'window.']) {
            const hit = lines.map((l, i) => [i + 1, l]).find(([, l]) => l.includes(bad));
            assert.ok(!hit, name + ' строка ' + (hit && hit[0]) + ': симуляция не трогает ' + bad);
        }
    }
    // and the orchestrator keeps the kit's agent-facing contract plus the pipeline's
    const gameSrc = fs.readFileSync(path.join(ROOT, 'js/Game.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(gameSrc, /mirrorModel\(\)/, 'Game.js зеркалит симуляцию в GameModel');
    assert.match(gameSrc, /Game\.CASTLE_ID = 'castle'/, 'стабильные id сущностей объявлены');
    for (const bad of ['pc.', 'World3D.', 'Model3D.', 'Sprite2D.']) {
        assert.ok(!gameSrc.split('\n').map(l => l.replace(/\/\/.*$/, '')).some(l => l.includes(bad)), 'Game.js не трогает ' + bad);
    }
    // the spec says how the project presents itself: both modelled entities are self-presented
    for (const e of SPEC.entities) {
        assert.equal(e.visual.representation, 'none', e.id + ': игру рисует js/WanderView.js, пайплайн — нет');
        assert.ok(e.visual.role && AssetRegistry.has(e.visual.role), e.id + ': роль ' + e.visual.role + ' есть в реестре');
    }
});
