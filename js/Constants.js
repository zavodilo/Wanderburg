// Constants.js — ALL the numbers of Wanderburg: location, camera, render and game balance.
// Loaded FIRST: the other modules read these globals. The top part (LOCATION_*, CAMERA_*,
// WORLD3D_*, TERRAIN_*, AUDIO_*) is the ArcEngine kit canon — it is edited by the web editor
// (_utils/editor), which patches only lines of the form `const NAME = <number>;` — keep values
// as numeric literals (colors — 0xRRGGBB); the editor won't touch a formula.
// The WANDER_* block at the bottom is the game's balance: hand-edit it, the editor ignores it.
const GAME_VERSION = '1.0.0'; // build version: ?v= on scripts (tools/build.mjs) and the archive name

// localStorage shim: in a sandbox iframe and when site data is blocked, direct access throws SecurityError.
// All storage access goes through Store only.
/** @satisfies {Record<string, any>} */
const Store = {
    get(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
        try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch (e) { /* nothing to remove */ }
    },
    // JSON parsing that never throws: a broken value = as if there were no save.
    getJSON(key, fallback = null) {
        const raw = Store.get(key);
        if (raw === null) return fallback;
        try {
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : fallback;
        } catch (e) {
            console.warn('Store: повреждённое значение "' + key + '", сбрасываю.');
            Store.remove(key);
            return fallback;
        }
    }
};

// Phone or tablet: user agent, iPad posing as a Mac, touch on a small screen.
const IS_MOBILE = (() => {
    const userAgentMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const hasTouchScreen = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const isSmallScreen = Math.max(window.innerWidth, window.innerHeight) <= 1366 &&
        Math.min(window.innerWidth, window.innerHeight) <= 1024;
    const isiPad = /iPad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return userAgentMobile || isiPad || (hasTouchScreen && isSmallScreen);
})();

// --- LOCATION (Location3D.js, Terrain3D.js). World units are px: x to the right, y down
// the map, height up (skill world3d, §Coordinates). Wanderburg rebuilds the terrain per
// biome (js/WanderView.js) with its own noise settings, so these are the BOOT values only. ---
const LOCATION_WIDTH = 2048;            // px: location width (the area the game camera stays within)
const LOCATION_HEIGHT = 2048;           // px: location height
const LOCATION_GROUND = 0;              // ground texture: 0 — grass, 1 — sand, 2 — snow (Location3D.GROUNDS)
const GROUND_TILE_SIZE = 512;           // world px per one repeat of the ground texture
const TERRAIN_NOISE_AMP = 44;           // px: hill amplitude (0 — flat ground)
const TERRAIN_NOISE_SCALE = 620;        // px: hill size
const TERRAIN_NOISE_SEED = 4;           // terrain noise seed
const TERRAIN_BASE = 0;                 // px: mean ground level
const TERRAIN_CELL = 8;                 // px: terrain grid step (mobile — no finer than 12)

// --- MODELS (Gltf3D.js) and UI (UI.js) ---
const MODEL_CLIP_BLEND_SEC = 0.2;       // s: cross-fade between animation clips of a .glb model (idle -> run); 0 — instant
const UI_REF_HEIGHT = 720;              // px: the screen height the UI layout (UILayout.js) is drawn for; the UI scales with the screen height, 0 — no scaling

// --- SOUND (Sound3D.js): channel volumes; a sound with a place on the map is heard from where
// the CAMERA is — its audible region is a sphere of AUDIO_FALLOFF_MAX around it ---
const AUDIO_MASTER_VOLUME = 0.85;       // 0..1: everything (0 — silence)
const AUDIO_MUSIC_VOLUME = 0.45;        // 0..1: the 'music' channel
const AUDIO_SFX_VOLUME = 0.9;           // 0..1: the 'sfx' channel — effects and object sounds
const AUDIO_FALLOFF_MIN = 120;          // px: full volume while the camera is this close to a sound (0 — it fades from the source itself)
const AUDIO_FALLOFF_MAX = 1150;         // px: from here on it is silent (fades linearly in between); an object may set its own pair. The camera stands ~800 px from its look-at point at zoom 1
const AUDIO_PAN = 0.75;                 // 0..1: how far a sound at the side of the screen goes into one ear (0 — mono)

// --- CAMERA (CameraControl.js): a high tactical view that follows the walking castle.
// WASD steer the castle, so the camera's own flight keys are switched off in Game.js
// (camera.flightKeys = false); RMB orbit, the wheel zoom and R (re-center) stay. ---
const CAMERA_FOV_DEG = 52;              // vertical field of view
const CAMERA_AZIMUTH_DEG = -90;         // where the camera looks on the map: −90 — north up, 0 — east up
const CAMERA_PITCH_DEG = 55;            // pitch toward the ground: 90 — straight from above, less — more perspective
const CAMERA_ZOOM = 0.62;               // starting zoom: PC and tablets
const CAMERA_ZOOM_MOBILE = 0.5;         // starting zoom: phones (longer screen side < 1024)
const CAMERA_ZOOM_MIN = 0.4;            // wheel and pinch won't zoom out further (below this the ground edge gets into the frame)
const CAMERA_ZOOM_MAX = 1.7;            // won't zoom in closer
const CAMERA_ZOOM_WHEEL_STEP = 0.12;    // fraction of zoom per one wheel notch
const CAMERA_ZOOM_LERP = 0.18;          // zoom smoothing: fraction of the remainder per frame
const CAMERA_FOLLOW_LERP = 0.11;        // following an object (follow): fraction of the remainder per frame
const CAMERA_FLY_SPEED = 900;           // flight on WASD, arrows and Q/E: screen px/s (over the world — divided by zoom)
const CAMERA_LIMITS = 0;                // game camera limits: 0 — free flight, 1 — pitch within CAMERA_ORBIT_PITCH_*, target inside the location, flight ceiling; the ground edge stays out of the frame
const CAMERA_LIFT_MAX = 600;            // px, with limits: how high above the ground flight lifts the look-at point (higher — the ground edge gets into the frame)
const CAMERA_ORBIT = 1;                 // camera rotation by the player (RMB: look-around, orbit while following an object): 0 — orientation fixed, 1 — allowed
const CAMERA_ORBIT_DEG_PER_PX = 0.3;    // degrees of rotation per screen px of drag
const CAMERA_ORBIT_PITCH_MIN_DEG = 35;  // with limits: won't go lower toward the ground (the limit also rises on its own — ground edge stays out of the frame)
const CAMERA_ORBIT_PITCH_MAX_DEG = 88;  // with limits: higher — almost straight from above

// --- RENDER (World3D.js): light, shadows, sky, materials, toon and ink edges. Read by
// World3D.cfg(); the editor applies edits to the live scene. These are the DEFAULTS of the
// first biome — every biome overrides the sun, sky and fog from js/Content.js. ---
// One sun for the whole world. Azimuth — WHERE the shadow falls on the map (0 — right, 90 — down).
const WORLD3D_SUN_AZIMUTH_DEG = 38;
const WORLD3D_SUN_ELEVATION_DEG = 44;   // sun elevation above the horizon
const WORLD3D_SUN_INTENSITY = 0.82;     // sun strength (with the sky it sums to ~1.0 on flat ground — texture colors unchanged)
const WORLD3D_SUN_COLOR = 0xffedc7;     // sun color
const WORLD3D_SKYLIGHT_INTENSITY = 0.44; // diffuse sky light (hemispheric light source)
const WORLD3D_SKYLIGHT_COLOR = 0xb1d8f7; // sky light color (faces looking up)
const WORLD3D_GROUNDLIGHT_COLOR = 0xc2c7ad; // fill light from below (reflection off the ground)
const WORLD3D_SKY_COLOR = 0x8fc3e0;     // sky and fog color
const WORLD3D_FOG_DENSITY = 0.00014;    // exponential fog toward the horizon (0 — off); biomes override it in Content.js
// Shadows: one color for all (painted by the toon chunks, the sun only provides visibility)
const WORLD3D_SHADOW_COLOR = 0x123a4a;  // shadow color
const WORLD3D_SHADOW_STRENGTH = 0.5;    // shadow strength 0..1: a surface in shadow is multiplied by a blend of white and the shadow color
const WORLD3D_SHADOW_SOFT = 2;          // edge: 0 — hard (for toon), 1..3 — PCF low/medium/high (mobile — no higher than 1)
const WORLD3D_SHADOW_MAP = 1024;        // shadow map size (mobile — half as large); takes effect with a new scene
const WORLD3D_SHADOW_RADIUS = 900;      // px: LIMIT of the shadow ortho frustum half-size; the frustum itself shrinks to the objects in the frame
const WORLD3D_SHADOW_BIAS = 0.001;      // depth bias against shadow acne (shadow stripes on lit faces)
const WORLD3D_SHADOW_NORMAL_BIAS = 0.8; // bias along the normal against shadow acne (stripes and sawtooth on faces at an acute angle to the sun), in shadow map texels on top of the edge smoothing radius (the engine adds it)
// Materials by group (specular highlight — fraction 0..1, size — exponent: larger — smaller highlight)
const WORLD3D_GROUND_SPECULAR = 0;      // ground specular highlight (0 — matte)
const WORLD3D_GROUND_SPEC_POWER = 1;    // ground specular highlight size
const WORLD3D_OUTER_TINT = 0.85;        // ground brightness BEYOND the location edge (less than 1 — the location boundary is visible)
const WORLD3D_PROP_SPECULAR = 0.04;     // environment specular highlight (group 'prop')
const WORLD3D_PROP_SPEC_POWER = 9;      // environment specular highlight size
const WORLD3D_ACTOR_SPECULAR = 0;       // main objects specular highlight (group 'actor'); with toon — toon glint brightness
const WORLD3D_ACTOR_SPEC_POWER = 23;    // main objects specular highlight size
// Toon shader (ArcToonPlugin): light from all sources (sun + sky, with shadow) is quantized into bands
const WORLD3D_TOON = 1;                 // 1 — toon shading and silhouette outline, 0 — regular smooth shading without outline
const WORLD3D_TOON_BANDS = 4;           // number of light bands (2..6)
const WORLD3D_TOON_SOFT = 0.03;         // band boundary softness (0 — sharp, 0.5 — almost smooth)
const WORLD3D_TOON_LOW = 0.5;           // brightness of the darkest band (fraction of full)
const WORLD3D_TOON_GROUND = 1;          // 1 — bands on the ground too, 0 — ground is shaded smoothly
const WORLD3D_TOON_SPEC = 0.22;         // toon glint highlight strength (0 — no highlight)
const WORLD3D_TOON_SPEC_SIZE = 0.075;   // highlight threshold (smaller — larger spot)
const WORLD3D_TOON_RIM = 0.24;          // bright rim light along the objects' silhouette edge (0 — none)
const WORLD3D_TOON_RIM_WIDTH = 0.26;    // rim light width
// Ink edges (EdgesRenderer): edges creased more sharply than the threshold
const WORLD3D_TOON_INK = 2;             // 0 — none, 1 — main objects, 2 — environment too
const WORLD3D_TOON_INK_WIDTH = 22;      // line thickness (≈ world px × 100; thinner as the camera moves away)
const WORLD3D_TOON_INK_COLOR = 0x1a1712; // ink color: ink edges and silhouette outline
const WORLD3D_TOON_INK_ANGLE = 42;      // °: an edge is drawn if the faces are creased more sharply
// Outer silhouette outline: post-effect (HighlightLayer, isStroke), thickness — in screen px.
// Wanderburg builds its meshes procedurally (js/WanderMesh.js) and registers them with
// { outline: false }: on convex hand-built meshes the inverted hull wins the depth tie and
// paints the object black (skill world3d, §Pitfalls). Ink edges and toon bands stay.
const WORLD3D_TOON_OUTLINE = 0;         // 0 — none, 1 — main objects, 2 — environment too (only when WORLD3D_TOON = 1)
const WORLD3D_TOON_OUTLINE_ACTOR_WIDTH = 1.5;   // screen px: main objects outline
const WORLD3D_TOON_OUTLINE_PROP_WIDTH = 1;  // screen px: environment outline (there is a lot of it in the frame — thinner)

// --- SAMPLE GAME constants of the kit (kept: the web editor's inspector lists them) ---
const GAME_RUN_SEC = 8;                 // s: a full energy bar lasts this long while running
const GAME_REST_SEC = 4;                // s: an empty energy bar refills in this time while standing
const GAME_STEP_SEC = 0.35;             // s: between footstep sounds while the character runs

// ============================================================================
//  WANDERBURG — game balance. Everything the simulation reads lives here; the
//  editor does not touch this block (its schema is the kit canon above).
// ============================================================================

// --- MAP: one biome is a round valley of WANDER_REGION_R, ringed by mountains ---
const WANDER_REGION_R = 900;            // px: radius of the playable valley (the location is 2048×2048)
const WANDER_WALL_R = 990;              // px: where the mountain ring is at full height — impassable
const WANDER_WALL_H = 250;              // px: height of the mountain ring
const WANDER_WALL_START = 0.8;          // fraction of WANDER_REGION_R: the slopes begin here
const WANDER_SPAWN_R = 0.52;            // fraction of the region radius: the player starts this far from the centre
const WANDER_SCENERY_TREES = 340;       // trees/rocks/bushes per region (decoration, no collision)
const WANDER_SCATTER_SEED = 1337;       // base seed of a run: region n is generated from seed + n

// --- CASTLE: the walking fortress. Mass grows it, the tier unlocks module slots ---
const WANDER_TIER_MASS_2 = 240;         // mass needed for tier 2 (tier 1 is the start): ~4 villages
const WANDER_TIER_MASS_3 = 620;         // mass needed for tier 3: most of a region
const WANDER_TIER_MASS_4 = 1100;        // mass needed for tier 4
const WANDER_TIER_MASS_5 = 1750;        // mass needed for tier 5 (the biggest hull)
const WANDER_MAX_SPEED = 205;           // px/s: top speed of a tier-1 hull (a fortress does ~135)
const WANDER_SPEED_PER_TIER = 11;       // px/s: how much slower each hull tier is
const WANDER_ACCEL = 235;               // px/s²: engine power (divided by the hull's mass factor)
const WANDER_REVERSE_FACTOR = 0.45;     // fraction of the top speed backwards
const WANDER_DRAG = 1.5;                // 1/s: coasting friction
const WANDER_TURN_RATE = 2.15;          // rad/s: rudder of a tier-1 hull
const WANDER_TURN_PER_TIER = 0.17;      // rad/s: how much slower each hull tier turns
const WANDER_SLOPE_DRAG = 2.6;          // extra drag per unit of ground slope (hills slow the castle)
const WANDER_STEAM_MAX = 100;           // units: the boiler tank
const WANDER_STEAM_REGEN = 17;          // units/s
const WANDER_BOOST_DRAIN = 34;          // units/s while the furnace is stoked (Shift / Space)
const WANDER_BOOST_SPEED = 1.72;        // top-speed multiplier while boosting
const WANDER_BOOST_ACCEL = 2.1;         // acceleration multiplier while boosting
const WANDER_BOOST_RAM = 1.5;           // ram damage multiplier while boosting

// --- RAMMING: the hull itself is a weapon ---
const WANDER_RAM_MIN_SPEED = 72;        // px/s: slower than this a collision is only a bump
const WANDER_RAM_DMG = 26;              // base ram damage at WANDER_RAM_REF_SPEED
const WANDER_RAM_REF_SPEED = 150;       // px/s: the speed the base damage is tuned for
const WANDER_RAM_COOLDOWN = 0.5;        // s: between two ram hits of the same pair
const WANDER_RAM_SELF = 0.22;           // fraction of the ram damage the attacker takes
const WANDER_RAM_KNOCK_SELF = 0.45;     // fraction of its speed the attacker loses
const WANDER_RAM_KNOCK_OTHER = 0.7;     // px/s fraction: the knockback the defender gets

// --- COMBAT ---
const WANDER_CRIT_CHANCE = 0.06;        // 0..1: a lucky shot
const WANDER_CRIT_MULT = 1.7;           // damage of a lucky shot
const WANDER_TARGET_LEAD = 1;           // 0..1: how well modules aim ahead of a moving target
const WANDER_PROJECTILE_STEP_MAX = 34;  // px: collision substep — a fast shell must not tunnel
const WANDER_FIRE_CONE_DEG = 150;       // °: a fixed module only fires inside this arc of its own side
const WANDER_TURRET_TURN = 3.4;         // rad/s: how fast a turret tracks its target
const WANDER_HULL_REGEN = 10;            // hull/s: the crew patches the walls out of combat
const WANDER_HULL_REGEN_DELAY = 7;      // s without damage before that repair starts

// --- DEVOURING: eat everything, grow ---
const WANDER_DEVOUR_PULL = 420;         // px/s: how fast a devoured chunk flies into the hull
const WANDER_DEVOUR_PULL_R = 190;       // px: chunks inside this radius are sucked in
const WANDER_MASS_PER_HP = 0.16;        // mass for 1 hp of a devoured structure
const WANDER_SCATTER_MASS = 2.0;        // mass of one debris/peasant chunk
const WANDER_HEAL_ON_DEVOUR = 0.02;     // fraction of the hull max repaired by a full structure

// --- ECONOMY and PROGRESSION ---
const WANDER_SCRAP_PER_MASS = 0.006;    // legacy scrap for 1 mass devoured in a run
const WANDER_SCRAP_FORTRESS = 16;       // scrap for a roaming fortress
const WANDER_SCRAP_WARDEN = 70;         // scrap for a region warden
const WANDER_SCRAP_CROWN = 200;         // scrap for the Iron Crown (the final boss)
const WANDER_SCRAP_REGION = 45;         // scrap for leaving a region alive
const WANDER_DRAFT_CARDS = 4;           // upgrade cards offered at once
const WANDER_DRAFT_REROLL_COST = 22;    // mass for a reroll of the whole offer
const WANDER_DRAFT_SKIP_HEAL = 0.12;    // fraction of the hull max for skipping the draft
const WANDER_GATE_FORTRESSES = 1;       // roaming fortresses that may still stand when the warden gate opens
const WANDER_REGION_COUNT = 4;          // regions of a full run (the 4th is the Iron Crown)
const WANDER_ENEMY_SCALE = 1.38;        // per-region multiplier of enemy hull and damage
const WANDER_ENDLESS_SCALE = 1.18;      // per-region multiplier after the run is won

// --- VIEW: what the renderer and the HUD are allowed to spend ---
const WANDER_VIEW_RADIUS = 1500;        // px: entities farther from the camera target are not drawn
const WANDER_PARTICLE_MAX = 240;        // pooled debris/smoke particles
const WANDER_PROJECTILE_MAX = 90;       // pooled shells and bolts
const WANDER_FLOAT_TEXT_MAX = 14;       // pooled floating damage/mass numbers over the world
const WANDER_MINIMAP_SIZE = 168;        // px (of a UI_REF_HEIGHT screen): the map in the corner
const WANDER_DAMAGE_FLASH = 0.5;        // s: the red vignette after a hit
const WANDER_SHAKE_RAM = 9;             // px: camera shake of a ram
const WANDER_SHAKE_BOOM = 16;           // px: camera shake of an explosion

// --- WANDER_CFG: the snapshot the simulation reads -------------------------------------
// A classic script's top-level `const` is a LEXICAL global: `window.WANDER_MAX_SPEED` is
// undefined and reading the identifier by name needs eval. js/Logic.js therefore reads the
// balance through this one object (WB.num('MAX_SPEED', fallback)) — same numbers, no eval,
// and the game logic stays loadable in node for the tests. Keep a key here for every
// WANDER_* constant above (tests/logic.test.mjs asserts the two lists match).
const WANDER_CFG = {
    REGION_R: WANDER_REGION_R, WALL_R: WANDER_WALL_R, WALL_H: WANDER_WALL_H,
    WALL_START: WANDER_WALL_START, SPAWN_R: WANDER_SPAWN_R, SCATTER_SEED: WANDER_SCATTER_SEED,
    SCENERY_TREES: WANDER_SCENERY_TREES,
    TIER_MASS_2: WANDER_TIER_MASS_2, TIER_MASS_3: WANDER_TIER_MASS_3,
    TIER_MASS_4: WANDER_TIER_MASS_4, TIER_MASS_5: WANDER_TIER_MASS_5,
    MAX_SPEED: WANDER_MAX_SPEED, SPEED_PER_TIER: WANDER_SPEED_PER_TIER, ACCEL: WANDER_ACCEL,
    REVERSE_FACTOR: WANDER_REVERSE_FACTOR, DRAG: WANDER_DRAG, TURN_RATE: WANDER_TURN_RATE,
    TURN_PER_TIER: WANDER_TURN_PER_TIER, SLOPE_DRAG: WANDER_SLOPE_DRAG,
    STEAM_MAX: WANDER_STEAM_MAX, STEAM_REGEN: WANDER_STEAM_REGEN, BOOST_DRAIN: WANDER_BOOST_DRAIN,
    BOOST_SPEED: WANDER_BOOST_SPEED, BOOST_ACCEL: WANDER_BOOST_ACCEL, BOOST_RAM: WANDER_BOOST_RAM,
    RAM_MIN_SPEED: WANDER_RAM_MIN_SPEED, RAM_DMG: WANDER_RAM_DMG, RAM_REF_SPEED: WANDER_RAM_REF_SPEED,
    RAM_COOLDOWN: WANDER_RAM_COOLDOWN, RAM_SELF: WANDER_RAM_SELF, RAM_KNOCK_SELF: WANDER_RAM_KNOCK_SELF,
    RAM_KNOCK_OTHER: WANDER_RAM_KNOCK_OTHER, CRIT_CHANCE: WANDER_CRIT_CHANCE, CRIT_MULT: WANDER_CRIT_MULT,
    TARGET_LEAD: WANDER_TARGET_LEAD, PROJECTILE_STEP_MAX: WANDER_PROJECTILE_STEP_MAX,
    FIRE_CONE_DEG: WANDER_FIRE_CONE_DEG, TURRET_TURN: WANDER_TURRET_TURN,
    HULL_REGEN: WANDER_HULL_REGEN, HULL_REGEN_DELAY: WANDER_HULL_REGEN_DELAY,
    DEVOUR_PULL: WANDER_DEVOUR_PULL, DEVOUR_PULL_R: WANDER_DEVOUR_PULL_R, MASS_PER_HP: WANDER_MASS_PER_HP,
    SCATTER_MASS: WANDER_SCATTER_MASS, HEAL_ON_DEVOUR: WANDER_HEAL_ON_DEVOUR,
    SCRAP_PER_MASS: WANDER_SCRAP_PER_MASS, SCRAP_FORTRESS: WANDER_SCRAP_FORTRESS,
    SCRAP_WARDEN: WANDER_SCRAP_WARDEN, SCRAP_CROWN: WANDER_SCRAP_CROWN, SCRAP_REGION: WANDER_SCRAP_REGION,
    DRAFT_CARDS: WANDER_DRAFT_CARDS, DRAFT_REROLL_COST: WANDER_DRAFT_REROLL_COST,
    DRAFT_SKIP_HEAL: WANDER_DRAFT_SKIP_HEAL, GATE_FORTRESSES: WANDER_GATE_FORTRESSES,
    REGION_COUNT: WANDER_REGION_COUNT, ENEMY_SCALE: WANDER_ENEMY_SCALE, ENDLESS_SCALE: WANDER_ENDLESS_SCALE,
    VIEW_RADIUS: WANDER_VIEW_RADIUS, PARTICLE_MAX: WANDER_PARTICLE_MAX, PROJECTILE_MAX: WANDER_PROJECTILE_MAX,
    FLOAT_TEXT_MAX: WANDER_FLOAT_TEXT_MAX, MINIMAP_SIZE: WANDER_MINIMAP_SIZE,
    DAMAGE_FLASH: WANDER_DAMAGE_FLASH, SHAKE_RAM: WANDER_SHAKE_RAM, SHAKE_BOOM: WANDER_SHAKE_BOOM
};
