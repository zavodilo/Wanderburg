// Content.js — Wanderburg's data tables: biomes, hull chassis, captains, modules, the legacy
// (meta-progression) shop and the enemy loadouts. Pure data + a couple of pure helpers, no
// engine calls: the simulation (js/Logic.js), the renderer (js/WanderView.js) and the HUD
// (js/Hud.js) all read the same tables, so a balance edit never needs a code edit.
//
// Numbers that TUNE the whole game live in Constants.js (WANDER_*); numbers that describe ONE
// thing (this module, this biome) live here.

// The game's one namespace. `any` on purpose: WB is built up across four files (Content, Logic,
// WanderView, Hud) and a JSDoc-checked classic script cannot describe that shape incrementally
// the way the kit's own objects (Scene, UI, World3D) do with a single literal.
const WB = /** @type {any} */ ({});

// --- Colors -------------------------------------------------------------------
// One palette for the whole game: the renderer reads it, the HUD reads it, so a biome or a
// faction never drifts out of sync. Hex numbers (0xRRGGBB) for the 3D, '#rrggbb' for the DOM.
WB.PAL = {
    stone: 0x9aa0a6, stoneDark: 0x6d747b, stoneLight: 0xc3c8cc,
    wood: 0x7d5636, woodDark: 0x553a24, woodLight: 0xa87a4c,
    iron: 0x4b5158, ironDark: 0x33383d, ironLight: 0x6f767e,
    copper: 0xb5793a, brass: 0xd8ab52, gold: 0xf0c75e,
    roof: 0x9c4436, roofDark: 0x6f2f26, thatch: 0xc8a24e,
    banner: 0x2f5f9e, bannerDark: 0x1d3d68,
    enemy: 0x8f2f2a, enemyDark: 0x5c1e1b, enemyIron: 0x3b3f45,
    arcane: 0x63c8e8, arcaneDeep: 0x2f7fa8, flame: 0xf08a2e, poison: 0x8ec63f,
    leaf: 0x3f7a34, leafDark: 0x2c5726, leafDry: 0x8a7a34, leafFrost: 0x5c7a63,
    trunk: 0x54402c, rock: 0x7c7f84, rockDark: 0x5a5d62,
    wool: 0xe8e4da, hide: 0x4a4038,
    peasant: 0xd8b48a, peasantCloth: 0x4f6f8f,
    steel: 0xcfd6dc, smoke: 0x8e949a, blood: 0x8e2b23,
    white: 0xf2f4f5, black: 0x1a1c1e
};

/** Linear mix of two 0xRRGGBB colors (t: 0 — a, 1 — b): the CC0 pack's own palette meets the biome's. */
WB.mixHex = (a, b, t) => {
    const k = WB.M.clamp(t == null ? 0.5 : t, 0, 1);
    const ch = (sh) => Math.round((((a >> sh) & 255) * (1 - k)) + (((b >> sh) & 255) * k));
    return ((ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
};

/** 0xRRGGBB -> '#rrggbb' for the DOM HUD. */
WB.css = (hex) => '#' + ('000000' + (hex >>> 0).toString(16)).slice(-6);

// --- Biomes -------------------------------------------------------------------
// ground — an index into Location3D.GROUNDS (0 grass, 1 sand, 2 snow); the paths stay
// literals there, so the asset scanner still sees them.
// render — overrides of the kit's render constants for this biome's mood; WanderView merges
// them over World3D.cfg() and calls view.applyLighting(cfg).
WB.BIOMES = [
    {
        id: 'marches', name: 'Зелёные Рубежи', subtitle: 'Плодородная долина, где деревни ещё надеются',
        ground: 0, villages: 11, herds: 7, nodes: 5, fortresses: 4, knights: 9, wrecks: 5,
        terrain: { amp: 46, scale: 640, seed: 11 },
        scenery: { tree: 0.62, rock: 0.2, bush: 0.18 },
        treeColor: WB.PAL.leaf, rockColor: WB.PAL.rock,
        render: {
            sunAz: 38, sunEl: 44, sunIntensity: 0.82, sunColor: 0xffedc7,
            skyIntensity: 0.44, skyLight: 0xb1d8f7, groundLight: 0xc2c7ad,
            sky: 0x9ccbe6, fog: 0.00011, shadowColor: 0x123a4a, shadowStrength: 0.5
        },
        music: 'assets/sounds/music_march.wav'
    },
    {
        id: 'steppe', name: 'Пепельная Степь', subtitle: 'Выжженные пустоши: деревни бегут быстрее',
        ground: 1, villages: 10, herds: 9, nodes: 7, fortresses: 5, knights: 12, wrecks: 7,
        terrain: { amp: 34, scale: 820, seed: 27 },
        scenery: { tree: 0.24, rock: 0.52, bush: 0.24 },
        treeColor: WB.PAL.leafDry, rockColor: 0x8a7258,
        render: {
            sunAz: 24, sunEl: 33, sunIntensity: 0.86, sunColor: 0xffd9a0,
            skyIntensity: 0.4, skyLight: 0xe0c9a0, groundLight: 0xa08a68,
            sky: 0xdcc096, fog: 0.00020, shadowColor: 0x4a3222, shadowStrength: 0.55
        },
        music: 'assets/sounds/music_steppe.wav'
    },
    {
        id: 'frost', name: 'Хладоземье', subtitle: 'Мёрзлая земля, где сталь звенит громче',
        ground: 2, villages: 9, herds: 6, nodes: 8, fortresses: 6, knights: 14, wrecks: 9,
        terrain: { amp: 58, scale: 540, seed: 43 },
        scenery: { tree: 0.5, rock: 0.34, bush: 0.16 },
        treeColor: WB.PAL.leafFrost, rockColor: 0x8f9aa4,
        render: {
            sunAz: 52, sunEl: 27, sunIntensity: 0.7, sunColor: 0xdfe9ff,
            skyIntensity: 0.52, skyLight: 0xcfe2f5, groundLight: 0x9fb0c0,
            sky: 0xc2d2e0, fog: 0.00028, shadowColor: 0x2a3f5c, shadowStrength: 0.58
        },
        music: 'assets/sounds/music_frost.wav'
    },
    {
        id: 'crown', name: 'Железный Венец', subtitle: 'Последний рубеж: здесь куют короны',
        ground: 1, villages: 7, herds: 4, nodes: 9, fortresses: 7, knights: 16, wrecks: 12,
        terrain: { amp: 66, scale: 470, seed: 61 },
        scenery: { tree: 0.14, rock: 0.7, bush: 0.16 },
        treeColor: 0x5d5a44, rockColor: 0x5f5f68,
        render: {
            sunAz: 8, sunEl: 21, sunIntensity: 0.62, sunColor: 0xffb070,
            skyIntensity: 0.34, skyLight: 0x8f8fa8, groundLight: 0x5f5460,
            sky: 0x6a5566, fog: 0.00036, shadowColor: 0x2a1830, shadowStrength: 0.62
        },
        music: 'assets/sounds/music_boss.wav'
    }
];

// A region past the run is the Crown biome re-rolled harder (endless).
WB.biomeOf = (n) => WB.BIOMES[Math.min(n, WB.BIOMES.length - 1)];

// --- Hull chassis ---------------------------------------------------------------
// mods multiply/add onto the base castle stats (Constants.js WANDER_*).
WB.CHASSIS = [
    { id: 'keep', name: 'Катящаяся Крепость', desc: 'Сбалансированный корпус: четыре слота, честная скорость. Начинается с бомбардой.',
      cost: 0, slots: 4, mods: {}, startModule: 'bombard' },
    { id: 'caterpillar', name: 'Железная Гусеница', desc: 'Тяжёлый паровой ход: +22% брони и корпуса, −12% скорости.',
      cost: 180, slots: 4, mods: { armor: 0.22, integrity: 0.25, speed: -0.12, turn: -0.1 }, startModule: 'bombard' },
    { id: 'timber', name: 'Лесная Рама', desc: 'Лёгкое дерево: +26% скорости и поворотливости, −18% корпуса, пять слотов.',
      cost: 180, slots: 5, mods: { speed: 0.26, turn: 0.22, integrity: -0.18 }, startModule: 'gatling' },
    { id: 'arcane', name: 'Арканный Понтон', desc: 'Парящая платформа: +25% дальности и урона, −10% брони. Начинается с арканной башней.',
      cost: 320, slots: 4, mods: { range: 0.25, dmg: 0.25, armor: -0.1 }, startModule: 'spire' },
    { id: 'dreadnought', name: 'Дредноут', desc: 'Шесть слотов и гора стали: −22% скорости, −20% поворотливости, +42% корпуса.',
      cost: 520, slots: 6, mods: { speed: -0.22, turn: -0.2, integrity: 0.42, armor: 0.14 }, startModule: 'culverin' }
];

// --- Captains -------------------------------------------------------------------
// Each key of `mods` is read by js/Logic.js; a key nobody reads does nothing (no silent bugs:
// tests/content.test.mjs asserts every key is in Logic.CAPTAIN_KEYS).
WB.CAPTAINS = [
    { id: 'cogsworth', name: 'Сэр Когсворт', desc: 'После каждого поглощения +35% скорости на 5 с.',
      cost: 0, mods: { feastSpeed: 0.35, feastTime: 5 } },
    { id: 'vex', name: 'Магистр Векс', desc: 'Арканные модули: +30% урона, +15% дальности.',
      cost: 150, mods: { arcaneDmg: 0.3, arcaneRange: 0.15 } },
    { id: 'abbott', name: 'Железный Аббат', desc: 'Стоя на месте, чинит 5 ед. корпуса в секунду.',
      cost: 150, mods: { stillRepair: 5 } },
    { id: 'grubb', name: 'Квотермирст Грюбб', desc: '+25% массы от поглощения, +15% лома.',
      cost: 220, mods: { massGain: 0.25, scrapGain: 0.15 } },
    { id: 'brann', name: 'Бранн Пороховой', desc: 'Урон вблизи (до 300 px) +25%, бочки +60%.',
      cost: 220, mods: { closeDmg: 0.25, closeRange: 300, kegMult: 0.6 } },
    { id: 'seraphine', name: 'Серафина Лёгкая', desc: '+18% скорости, +30% регенерации пара, паровой таран бьёт сильнее.',
      cost: 300, mods: { speed: 0.18, steamRegen: 0.3, boostRam: 0.5 } },
    { id: 'mordrek', name: 'Мордрек Стенобой', desc: 'Таран +60% урона и бьёт по площади; отдача вдвое меньше.',
      cost: 300, mods: { ramDmg: 0.6, ramSplash: 1, ramRecoil: -0.5 } },
    { id: 'ysolde', name: 'Изольт Хранительница', desc: 'Начинаешь забег с 30% запаса Наследия и чинишься при повышении ступени.',
      cost: 380, mods: { startLegacy: 0.3, tierHeal: 0.5 } }
];

// --- Modules --------------------------------------------------------------------
// behavior — what the module does every frame (js/Logic.js):
//   'turret'  aimed shot (gun, bolt, cannon, arcane, mortar, flame, tesla)
//   'passive' a constant modifier
//   'react'   triggers on an event (keg — on being hit, banner — on peasants nearby)
//   'spawner' creates units (hive)
// up — per-level multipliers; the level-1 value is the stat itself.
// TWO NAMESPACES, never mixed (tests/content.test.mjs guards this — a collision silently
// turned one bombard into "+17 damage, +430 range" for the whole hull):
//
//   WEAPON fields describe the module itself and are read one module at a time through
//   WB.moduleStat(mod, level, key):
//     power — damage of one shot (or one wasp sting), rate — s between shots,
//     reach — px, pspeed — projectile speed px/s, plife — projectile lifetime s,
//     aoe — blast radius px, pierce, arc, spread, cone, stun, instant, hitsTop,
//     units — how many wasps a hive keeps alive, unit — the spawned type,
//     kegPower / kegRadius / kegCd — the powder keg's own explosion,
//     repair — hull/s, steam — flat tank size, burn — hull/s self-damage,
//     scrapTick — scrap found every 20 s, fear — peasants surrender.
//
//   MODIFIER fields are summed over the whole hull by WB.playerStats / WB.enemyStats and are
//   fractions (+0.18 = +18%) unless noted:
//     speed, accel, dmg, range, plate (armor fraction), walls (flat hull), ramPower,
//     steamFlow, massBonus, scrapBonus, sight, vision, draftCost (× of the reroll price).
// rarity: 0 common, 1 uncommon, 2 rare. lockedBy — a legacy id that must be bought first.
WB.MODULES = [
    { id: 'bombard', name: 'Бомбарда', short: 'Пушка', behavior: 'turret', shot: 'ball', rarity: 0,
      desc: 'Надёжная пушка: средний урон, средняя дальность.',
      power: 17, rate: 1.15, reach: 430, pspeed: 620, aoe: 0, turn: true, arc: 0,
      up: { power: 1.34, rate: 0.88, reach: 1.1 } },
    { id: 'culverin', name: 'Кулеврина', short: 'Дальнобой', behavior: 'turret', shot: 'ball', rarity: 0,
      desc: 'Длинный ствол: далеко и больно, но редко.',
      power: 34, rate: 2.5, reach: 660, pspeed: 820, aoe: 0, turn: true, arc: 0.04,
      up: { power: 1.32, rate: 0.9, reach: 1.09 } },
    { id: 'gatling', name: 'Паровой Пулемёт', short: 'Пулемёт', behavior: 'turret', shot: 'bullet', rarity: 0,
      desc: 'Шквал пуль вблизи: много попаданий, мало урона за выстрел.',
      power: 5.5, rate: 0.15, reach: 300, pspeed: 760, aoe: 0, turn: true, spread: 0.07,
      up: { power: 1.28, rate: 0.88, reach: 1.08 } },
    { id: 'ballista', name: 'Баллиста', short: 'Баллиста', behavior: 'turret', shot: 'bolt', rarity: 0,
      desc: 'Тяжёлый болт пробивает всех на линии выстрела.',
      power: 21, rate: 1.5, reach: 520, pspeed: 700, pierce: 3, turn: true,
      up: { power: 1.3, rate: 0.89, reach: 1.1 } },
    { id: 'spire', name: 'Арканная Башня', short: 'Башня', behavior: 'turret', shot: 'arcane', rarity: 0, arcane: true,
      desc: 'Магический заряд бьёт по площади и не промахивается.',
      power: 15, rate: 1.35, reach: 470, pspeed: 540, aoe: 92, turn: true,
      up: { power: 1.33, rate: 0.89, reach: 1.11 } },
    { id: 'mortar', name: 'Мортира', short: 'Мортира', behavior: 'turret', shot: 'shell', rarity: 1,
      desc: 'Несёт ядро по дуге: огромный взрыв, долгая перезарядка.',
      power: 46, rate: 3.5, reach: 760, pspeed: 430, aoe: 168, arc: 1, turn: false,
      up: { power: 1.3, rate: 0.9, reach: 1.07 } },
    { id: 'flame', name: 'Огнемёт', short: 'Огнемёт', behavior: 'turret', shot: 'flame', rarity: 1,
      desc: 'Конус огня: жжёт всех вокруг и обращает крестьян в бегство.',
      power: 7, rate: 0.2, reach: 210, pspeed: 340, aoe: 60, plife: 0.42, turn: true, cone: 0.6,
      up: { power: 1.3, rate: 0.92, reach: 1.14 } },
    { id: 'tesla', name: 'Громоотвод', short: 'Тесла', behavior: 'turret', shot: 'spark', rarity: 2, arcane: true,
      desc: 'Бьёт молнией по самой крепкой цели в радиусе, оглушая её.',
      power: 30, rate: 2.1, reach: 400, pspeed: 2400, stun: 0.7, hitsTop: true, instant: true, turn: false,
      up: { power: 1.32, rate: 0.88, reach: 1.12 } },
    { id: 'hive', name: 'Улей', short: 'Улей', behavior: 'spawner', rarity: 2,
      desc: 'Рой боевых ос атакует ближайшего врага сам.',
      power: 6, rate: 3.4, reach: 380, units: 4, unit: 'wasp',
      up: { power: 1.3, rate: 0.86, units: 1.25 } },
    { id: 'workshop', name: 'Ремонтная Мастерская', short: 'Мастерская', behavior: 'passive', rarity: 0,
      desc: 'Чинит корпус в бою: 3 ед./с.',
      repair: 3, up: { repair: 1.55 } },
    { id: 'boiler', name: 'Доп. Котёл', short: 'Котёл', behavior: 'passive', rarity: 0,
      desc: '+30 к запасу пара, +18% к скорости и тяге.',
      steam: 30, speed: 0.18, accel: 0.18, up: { steam: 1.4, speed: 1.16, accel: 1.14 } },
    { id: 'plate', name: 'Броневые Плиты', short: 'Броня', behavior: 'passive', rarity: 0,
      desc: '+14% брони: весь входящий урон меньше.',
      plate: 0.14, up: { plate: 1.5 } },
    { id: 'masonry', name: 'Каменная Кладка', short: 'Кладка', behavior: 'passive', rarity: 0,
      desc: '+75 к предельной прочности корпуса.',
      walls: 75, up: { walls: 1.5 } },
    { id: 'keg', name: 'Пороховая Бочка', short: 'Бочка', behavior: 'react', rarity: 1,
      desc: 'Взрывается, когда корпус получает урон: 120 по площади вокруг.',
      kegPower: 120, kegRadius: 190, kegCd: 5, up: { kegPower: 1.45, kegCd: 0.82 } },
    { id: 'ram', name: 'Таранный Брус', short: 'Таран', behavior: 'passive', rarity: 0,
      desc: '+65% урона тараном и +25% скорости.',
      ramPower: 0.65, speed: 0.06, up: { ramPower: 1.5, speed: 1.08 } },
    { id: 'banner', name: 'Знамя Ужаса', short: 'Знамя', behavior: 'passive', rarity: 1,
      desc: 'Крестьяне сдаются сами: +40% массы с деревень, они бегут медленнее.',
      villageBonus: 0.4, fear: 1, up: { villageBonus: 1.4 } },
    { id: 'sail', name: 'Арканный Парус', short: 'Парус', behavior: 'passive', rarity: 1, arcane: true,
      desc: '+55% регенерации пара, чертёж в draft стоит дешевле.',
      steamFlow: 0.55, draftCost: -0.15, up: { steamFlow: 1.4, draftCost: 0.88 } },
    { id: 'nest', name: 'Воронье Гнездо', short: 'Гнездо', behavior: 'passive', rarity: 1,
      desc: '+18% дальности всех модулей и шире обзор карты.',
      sight: 0.18, vision: 1, up: { sight: 1.16 } },
    { id: 'reliquary', name: 'Реликварий', short: 'Реликварий', behavior: 'passive', rarity: 2,
      desc: '+22% массы и +22% лома за всё; раз в 20 с находит 3 лома.',
      massBonus: 0.22, scrapBonus: 0.22, scrapTick: 3, up: { massBonus: 1.2, scrapBonus: 1.2, scrapTick: 1.5 } },
    { id: 'furnace', name: 'Адская Топка', short: 'Топка', behavior: 'passive', rarity: 2,
      desc: '+26% урона всех модулей, но корпус медленно тлеет: −1 ед./с.',
      dmg: 0.26, burn: 1, up: { dmg: 1.22, burn: 1 } }
];

WB.moduleById = (id) => WB.MODULES.find(m => m.id === id) || null;

/** The module a chassis is built around: a bombard, a spire for the arcane ponton. */
WB.startModuleOf = (chassis) => WB.moduleById((chassis && chassis.startModule) || 'bombard');

// Where a module stands on the hull: the slot index gives the angle, the module its offset.
// The renderer (js/WanderMesh.js) and the logic (firing arcs) read the same table.
WB.SLOT_ANGLE = (i, n) => (n <= 0 ? 0 : (i / n) * Math.PI * 2 - Math.PI / 2);

// Stat of a module at a level (1..WB.MOD_MAX_LEVEL). `up[key]` is a per-level MULTIPLIER
// (absent or 1 — the stat does not grow), so level 2 of a 17-damage bombard with up.dmg 1.34
// is 17 × 1.34 = 22.8. Counters (hive wasps) are rounded by the caller.
WB.MOD_MAX_LEVEL = 3;
WB.moduleStat = (mod, level, key) => {
    const base = mod[key];
    if (base == null) return 0;
    const up = mod.up ? mod.up[key] : null;
    const lv = Math.max(1, Math.min(WB.MOD_MAX_LEVEL, level | 0));
    return up == null || up === 1 ? base : base * Math.pow(up, lv - 1);
};

// Sum a modifier key over the installed modules: `mult` — ×(1 + Σ(stat − 1)) for stat ≥ 1
// style entries, 'add' — plain Σ. Both return the neutral value (1 / 0) for an empty list.
WB.modMult = (mods, key) => mods.reduce((a, m) => a + (WB.moduleStat(m.mod, m.level, key) || 0), 0);

// --- Enemy loadouts -------------------------------------------------------------
// The AI castles are built from the same module table: a fortress is a small player castle,
// a warden is a big one. hp/dmg scale by region (Constants.js WANDER_ENEMY_SCALE).
// Fortress loadouts by rank (0 = the fortress closest to the player's start). A rank-0 hull
// gets one short-range gun and nothing else: a random draw from the whole table used to hand
// the FIRST fortress of a run a level-2 mortar, which out-ranged the player's starting
// bombard by 230 px and made the opening unwinnable. Every entry is a gun or a gun + support,
// so a fortress can always shoot back.
WB.FORTRESS_LOADOUTS = [
    ['gatling', 'bombard'],
    ['bombard', 'ballista', 'spire'],
    ['bombard', 'ballista', 'spire', 'culverin', 'flame'],
    ['bombard', 'culverin', 'ballista', 'spire', 'flame', 'mortar', 'gatling'],
    ['culverin', 'mortar', 'spire', 'ballista', 'flame', 'gatling', 'bombard']
];
WB.FORTRESS_SUPPORT = ['plate', 'masonry', 'workshop', 'ram'];
WB.FORTRESS_MODULES = ['bombard', 'culverin', 'gatling', 'ballista', 'spire', 'mortar', 'plate', 'masonry', 'workshop', 'ram', 'flame'];
WB.WARDEN_MODULES = ['bombard', 'culverin', 'mortar', 'spire', 'tesla', 'gatling', 'plate', 'masonry', 'workshop', 'keg', 'flame', 'ballista'];
WB.FORTRESS_TIERS = [1, 2, 3, 4, 4];   // by distance from the player's start: 0 — the closest
WB.WARDEN_TIER = 5;
WB.WARDEN_HP = 2600;         // base hull of a region warden (× region scale)
WB.FORTRESS_HP = 210;        // base hull of a fortress (× (0.55 + 0.45·tier), × region scale)
WB.WARDEN_NAME = ['Хранитель Рубежей', 'Пепельный Страж', 'Ледяной Варден', 'Железный Венец'];

// --- Legacy (meta-progression) ----------------------------------------------------
// Bought with scrap between runs; kept in localStorage (js/Logic.js Save).
WB.LEGACY = [
    { id: 'ch_caterpillar', kind: 'chassis', ref: 'caterpillar', name: 'Корпус: Железная Гусеница', cost: 180,
      desc: 'Открывает тяжёлый паровой корпус в снаряжении.' },
    { id: 'ch_timber', kind: 'chassis', ref: 'timber', name: 'Корпус: Лесная Рама', cost: 180,
      desc: 'Открывает лёгкий деревянный корпус на пять слотов.' },
    { id: 'ch_arcane', kind: 'chassis', ref: 'arcane', name: 'Корпус: Арканный Понтон', cost: 320,
      desc: 'Открывает парящий корпус для арканных башен.' },
    { id: 'ch_dreadnought', kind: 'chassis', ref: 'dreadnought', name: 'Корпус: Дредноут', cost: 520,
      desc: 'Открывает шести слотовый стальной дредноут.' },
    { id: 'cap_vex', kind: 'captain', ref: 'vex', name: 'Капитан: Магистр Векс', cost: 150, desc: 'Аркана: +30% урона, +15% дальности.' },
    { id: 'cap_abbott', kind: 'captain', ref: 'abbott', name: 'Капитан: Железный Аббат', cost: 150, desc: 'Ремонт 5 ед./с, пока замок стоит.' },
    { id: 'cap_grubb', kind: 'captain', ref: 'grubb', name: 'Капитан: Квотермирст Грюбб', cost: 220, desc: '+25% массы, +15% лома.' },
    { id: 'cap_brann', kind: 'captain', ref: 'brann', name: 'Капитан: Бранн Пороховой', cost: 220, desc: '+25% урона вблизи, бочки +60%.' },
    { id: 'cap_seraphine', kind: 'captain', ref: 'seraphine', name: 'Капитан: Серафина Лёгкая', cost: 300, desc: '+18% скорости, +30% пара.' },
    { id: 'cap_mordrek', kind: 'captain', ref: 'mordrek', name: 'Капитан: Мордрек Стенобой', cost: 300, desc: 'Таран +60% и по площади.' },
    { id: 'cap_ysolde', kind: 'captain', ref: 'ysolde', name: 'Капитан: Изольт Хранительница', cost: 380, desc: '30% Наследия на старте, ремонт при ступени.' },
    { id: 'mod_mortar', kind: 'module', ref: 'mortar', name: 'Чертёж: Мортира', cost: 120, desc: 'Мортира появляется в выборах.' },
    { id: 'mod_flame', kind: 'module', ref: 'flame', name: 'Чертёж: Огнемёт', cost: 120, desc: 'Огнемёт появляется в выборах.' },
    { id: 'mod_keg', kind: 'module', ref: 'keg', name: 'Чертёж: Пороховая Бочка', cost: 120, desc: 'Бочка появляется в выборах.' },
    { id: 'mod_banner', kind: 'module', ref: 'banner', name: 'Чертёж: Знамя Ужаса', cost: 120, desc: 'Знамя появляется в выборах.' },
    { id: 'mod_sail', kind: 'module', ref: 'sail', name: 'Чертёж: Арканный Парус', cost: 120, desc: 'Парус появляется в выборах.' },
    { id: 'mod_nest', kind: 'module', ref: 'nest', name: 'Чертёж: Воронье Гнездо', cost: 120, desc: 'Гнездо появляется в выборах.' },
    { id: 'mod_tesla', kind: 'module', ref: 'tesla', name: 'Чертёж: Громоотвод', cost: 260, desc: 'Громоотвод появляется в выборах.' },
    { id: 'mod_hive', kind: 'module', ref: 'hive', name: 'Чертёж: Улей', cost: 260, desc: 'Боевой рой появляется в выборах.' },
    { id: 'mod_reliquary', kind: 'module', ref: 'reliquary', name: 'Чертёж: Реликварий', cost: 260, desc: 'Реликварий появляется в выборах.' },
    { id: 'mod_furnace', kind: 'module', ref: 'furnace', name: 'Чертёж: Адская Топка', cost: 260, desc: 'Топка появляется в выборах.' },
    { id: 'start_tier', kind: 'perk', name: 'Обтёсанный Корпус', cost: 200, desc: 'Забеги начинаются со 2-й ступени.' },
    { id: 'extra_card', kind: 'perk', name: 'Широкий Выбор', cost: 160, desc: '+1 чертёж в каждом выборе.' },
    { id: 'extra_reroll', kind: 'perk', name: 'Запасной Чертёж', cost: 140, desc: '+1 бесплатная смена выбора за забег.' },
    { id: 'second_wind', kind: 'perk', name: 'Второе Дыхание', cost: 300, desc: 'Один раз за забег корпус восстанавливается до 45%.' },
    { id: 'tier_repair', kind: 'perk', name: 'Полевой Ремонт', cost: 150, desc: 'Каждая новая ступень чинит 35% корпуса.' },
    { id: 'long_shot', kind: 'perk', name: 'Дальний Бой', cost: 180, desc: '+12% дальности всех модулей.' },
    { id: 'thick_walls', kind: 'perk', name: 'Толстые Стены', cost: 180, desc: '+15% предельной прочности корпуса.' },
    { id: 'scavenger', kind: 'perk', name: 'Марадёр', cost: 160, desc: '+25% лома за всё.' },
    { id: 'fast_boiler', kind: 'perk', name: 'Быстрый Котёл', cost: 140, desc: '+25% регенерации пара.' }
];

WB.legacyById = (id) => WB.LEGACY.find(l => l.id === id) || null;
WB.legacyTotal = () => WB.LEGACY.reduce((s, l) => s + l.cost, 0);

// A module is in the draft pool when it is common or its blueprint is bought.
WB.moduleUnlocked = (mod, save) => mod.rarity === 0 || (save && save.legacy ? save.legacy.indexOf('mod_' + mod.id) >= 0 : false);
WB.chassisUnlocked = (ch, save) => ch.cost === 0 || (save && save.legacy ? save.legacy.indexOf('ch_' + ch.id) >= 0 : false);
WB.captainUnlocked = (cap, save) => cap.cost === 0 || (save && save.legacy ? save.legacy.indexOf('cap_' + cap.id) >= 0 : false);

// --- Flavor text ------------------------------------------------------------------
WB.TIPS = [
    'Деревни убегают. Догоняй их на пару — котёл для этого и нужен.',
    'Таран почти бесплатен: разгонись с горы и бей врага в борт.',
    'Ступень корпуса растёт от массы. Масса — это съеденное, а не урон.',
    'Мортира бьёт по площади: держи вражеские замки в куче.',
    'Громоотвод целится в самую крепкую цель — хорош против вардена.',
    'Пороховая бочка взрывается, когда тебя бьют. Не стой в толпе.',
    'Ремонтная мастерская чинит в бою, Аббат — только на месте.',
    'Камень и руда дают много массы разом, но жуются дольше.',
    'Врата вардена открыты, когда съедены все бродячие крепости региона.',
    'Лом копится между забегами: Наследие открывает чертежи и капитанов.',
    'Знамя Ужаса заставляет крестьян сдаваться: масса без погони.',
    'Адская топка жжёт твой же корпус. Бери её с мастерской.',
    'Улей выпускает ос, которые воюют сами, пока ты таранишь.',
    'Правая кнопка мыши — осмотреться, колесо — приблизить.',
    'Лёд и песок замедляют всех одинаково: пользуйся горами как стеной.'
];
WB.VILLAGE_NAMES = [
    'Тихие Дворы', 'Грязнушка', 'Верхолесье', 'Кривой Брод', 'Свиной Хутор', 'Мельничный Лог',
    'Старая Кузница', 'Гусиный Пруд', 'Волчья Падь', 'Липовка', 'Каменный Ключ', 'Овсянка',
    'Песья Слобода', 'Журавли', 'Медвежий Угол', 'Соломенка', 'Долгий Мост', 'Пепелище',
    'Барсучий Яр', 'Звонкий Ручей', 'Козье Поле', 'Гнилые Пни', 'Три Сосны', 'Ясный Дол'
];
WB.HERD_NAMES = ['Стадо овец', 'Стадо коз', 'Коровий выпас', 'Табун', 'Отара'];
WB.NODE_NAMES = { quarry: 'Каменоломня', mine: 'Железный рудник', lumber: 'Лесоповал' };
