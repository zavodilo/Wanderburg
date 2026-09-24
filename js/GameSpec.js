// GameSpec.js — the MASTER PROJECT's game model (GAME_SPEC): Wanderburg.
//
// This is the single source of truth for the game: rules, systems, world, entities, scenes,
// assets (semantic roles), UI, audio, input, progression and the save schema. It is
// renderer-independent by construction — no profile, no camera, no file format, no engine
// object appears in the gameplay parts of it. Shape: manifest/game-schema.json.
//
// HOW THIS PROJECT PRESENTS ITSELF (read before touching `visual` blocks):
// Wanderburg draws its own world. js/Logic.js owns the truth (a seeded simulation of the
// valley, the hulls, the projectiles, the devouring) and js/WanderView.js + js/WanderMesh.js
// build hand-made low-poly meshes for it on top of the kit's engine layer (World3D, Terrain3D,
// Procedural3D). Every entity below therefore declares `representation: 'none'` — "this
// project presents the entity itself" — so the pipeline never draws a second copy of a castle.
// The asset registry roles are kept complete on purpose: they are the machine-readable TARGET
// of a migration (`arc variant convert --source wanderburg-2d --profile full3d`), telling the
// pipeline what each entity type becomes in a profile where the kit presents entities.
//
// The shipped presentation is the lowpoly3d profile: perspective camera, low-poly meshes,
// flat stylized materials with toon bands, one directional light, mobile budgets. The variant
// `wanderburg-lowpoly3d` carries exactly the camera and lighting numbers Constants.js uses,
// so applying the pipeline changes nothing visible — it documents and checks the look.
//
// Coordinates are canonical everywhere — x horizontal, y height, z depth. The simulation's own
// map space is the kit's mirror of that (x, y = depth, height separate): Coords.toMap/fromMap
// convert, and the mirror of a logical entity is written through Coords (js/Game.js).
//
// The editor writes this file (POST /api/save-spec) and tools/variants.mjs regenerates the
// variant/project files from it — keep GAME_SPEC a plain literal object.

/** @satisfies {Record<string, any>} */
const GAME_SPEC = {
    id: 'wanderburg',
    title: 'Wanderburg',
    specVersion: 1,

    // The project's DEFAULT profile. Which variant a runtime instance presents comes from the
    // launch (/?variant=…, `arc run --variant …`) or from project.json's defaultVariant.
    renderProfile: 'lowpoly3d',
    renderProfileReason: 'the game ships hand-built low-poly meshes (js/WanderMesh.js) under a perspective camera with toon bands, ink edges, one directional light and a mobile frame budget — that is the lowpoly3d profile verbatim; isometric3d would force an orthographic lens the camera rig and the mountain-ring composition are not authored for, and full3d would promise PBR/post-effects the stylized look deliberately avoids',
    genre: 'action roguelike — a mobile fortress devours the valley',

    // --- rules: the numbers the simulation reads (never presentation) ------------------------
    // Canon for a run: Constants.js (WANDER_*, read through WB.num/WB.CFG). These params are
    // the same numbers as the semantic contract — tests/wanderburg.test.mjs fails when the two
    // drift, so a balance edit in the editor is a spec edit too.
    rules: {
        'hull.movement': {
            id: 'hull.movement', description: 'a walking fortress: top speed falls with the hull tier, hills and mass slow it',
            params: { maxSpeed: 205, speedPerTier: 11, accel: 235, reverseFactor: 0.45, drag: 1.5, turnRate: 2.15, turnPerTier: 0.17, slopeDrag: 2.6 }
        },
        'hull.tiers': {
            id: 'hull.tiers', description: 'devoured mass raises the hull tier 1→5: bigger, tougher, more module slots',
            params: { tier2Mass: 240, tier3Mass: 620, tier4Mass: 1100, tier5Mass: 1750, tier1Slots: 4, tier5Slots: 8, tier1Hull: 500, tier5Hull: 1850 }
        },
        'hull.steam': {
            id: 'hull.steam', description: 'the boiler: stoking it (Shift/Space) buys speed and a harder ram, and drains the tank',
            params: { max: 100, regen: 17, boostDrain: 34, boostSpeed: 1.72, boostAccel: 2.1, boostRam: 1.5 }
        },
        'combat.ram': {
            id: 'combat.ram', description: 'the hull itself is a weapon: a ram above the minimum speed damages both castles',
            params: { minSpeed: 72, damage: 26, refSpeed: 150, cooldown: 0.5, selfDamage: 0.22, knockSelf: 0.45, knockOther: 0.7 }
        },
        'combat.gunnery': {
            id: 'combat.gunnery', description: 'modules shoot: fixed ones fire inside an arc of their side, turrets track, shells substep against tunnelling',
            params: { critChance: 0.06, critMult: 1.7, targetLead: 1, projectileStepMax: 34, fireConeDeg: 150, turretTurn: 3.4, hullRegen: 10, hullRegenDelay: 7 }
        },
        'devour.mass': {
            id: 'devour.mass', description: 'everything eaten breaks into debris, the debris is vacuumed into the hull and becomes mass',
            params: { pull: 420, pullRadius: 190, massPerHp: 0.16, scatterMass: 2, healOnDevour: 0.02, chunkShare: 0.34 }
        },
        'economy.scrap': {
            id: 'economy.scrap', description: 'legacy scrap: the meta-currency a run earns and the legacy shop spends',
            params: { perMass: 0.006, fortress: 16, warden: 70, crown: 200, region: 45 }
        },
        'progression.draft': {
            id: 'progression.draft', description: 'every hull tier opens a draft: four blueprints, a reroll costs mass, skipping heals',
            params: { cards: 4, rerollCost: 22, skipHeal: 0.12, maxModuleLevel: 3 }
        },
        'region.valley': {
            id: 'region.valley', description: 'a run is four valleys (the fourth is the Iron Crown); each is a round region ringed by impassable mountains',
            params: { radius: 900, wallRadius: 990, wallHeight: 250, wallStart: 0.8, spawnRadius: 0.52, count: 4, gateFortresses: 1, enemyScale: 1.38, endlessScale: 1.18, sceneryTrees: 340, seed: 1337, graceSec: 14 }
        },
        'view.budget': {
            id: 'view.budget', description: 'what the presentation is allowed to spend per frame (pools and the cull radius)',
            params: { radius: 1500, particles: 240, projectiles: 90, floatTexts: 14, minimapSize: 168, damageFlash: 0.5, shakeRam: 9, shakeBoom: 16 }
        }
    },

    // --- systems: what runs, in which order. Implementations live in js/Game.js ---------------
    systems: [
        { id: 'input', phase: 'input', description: 'throttle / rudder / steam from the keys or the touch stick' },
        { id: 'region', phase: 'logic', description: 'generate a valley from the run seed, advance regions, open the warden gate' },
        { id: 'simulation', phase: 'logic', description: 'WB.Run.update: hulls, modules, projectiles, devouring, the enemy AI' },
        { id: 'progression', phase: 'logic', description: 'mass → hull tier → the draft; scrap → the legacy shop' },
        { id: 'events', phase: 'resolve', description: 'the simulation event list → reactions: toast, shake, draft, region end, run end' },
        { id: 'model-mirror', phase: 'resolve', description: 'the player castle and the warden gate are mirrored into GameModel (stable ids, one save schema)' },
        { id: 'view', phase: 'present', description: 'js/WanderView.js draws the simulation truth (entities are self-presented)' },
        { id: 'audio', phase: 'present', description: 'js/WanderAudio.js sounds the events: 36 synthesized cues, music per biome' },
        { id: 'hud', phase: 'present', description: 'js/Hud.js feeds the HUD (UILayout.js records) from the model' }
    ],

    // --- the logical world: one valley for every profile --------------------------------------
    // The valley is CONTINUOUS, not a tile grid: the simulation walks a circle of regionRadius
    // and the mountain ring is an analytic ramp (WBRegion.wallAt/inside). navigation.grid is
    // therefore false and `tiles` stays empty — the zones below are the machine-readable shape.
    world: {
        id: 'valley',
        size: { width: 2048, height: 2048 },
        tileSize: 64,
        height: { base: 0, amplitude: 46 },
        tiles: [],
        rects: [],
        zones: [
            { id: 'valley-floor', kind: 'playable', x: 1024, z: 1024, w: 1800, h: 1800, data: { shape: 'circle', radius: 900, note: 'the playable valley: four biomes reuse this shape' } },
            { id: 'mountain-ring', kind: 'wall', x: 1024, z: 1024, w: 1980, h: 1980, data: { shape: 'ring', innerRadius: 720, outerRadius: 990, height: 250, note: 'impassable: the ring rises from 0.8·radius to its full height at 990 px' } },
            { id: 'warden-courtyard', kind: 'landmark', x: 1024, z: 1024, w: 480, h: 480, data: { shape: 'circle', radius: 240, note: 'kept clear by the generator: the boss fight needs room' } }
        ],
        triggers: [
            { id: 'warden-gate', x: 1024, z: 1024, r: 220, event: 'warden.approach', once: false },
            { id: 'rim-warning', x: 1024, z: 1024, r: 900, event: 'region.rim', once: false }
        ],
        spawns: [
            { id: 'player-spawn', kind: 'player', x: 1024, y: 0, z: 553 },
            { id: 'warden-gate-spawn', kind: 'generic', x: 1024, y: 0, z: 1290 },
            { id: 'fortress-belt', kind: 'enemy', x: 1024, y: 0, z: 1024 },
            { id: 'food-belt', kind: 'generic', x: 1024, y: 0, z: 1024 }
        ],
        props: [],
        navigation: { grid: false, diagonal: true }
    },

    // --- entities: stable ids, shared by every variant ----------------------------------------
    // Only the actors that outlive a frame of the simulation are modelled here: the player's
    // castle and the region's warden gate. Everything else (villages, herds, nodes, knights,
    // wagons, roaming fortresses, debris, shells) is generated per region from the run seed and
    // lives in the simulation — js/Game.js mirrors the two below into GameModel every frame, so
    // Save/inspect/gameplayHash speak about real state, not about a snapshot.
    entities: [
        {
            id: 'castle', type: 'vehicle', name: 'Замок на колёсах', tags: ['player', 'castle', 'hull'],
            scene: 'gameplay',
            position: { x: 1024, y: 0, z: 553 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            logic: { hull: 500, maxHull: 500, mass: 0, tier: 1, steam: 100, speed: 0, heading: 0, slots: 4, modules: 0, region: 0 },
            components: {
                Hull: { max: 500, current: 500, tier: 1, regen: 10, regenDelay: 7 },
                Steam: { max: 100, current: 100, regen: 17, boostDrain: 34 },
                Mass: { current: 0, tiers: [0, 0, 240, 620, 1100, 1750] },
                Modules: { slots: 4, items: [] },
                Ram: { minSpeed: 72, damage: 26, cooldown: 0.5 }
            },
            // Self-presented: js/WanderView.js builds the hull, its modules and its blob shadow
            // from Procedural3D/WanderMesh geometry. The role below is the migration target.
            visual: { role: 'player.castle.visual', representation: 'none', renderLayer: 'actors', animation: { default: 'idle', states: ['idle', 'roll', 'boost', 'hurt', 'death'] } }
        },
        {
            id: 'warden-gate', type: 'structure', name: 'Врата вардена', tags: ['gate', 'boss', 'objective'],
            scene: 'gameplay',
            position: { x: 1024, y: 0, z: 1290 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            logic: { open: false, hp: Infinity, radius: 46, region: 0 },
            components: { Interactable: { radius: 220, action: 'enter-region' }, Objective: { requires: 'fortresses nearly extinct' } },
            visual: { role: 'world.gate.visual', representation: 'none', renderLayer: 'world' }
        }
    ],

    // --- scenes: one game, its screens ---------------------------------------------------------
    // All of them are the SAME profile: Wanderburg presents its menus over the living valley
    // (the attract run rolls behind the title), so a menu is a camera + HUD state, not a
    // renderer switch. renderProfile null — the project profile.
    scenes: [
        { id: 'gameplay', title: 'Долина', kind: 'gameplay', renderProfile: null, camera: { mode: 'thirdPerson', follow: 'castle' }, entities: ['castle', 'warden-gate'], ui: ['hudPanel', 'hudTier', 'hudHull', 'hudSteam', 'hudMass', 'hudMassTxt', 'hudRegion', 'hudObjective', 'hudScrap', 'minimap', 'threat', 'toastPanel', 'toast', 'hintBar', 'fps'] },
        { id: 'boss', title: 'Варден', kind: 'gameplay', renderProfile: null, camera: { mode: 'thirdPerson', follow: 'castle' }, entities: ['castle', 'warden-gate'], ui: ['hudPanel', 'hudHull', 'hudSteam', 'hudMass', 'bossPanel', 'bossBar', 'bossName', 'minimap', 'toastPanel', 'toast', 'fps'] },
        { id: 'main-menu', title: 'Титул', kind: 'menu', renderProfile: null, camera: { mode: 'orbit', follow: 'castle' }, entities: ['castle'], ui: ['titleBig', 'titleSub', 'titleVer', 'btnStart', 'btnLoadout', 'btnLegacy', 'btnHelp', 'btnSettings', 'titleScrap', 'titleStats', 'titleHint', 'fps'] },
        { id: 'loadout', title: 'Снаряжение', kind: 'menu', renderProfile: null, camera: { mode: 'orbit', follow: null }, entities: [], ui: ['loadTitle', 'loadChassisP', 'loadChassisH', 'loadChassisN', 'loadChassisD', 'loadChassisS', 'loadChassisB', 'loadCaptainP', 'loadCaptainH', 'loadCaptainN', 'loadCaptainD', 'loadCaptainB', 'loadSeed', 'btnRoll', 'btnGo', 'btnBackLoad'] },
        { id: 'legacy', title: 'Наследие', kind: 'menu', renderProfile: null, camera: { mode: 'orbit', follow: null }, entities: [], ui: ['legTitle', 'legScrap', 'legListP', 'legList', 'legHint', 'legUp', 'legDown', 'legBuy', 'legBack', 'legWipe'] },
        { id: 'draft', title: 'Чертёж', kind: 'overlay', renderProfile: null, camera: { mode: 'thirdPerson', follow: 'castle' }, entities: ['castle'], ui: ['draftDim', 'draftTitle', 'draftSub', 'cardP1', 'cardN1', 'cardL1', 'cardD1', 'cardS1', 'cardB1', 'cardP2', 'cardN2', 'cardL2', 'cardD2', 'cardS2', 'cardB2', 'cardP3', 'cardN3', 'cardL3', 'cardD3', 'cardS3', 'cardB3', 'cardP4', 'cardN4', 'cardL4', 'cardD4', 'cardS4', 'cardB4', 'draftReroll', 'draftSkip', 'draftNote'] },
        { id: 'pause', title: 'Пауза', kind: 'overlay', renderProfile: null, camera: { mode: 'thirdPerson', follow: 'castle' }, entities: ['castle'], ui: ['pauseTitle', 'pauseResume', 'pauseRestart', 'pauseSettings', 'pauseMenu'] },
        { id: 'settings', title: 'Настройки', kind: 'overlay', renderProfile: null, camera: null, entities: [], ui: ['setTitle', 'setPanel', 'setList', 'setPrev', 'setNext', 'setBack'] },
        { id: 'help', title: 'Правила и клавиши', kind: 'overlay', renderProfile: null, camera: null, entities: [], ui: ['helpTitle', 'helpPanel', 'helpText', 'helpBack'] },
        { id: 'run-over', title: 'Итог забега', kind: 'overlay', renderProfile: null, camera: { mode: 'orbit', follow: null }, entities: [], ui: ['endDim', 'endTitle', 'endPanel', 'endStats', 'endMods', 'endScrap', 'endAgain', 'endMenu', 'winTitle', 'winText', 'winEndless', 'winMenu'] }
    ],

    // --- the semantic asset registry: roles, not files ------------------------------------------
    // Wanderburg imports NO unit art: every mesh is built in code (js/WanderMesh.js) from
    // Procedural3D geometry, and every sound is synthesized (tools/make-wander-sounds.mjs). The
    // only files are the kit's three ground textures, declared as world.ground.* roles below.
    // A role with no variant for the active profile resolves through the fallback chain to a
    // GENERATED placeholder (AssetRegistry.placeholder) — a migration therefore never fails on
    // missing art, and `arc variant convert --write-placeholders` can materialize it.
    assets: [
        {
            role: 'player.castle.visual', kind: 'visual', entityType: 'vehicle',
            placeholder: { kind: 'box', color: '#9aa0a6', label: 'castle', size: [120, 90] },
            tags: ['player', 'hull']
        },
        {
            role: 'enemy.fortress.visual', kind: 'visual', entityType: 'vehicle',
            placeholder: { kind: 'box', color: '#8f2f2a', label: 'fortress', size: [110, 84] },
            tags: ['enemy', 'roaming']
        },
        {
            role: 'enemy.warden.visual', kind: 'visual', entityType: 'vehicle',
            placeholder: { kind: 'box', color: '#5c1e1b', label: 'warden', size: [170, 130] },
            tags: ['enemy', 'boss']
        },
        {
            role: 'unit.knight.visual', kind: 'visual', entityType: 'character',
            placeholder: { kind: 'capsule', color: '#4b5158', label: 'knight', size: [26, 44] },
            tags: ['enemy', 'ground']
        },
        {
            role: 'structure.village.visual', kind: 'visual', entityType: 'structure',
            placeholder: { kind: 'box', color: '#7d5636', label: 'village', size: [70, 60] },
            tags: ['food', 'devourable']
        },
        {
            role: 'structure.node.visual', kind: 'visual', entityType: 'structure',
            placeholder: { kind: 'rock', color: '#7c7f84', label: 'node', size: [64, 48] },
            tags: ['food', 'quarry', 'mine', 'lumber']
        },
        {
            role: 'world.gate.visual', kind: 'visual', entityType: 'structure',
            placeholder: { kind: 'pole', color: '#d8ab52', label: 'gate', size: [92, 120] },
            tags: ['objective']
        },
        {
            role: 'creature.herd.visual', kind: 'visual', entityType: 'creature',
            placeholder: { kind: 'box', color: '#e8e4da', label: 'herd', size: [22, 18] },
            tags: ['food', 'fleeing']
        },
        {
            role: 'item.chunk.visual', kind: 'visual', entityType: 'item',
            placeholder: { kind: 'crate', color: '#a87a4c', label: 'chunk', size: [12, 12] },
            tags: ['debris', 'mass']
        },
        {
            role: 'projectile.shell.visual', kind: 'visual', entityType: 'projectile',
            placeholder: { kind: 'debug', color: '#f0c75e', label: 'shell', size: [8, 8] },
            tags: ['combat']
        },
        {
            role: 'prop.tree.visual', kind: 'visual', entityType: 'prop',
            placeholder: { kind: 'tree', color: '#3f7a34', label: 'tree', size: [40, 70] },
            tags: ['scenery', 'batched']
        },
        {
            role: 'prop.rock.visual', kind: 'visual', entityType: 'prop',
            placeholder: { kind: 'rock', color: '#7c7f84', label: 'rock', size: [34, 26] },
            tags: ['scenery', 'batched']
        },
        {
            role: 'prop.bush.visual', kind: 'visual', entityType: 'prop',
            placeholder: { kind: 'crate', color: '#8a7a34', label: 'bush', size: [24, 18] },
            tags: ['scenery', 'batched']
        },
        {
            role: 'world.ground.grass.visual', kind: 'visual', entityType: 'terrain',
            variants: {
                '2d': { type: 'sprite', asset: 'assets/ground_texture_g.jpg' },
                '2.5d': { type: 'sprite', asset: 'assets/ground_texture_g.jpg' },
                isometric3d: { type: 'terrain', asset: 'assets/ground_texture_g.jpg' },
                lowpoly3d: { type: 'terrain', asset: 'assets/ground_texture_g.jpg' },
                full3d: { type: 'terrain', asset: 'assets/ground_texture_g.jpg' }
            },
            placeholder: { kind: 'tile', color: '#4c7a3a', label: 'grass' },
            tags: ['biome:marches']
        },
        {
            role: 'world.ground.sand.visual', kind: 'visual', entityType: 'terrain',
            variants: {
                '2d': { type: 'sprite', asset: 'assets/ground_texture_s.jpg' },
                '2.5d': { type: 'sprite', asset: 'assets/ground_texture_s.jpg' },
                isometric3d: { type: 'terrain', asset: 'assets/ground_texture_s.jpg' },
                lowpoly3d: { type: 'terrain', asset: 'assets/ground_texture_s.jpg' },
                full3d: { type: 'terrain', asset: 'assets/ground_texture_s.jpg' }
            },
            placeholder: { kind: 'tile', color: '#c2a878', label: 'sand' },
            tags: ['biome:steppe']
        },
        {
            role: 'world.ground.snow.visual', kind: 'visual', entityType: 'terrain',
            variants: {
                '2d': { type: 'sprite', asset: 'assets/ground_texture_d.jpg' },
                '2.5d': { type: 'sprite', asset: 'assets/ground_texture_d.jpg' },
                isometric3d: { type: 'terrain', asset: 'assets/ground_texture_d.jpg' },
                lowpoly3d: { type: 'terrain', asset: 'assets/ground_texture_d.jpg' },
                full3d: { type: 'terrain', asset: 'assets/ground_texture_d.jpg' }
            },
            placeholder: { kind: 'tile', color: '#dfe8ee', label: 'snow' },
            tags: ['biome:frost', 'biome:crown']
        }
    ],

    // --- UI: one semantic definition, the profile only changes presentation ----------------------
    // The full layout (position, size, color of every element) is js/UILayout.js — the editor's
    // UI tab writes it. Listed here are the elements the game model binds to, by screen.
    ui: {
        space: 'screen',
        elements: [
            { id: 'titleBig', role: 'branding', binds: 'game.title' },
            { id: 'titleScrap', role: 'counter', binds: 'meta.scrap' },
            { id: 'titleStats', role: 'stats', binds: 'meta.stats' },
            { id: 'titleHint', role: 'help', binds: 'input.hints' },
            { id: 'btnStart', role: 'action', binds: 'scene.gameplay' },
            { id: 'hudPanel', role: 'chrome' },
            { id: 'hudTier', role: 'counter', binds: 'castle.tier' },
            { id: 'hudHull', role: 'meter', binds: 'castle.hull' },
            { id: 'hudSteam', role: 'meter', binds: 'castle.steam' },
            { id: 'hudMass', role: 'meter', binds: 'castle.mass' },
            { id: 'hudMassTxt', role: 'counter', binds: 'castle.mass' },
            { id: 'hudRegion', role: 'label', binds: 'region.name' },
            { id: 'hudObjective', role: 'help', binds: 'region.objective' },
            { id: 'hudScrap', role: 'counter', binds: 'run.scrap' },
            { id: 'bossBar', role: 'meter', binds: 'warden.hull' },
            { id: 'bossName', role: 'label', binds: 'warden.name' },
            { id: 'minimap', role: 'map', binds: 'region.entities' },
            { id: 'threat', role: 'warning', binds: 'region.threats' },
            { id: 'toast', role: 'toast', binds: 'events.toasts' },
            { id: 'hintBar', role: 'help', binds: 'input.hints' },
            { id: 'draftTitle', role: 'label', binds: 'draft.tier' },
            { id: 'cardN1', role: 'card', binds: 'draft.cards[0]' },
            { id: 'cardN2', role: 'card', binds: 'draft.cards[1]' },
            { id: 'cardN3', role: 'card', binds: 'draft.cards[2]' },
            { id: 'cardN4', role: 'card', binds: 'draft.cards[3]' },
            { id: 'draftReroll', role: 'action', binds: 'draft.reroll' },
            { id: 'draftSkip', role: 'action', binds: 'draft.skip' },
            { id: 'legList', role: 'list', binds: 'meta.legacy' },
            { id: 'legScrap', role: 'counter', binds: 'meta.scrap' },
            { id: 'endStats', role: 'stats', binds: 'run.stats' },
            { id: 'endScrap', role: 'counter', binds: 'run.scrap' },
            { id: 'fps', role: 'debug', binds: 'runtime.fps' },
            { id: 'joyBase', role: 'touch', binds: 'input.stick' },
            { id: 'btnBoost', role: 'touch', binds: 'input.boost' }
        ]
    },

    // --- audio: cues by id (every file is synthesized by tools/make-wander-sounds.mjs) -----------
    audio: {
        channels: ['master', 'music', 'sfx'],
        cues: [
            { id: 'shotSmall', asset: 'assets/sounds/shot_small.wav', volume: 0.5, spatial: true },
            { id: 'shotBig', asset: 'assets/sounds/shot_big.wav', volume: 0.6, spatial: true },
            { id: 'shotRapid', asset: 'assets/sounds/shot_rapid.wav', volume: 0.35, spatial: true },
            { id: 'shotArcane', asset: 'assets/sounds/shot_arcane.wav', volume: 0.5, spatial: true },
            { id: 'shotMortar', asset: 'assets/sounds/shot_mortar.wav', volume: 0.6, spatial: true },
            { id: 'shotFlame', asset: 'assets/sounds/shot_flame.wav', volume: 0.45, spatial: true },
            { id: 'shotTesla', asset: 'assets/sounds/shot_tesla.wav', volume: 0.45, spatial: true },
            { id: 'impact', asset: 'assets/sounds/impact.wav', volume: 0.5, spatial: true },
            { id: 'boomSmall', asset: 'assets/sounds/boom_small.wav', volume: 0.55, spatial: true },
            { id: 'boomBig', asset: 'assets/sounds/boom_big.wav', volume: 0.7, spatial: true },
            { id: 'ram', asset: 'assets/sounds/ram.wav', volume: 0.7, spatial: true },
            { id: 'gulp', asset: 'assets/sounds/gulp.wav', volume: 0.5, spatial: true },
            { id: 'chew', asset: 'assets/sounds/chew.wav', volume: 0.45, spatial: true },
            { id: 'crumble', asset: 'assets/sounds/crumble.wav', volume: 0.55, spatial: true },
            { id: 'scream', asset: 'assets/sounds/scream.wav', volume: 0.4, spatial: true },
            { id: 'knight', asset: 'assets/sounds/knight.wav', volume: 0.45, spatial: true },
            { id: 'hurt', asset: 'assets/sounds/hurt.wav', volume: 0.6, spatial: false },
            { id: 'repair', asset: 'assets/sounds/repair.wav', volume: 0.45, spatial: false },
            { id: 'steam', asset: 'assets/sounds/steam.wav', volume: 0.4, spatial: false, loop: true },
            { id: 'rumble', asset: 'assets/sounds/rumble.wav', volume: 0.35, spatial: false, loop: true },
            { id: 'tierUp', asset: 'assets/sounds/tier_up.wav', volume: 0.7, spatial: false },
            { id: 'draft', asset: 'assets/sounds/draft.wav', volume: 0.55, spatial: false },
            { id: 'take', asset: 'assets/sounds/take.wav', volume: 0.55, spatial: false },
            { id: 'deny', asset: 'assets/sounds/deny.wav', volume: 0.5, spatial: false },
            { id: 'horn', asset: 'assets/sounds/horn.wav', volume: 0.65, spatial: false },
            { id: 'clear', asset: 'assets/sounds/clear.wav', volume: 0.6, spatial: false },
            { id: 'victory', asset: 'assets/sounds/victory.wav', volume: 0.75, spatial: false },
            { id: 'death', asset: 'assets/sounds/death.wav', volume: 0.75, spatial: false },
            { id: 'click', asset: 'assets/sounds/ui_click.wav', volume: 0.4, spatial: false },
            { id: 'buy', asset: 'assets/sounds/ui_buy.wav', volume: 0.5, spatial: false },
            { id: 'err', asset: 'assets/sounds/ui_error.wav', volume: 0.45, spatial: false },
            { id: 'musicMenu', asset: 'assets/sounds/music_menu.wav', volume: 0.3, spatial: false, loop: true },
            { id: 'musicMarch', asset: 'assets/sounds/music_march.wav', volume: 0.3, spatial: false, loop: true },
            { id: 'musicSteppe', asset: 'assets/sounds/music_steppe.wav', volume: 0.3, spatial: false, loop: true },
            { id: 'musicFrost', asset: 'assets/sounds/music_frost.wav', volume: 0.3, spatial: false, loop: true },
            { id: 'musicBoss', asset: 'assets/sounds/music_boss.wav', volume: 0.32, spatial: false, loop: true }
        ]
    },

    // --- input: actions and their bindings (never keys inside gameplay code) ----------------------
    // js/Game.js binds these plus the touch stick; the semantic map is what an agent, the editor
    // and a rebind UI read. 'move' is the canonical x/z axis (north is −z), throttle/steer are
    // the two halves the hull model actually consumes.
    input: {
        actions: {
            move: ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'],
            throttle: ['KeyW', 'ArrowUp', 'KeyS', 'ArrowDown'],
            steer: ['KeyA', 'ArrowLeft', 'KeyD', 'ArrowRight'],
            boost: ['ShiftLeft', 'ShiftRight', 'Space'],
            pause: ['Escape', 'KeyP'],
            cancel: ['Escape'],
            confirm: ['Enter'],
            help: ['KeyH'],
            mute: ['KeyM'],
            hud: ['Tab'],
            recenter: ['KeyR', 'KeyF'],
            draft1: ['Digit1', 'Numpad1'],
            draft2: ['Digit2', 'Numpad2'],
            draft3: ['Digit3', 'Numpad3'],
            draft4: ['Digit4', 'Numpad4'],
            reroll: ['KeyR'],
            navigate: ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'PageUp', 'PageDown'],
            page: ['PageUp', 'PageDown']
        },
        planes: { move: 'xz', throttle: 'none', steer: 'none', look: 'xy', aim: 'xz' }
    },

    // Meta-progression: scrap is the currency, the legacy shop (30 entries in js/Content.js)
    // spends it between runs. The hull tier is the in-run level, mass is its experience.
    progression: {
        level: 1,
        xp: 0,
        xpToLevel: [240, 620, 1100, 1750],
        unlocks: [],
        currencies: { scrap: 0, mass: 0 }
    },

    // --- the save schema: identical in every variant, so a save loads anywhere -------------------
    // Two stores, one contract: the kit's Save.* serializes the model below (slot
    // 'wanderburg.save.v1'), and WB.Save persists the meta-progression of the game (scrap,
    // legacy, settings, stats) under the SAME key in Store — never localStorage directly.
    saveState: {
        schemaVersion: 1,
        slot: 'wanderburg.save.v1',
        fields: ['progression', 'entities', 'world', 'kit', 'activeScene'],
        entityFields: ['id', 'position', 'rotation', 'logic', 'components']
    },

    // Filled by Migration.convert: every conversion of this project, newest last.
    visualMigrationJournal: []
};
