// Logic.js — Wanderburg's simulation: the seeded random, the region generator, the walking
// castle, its modules, projectiles, entities and the enemy AI. Pure data + pure functions.
//
// THE INVARIANT: this file never touches the renderer (no pc.*, no World3D, no Location3D, no
// DOM). It owns the truth — every position, hit point and cooldown — and emits an event list
// each frame; js/WanderView.js draws that truth, js/WanderAudio.js sounds it, js/Hud.js shows
// it. That keeps the game testable in node (tests/logic.test.mjs), deterministic from a seed
// (Scene.seed / WB.RNG — never Math.random) and replayable.
//
// Coordinates are the kit's map space: x right, y down the map, px, height up (skill world3d,
// §Coordinates). The ground height the logic needs (slopes slow a castle, the mountain ring
// stops it) is recomputed here from the SAME noise settings the view gives Terrain3D — the
// picture follows the logic, not the other way round.

/** @satisfies {Record<string, any>} */
WB.RNG = {
    /** mulberry32: tiny, stable across engines, good enough for a roguelike run. */
    make(seed) {
        let a = (typeof seed === 'number' ? seed : WB.RNG.hash(String(seed))) >>> 0;
        const rnd = () => {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        /** @type {any} */
        const r = rnd;
        r.next = rnd;
        r.range = (lo, hi) => lo + rnd() * (hi - lo);
        r.int = (lo, hi) => Math.floor(lo + rnd() * (hi - lo + 1));
        r.pick = (arr) => arr.length ? arr[Math.floor(rnd() * arr.length) % arr.length] : null;
        r.chance = (p) => rnd() < p;
        r.sign = () => (rnd() < 0.5 ? -1 : 1);
        r.shuffle = (arr) => {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(rnd() * (i + 1));
                const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
            }
            return arr;
        };
        // Weighted pick: weights are non-negative numbers, the sum may be anything > 0.
        r.weighted = (items, weightOf) => {
            let total = 0;
            for (const it of items) total += Math.max(0, weightOf(it));
            if (!(total > 0)) return items.length ? items[0] : null;
            let t = rnd() * total;
            for (const it of items) {
                t -= Math.max(0, weightOf(it));
                if (t <= 0) return it;
            }
            return items[items.length - 1];
        };
        r.fork = (tag) => WB.RNG.make(WB.RNG.hash(a + ':' + tag));
        return r;
    },

    /** FNV-1a over a string/number — a stable 32-bit seed from anything. */
    hash(v) {
        let h = 2166136261;
        const s = String(v);
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    }
};

/** Math helpers used all over the simulation (all pure). */
WB.M = {
    TAU: Math.PI * 2,
    clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
    lerp: (a, b, t) => a + (b - a) * t,
    dist: (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by),
    dist2: (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; },
    /** Shortest signed difference a -> b, wrapped to −π..π. */
    angleDelta: (a, b) => {
        let d = (b - a) % WB.M.TAU;
        if (d > Math.PI) d -= WB.M.TAU;
        if (d < -Math.PI) d += WB.M.TAU;
        return d;
    },
    /** Frame-rate independent exponential smoothing. */
    damp: (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt))
};

// --- Persistent save (meta-progression and settings) -----------------------------
WB.SAVE_KEY = 'wanderburg.save.v1';

WB.Save = {
    /** @type {any} */
    meta: null,

    blank() {
        return {
            v: 1,
            scrap: 0,
            legacy: [],
            settings: { sfx: 1, music: 1, shake: 1 },
            stats: { runs: 0, bestRegion: 0, wins: 0, massTotal: 0, kills: 0, devoured: 0, bestTime: 0, playTime: 0, seeds: [] }
        };
    },

    load() {
        const raw = (typeof Store !== 'undefined') ? Store.getJSON(WB.SAVE_KEY, null) : null;
        const base = WB.Save.blank();
        const m = raw && typeof raw === 'object' ? raw : {};
        WB.Save.meta = {
            v: 1,
            scrap: Math.max(0, Number(m.scrap) || 0),
            legacy: Array.isArray(m.legacy) ? m.legacy.filter(id => WB.legacyById(id)).slice(0, WB.LEGACY.length) : [],
            settings: Object.assign(base.settings, m.settings && typeof m.settings === 'object' ? m.settings : {}),
            stats: Object.assign(base.stats, m.stats && typeof m.stats === 'object' ? m.stats : {})
        };
        return WB.Save.meta;
    },

    persist() {
        if (typeof Store === 'undefined' || !WB.Save.meta) return false;
        return Store.set(WB.SAVE_KEY, JSON.stringify(WB.Save.meta));
    },

    reset() {
        WB.Save.meta = WB.Save.blank();
        return WB.Save.persist();
    },

    has(id) { return !!WB.Save.meta && WB.Save.meta.legacy.indexOf(id) >= 0; },

    /** Buy a legacy entry; false when it is already owned or too expensive. */
    buy(id) {
        const m = WB.Save.meta || WB.Save.load();
        const entry = WB.legacyById(id);
        if (!entry || WB.Save.has(id) || m.scrap < entry.cost) return false;
        m.scrap -= entry.cost;
        m.legacy.push(id);
        WB.Save.persist();
        return true;
    },

    addScrap(n) {
        const m = WB.Save.meta || WB.Save.load();
        m.scrap = Math.max(0, m.scrap + Math.round(n));
        WB.Save.persist();
        return m.scrap;
    }
};

// --- The region: a generated valley with everything in it --------------------------
// Terrain of ONE region: the same two-octave simplex the kit's Terrain3D draws, plus the
// mountain ring. The view builds Terrain3D with these numbers, the logic reads heights from
// here — one source of truth, no renderer queries from the simulation.
class WBRegion {
    /**
     * @param {number} index region number (0-based)
     * @param {any} opts { seed, biome, endless }
     */
    constructor(index, opts) {
        const o = opts || {};
        this.index = index;
        this.biome = o.biome || WB.biomeOf(index);
        this.seed = (o.seed != null ? o.seed : WB.num('SCATTER_SEED', 1337)) >>> 0;
        this.endless = !!o.endless;
        this.rnd = WB.RNG.make(this.seed + index * 7919);
        this.regionR = WB.num('REGION_R', 900);
        // The kit's terrain grid spans 0..LOCATION_WIDTH in map space, so the valley is
        // centred on the middle of that square, not on the origin.
        const LW = (typeof LOCATION_WIDTH !== 'undefined' ? LOCATION_WIDTH : 2048);
        const LH = (typeof LOCATION_HEIGHT !== 'undefined' ? LOCATION_HEIGHT : 2048);
        this.cx = LW / 2;
        this.cy = LH / 2;
        this.wallR = WB.num('WALL_R', 990);
        this.wallH = WB.num('WALL_H', 250);
        this.wallStart = WB.num('WALL_START', 0.8);
        const t = this.biome.terrain;
        this.amp = t.amp; this.scale = Math.max(64, t.scale); this.base = 0;
        this.noise = (typeof SimplexNoise !== 'undefined') ? new SimplexNoise(String(t.seed)) : null;
        /** @type {any[]} */
        this.entities = [];
        /** @type {any[]} */
        this.scenery = [];
        /** @type {any[]} */
        this.castles = [];
        this.nextId = 1;
        this.scale = 1;      // enemy power scale (set by generate)
        this._grid = new Map();
        this._gridCell = 176;
    }

    // --- terrain -----------------------------------------------------------------
    noiseAt(x, y) {
        if (!this.noise || !(this.amp > 0)) return this.base;
        const s = this.scale;
        const n = this.noise.noise2D(x / s, y / s) * 0.72 +
                  this.noise.noise2D(x / s * 2.3 + 17.1, y / s * 2.3 - 9.7) * 0.28;
        return this.base + n * this.amp;
    }

    /** Mountain ring: 0 in the valley, wallH at the rim — a smoothstep ramp. */
    wallAt(x, y) {
        const d = Math.hypot(x - this.cx, y - this.cy), r0 = this.regionR * this.wallStart;
        if (d <= r0) return 0;
        const t = WB.M.clamp((d - r0) / Math.max(1, this.wallR - r0), 0, 1);
        return this.wallH * t * t * (3 - 2 * t);
    }

    /** Ground height under a map point — what the renderer draws and what blocks the castle. */
    heightAt(x, y) { return this.noiseAt(x, y) + this.wallAt(x, y); }

    /** Slope along a heading (rad): > 0 uphill, < 0 downhill. Used for speed and tilt. */
    slopeAt(x, y, heading) {
        const e = 26, cx = Math.cos(heading), sy = Math.sin(heading);
        return (this.heightAt(x + cx * e, y + sy * e) - this.heightAt(x - cx * e, y - sy * e)) / (2 * e);
    }

    /** Inside the playable valley (not on the mountain ring). */
    inside(x, y, pad) { return Math.hypot(x - this.cx, y - this.cy) < this.regionR - (pad || 0); }

    /** Distance from the valley centre. */
    dCenter(x, y) { return Math.hypot(x - this.cx, y - this.cy); }

    // --- entity bookkeeping --------------------------------------------------------
    id() { return this.nextId++; }

    add(e) {
        e.id = e.id || this.id();
        e.dead = false;
        if (e.alive == null) e.alive = true;
        this.entities.push(e);
        return e;
    }

    remove(e) {
        e.dead = true;
        const i = this.entities.indexOf(e);
        if (i >= 0) this.entities.splice(i, 1);
        const c = this.castles.indexOf(e);
        if (c >= 0) this.castles.splice(c, 1);
    }

    byType(type) { return this.entities.filter(e => e.type === type); }

    /** Rebuild the uniform spatial hash (every frame — ~400 inserts is nothing). */
    rebuildGrid() {
        const g = this._grid, cell = this._gridCell;
        g.clear();
        for (const e of this.entities) {
            // Debris is in the hash (the hull vacuums it through near()) but it never takes
            // part in the castle-vs-castle broad phase — collide() skips it by type.
            if (e.noCollide) continue;
            const k = ((Math.floor(e.x / cell) + 512) << 10) | (Math.floor(e.y / cell) + 512);
            let list = g.get(k);
            if (!list) g.set(k, list = []);
            list.push(e);
        }
    }

    /** Entities within r of (x, y) that can be hit (no scenery, no dead ones). */
    near(x, y, r, filter) {
        const cell = this._gridCell, out = [];
        const i0 = Math.floor((x - r) / cell), i1 = Math.floor((x + r) / cell);
        const j0 = Math.floor((y - r) / cell), j1 = Math.floor((y + r) / cell);
        const r2 = r * r;
        for (let i = i0; i <= i1; i++) {
            for (let j = j0; j <= j1; j++) {
                const list = this._grid.get(((i + 512) << 10) | (j + 512));
                if (!list) continue;
                for (const e of list) {
                    if (e.dead || e.noCollide) continue;
                    if (filter && !filter(e)) continue;
                    if (WB.M.dist2(x, y, e.x, e.y) <= r2) out.push(e);
                }
            }
        }
        return out;
    }

    // --- generation ----------------------------------------------------------------
    /**
     * Candidate sites for the whole region: `n` points spread by the golden angle over the
     * valley with a jittered radius (even, deterministic, no clumping) plus a ring of sites
     * out on the slopes. `generate` walks this list in order and skips a site that sits too
     * close to something already placed, so spacing is guaranteed instead of hoped for —
     * rejection sampling used to run out of tries and drop a fortress on the player's head.
     */
    makeSites(n) {
        const rnd = this.rnd, sites = [], GA = Math.PI * (3 - Math.sqrt(5));
        // Sites stop where the mountain ramp begins (WANDER_WALL_START): a village on the slope
        // would stand half-buried in the ridge and its peasants would flee uphill.
        const R = this.regionR * 0.8;
        for (let i = 0; i < n; i++) {
            const a = i * GA + rnd.range(-0.22, 0.22);
            const d = R * (0.14 + 0.86 * Math.sqrt((i + rnd.range(0, 0.7)) / n));
            sites.push({ x: this.cx + Math.cos(a) * d, y: this.cy + Math.sin(a) * d, free: true });
        }
        return sites;
    }

    /** The next site at least `minDist` from every placed thing and from the reserved spots. */
    takeSite(minDist) {
        for (const s of this.sites) {
            if (!s.free) continue;
            let ok = true;
            for (const keep of this._keep) {
                const rr = minDist + keep.r;
                if (WB.M.dist2(s.x, s.y, keep.x, keep.y) < rr * rr) { ok = false; break; }
            }
            if (!ok) continue;
            s.free = false;
            this._keep.push({ x: s.x, y: s.y, r: minDist * 0.5 });
            return { x: s.x, y: s.y };
        }
        // Every site is taken (a tiny valley): fall back to a ring position, still kept apart
        // from the reserved circles so nothing ever spawns inside another thing.
        const rnd = this.rnd;
        for (let t = 0; t < 40; t++) {
            const a = rnd() * WB.M.TAU, d = rnd.range(this.regionR * 0.2, this.regionR * 0.8);
            const x = this.cx + Math.cos(a) * d, y = this.cy + Math.sin(a) * d;
            let ok = true;
            for (const keep of this._keep) {
                const rr = minDist + keep.r;
                if (WB.M.dist2(x, y, keep.x, keep.y) < rr * rr) { ok = false; break; }
            }
            if (ok) { this._keep.push({ x, y, r: minDist * 0.5 }); return { x, y }; }
        }
        // Last resort: the free site farthest from the spawn, else the antipode of the spawn.
        // Never a blind random point: a fortress on the player's head ruins the opening.
        let best = null, bestD = -1;
        for (const s2 of this.sites) {
            if (!s2.free) continue;
            const d2 = WB.M.dist2(s2.x, s2.y, this.spawn.x, this.spawn.y);
            if (d2 > bestD) { bestD = d2; best = s2; }
        }
        if (best) { best.free = false; return { x: best.x, y: best.y }; }
        const away = Math.atan2(this.spawn.y - this.cy, this.spawn.x - this.cx) + Math.PI;
        return { x: this.cx + Math.cos(away) * this.regionR * 0.6, y: this.cy + Math.sin(away) * this.regionR * 0.6 };
    }

    /**
     * Build the whole region.
     * @param {{ playerPos?: {x:number,y:number} }} [opts]
     */
    generate(opts) {
        const o = opts || {}, rnd = this.rnd, b = this.biome;
        const k = Math.pow(WB.num('ENEMY_SCALE', 1.38), this.index) *
            (this.endless ? Math.pow(WB.num('ENDLESS_SCALE', 1.18), Math.max(0, this.index - WB.BIOMES.length + 1)) : 1);
        this.scale = k;
        this.isCrown = this.index >= WB.BIOMES.length - 1;

        // The player's start: a random side of the valley, away from the centre (the warden
        // gate stands near the middle, so the run always begins with a drive).
        const pa = rnd() * WB.M.TAU, pd = this.regionR * WB.num('SPAWN_R', 0.52);
        this.spawn = o.playerPos || { x: this.cx + Math.cos(pa) * pd, y: this.cy + Math.sin(pa) * pd, heading: pa + Math.PI };

        // The warden gate: near the centre, on the far side from the player.
        const ga = pa + Math.PI + rnd.range(-0.5, 0.5);
        const gd = this.regionR * rnd.range(0.12, 0.3);
        this.gate = this.add({
            type: 'gate', x: this.cx + Math.cos(ga) * gd, y: this.cy + Math.sin(ga) * gd,
            r: 46, hp: Infinity, maxHp: Infinity, open: false, faction: 'none', heading: ga + Math.PI
        });

        // Reserved circles nothing may be placed in: the player's first seconds are a drive,
        // not an ambush, and the warden's courtyard stays clear for the boss fight.
        this._keep = [
            { x: this.spawn.x, y: this.spawn.y, r: 560 },
            { x: this.gate.x, y: this.gate.y, r: 240 }
        ];

        const difficulty = this.isCrown ? 1.35 : 1;
        const villages = Math.max(4, Math.round(b.villages * (this.endless ? 1.1 : 1)));
        const forts = Math.max(2, Math.round(b.fortresses * (this.isCrown ? 1.15 : 1)));
        const knights = Math.max(4, Math.round(b.knights));
        this.fortressesTotal = forts;
        // Three sites per planned entity: takeSite scans in order, and the fortress ranks must
        // still find a free spot FAR from the spawn after the food took its share.
        this.sites = this.makeSites((villages + b.herds + b.nodes + forts + knights) * 3);

        // The plan is shuffled and then sorted by "how far from the player": food lands near
        // the start (the run opens with a feast), the armed things land far away and close in
        // only when the player has grown. Fortresses keep their site, and the site decides
        // their tier — the nearest one is a tier-1 hull a beginner can actually ram to death.
        const plan = [];
        for (let i = 0; i < villages; i++) plan.push({ t: 'village', gap: 185 });
        for (let i = 0; i < b.herds; i++) plan.push({ t: 'herd', gap: 150 });
        for (let i = 0; i < b.nodes; i++) plan.push({ t: 'node', gap: 200 });
        for (let i = 0; i < 2 + Math.round(rnd() * 3); i++) plan.push({ t: 'wagon', gap: 150 });
        for (let i = 0; i < knights; i++) plan.push({ t: 'knight', gap: 150 });
        for (let i = 0; i < forts; i++) plan.push({ t: 'fortress', gap: 380 });
        rnd.shuffle(plan);
        plan.sort((A, B) => {
            const food = (t) => (t === 'village' || t === 'herd' || t === 'node' || t === 'wagon') ? 0 : 1;
            return food(A.t) - food(B.t);
        });
        // Fortresses are placed last and ranked by distance: n = 0 is the closest to the spawn.
        const fortSites = [];
        for (const item of plan) {
            const p = this.takeSite(item.gap);
            if (item.t === 'fortress') { fortSites.push(p); continue; }
            if (item.t === 'village') this.makeVillage(p.x, p.y, difficulty);
            else if (item.t === 'herd') this.makeHerd(p.x, p.y);
            else if (item.t === 'node') this.makeNode(p.x, p.y, rnd.pick(['quarry', 'mine', 'lumber']), difficulty);
            else if (item.t === 'knight') this.makeKnight(p.x, p.y, k);
            else this.add({ type: 'wagon', x: p.x, y: p.y, r: 15, hp: 18 * k, maxHp: 18 * k,
                faction: 'wild', boomable: true, massValue: 9, boom: 210 * k, boomR: 165,
                heading: rnd() * WB.M.TAU });
        }
        fortSites.sort((A, B) =>
            WB.M.dist2(A.x, A.y, this.spawn.x, this.spawn.y) - WB.M.dist2(B.x, B.y, this.spawn.x, this.spawn.y));
        fortSites.forEach((p, i) => this.makeFortress(p.x, p.y, i));
        // Decoration: trees, rocks, bushes (no collision, batched by the view).
        this.generateScenery();
        this.rebuildGrid();
        return this;
    }

    generateScenery() {
        const rnd = this.rnd, b = this.biome, n = WB.num('SCENERY_TREES', 340);
        const mix = b.scenery;
        this.scenery.length = 0;
        for (let i = 0; i < n; i++) {
            const a = rnd() * WB.M.TAU, d = Math.sqrt(rnd()) * (this.regionR + 70);
            const x = Math.cos(a) * d, y = Math.sin(a) * d;
            const t = rnd();
            const kind = t < mix.tree ? 'tree' : t < mix.tree + mix.rock ? 'rock' : 'bush';
            const s = kind === 'tree' ? rnd.range(0.75, 1.5) : kind === 'rock' ? rnd.range(0.6, 1.7) : rnd.range(0.7, 1.4);
            this.scenery.push({ kind, x, y, s, seed: rnd.int(1, 99999), h: this.heightAt(x, y) });
        }
        // The mountain ring: low wide hills just outside the playable rim, dense enough to
        // close the horizon from any camera angle inside the valley.
        for (let i = 0; i < 40; i++) {
            const a = (i / 40) * WB.M.TAU + rnd.range(-0.09, 0.09);
            const d = this.regionR * rnd.range(1.03, 1.2);
            const x = this.cx + Math.cos(a) * d, y = this.cy + Math.sin(a) * d;
            this.scenery.push({ kind: 'peak', x, y, s: rnd.range(0.8, 1.45), seed: rnd.int(1, 99999), h: this.heightAt(x, y) - 4 });
        }
    }

    makeVillage(x, y, difficulty) {
        const rnd = this.rnd;
        const houses = rnd.int(3, 6);
        const hp = (46 + houses * 12) * (difficulty || 1);
        const parts = [];
        for (let i = 0; i < houses; i++) {
            const a = rnd() * WB.M.TAU, d = rnd.range(8, 52);
            parts.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d, s: rnd.range(0.7, 1.25), seed: rnd.int(1, 9999), kind: i === 0 ? 'chapel' : 'house' });
        }
        const peasants = [];
        for (let i = 0; i < rnd.int(3, 7); i++) {
            const a = rnd() * WB.M.TAU, d = rnd.range(6, 62);
            peasants.push(this.add({
                type: 'peasant', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, r: 7,
                hp: 4, maxHp: 4, faction: 'wild', massValue: WB.num('SCATTER_MASS', 1.6) * 2.2,
                speed: rnd.range(74, 96), panic: 0, heading: rnd() * WB.M.TAU, surrender: false
            }));
        }
        return this.add({
            type: 'village', x, y, r: 62, hp, maxHp: hp, faction: 'wild', parts, peasants,
            name: rnd.pick(WB.VILLAGE_NAMES), massValue: (48 + houses * 12) * (difficulty || 1),
            scrap: 1, flee: 0, heading: rnd() * WB.M.TAU, devourRate: 1
        });
    }

    makeHerd(x, y) {
        const rnd = this.rnd;
        const sheep = [];
        for (let i = 0; i < rnd.int(6, 13); i++) {
            const a = rnd() * WB.M.TAU, d = rnd.range(6, 66);
            sheep.push(this.add({
                type: 'sheep', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, r: 8,
                hp: 3, maxHp: 3, faction: 'wild', massValue: WB.num('SCATTER_MASS', 1.6) * 1.6,
                speed: rnd.range(104, 132), panic: 0, heading: rnd() * WB.M.TAU
            }));
        }
        return this.add({ type: 'herd', x, y, r: 70, hp: 1, maxHp: 1, faction: 'wild', sheep,
            massValue: 4, name: rnd.pick(WB.HERD_NAMES), noCollide: false });
    }

    makeNode(x, y, kind, difficulty) {
        const rnd = this.rnd;
        const base = kind === 'mine' ? 130 : kind === 'quarry' ? 110 : 95;
        const hp = base * (difficulty || 1);
        return this.add({
            type: 'node', kind, x, y, r: 40, hp, maxHp: hp, faction: 'wild',
            massValue: (base * 1.25) * (difficulty || 1), scrap: kind === 'mine' ? 4 : 2,
            name: WB.NODE_NAMES[kind] || 'Рудник', heading: rnd() * WB.M.TAU, seed: rnd.int(1, 9999),
            devourRate: 0.62
        });
    }

    makeKnight(x, y, k) {
        const rnd = this.rnd;
        return this.add({
            type: 'knight', x, y, r: 13, hp: 30 * k, maxHp: 30 * k, faction: 'enemy',
            massValue: 9, scrap: 1, speed: 132, dmg: 3.5 * k, cd: 0, hitCd: 2.0,
            state: 'roam', tx: x, ty: y, homeX: x, homeY: y, leash: 460,
            think: rnd.range(1, 4), heading: rnd() * WB.M.TAU
        });
    }

    /** A roaming enemy fortress — a small AI castle built from the same module table. */
    makeFortress(x, y, n) {
        const rnd = this.rnd, k = this.scale;
        // Tier from the distance to the player's start: near — a tier-1 hull with one gun,
        // far — a tier-4 with four. `n` is that rank (0 = the closest).
        const rank = WB.M.clamp(n | 0, 0, WB.FORTRESS_LOADOUTS.length - 1);
        const tier = WB.FORTRESS_TIERS[rank];
        const hp = WB.FORTRESS_HP * (0.55 + tier * 0.45) * k;
        const mods = [];
        // The gun comes from this rank's table, the optional support from the common one.
        const count = WB.M.clamp(1 + Math.floor(rank / 1.4) + (rnd.chance(0.4) ? 1 : 0), 1, 4);
        const guns = rnd.shuffle(WB.FORTRESS_LOADOUTS[rank].slice());
        const maxLevel = this.index > 0 ? 3 : (rank >= 3 ? 2 : 1);
        for (let i = 0; i < count; i++) {
            const id = i === count - 1 && count > 2 && rnd.chance(0.5)
                ? rnd.pick(WB.FORTRESS_SUPPORT)
                : guns[i % guns.length];
            mods.push({ mod: WB.moduleById(id), level: rnd.int(1, maxLevel), slot: i, aim: 0, cd: rnd.range(0, 1.4), mount: null });
        }
        const c = this.makeCastle(x, y, {
            tier, hp, mods, faction: 'enemy', kind: 'fortress',
            name: 'Бродячая крепость ' + (n + 1), speed: WB.num('MAX_SPEED', 196) * 0.66, massValue: 55 * tier * k, scrap: WB.num('SCRAP_FORTRESS', 14)
        });
        c.ai = { state: 'roam', think: rnd.range(1, 5), tx: x, ty: y, aggro: 470, leash: 640,
            homeX: x, homeY: y, chargeCd: 0, dodgeCd: 0, stuck: 0, lastX: x, lastY: y };
        return c;
    }

    /** The region boss (or the Iron Crown in the last region). */
    makeWarden(x, y) {
        const rnd = this.rnd, k = this.scale;
        const crown = this.isCrown;
        const tier = WB.WARDEN_TIER;
        const hp = WB.WARDEN_HP * k;
        const count = crown ? 7 : 5;
        const mods = [];
        for (let i = 0; i < count; i++) {
            const id = i < 2 ? WB.pick(rnd, ['mortar', 'culverin', 'tesla']) : rnd.pick(WB.WARDEN_MODULES);
            mods.push({ mod: WB.moduleById(id), level: crown ? 3 : 2, slot: i, aim: 0, cd: rnd.range(0, 2), mount: null });
        }
        const c = this.makeCastle(x, y, {
            tier, hp, mods, faction: 'enemy', kind: crown ? 'crown' : 'warden',
            name: crown ? 'ЖЕЛЕЗНЫЙ ВЕНЕЦ' : (WB.WARDEN_NAME[Math.min(this.index, WB.WARDEN_NAME.length - 1)]),
            speed: WB.num('MAX_SPEED', 196) * (crown ? 0.66 : 0.72),
            massValue: (crown ? 760 : 480) * k,
            scrap: crown ? WB.num('SCRAP_CROWN', 200) : WB.num('SCRAP_WARDEN', 70),
            boss: true
        });
        c.ai = { state: 'patrol', think: 2, tx: x, ty: y, aggro: 900, chargeCd: crown ? 7 : 9,
            chargeT: 0, chargeDir: 0, telegraph: 0, summonCd: crown ? 8 : 14, enrage: 0, dodgeCd: 0, stuck: 0, lastX: x, lastY: y };
        return c;
    }

    /**
     * One castle (player or AI). Everything the simulation needs; the view reads the same
     * object and adds `body` (its entity tree) to it.
     */
    makeCastle(x, y, o) {
        const tier = WB.M.clamp(o.tier || 1, 1, 5);
        const c = this.add({
            type: 'castle', kind: o.kind || 'fortress', faction: o.faction || 'enemy',
            x, y, h: 0, vx: 0, vy: 0, heading: o.heading != null ? o.heading : this.rnd() * WB.M.TAU,
            spin: 0, roll: 0, pitch: 0, wheelSpin: 0,
            tier, mass: 0, r: WB.tierRadius(tier), hp: o.hp, maxHp: o.hp,
            armor: 0, modules: o.mods || [], slots: WB.tierSlots(tier),
            speedMul: 1, accelMul: 1, turnMul: 1, steam: 0, boost: false,
            ramCd: 0, hitFlash: 0, stun: 0, name: o.name || 'Замок',
            massValue: o.massValue || 40, scrap: o.scrap || 0, boss: !!o.boss,
            speedBase: o.speed || WB.num('MAX_SPEED', 196) * 0.72,
            ai: null, stats: null, statsKey: '', regenDelay: 0, alive: true, kegCd: 0, feast: 0
        });
        this.castles.push(c);
        return c;
    }

    /** The player's castle, from the chosen chassis + captain + legacy. */
    makePlayer(x, y, heading, chassis, captain, legacy) {
        const startTier = legacy && legacy.indexOf('start_tier') >= 0 ? 2 : 1;
        const c = this.makeCastle(x, y, {
            tier: startTier, hp: 100, mods: [], faction: 'player', kind: 'player',
            name: 'Вандерберг', heading, speed: WB.num('MAX_SPEED', 196)
        });
        c.chassis = chassis || WB.CHASSIS[0];
        c.captain = captain || WB.CAPTAINS[0];
        c.legacy = legacy || [];
        c.slots = Math.max(2, (c.chassis.slots || 4) + WB.tierBonusSlots(c.tier));
        c.speedBase = WB.num('MAX_SPEED', 196);
        c.mass = WB.tierMass(c.tier - 1);
        c.modules.push({ mod: WB.startModuleOf(c.chassis), level: 1, slot: 0, aim: heading, cd: 0, mount: null });
        // Every hull leaves the yard with a plate of armour: the first fortress fight must be
        // survivable with a starting loadout.
        c.modules.push({ mod: WB.moduleById('plate'), level: 1, slot: 1, aim: heading, cd: 0, mount: null });
        WB.recompute(c);
        c.hp = c.maxHp;
        c.steam = c.stats.steamMax;
        // Ysolde: a slice of the second tier's mass as a head start.
        if (c.captain.mods.startLegacy) c.mass += WB.tierMass(2) * c.captain.mods.startLegacy;
        return c;
    }
}

// --- Numeric constant access -------------------------------------------------------
// The WANDER_* constants are lexical globals of Constants.js; `typeof X !== 'undefined'`
// is the kit's own way to read them (World3D.cfg does exactly this). WB.num keeps the
// simulation runnable in node without the whole kit loaded.
// Short keys of the WANDER_CFG snapshot (the documentation of what the simulation reads).
WB.CONST_KEYS = [
    'REGION_R', 'WALL_R', 'WALL_H', 'WALL_START', 'SPAWN_R', 'SCATTER_SEED', 'SCENERY_TREES',
    'MAX_SPEED', 'SPEED_PER_TIER', 'ACCEL', 'REVERSE_FACTOR', 'DRAG', 'TURN_RATE', 'TURN_PER_TIER',
    'SLOPE_DRAG', 'STEAM_MAX', 'STEAM_REGEN', 'BOOST_DRAIN', 'BOOST_SPEED', 'BOOST_ACCEL', 'BOOST_RAM',
    'RAM_MIN_SPEED', 'RAM_DMG', 'RAM_REF_SPEED', 'RAM_COOLDOWN', 'RAM_SELF', 'RAM_KNOCK_SELF',
    'RAM_KNOCK_OTHER', 'CRIT_CHANCE', 'CRIT_MULT', 'TARGET_LEAD', 'PROJECTILE_STEP_MAX',
    'FIRE_CONE_DEG', 'TURRET_TURN', 'HULL_REGEN', 'HULL_REGEN_DELAY', 'DEVOUR_PULL', 'DEVOUR_PULL_R',
    'MASS_PER_HP', 'SCATTER_MASS', 'HEAL_ON_DEVOUR', 'SCRAP_PER_MASS', 'SCRAP_FORTRESS', 'SCRAP_WARDEN',
    'SCRAP_CROWN', 'SCRAP_REGION', 'DRAFT_CARDS', 'DRAFT_REROLL_COST', 'DRAFT_SKIP_HEAL',
    'GATE_FORTRESSES', 'REGION_COUNT', 'ENEMY_SCALE', 'ENDLESS_SCALE', 'TIER_MASS_2', 'TIER_MASS_3',
    'TIER_MASS_4', 'TIER_MASS_5', 'VIEW_RADIUS', 'PARTICLE_MAX', 'PROJECTILE_MAX', 'FLOAT_TEXT_MAX',
    'MINIMAP_SIZE', 'DAMAGE_FLASH', 'SHAKE_RAM', 'SHAKE_BOOM'
];

/**
 * Read a WANDER_* constant by its short key, with a fallback for node tests.
 * Constants.js ends with a WANDER_CFG snapshot ({ SHORT_NAME: value }): a classic script's
 * top-level `const` is a lexical global (window.X is undefined), so the snapshot is the one
 * place the simulation can read the balance from without eval and without a hard dependency
 * on the whole kit being loaded.
 */
WB.num = (key, fallback) => {
    const cfg = WB.CFG();
    const v = cfg ? cfg[key] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

/** The live WANDER_CFG snapshot (null in a bare node test without Constants.js). */
WB.CFG = () => {
    if (WB._cfg !== undefined) return WB._cfg;
    WB._cfg = typeof WANDER_CFG !== 'undefined' && WANDER_CFG ? WANDER_CFG : null;
    return WB._cfg;
};

WB.pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

// --- Hull tiers ---------------------------------------------------------------------
WB.TIER_R = [0, 46, 60, 74, 88, 102];
WB.TIER_SLOTS = [0, 4, 5, 6, 7, 8];
WB.TIER_HP = [0, 500, 720, 1000, 1380, 1850];
WB.tierRadius = (t) => WB.TIER_R[WB.M.clamp(t | 0, 1, 5)];
WB.tierSlots = (t) => WB.TIER_SLOTS[WB.M.clamp(t | 0, 1, 5)];
WB.tierMass = (t) => [0, 0, WB.num('TIER_MASS_2', 240), WB.num('TIER_MASS_3', 700),
    WB.num('TIER_MASS_4', 1300), WB.num('TIER_MASS_5', 2200), Infinity][WB.M.clamp(t | 0, 0, 6)];
WB.tierBonusSlots = (t) => Math.max(0, WB.tierSlots(t) - WB.TIER_SLOTS[1]);

// --- Derived castle stats -------------------------------------------------------------
// One place where chassis, captain, modules and legacy perks meet. Cached on the castle and
// recomputed whenever the module list or the tier changes (WB.recompute).
WB.playerStats = (c) => {
    const mods = c.modules.map(m => m.mod && m.level ? m : null).filter(Boolean);
    const sum = (key) => mods.reduce((a, m) => a + (WB.moduleStat(m.mod, m.level, key) || 0), 0);
    const prod = (key, def) => mods.reduce((a, m) => {
        const v = WB.moduleStat(m.mod, m.level, key);
        return v ? a * v : a;
    }, def == null ? 1 : def);
    const cap = c.captain ? c.captain.mods : {};
    const ch = c.chassis ? c.chassis.mods : {};
    const leg = c.legacy || [];
    const has = (id) => leg.indexOf(id) >= 0;

    const tier = WB.M.clamp(c.tier | 0, 1, 5);
    let speed = WB.num('MAX_SPEED', 196) - (tier - 1) * WB.num('SPEED_PER_TIER', 11);
    speed *= 1 + (ch.speed || 0);
    speed *= 1 + sum('speed');
    speed *= 1 + (cap.speed || 0);
    speed *= c.feast > 0 ? 1 + (cap.feastSpeed || 0) : 1;

    let turn = WB.num('TURN_RATE', 2.05) - (tier - 1) * WB.num('TURN_PER_TIER', 0.17);
    turn *= 1 + (ch.turn || 0);

    let accel = WB.num('ACCEL', 235) * (1 - (tier - 1) * 0.07);
    accel *= 1 + sum('accel');

    let maxHp = WB.TIER_HP[tier] * (1 + (ch.integrity || 0)) + sum('walls');
    if (has('thick_walls')) maxHp *= 1.15;

    let armor = WB.M.clamp((ch.armor || 0) + sum('plate'), -0.5, 0.75);

    let dmg = 1 + (ch.dmg || 0) + sum('dmg') + (cap.arcaneDmg ? 0 : 0);
    let range = 1 + (ch.range || 0) + sum('range') + sum('sight') + (cap.arcaneRange || 0);
    if (has('long_shot')) range *= 1.12;

    let steamMax = WB.num('STEAM_MAX', 100) + sum('steam');
    let steamRegen = WB.num('STEAM_REGEN', 17) * (1 + sum('steamFlow')) * (1 + (cap.steamRegen || 0));
    if (has('fast_boiler')) steamRegen *= 1.25;

    let repair = sum('repair') + WB.num('HULL_REGEN', 0) + (cap.stillRepair ? 0 : 0);
    let ram = 1 + sum('ramPower') + (cap.ramDmg || 0);
    let massGain = 1 + sum('massBonus') + (cap.massGain || 0);
    let scrapGain = 1 + sum('scrapBonus') + (cap.scrapGain || 0);
    if (has('scavenger')) scrapGain *= 1.25;

    return {
        tier, speed: Math.max(40, speed), turn: Math.max(0.4, turn), accel: Math.max(60, accel),
        maxHp: Math.max(60, Math.round(maxHp)), armor, dmg: Math.max(0.2, dmg), range: Math.max(0.4, range),
        steamMax: Math.max(20, steamMax), steamRegen: Math.max(2, steamRegen),
        repair: Math.max(0, repair), ram: Math.max(0.2, ram),
        massGain: Math.max(0.2, massGain), scrapGain: Math.max(0.2, scrapGain),
        kegDmg: sum('kegPower') * (1 + (cap.kegMult || 0)), kegAoe: Math.max(0, sum('kegRadius')),
        kegCd: mods.some(m => m.mod.id === 'keg') ? Math.min(...mods.filter(m => m.mod.id === 'keg').map(m => WB.moduleStat(m.mod, m.level, 'kegCd'))) : 0,
        burn: sum('burn'), villageMass: 1 + sum('villageBonus'), fear: sum('fear'),
        vision: sum('vision'), draftCost: prod('draftCost', 1), scrapTick: sum('scrapTick'),
        closeDmg: cap.closeDmg || 0, closeRange: cap.closeRange || 0,
        ramSplash: cap.ramSplash || 0, ramRecoil: 1 + (cap.ramRecoil || 0), boostRam: 1 + (cap.boostRam || 0),
        stillRepair: cap.stillRepair || 0, tierHeal: cap.tierHeal || 0,
        cards: WB.num('DRAFT_CARDS', 4) + (has('extra_card') ? 1 : 0),
        rerolls: (has('extra_reroll') ? 1 : 0),
        secondWind: has('second_wind'),
        mods
    };
};

/** Recompute and cache the stats; keep hp/steam inside the new limits. */
WB.recompute = (c) => {
    c.stats = WB.playerStats(c);
    c.maxHp = c.stats.maxHp;
    c.hp = Math.min(c.hp, c.maxHp);
    c.steam = Math.min(c.steam == null ? c.stats.steamMax : c.steam, c.stats.steamMax);
    return c.stats;
};

/** An AI castle's stats: no chassis/captain, just its modules and the region scale. */
WB.enemyStats = (c, scale) => {
    const sum = (key) => c.modules.reduce((a, m) => a + (WB.moduleStat(m.mod, m.level, key) || 0), 0);
    return {
        dmg: 1 + sum('dmg') * 0.5, range: 1 + sum('sight') * 0.5, armor: WB.M.clamp(sum('plate'), 0, 0.5),
        repair: sum('repair') * 0.7, kegDmg: sum('kegPower'), kegAoe: sum('kegRadius'),
        kegCd: sum('kegCd') ? 6 : 0, scale: scale || 1, mods: c.modules.map(m => m.mod).filter(Boolean)
    };
};

// --- The run ---------------------------------------------------------------------------
// One WBRun owns the region, the player, projectiles, the event queue and the frame step.
// js/Game.js drives it; nothing in here knows about the DOM or the renderer.
class WBRun {
    /** @param {{ seed?: number|string, region?: number, chassis?: any, captain?: any, legacy?: string[], meta?: any }} opts */
    constructor(opts) {
        const o = opts || {};
        this.seed = WB.RNG.hash(o.seed != null ? o.seed : Date.now());
        this.rnd = WB.RNG.make(this.seed);
        this.meta = o.meta || WB.Save.meta || WB.Save.load();
        this.legacy = o.legacy || (this.meta ? this.meta.legacy : []);
        this.regionIndex = o.region || 0;
        // The chosen loadout: every region of the run is entered with it.
        this.chassis = o.chassis || WB.CHASSIS[0];
        this.captain = o.captain || WB.CAPTAINS[0];
        /** @type {any[]} */
        this.events = [];
        /** @type {any[]} */
        this.projectiles = [];
        /** @type {any[]} */
        this.beams = [];
        /** @type {any[]} */
        this.chunks = [];
        this.time = 0;
        this.over = false;
        this.won = false;
        this.draftPending = null;
        this.paused = false;
        this.rerollsLeft = 0;
        this.secondWind = false;
        this.totals = { mass: 0, scrap: 0, kills: 0, devoured: 0, damage: 0, villages: 0, time: 0, wardens: 0 };
        this.gateKills = 0;
        this.newRegion(o);
    }

    // --- region lifecycle ----------------------------------------------------------
    newRegion(o) {
        const idx = this.regionIndex;
        const biome = WB.biomeOf(idx);
        this.region = new WBRegion(idx, {
            seed: this.seed, biome,
            endless: idx >= WB.BIOMES.length
        });
        this.region.generate();
        const r = this.region;
        this.scale = r.scale;
        this.player = r.makePlayer(r.spawn.x, r.spawn.y, r.spawn.heading,
            (o && o.chassis) || this.chassis || WB.CHASSIS[0],
            (o && o.captain) || this.captain || WB.CAPTAINS[0],
            this.legacy);
        this.rerollsLeft = this.player.stats.rerolls;
        this.secondWind = this.player.stats.secondWind;
        this.projectiles.length = 0;
        this.beams.length = 0;
        this.chunks.length = 0;
        this.boss = null;
        this.bossActive = false;
        this.gateKills = 0;
        // Grace: the first seconds of a region are for driving and eating, not for being shot.
        this.grace = WB.GRACE_SEC;
        this.emit('objective', { text: WB.OBJECTIVE_TEXT });
        this.fortressesLeft = r.fortressesTotal;
        this.emit('region', { index: idx, biome: biome.id, name: biome.name, subtitle: biome.subtitle, music: biome.music });
        return r;
    }

    /** Leave the region for the next one (the warden is dead, the gate is open). */
    nextRegion() {
        const old = this.player;
        const carry = {
            modules: old.modules, mass: old.mass, tier: old.tier,
            chassis: old.chassis, captain: old.captain, legacy: old.legacy
        };
        this.regionIndex++;
        this.regionCleared = false;
        this.newRegion({ chassis: carry.chassis, captain: carry.captain });
        const p = this.player;
        p.modules = carry.modules;
        p.mass = carry.mass;
        p.tier = carry.tier;
        p.r = WB.tierRadius(p.tier);
        p.slots = Math.max(2, (p.chassis.slots || 4) + WB.tierBonusSlots(p.tier));
        for (const m of p.modules) { m.mount = null; m.slot = p.modules.indexOf(m); }
        WB.recompute(p);
        p.hp = p.maxHp;
        p.steam = p.stats.steamMax;
        return this.region;
    }

    emit(type, data) {
        const e = { type, t: this.time };
        if (data) for (const k in data) e[k] = data[k];
        this.events.push(e);
        return e;
    }

    // --- the frame -------------------------------------------------------------------
    /**
     * One simulation step.
     * @param {number} dt seconds (clamped by the caller)
     * @param {{ throttle?: number, steer?: number, boost?: boolean }} [input]
     */
    update(dt, input) {
        if (this.over || this.paused || this.draftPending) return this.events;
        dt = WB.M.clamp(dt, 0, 0.05);
        this.time += dt;
        this.totals.time += dt;
        this.grace = Math.max(0, (this.grace || 0) - dt);
        this.events.length = 0;
        const p = this.player;
        if (!p) return this.events;

        p.feast = Math.max(0, (p.feast || 0) - dt);
        this.stepPlayer(p, dt, input || {});
        for (const c of this.region.castles) if (c !== p && c.alive) this.stepEnemyCastle(c, dt);
        this.stepUnits(dt);
        this.stepEntities(dt);
        this.stepProjectiles(dt);
        this.stepChunks(dt);
        this.stepBeams(dt);
        this.collide(dt);
        this.region.rebuildGrid();
        this.checkProgress();
        return this.events;
    }

    // --- the player's castle -----------------------------------------------------------
    stepPlayer(p, dt, input) {
        const st = p.stats || WB.recompute(p);
        const throttle = WB.M.clamp(Number(input.throttle) || 0, -1, 1);
        const steer = WB.M.clamp(Number(input.steer) || 0, -1, 1);
        const wantBoost = !!input.boost && p.steam > 1 && throttle > 0.1;
        p.boost = wantBoost;
        if (wantBoost) p.steam = Math.max(0, p.steam - WB.num('BOOST_DRAIN', 34) * dt);
        else p.steam = Math.min(st.steamMax, p.steam + st.steamRegen * dt);

        const slope = this.region.slopeAt(p.x, p.y, p.heading);
        const speedMax = st.speed * (wantBoost ? WB.num('BOOST_SPEED', 1.72) : 1) *
            (this.slowFactor(p.x, p.y));
        const accel = st.accel * (wantBoost ? WB.num('BOOST_ACCEL', 2.1) : 1);

        // Steering needs way: a standing castle turns sluggishly, a rolling one turns well.
        const fwd = p.vx * Math.cos(p.heading) + p.vy * Math.sin(p.heading);
        const way = WB.M.clamp(Math.abs(fwd) / Math.max(40, st.speed), 0, 1);
        // REVERSE GEAR flips the rudder (a car backs up the other way) — but a gravity slide
        // downhill must not: the whole valley is hills, and reading the flip off the actual
        // velocity made a standing hull on a slope steer backwards ("влево поворачивает вправо").
        // The driver's command decides, not the ground under the hull.
        const dirSign = throttle < -0.1 ? -1 : 1;
        const turnRate = st.turn * (0.32 + 0.68 * way) * dirSign * (p.stun > 0 ? 0.35 : 1);
        p.heading += steer * turnRate * dt;
        p.heading = ((p.heading + Math.PI) % WB.M.TAU + WB.M.TAU) % WB.M.TAU - Math.PI;

        // Thrust along the heading, minus gravity along the slope, minus drag.
        const ax = Math.cos(p.heading) * throttle * accel - slope * 420 * WB.num('SLOPE_DRAG', 2.6) * 0.28;
        const ay = Math.sin(p.heading) * throttle * accel - slope * 420 * WB.num('SLOPE_DRAG', 2.6) * 0.28;
        p.vx += ax * dt; p.vy += ay * dt;
        const drag = WB.num('DRAG', 1.5) + Math.abs(slope) * WB.num('SLOPE_DRAG', 2.6) + (p.stun > 0 ? 2.5 : 0);
        const d = Math.exp(-drag * dt);
        p.vx *= d; p.vy *= d;
        // Grip: the hull slides a little, heavier tiers slide more (a castle is not a car).
        const grip = 1 - Math.exp(-(6.5 - p.tier * 0.55) * dt);
        const hx = Math.cos(p.heading), hy = Math.sin(p.heading);
        const vf = p.vx * hx + p.vy * hy;
        const vr = -p.vx * hy + p.vy * hx;
        const vr2 = vr * (1 - grip);
        p.vx = hx * vf - hy * vr2; p.vy = hy * vf + hx * vr2;

        const sp = Math.hypot(p.vx, p.vy);
        const cap = throttle < 0 ? speedMax * WB.num('REVERSE_FACTOR', 0.45) : speedMax;
        if (sp > cap) { p.vx *= cap / sp; p.vy *= cap / sp; }

        const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
        if (this.region.inside(nx, ny, p.r * 0.5)) { p.x = nx; p.y = ny; }
        else this.wallBounce(p, nx, ny);

        p.speed = Math.hypot(p.vx, p.vy);
        p.h = this.region.heightAt(p.x, p.y);
        p.wheelSpin = (p.wheelSpin || 0) + (p.speed / Math.max(12, p.r * 0.42)) * dt;
        p.pitch = WB.M.clamp(this.region.slopeAt(p.x, p.y, p.heading), -0.5, 0.5);
        p.roll = WB.M.clamp(this.region.slopeAt(p.x, p.y, p.heading + Math.PI / 2), -0.5, 0.5);
        p.hitFlash = Math.max(0, (p.hitFlash || 0) - dt * 3.2);
        p.stun = Math.max(0, (p.stun || 0) - dt);
        p.ramCd = Math.max(0, (p.ramCd || 0) - dt);
        p.regenDelay = Math.max(0, (p.regenDelay || 0) - dt);

        // Repair: the workshop module always, the captain only while standing.
        let repair = st.repair;
        if (st.stillRepair && p.speed < 12) repair += st.stillRepair;
        if (p.regenDelay <= 0) repair += WB.num('HULL_REGEN', 0);
        if (repair > 0 && p.hp < p.maxHp) {
            p.hp = Math.min(p.maxHp, p.hp + repair * dt);
            if (!this._repairTick || this.time - this._repairTick > 1) { this._repairTick = this.time; this.emit('repair', { hp: p.hp }); }
        }
        // The hellish furnace eats its own hull.
        if (st.burn > 0) this.damage(p, st.burn * dt, { source: 'burn', noEvents: true });

        // Modules fire on their own; the player only drives.
        this.stepModules(p, dt);
        // Devour what the hull touches.
        this.devour(p, dt);
        // Scrap from the reliquary.
        if (st.scrapTick > 0) {
            this._scrapTick = (this._scrapTick || 0) + dt;
            if (this._scrapTick > 20) { this._scrapTick = 0; this.gainScrap(st.scrapTick, p.x, p.y); }
        }
    }

    /** Anything the ground itself slows down on (the rim of the valley, deep sand). */
    slowFactor(x, y) {
        const h = this.region.heightAt(x, y);
        return h > 40 ? WB.M.clamp(1 - (h - 40) / 160, 0.25, 1) : 1;
    }

    /** The mountain ring stops the castle and pushes it back into the valley. */
    wallBounce(c, nx, ny) {
        const R = this.region;
        const rx = nx - R.cx, ry = ny - R.cy;
        const d = Math.hypot(rx, ry) || 1;
        const max = R.regionR - c.r * 0.5;
        if (d > max) {
            const k = max / d;
            c.x = R.cx + rx * k; c.y = R.cy + ry * k;
        } else { c.x = nx; c.y = ny; }
        const nxn = (c.x - R.cx) / (d || 1), nyn = (c.y - R.cy) / (d || 1);
        const vn = c.vx * nxn + c.vy * nyn;
        if (vn > 0) {
            c.vx -= nxn * vn * 1.35; c.vy -= nyn * vn * 1.35;
            if (vn > 90) {
                this.damage(c, vn * 0.06, { source: 'wall' });
                this.emit('bump', { x: c.x, y: c.y, power: WB.M.clamp(vn / 220, 0.2, 1) });
            }
        }
    }

    // --- modules ------------------------------------------------------------------------
    stepModules(c, dt) {
        const st = c.faction === 'player' ? (c.stats || WB.recompute(c)) : (c.estats || (c.estats = WB.enemyStats(c, this.scale)));
        for (const m of c.modules) {
            if (!m.mod) continue;
            const mod = m.mod;
            m.cd = Math.max(0, (m.cd || 0) - dt * (c.faction === 'player' ? 1 : 1 + 0.18 * ((c.ai && c.ai.enrage) || 0)));
            if (mod.behavior === 'passive' || mod.behavior === 'react') continue;
            if (mod.behavior === 'spawner') { this.stepSpawner(c, m, dt, st); continue; }
            const range = WB.moduleStat(mod, m.level, 'reach') * (st.range || 1);
            if (!(range > 0)) continue;
            const target = this.findTarget(c, m, range);
            // Turrets track; fixed mounts only fire inside their own arc.
            const mountAngle = c.heading + WB.SLOT_ANGLE(m.slot, Math.max(1, c.modules.length));
            const want = target ? Math.atan2(target.y - c.y, target.x - c.x) : mountAngle;
            if (mod.turn) {
                // The shortest way round: without angleDelta a target one degree past ±180°
                // made the turret spin almost a full turn the wrong way and never fire.
                const rate = WB.num('TURRET_TURN', 3.4) * dt;
                const aim = WB.M.angleDelta(0, m.aim || 0);
                m.aim = WB.M.angleDelta(0, aim + WB.M.clamp(WB.M.angleDelta(aim, want), -rate, rate));
            } else m.aim = WB.M.angleDelta(0, want);
            if (!target || m.cd > 0) continue;
            if (!mod.turn) {
                // A fixed mount only fires inside its own arc (the mortar cannot shoot behind itself).
                const dev = WB.M.angleDelta(c.heading + mountAngle, m.aim);
                if (Math.abs(dev) > WB.num('FIRE_CONE_DEG', 150) * Math.PI / 360) continue;
            }
            m.cd = WB.moduleStat(mod, m.level, 'rate');
            this.fire(c, m, target, st);
        }
    }

    /**
     * The best target in range. Castles outrank everything (they are the threat and the
     * prize); bicycle knights are a target for the PLAYER only — an AI castle shooting a
     * knight instead of the player was wasted DPS. Debris, peasants and animals are never
     * targets: they are food for the hull, not for the guns.
     */
    findTarget(c, m, range) {
        const foe = c.faction === 'player' ? 'enemy' : 'player';
        let best = null, bestD = range * range;
        for (const t of this.region.castles) {
            if (t === c || !t.alive || t.faction !== foe) continue;
            const d = WB.M.dist2(c.x, c.y, t.x, t.y);
            if (d < bestD) { bestD = d; best = t; }
        }
        if (best) return best;
        if (foe === 'enemy') {
            for (const t of this.region.entities) {
                if (t.dead || t.faction !== 'enemy' || t.type !== 'knight') continue;
                const d = WB.M.dist2(c.x, c.y, t.x, t.y);
                if (d < bestD) { bestD = d; best = t; }
            }
        } else if (c.faction === 'enemy') {
            // AI castles also eat villages they roll past (the world lives without the player).
            for (const t of this.region.entities) {
                if (t.dead || t.type !== 'village') continue;
                const d = WB.M.dist2(c.x, c.y, t.x, t.y);
                if (d < range * range * 0.36 && d < bestD) { bestD = d; best = t; }
            }
        }
        if (m.mod && m.mod.hitsTop && best) {
            // The tesla coil wants the toughest thing in range.
            let tough = null, toughHp = -1;
            for (const t of this.region.castles) {
                if (t === c || !t.alive || t.faction !== foe) continue;
                if (WB.M.dist2(c.x, c.y, t.x, t.y) < range * range && t.hp > toughHp) { toughHp = t.hp; tough = t; }
            }
            if (tough) best = tough;
        }
        return best;
    }

    fire(c, m, target, st) {
        const mod = m.mod, lvl = m.level;
        const aim = WB.M.angleDelta(0, m.aim || 0);
        const off = c.r * 0.82;
        const mx = c.x + Math.cos(aim) * off, my = c.y + Math.sin(aim) * off;
        let dmg = WB.moduleStat(mod, lvl, 'power') * (st.dmg || 1);
        if (c.faction === 'enemy') dmg *= this.scale * (c.boss ? 0.9 : 0.5);
        const range = WB.moduleStat(mod, lvl, 'reach') * (st.range || 1);
        const shot = mod.shot || 'ball';

        // Captain Brann: more damage up close.
        if (c.faction === 'player' && c.captain && c.captain.mods.closeDmg) {
            const d = WB.M.dist(c.x, c.y, target.x, target.y);
            if (d < c.captain.mods.closeRange) dmg *= 1 + c.captain.mods.closeDmg;
        }

        if (mod.instant) {           // the tesla coil: no projectile, a beam and instant damage
            this.beams.push({ x1: mx, y1: my, x2: target.x, y2: target.y, life: 0.16, max: 0.16, color: WB.PAL.arcane });
            const crit = this.rnd.chance(WB.num('CRIT_CHANCE', 0.06));
            this.damage(target, dmg * (crit ? WB.num('CRIT_MULT', 1.7) : 1), { source: c, crit, x: target.x, y: target.y, kind: shot });
            if (mod.stun) target.stun = Math.max(target.stun || 0, mod.stun);
            this.emit('zap', { x: mx, y: my, tx: target.x, ty: target.y, faction: c.faction });
            return;
        }
        if (mod.cone) {              // the flamethrower: a short-lived cone of fire
            this.emit('flame', { x: mx, y: my, aim, faction: c.faction, range });
            for (let i = 0; i < 3; i++) {
                const a = aim + this.rnd.range(-0.32, 0.32);
                const pspd = WB.moduleStat(mod, lvl, 'pspeed');
                this.spawnProjectile({
                    x: mx, y: my, vx: Math.cos(a) * pspd, vy: Math.sin(a) * pspd,
                    dmg: dmg * 0.5, r: 16, aoe: WB.moduleStat(mod, lvl, 'aoe') * 0.5, life: mod.plife || 0.42,
                    faction: c.faction, shot, owner: c, color: WB.PAL.flame, fear: !!mod.cone
                });
            }
            return;
        }
        // Lead the target so fast hulls are hittable (the player's modules lead better).
        const lead = c.faction === 'player' ? WB.num('TARGET_LEAD', 1) : 0.35;
        const speed = WB.moduleStat(mod, lvl, 'pspeed');
        const d = WB.M.dist(mx, my, target.x, target.y) || 1;
        // Flight time comes from the DISTANCE to the target, not from the module's max range:
        // a mortar shell lands on what it was aimed at instead of flying on past it.
        const tof = WB.M.clamp(d / speed, 0.12, range / speed);
        const tx = target.x + (target.vx || 0) * tof * lead, ty = target.y + (target.vy || 0) * tof * lead;
        const a = Math.atan2(ty - my, tx - mx) + (mod.spread ? this.rnd.range(-mod.spread, mod.spread) : 0);
        const arc = mod.arc || 0;
        this.spawnProjectile({
            x: mx, y: my, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
            dmg, r: shot === 'shell' ? 13 : shot === 'bullet' ? 5 : 9,
            aoe: WB.moduleStat(mod, lvl, 'aoe'), life: arc ? tof : Math.max(tof, Math.min(range * 1.2 / speed, 2.4)),
            faction: c.faction, shot, arc, owner: c, pierce: mod.pierce || 0,
            color: mod.arcane ? WB.PAL.arcane : WB.PAL.ironDark, aim: a
        });
        this.emit('shot', { x: mx, y: my, aim: a, kind: shot, faction: c.faction, boss: !!c.boss });
        if (c.faction === 'player' && arc) this.emit('shake', { power: 0.35 });
    }

    stepSpawner(c, m, dt, st) {
        const mod = m.mod;
        const count = Math.max(1, Math.round(WB.moduleStat(mod, m.level, 'units')));
        m.units = m.units || [];
        m.units = m.units.filter(u => u.alive);
        m.cd = (m.cd || 0) - dt;
        if (m.cd > 0 || m.units.length >= count) return;
        const range = WB.moduleStat(mod, m.level, 'reach');
        const foe = c.faction === 'player' ? 'enemy' : 'player';
        let target = null, bestD = range * range;
        for (const t of this.region.castles) {
            if (t === c || !t.alive || t.faction !== foe) continue;
            const d = WB.M.dist2(c.x, c.y, t.x, t.y);
            if (d < bestD) { bestD = d; target = t; }
        }
        if (!target) { m.cd = 1; return; }
        m.cd = WB.moduleStat(mod, m.level, 'rate') / Math.max(1, count);
        const a = this.rnd() * WB.M.TAU;
        const u = this.region.add({
            type: 'wasp', x: c.x + Math.cos(a) * c.r, y: c.y + Math.sin(a) * c.r, r: 6,
            hp: 8, maxHp: 8, faction: c.faction, speed: 210, dmg: WB.moduleStat(mod, m.level, 'power'),
            target, life: 7, alive: true, owner: c, cd: 0, h: 40, heading: a
        });
        m.units.push(u);
        this.emit('spawn', { x: u.x, y: u.y, faction: c.faction });
    }

    // --- projectiles ---------------------------------------------------------------------
    /**
     * A projectile flies a straight line at `speed` for `life` seconds and lands. Its height
     * is a cosmetic parabola (arc 0..1): the shell of a mortar is drawn high over the field
     * and comes down exactly at its range, so what the player sees is what the logic hits.
     */
    spawnProjectile(o) {
        if (this.projectiles.length > WB.num('PROJECTILE_MAX', 90)) this.projectiles.shift();
        const speed = Math.hypot(o.vx, o.vy);
        const life = Math.max(0.05, o.life || 1.6);
        const p = {
            x: o.x, y: o.y, x0: o.x, y0: o.y, vx: o.vx, vy: o.vy, speed,
            dmg: o.dmg, r: o.r || 8, aoe: o.aoe || 0,
            life, maxLife: life, traveled: 0, range: speed * life,
            faction: o.faction, shot: o.shot || 'ball', arc: o.arc || 0, h: o.h || 16,
            owner: o.owner || null, pierce: o.pierce || 0,
            color: o.color == null ? WB.PAL.ironDark : o.color, fear: !!o.fear, spin: this.rnd() * WB.M.TAU
        };
        this.projectiles.push(p);
        return p;
    }

    stepProjectiles(dt) {
        const maxStep = WB.num('PROJECTILE_STEP_MAX', 34);
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            p.life -= dt;
            const step = p.speed * dt;
            const steps = Math.max(1, Math.ceil(step / maxStep));
            const sdt = dt / steps;
            let done = p.life <= 0;
            if (done) { p.h = 0; this.land(p, p.x, p.y, null); }
            for (let s = 0; s < steps && !done; s++) {
                p.x += p.vx * sdt; p.y += p.vy * sdt;
                p.traveled += p.speed * sdt;
                const t = WB.M.clamp(p.traveled / Math.max(1, p.range), 0, 1);
                p.h = (p.arc > 0 ? 26 + p.arc * 150 : 16) * 4 * t * (1 - t) + (p.arc > 0 ? 0 : 12);
                if (t >= 1) { p.h = 0; done = true; this.land(p, p.x, p.y, null); break; }
                if (this.region.dCenter(p.x, p.y) > this.region.wallR + 60) {
                    done = true; this.land(p, p.x, p.y, null); break;
                }
                const hit = this.projectileHit(p);
                if (hit) { done = true; this.land(p, hit.x, hit.y, hit.e); }
            }
            if (done) this.projectiles.splice(i, 1);
        }
    }

    /** What a shell touches this step (only foes of its faction; an arc flies over them). */
    projectileHit(p) {
        // A lobbed shell is high in the air for most of its flight: it only takes a hit at
        // the very end of the arc, which is where the player saw it coming down.
        if (p.arc > 0 && p.traveled < p.range * 0.72) return null;
        const list = this.region.near(p.x, p.y, p.r + 60, e =>
            WBRun.isFoeOf(p.faction, e) && e !== p.owner && !(e.type === 'peasant' || e.type === 'sheep'));
        for (const e of list) {
            const rr = (e.r || 10) + p.r;
            if (WB.M.dist2(p.x, p.y, e.x, e.y) <= rr * rr) {
                if (p.pierce > 0) {
                    p.pierce--;
                    this.damage(e, p.dmg, { source: p.owner, x: e.x, y: e.y, kind: p.shot });
                    this.emit('hit', { x: e.x, y: e.y, kind: p.shot, dmg: p.dmg });
                    continue;
                }
                return { e, x: p.x, y: p.y };
            }
        }
        return null;
    }

    /**
     * Who a shot of `faction` may hurt: the other side, plus powder wagons (they are nobody's,
     * and shooting one is a legitimate trick). Villages, herds and peasants are NOT foes of a
     * projectile — they are food, eaten by the hull, so a stray shell never deletes the map.
     */
    static isFoeOf(faction, e) {
        if (!e || e.faction === 'none') return false;
        if (e.boomable) return true;
        if (faction === 'player') return e.faction === 'enemy';
        if (faction === 'enemy') return e.faction === 'player';
        return false;
    }

    /** Impact: single-target damage plus an area, effects and the visuals' events. */
    land(p, x, y, direct) {
        if (p.aoe > 0) {
            this.explode(x, y, p.aoe, p.dmg, p.faction, p.owner, p.shot);
            return;
        }
        // `direct` IS the entity that was hit (projectileHit returns it bare) — reading
        // direct.e here silently made every single-target shell a no-op.
        const crit = this.rnd.chance(WB.num('CRIT_CHANCE', 0.06));
        if (direct) {
            this.damage(direct, p.dmg * (crit ? WB.num('CRIT_MULT', 1.7) : 1),
                { source: p.owner, x, y, kind: p.shot, crit });
        }
        this.emit('impact', { x, y, kind: p.shot, faction: p.faction, power: WB.M.clamp(p.dmg / 40, 0.3, 1.4) });
    }

    explode(x, y, radius, dmg, faction, owner, kind) {
        const list = this.region.near(x, y, radius + 40, e => WBRun.isFoeOf(faction, e) || e.boomable);
        for (const e of list) {
            const d = WB.M.dist(x, y, e.x, e.y);
            const fall = WB.M.clamp(1 - Math.max(0, d - (e.r || 0)) / Math.max(1, radius), 0, 1);
            if (fall <= 0) continue;
            this.damage(e, dmg * (0.45 + 0.55 * fall), { source: owner, x: e.x, y: e.y, kind: kind || 'boom' });
        }
        this.emit('boom', { x, y, r: radius, faction, power: WB.M.clamp(dmg / 60, 0.4, 2) });
    }

    stepBeams(dt) {
        for (let i = this.beams.length - 1; i >= 0; i--) {
            this.beams[i].life -= dt;
            if (this.beams[i].life <= 0) this.beams.splice(i, 1);
        }
    }

    // --- units and entities ---------------------------------------------------------------
    stepUnits(dt) {
        for (const e of this.region.entities) {
            if (e.dead) continue;
            if (e.type === 'wasp') this.stepWasp(e, dt);
            else if (e.type === 'knight') this.stepKnight(e, dt);
            else if (e.type === 'peasant') this.stepPeasant(e, dt);
            else if (e.type === 'sheep') this.stepSheep(e, dt);
        }
    }

    stepWasp(u, dt) {
        u.life -= dt;
        if (u.life <= 0) { this.region.remove(u); return; }
        const t = u.target;
        if (!t || t.dead || !t.alive) {
            u.target = this.nearestFoe(u, WB.moduleStat(WB.moduleById('hive'), 1, 'reach') * 1.4);
            if (!u.target) { u.h = Math.max(24, u.h - 20 * dt); return; }
        }
        const a = Math.atan2(u.target.y - u.y, u.target.x - u.x);
        u.heading = a;
        u.x += Math.cos(a) * u.speed * dt; u.y += Math.sin(a) * u.speed * dt;
        u.h = 34 + Math.sin(this.time * 9 + u.id) * 7;
        u.cd = Math.max(0, (u.cd || 0) - dt);
        if (u.cd <= 0 && WB.M.dist(u.x, u.y, u.target.x, u.target.y) < (u.target.r || 20) + 14) {
            u.cd = 0.8;
            this.damage(u.target, u.dmg, { source: u.owner, x: u.target.x, y: u.target.y, kind: 'sting' });
            this.emit('sting', { x: u.target.x, y: u.target.y });
        }
    }

    nearestFoe(u, range) {
        const foe = u.faction === 'player' ? 'enemy' : 'player';
        let best = null, bestD = range * range;
        for (const c of this.region.castles) {
            if (!c.alive || c.faction !== foe) continue;
            const d = WB.M.dist2(u.x, u.y, c.x, c.y);
            if (d < bestD) { bestD = d; best = c; }
        }
        return best;
    }

    stepKnight(k, dt) {
        k.think -= dt;
        k.cd = Math.max(0, (k.cd || 0) - dt);
        k.stun = Math.max(0, (k.stun || 0) - dt);
        if (k.stun > 0) return;
        const p = this.player;
        const dPlayer = (p && this.grace <= 0) ? WB.M.dist(k.x, k.y, p.x, p.y) : 1e9;
        const dHome = WB.M.dist(k.x, k.y, k.homeX == null ? k.x : k.homeX, k.homeY == null ? k.y : k.homeY);
        if (k.think <= 0) {
            k.think = this.rnd.range(1.2, 3);
            // A knight defends his stretch of the valley: he charges what comes close and
            // rides home when the chase goes too far (no map-wide swarm behind the player).
            if (dPlayer < 340 && dHome < (k.leash || 460)) { k.state = 'attack'; k.tx = p.x; k.ty = p.y; }
            else if (dHome > (k.leash || 460)) { k.state = 'home'; k.tx = k.homeX; k.ty = k.homeY; }
            else {
                k.state = 'roam';
                const a = this.rnd() * WB.M.TAU, d = this.rnd.range(120, 300);
                k.tx = WB.M.clamp(k.homeX + Math.cos(a) * d, -this.region.regionR + 60, this.region.regionR - 60);
                k.ty = WB.M.clamp(k.homeY + Math.sin(a) * d, -this.region.regionR + 60, this.region.regionR - 60);
            }
        }
        if (k.state === 'home' && dHome < 90) { k.state = 'roam'; k.think = 0; }
        if (k.state === 'attack' && p) { k.tx = p.x; k.ty = p.y; }
        const a = Math.atan2(k.ty - k.y, k.tx - k.x);
        k.heading = a;
        const sp = k.state === 'attack' ? k.speed : k.speed * 0.55;
        k.x += Math.cos(a) * sp * dt; k.y += Math.sin(a) * sp * dt;
        k.h = this.region.heightAt(k.x, k.y);
        if (k.state === 'attack' && p && dPlayer < p.r + 26 && k.cd <= 0) {
            k.cd = k.hitCd;
            this.damage(p, k.dmg, { source: k, x: p.x, y: p.y, kind: 'lance' });
            this.emit('melee', { x: k.x, y: k.y });
        }
    }

    stepPeasant(pe, dt) {
        pe.stun = Math.max(0, (pe.stun || 0) - dt);
        if (pe.surrender) {
            // Walking into the hull: a surrendered peasant is mass without a chase.
            const p = this.player;
            if (p) {
                const a = Math.atan2(p.y - pe.y, p.x - pe.x);
                pe.x += Math.cos(a) * 70 * dt; pe.y += Math.sin(a) * 70 * dt;
                pe.heading = a;
            }
            return;
        }
        const threat = this.nearestThreat(pe.x, pe.y, 420);
        if (threat) {
            const a = Math.atan2(pe.y - threat.y, pe.x - threat.x) + this.rnd.range(-0.25, 0.25);
            pe.heading = a;
            const fear = this.player && this.player.stats ? this.player.stats.fear : 0;
            const sp = pe.speed * (threat.faction === 'player' ? (fear > 0 ? 0.72 : 1) : 1);
            pe.x += Math.cos(a) * sp * dt; pe.y += Math.sin(a) * sp * dt;
            pe.panic = 1;
            if (fear > 0 && threat.faction === 'player' && WB.M.dist(pe.x, pe.y, threat.x, threat.y) < 200 && this.rnd.chance(dt * 1.2)) {
                pe.surrender = true;
                this.emit('surrender', { x: pe.x, y: pe.y });
            }
        } else {
            pe.panic = Math.max(0, pe.panic - dt);
            pe.think = (pe.think || 0) - dt;
            if (pe.think <= 0) {
                pe.think = this.rnd.range(1.5, 4);
                pe.wander = this.rnd() * WB.M.TAU;
            }
            const a = pe.wander || 0;
            pe.x += Math.cos(a) * 16 * dt; pe.y += Math.sin(a) * 16 * dt;
            pe.heading = a;
        }
        pe.h = this.region.heightAt(pe.x, pe.y);
        if (!this.region.inside(pe.x, pe.y, 20)) {
            const d = Math.hypot(pe.x, pe.y) || 1, k = (this.region.regionR - 20) / d;
            pe.x *= k; pe.y *= k;
        }
    }

    stepSheep(s, dt) {
        const threat = this.nearestThreat(s.x, s.y, 300);
        if (threat) {
            const a = Math.atan2(s.y - threat.y, s.x - threat.x) + this.rnd.range(-0.6, 0.6);
            s.heading = a;
            s.x += Math.cos(a) * s.speed * dt; s.y += Math.sin(a) * s.speed * dt;
            s.panic = 1;
        } else {
            s.panic = Math.max(0, s.panic - dt);
            s.think = (s.think || 0) - dt;
            if (s.think <= 0) { s.think = this.rnd.range(1, 3.4); s.wander = this.rnd() * WB.M.TAU; }
            s.x += Math.cos(s.wander || 0) * 20 * dt; s.y += Math.sin(s.wander || 0) * 20 * dt;
        }
        s.h = this.region.heightAt(s.x, s.y);
        if (!this.region.inside(s.x, s.y, 20)) {
            const d = Math.hypot(s.x, s.y) || 1, k = (this.region.regionR - 20) / d;
            s.x *= k; s.y *= k;
        }
    }

    /** The nearest castle that this little thing is afraid of. */
    nearestThreat(x, y, range) {
        let best = null, bestD = range * range;
        for (const c of this.region.castles) {
            if (!c.alive) continue;
            const d = WB.M.dist2(x, y, c.x, c.y);
            if (d < bestD) { bestD = d; best = c; }
        }
        return best;
    }

    stepEntities(dt) {
        for (const e of this.region.entities) {
            if (e.dead) continue;
            if (e.type === 'village') {
                // A village walks away from the nearest castle, slowly, as a whole.
                const t = this.nearestThreat(e.x, e.y, 460);
                e.flee = t ? 1 : Math.max(0, (e.flee || 0) - dt);
                if (t) {
                    const a = Math.atan2(e.y - t.y, e.x - t.x);
                    e.heading = a;
                    const sp = 34 * (t.faction === 'player' ? 1 : 0.7);
                    const nx = e.x + Math.cos(a) * sp * dt, ny = e.y + Math.sin(a) * sp * dt;
                    if (this.region.inside(nx, ny, 90)) { e.x = nx; e.y = ny; }
                    for (const pe of e.peasants) { if (!pe.dead) { pe.x += Math.cos(a) * sp * dt; pe.y += Math.sin(a) * sp * dt; } }
                }
                e.h = this.region.heightAt(e.x, e.y);
            } else if (e.type === 'herd') {
                const t = this.nearestThreat(e.x, e.y, 380);
                if (t) {
                    const a = Math.atan2(e.y - t.y, e.x - t.x);
                    const nx = e.x + Math.cos(a) * 22 * dt, ny = e.y + Math.sin(a) * 22 * dt;
                    if (this.region.inside(nx, ny, 90)) { e.x = nx; e.y = ny; }
                }
                e.h = this.region.heightAt(e.x, e.y);
            }
        }
    }

    // --- collisions -------------------------------------------------------------------------
    collide(dt) {
        void dt;
        const list = this.region.entities;
        // Castle vs castle (ram) and castle vs the small things.
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            if (a.type !== 'castle' || !a.alive) continue;
            for (let j = i + 1; j < list.length; j++) {
                const b = list[j];
                if (b.dead || b.type === 'chunk' || b.type === 'peasant' || b.type === 'sheep') continue;
                const rr = a.r + (b.r || 10);
                const d2 = WB.M.dist2(a.x, a.y, b.x, b.y);
                if (d2 > rr * rr) continue;
                if (b.type === 'castle') this.castleHit(a, b);
                else if (b.faction && b.faction !== a.faction && (b.type === 'knight' || b.type === 'wagon')) {
                    const sp = Math.hypot(a.vx || 0, a.vy || 0);
                    if (sp > WB.num('RAM_MIN_SPEED', 72) * 0.6) {
                        this.damage(b, 18 + sp * 0.16, { source: a, x: b.x, y: b.y, kind: 'ram' });
                        a.vx *= 0.94; a.vy *= 0.94;
                    }
                } else if (b.noCollide === false && (b.type === 'village' || b.type === 'node')) {
                    // Structures stop the hull a little (they are being eaten anyway).
                    const d = Math.sqrt(d2) || 1, push = (rr - d) * 0.35;
                    a.x += (a.x - b.x) / d * push * 0.2; a.y += (a.y - b.y) / d * push * 0.2;
                }
            }
        }
    }

    /** Two hulls meet: separation + a ram hit from whoever is faster. */
    castleHit(a, b) {
        const d = WB.M.dist(a.x, a.y, b.x, b.y) || 1;
        const overlap = a.r + b.r - d;
        const nx = (a.x - b.x) / d, ny = (a.y - b.y) / d;
        const ma = a.tier * a.tier, mb = b.tier * b.tier, tot = ma + mb;
        a.x += nx * overlap * (mb / tot); a.y += ny * overlap * (mb / tot);
        b.x -= nx * overlap * (ma / tot); b.y -= ny * overlap * (ma / tot);
        const va = a.vx * nx + a.vy * ny, vb = b.vx * nx + b.vy * ny;
        const closing = va - vb;
        // Bounce
        const impulse = closing * 0.6;
        a.vx -= nx * impulse * (mb / tot) * 2; a.vy -= ny * impulse * (mb / tot) * 2;
        b.vx += nx * impulse * (ma / tot) * 2; b.vy += ny * impulse * (ma / tot) * 2;
        if (closing < WB.num('RAM_MIN_SPEED', 72)) return;
        const now = this.time;
        if ((a._ramAt && a._ramAt[b.id] > now) || (b._ramAt && b._ramAt[a.id] > now)) return;
        a._ramAt = a._ramAt || {}; b._ramAt = b._ramAt || {};
        a._ramAt[b.id] = b._ramAt[a.id] = now + WB.num('RAM_COOLDOWN', 0.5);
        this.ram(a, b, closing, nx, ny);
        this.ram(b, a, -vb, -nx, -ny);
    }

    /** One rammer, one victim. */
    ram(att, vic, closing, nx, ny) {
        if (!(closing > WB.num('RAM_MIN_SPEED', 72))) return;
        const st = att.faction === 'player' ? att.stats : att.estats;
        let dmg = WB.num('RAM_DMG', 26) * (closing / WB.num('RAM_REF_SPEED', 150)) *
            (0.6 + att.tier * 0.28) * (st && st.ram ? st.ram : 1);
        if (att.boost) dmg *= WB.num('BOOST_RAM', 1.5) * (att.faction === 'player' && att.captain ? att.captain.mods.boostRam || 1 : 1) ;
        if (att.faction === 'enemy' && att.boss && att.ai && att.ai.chargeT > 0) dmg *= 2.6;
        if (att.faction === 'enemy') dmg *= this.scale * 0.6;
        this.damage(vic, dmg, { source: att, x: vic.x, y: vic.y, kind: 'ram' });
        // Recoil for the rammer, knockback for the victim.
        const recoil = WB.num('RAM_SELF', 0.22) * (att.faction === 'player' && att.stats ? att.stats.ramRecoil : 1);
        this.damage(att, dmg * recoil, { source: att, x: att.x, y: att.y, kind: 'ram', noEvents: true });
        const attSpeed = Math.hypot(att.vx, att.vy), kick = WB.num('RAM_KNOCK_SELF', 0.45);
        att.vx -= nx * attSpeed * kick; att.vy -= ny * attSpeed * kick;
        const knock = closing * WB.num('RAM_KNOCK_OTHER', 0.7) * 0.5;
        vic.vx += nx * knock; vic.vy += ny * knock;
        // Mordrek: the ram hits everything around the victim too.
        const splash = att.faction === 'player' && att.stats ? att.stats.ramSplash : 0;
        if (splash > 0) this.explode(vic.x, vic.y, 130, dmg * 0.5, att.faction, att, 'ram');
        this.emit('ram', { x: (att.x + vic.x) / 2, y: (att.y + vic.y) / 2, dmg, power: WB.M.clamp(closing / 220, 0.3, 1.6), victim: vic.id });
        if (att.faction === 'player') this.emit('shake', { power: WB.num('SHAKE_RAM', 9) / 9 * WB.M.clamp(closing / 200, 0.35, 1.4) });
    }

    // --- devouring ---------------------------------------------------------------------------
    /** The hull eats what it touches: structures chew, small things die at once. */
    devour(c, dt) {
        if (c.faction !== 'player' && c.kind !== 'player') {
            // AI castles eat villages they roll over (the world does not wait for the player).
            for (const e of this.region.near(c.x, c.y, c.r + 12, e => e.type === 'village' || e.type === 'herd')) {
                this.damage(e, 60 * dt, { source: c, x: e.x, y: e.y, kind: 'devour', silent: true });
            }
            return;
        }
        const st = c.stats || WB.recompute(c);
        const rate = 95 * (0.75 + c.tier * 0.16);
        const pullR = WB.num('DEVOUR_PULL_R', 190);
        const near = this.region.near(c.x, c.y, c.r + pullR);
        for (const e of near) {
            const d = WB.M.dist(c.x, c.y, e.x, e.y);
            if (e.type === 'chunk') {
                // Debris flies into the hull. Its lifetime is NOT refreshed here: a chunk that
                // is never reached has to expire, or it orbits the hull forever.
                if (d < c.r + 14) { this.collectChunk(e, c); continue; }
                if (d < pullR) {
                    const a = Math.atan2(c.y - e.y, c.x - e.x);
                    const pull = WB.num('DEVOUR_PULL', 420) * dt * (1.25 - d / (pullR * 1.6));
                    e.x += Math.cos(a) * pull; e.y += Math.sin(a) * pull;
                }
                continue;
            }
            if (d > c.r + (e.r || 8) + 4) continue;
            if (e.type === 'peasant' || e.type === 'sheep') { this.killSmall(e, c); continue; }
            if (e.type === 'village' || e.type === 'node') {
                this.damage(e, rate * dt * (e.devourRate || 1), { source: c, x: e.x, y: e.y, kind: 'devour' });
                if (this.rnd.chance(dt * 6)) this.emit('chew', { x: e.x, y: e.y });
            } else if (e.type === 'gate') {
                if (e.open && !this.bossActive) this.startBoss();
            }
        }
    }

    killSmall(e, c) {
        const st = c && c.stats ? c.stats : null;
        const mass = (e.massValue || WB.num('SCATTER_MASS', 1.6)) * (st ? st.massGain : 1);
        this.gainMass(mass, e.x, e.y);   // eaten on contact: no debris to vacuum
        this.emit('gulp', { x: e.x, y: e.y, mass, kind: e.type });
        this.region.remove(e);
        this.totals.devoured++;
    }

    collectChunk(e, c) {
        const st = c && c.stats ? c.stats : null;
        const mass = (e.mass || WB.num('SCATTER_MASS', 1.6)) * (st ? st.massGain : 1);
        this.gainMass(mass, c.x, c.y);
        this.region.remove(e);
        this.emit('chunkEaten', { mass });
    }

    stepChunks(dt) {
        const p = this.player;
        for (let i = this.chunks.length - 1; i >= 0; i--) {
            const ch = this.chunks[i];
            ch.life -= dt;
            // A gentle magnet: the wreckage slides toward the hull, faster as it gets older,
            // so nothing valuable is left behind just because the player kept driving.
            if (p && p.alive) {
                const d = WB.M.dist(ch.x, ch.y, p.x, p.y);
                if (d < 420 && d > 1) {
                    // Stronger the older the chunk is, so fresh debris flies out and old
                    // debris gets sucked in — but never hard enough to orbit the hull.
                    const age = 1 - WB.M.clamp(ch.life / 12, 0, 1);
                    const pull = (60 + age * 260) / Math.max(60, d);
                    ch.vx += (p.x - ch.x) * pull * dt * 3;
                    ch.vy += (p.y - ch.y) * pull * dt * 3;
                }
            }
            ch.x += ch.vx * dt; ch.y += ch.vy * dt;
            ch.vx *= Math.exp(-2.2 * dt); ch.vy *= Math.exp(-2.2 * dt);
            ch.h = Math.max(4, ch.h - 22 * dt);
            if (ch.life <= 0 || ch.dead) { this.chunks.splice(i, 1); if (!ch.dead) this.region.remove(ch); }
        }
    }

    /**
     * Debris that flies out of a destroyed thing and is vacuumed into the hull.
     * `totalMass` is split: WB.CHUNK_SHARE of it goes straight into the hull when the thing
     * dies (the reward is never lost), the rest rides in the debris and is collected by
     * driving over it — the juicy bit, worth staying a second in a fight for. The debris also
     * drifts toward the hull over its lifetime, so a player who keeps rolling collects most
     * of it anyway.
     */
    scatterChunks(x, y, count, totalMass, color, speed) {
        const p = this.player;
        const straight = totalMass * (1 - WB.CHUNK_SHARE);
        if (straight > 0 && p) this.gainMass(straight, x, y);
        const n = WB.M.clamp(Math.round(count), 1, 26);
        const massEach = totalMass * WB.CHUNK_SHARE / n;
        for (let i = 0; i < n; i++) {
            const a = this.rnd() * WB.M.TAU, s = (speed || 130) * this.rnd.range(0.4, 1.2);
            const ch = this.region.add({
                type: 'chunk', x: x + Math.cos(a) * 6, y: y + Math.sin(a) * 6, r: 7,
                vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: this.rnd.range(9, 15),
                mass: massEach, color, faction: 'none', h: 8 + this.rnd() * 18
            });
            this.chunks.push(ch);
            // A hard cap: a long fight must not grow the entity list without bound. The
            // dropped chunk is removed from the world too, so its mass simply goes uncollected.
            if (this.chunks.length > 130) { const old = this.chunks.shift(); this.region.remove(old); }
        }
    }

    // --- damage and death -----------------------------------------------------------------------
    /**
     * Apply damage to anything with hp.
     * @param {any} e entity
     * @param {number} amount raw damage (before armor)
     * @param {any} [o] { source, x, y, kind, silent, massMult }
     */
    damage(e, amount, o) {
        const opt = o || {};
        if (!e || e.dead || !(amount > 0)) return 0;
        if (e.hp === Infinity) return 0;
        let dmg = amount;
        if (e.type === 'castle') {
            const st = e.faction === 'player' ? e.stats : (e.estats || (e.estats = WB.enemyStats(e, this.scale)));
            const armor = st ? st.armor : 0;
            dmg *= 1 - WB.M.clamp(armor, -0.3, 0.75);
        }
        const crit = opt.crit || false;
        e.hp -= dmg;
        e.hitFlash = 1;
        if (e.type === 'castle') {
            e.regenDelay = WB.num('HULL_REGEN_DELAY', 6);
            if (e.faction === 'player') this.emit('hurt', { dmg, x: e.x, y: e.y, kind: opt.kind || 'hit' });
        }
        if (opt.source && opt.source.faction === 'player' && e.faction === 'enemy') this.totals.damage += dmg;
        if (!opt.noEvents && dmg > 0.5) {
            this.emit('damage', { x: opt.x != null ? opt.x : e.x, y: opt.y != null ? opt.y : e.y, dmg, crit, kind: opt.kind || 'hit', target: e.type });
        }
        // The powder keg reacts to being hit.
        if (e.type === 'castle' && e.hp > 0) {
            const st = e.faction === 'player' ? e.stats : e.estats;
            if (st && st.kegDmg > 0 && e.alive) {
                e.kegCd = (e.kegCd || 0);
                if (this.time > e.kegCd) {
                    e.kegCd = this.time + (st.kegCd || 5);
                    this.explode(e.x, e.y, st.kegAoe || 180, st.kegDmg, e.faction, e, 'keg');
                }
            }
        }
        if (e.hp <= 0) this.kill(e, opt);
        return dmg;
    }

    kill(e, opt) {
        if (e.dead) return;
        const o = opt || {};
        if (e.type === 'castle') {
            e.alive = false;
            const isPlayer = e.faction === 'player';
            this.emit('castleDown', { x: e.x, y: e.y, r: e.r, faction: e.faction, boss: !!e.boss, name: e.name, player: isPlayer });
            const st = this.player.stats;
            this.scatterChunks(e.x, e.y, 22, (e.massValue || 40) * st.massGain, WB.PAL.stoneDark, 200);
            this.scatterChunks(e.x, e.y, 10, 12 * st.massGain, WB.PAL.iron, 150);
            if (isPlayer) { this.playerDeath(); return; }
            this.totals.kills++;
            this.gainScrap((e.scrap || 0) * (this.player.stats ? this.player.stats.scrapGain : 1), e.x, e.y);
            if (e.kind === 'fortress') {
                this.fortressesLeft = Math.max(0, this.fortressesLeft - 1);
                this.emit('fortressDown', { name: e.name, left: this.fortressesLeft });
            }
            if (e.boss) this.bossDown(e);
            this.region.remove(e);
            return;
        }
        if (e.type === 'wagon') {
            // Remove FIRST, then explode: two wagons in each other's radius would otherwise
            // kill one another forever (kill -> explode -> damage -> kill …).
            const boomR = e.boomR, boom = e.boom;
            e.dead = true;
            this.region.remove(e);
            this.emit('boom', { x: e.x, y: e.y, r: boomR, faction: 'wild', power: 1.2 });
            this.explode(e.x, e.y, boomR, boom, 'wild', null, 'wagon');
            this.scatterChunks(e.x, e.y, 5, (e.massValue || 8) * this.player.stats.massGain, WB.PAL.woodDark, 170);
            return;
        }
        if (e.type === 'village' || e.type === 'node') {
            const st = this.player.stats || WB.recompute(this.player);
            const mass = (e.massValue || 20) * (e.type === 'village' ? st.villageMass : 1) * st.massGain;
            this.emit('devoured', { x: e.x, y: e.y, name: e.name || (e.type === 'village' ? 'Деревня' : 'Рудник'), mass, kind: e.type, r: e.r });
            this.scatterChunks(e.x, e.y, e.type === 'village' ? 18 : 14, mass,
                e.type === 'village' ? WB.PAL.wood : WB.PAL.rockDark, 175);
            if (e.scrap) this.gainScrap(e.scrap * st.scrapGain, e.x, e.y);
            if (e.type === 'village') {
                this.totals.villages++;
                this.player.hp = Math.min(this.player.maxHp, this.player.hp + this.player.maxHp * WB.num('HEAL_ON_DEVOUR', 0.02));
                // The captain feasts.
                if (this.player.captain && this.player.captain.mods.feastSpeed) {
                    this.player.feast = this.player.captain.mods.feastTime || 4;
                    this.emit('feast', { time: this.player.feast });
                }
            }
            this.totals.devoured++;
            // Its peasants become free agents (they keep running).
            if (e.peasants) for (const pe of e.peasants) pe.home = null;
            this.region.remove(e);
            return;
        }
        if (e.type === 'herd') { this.region.remove(e); return; }
        if (e.type === 'peasant' || e.type === 'sheep' || e.type === 'wasp' || e.type === 'knight') {
            const st = this.player.stats;
            if (e.type === 'knight') {
                this.totals.kills++;
                this.gainScrap((e.scrap || 0) * st.scrapGain, e.x, e.y);
                this.scatterChunks(e.x, e.y, 5, (e.massValue || 6) * st.massGain, WB.PAL.steel, 140);
                this.emit('knightDown', { x: e.x, y: e.y });
            } else {
                this.scatterChunks(e.x, e.y, 2, (e.massValue || 2) * st.massGain,
                    e.type === 'sheep' ? WB.PAL.wool : WB.PAL.peasantCloth, 110);
            }
            this.region.remove(e);
            return;
        }
        this.region.remove(e);
    }

    playerDeath() {
        const p = this.player;
        // Second Wind: one free revive per run.
        if (this.secondWind) {
            this.secondWind = false;
            p.hp = p.maxHp * 0.45;
            p.alive = true;
            p.vx = p.vy = 0;
            this.emit('secondWind', { x: p.x, y: p.y });
            this.explode(p.x, p.y, 260, 90, 'player', p, 'revive');
            return;
        }
        p.alive = false;
        this.over = true;
        this.won = false;
        this.emit('playerDown', { x: p.x, y: p.y, r: p.r });
        this.emit('runEnd', { won: false, summary: this.summary() });
    }

    // --- mass, tiers, drafts -------------------------------------------------------------------
    gainMass(n, x, y) {
        if (!(n > 0)) return;
        const p = this.player;
        p.mass += n;
        this.totals.mass += n;
        this.emit('mass', { amount: n, total: p.mass, x, y });
        this.checkTier(p, { x, y });
    }

    gainScrap(n, x, y) {
        if (!(n > 0)) return;
        this.totals.scrap += n;
        this.emit('scrap', { amount: n, total: this.totals.scrap, x, y });
    }

    /** Grow a tier when the mass says so: bigger hull, more slots, a draft. */
    checkTier(p, at) {
        while (p.tier < 5 && p.mass >= WB.tierMass(p.tier + 1)) {
            p.tier++;
            p.r = WB.tierRadius(p.tier);
            p.slots = Math.max(2, (p.chassis ? p.chassis.slots : 4) + WB.tierBonusSlots(p.tier));
            WB.recompute(p);
            const heal = WB.num('HEAL_ON_DEVOUR', 0.02) + (p.stats.tierHeal || 0) +
                (this.legacy.indexOf('tier_repair') >= 0 ? 0.35 : 0);
            p.hp = Math.min(p.maxHp, p.hp + p.maxHp * heal);
            this.emit('tierUp', { tier: p.tier, x: at ? at.x : p.x, y: at ? at.y : p.y, slots: p.slots, maxHp: p.maxHp });
            this.offerDraft('tier');
        }
    }

    /** Queue a draft (the run pauses while the HUD shows it). */
    offerDraft(reason) {
        this.draftPending = { reason, cards: this.buildDraft(), rerollCost: this.rerollCost() };
        this.emit('draft', { reason, cards: this.draftPending.cards.map(c => ({ kind: c.kind, id: c.id, level: c.level })) });
        return this.draftPending;
    }

    rerollCost() {
        const st = this.player.stats;
        return Math.round(WB.num('DRAFT_REROLL_COST', 22) * (st ? st.draftCost : 1));
    }

    /** The card pool: new modules (weighted by rarity) + upgrades of the installed ones. */
    buildDraft() {
        const p = this.player, rnd = this.rnd;
        const owned = {};
        for (const m of p.modules) owned[m.mod.id] = m;
        const pool = [];
        for (const mod of WB.MODULES) {
            if (!WB.moduleUnlocked(mod, { legacy: this.legacy })) continue;
            if (owned[mod.id]) continue;
            if (p.modules.length >= p.slots) break;
            pool.push({ kind: 'new', id: mod.id, mod, level: 1, weight: [10, 5.5, 2.6][mod.rarity] * (p.modules.length < 2 ? 1.5 : 1) });
        }
        for (const m of p.modules) {
            if (m.level >= WB.MOD_MAX_LEVEL) continue;
            pool.push({ kind: 'upgrade', id: m.mod.id, mod: m.mod, level: m.level + 1, weight: 8.5 - m.level * 1.6 });
        }
        // A repair card is always on the table when the hull is hurt (a draft must never be a dead end).
        const cards = [];
        const n = p.stats ? p.stats.cards : WB.num('DRAFT_CARDS', 4);
        const picks = [];
        for (let i = 0; i < n + 3 && pool.length; i++) {
            const card = rnd.weighted(pool, c => c.weight);
            if (!card) break;
            if (picks.indexOf(card) >= 0) continue;
            picks.push(card);
            pool.splice(pool.indexOf(card), 1);
        }
        for (const c of picks.slice(0, n)) cards.push(c);
        if (p.hp < p.maxHp * 0.85) {
            cards.push({ kind: 'repair', id: 'repair', mod: null, level: 0, weight: 0,
                name: 'Полевой ремонт', desc: 'Починить ' + Math.round(p.maxHp * 0.3) + ' ед. корпуса.' });
        }
        if (!cards.length) {
            cards.push({ kind: 'scrap', id: 'scrap', mod: null, level: 0, weight: 0,
                name: 'Разобрать обоз', desc: 'Взять ' + (25 + p.tier * 10) + ' лома сразу.' });
        }
        return cards;
    }

    /** Take a card: 1..N by index, 'reroll', 'skip'. Returns the taken card or null. */
    takeDraft(which) {
        const d = this.draftPending;
        if (!d) return null;
        const p = this.player;
        if (which === 'reroll') {
            if (this.rerollsLeft > 0) { this.rerollsLeft--; d.cards = this.buildDraft(); this.emit('reroll', { free: true }); return d.cards; }
            const cost = this.rerollCost();
            if (p.mass < cost) { this.emit('deny', { why: 'mass' }); return null; }
            p.mass -= cost;
            d.cards = this.buildDraft();
            this.emit('reroll', { cost });
            return d.cards;
        }
        const idx = typeof which === 'number' ? which : parseInt(which, 10);
        const card = d.cards[idx - 1] || d.cards[idx];
        if (!card) return null;
        if (card.kind === 'new') {
            if (p.modules.length >= p.slots) { this.emit('deny', { why: 'slots' }); return null; }
            p.modules.push({ mod: card.mod, level: 1, slot: p.modules.length, aim: p.heading, cd: 0.4, mount: null });
        } else if (card.kind === 'upgrade') {
            const m = p.modules.find(x => x.mod.id === card.id);
            if (m) m.level = Math.min(WB.MOD_MAX_LEVEL, m.level + 1);
        } else if (card.kind === 'repair') {
            p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
        } else if (card.kind === 'scrap') {
            this.gainScrap(25 + p.tier * 10, p.x, p.y);
        }
        // Slots are laid out by index: re-number so the hull looks even.
        p.modules.forEach((m, i) => { m.slot = i; });
        WB.recompute(p);
        this.draftPending = null;
        this.emit('take', { kind: card.kind, id: card.id, level: card.level, name: card.name || (card.mod ? card.mod.name : '') });
        return card;
    }

    skipDraft() {
        const p = this.player;
        p.hp = Math.min(p.maxHp, p.hp + p.maxHp * WB.num('DRAFT_SKIP_HEAL', 0.12));
        this.draftPending = null;
        this.emit('skip', {});
    }

    // --- the gate, the boss, the region end -----------------------------------------------------
    checkProgress() {
        const g = this.region.gate;
        // The gate opens when only WANDER_GATE_FORTRESSES of them are still standing: the
        // player has to hunt most of the valley down before the warden will show itself.
        const left = WB.num('GATE_FORTRESSES', 2);
        if (g && !g.open && this.fortressesLeft <= Math.min(left, this.region.fortressesTotal - 1)) {
            g.open = true;
            this.emit('gateOpen', { x: g.x, y: g.y });
        }
        if (this.player.hp <= 0 && !this.over) this.playerDeath();
    }

    startBoss() {
        if (this.bossActive) return;
        this.bossActive = true;
        const g = this.region.gate;
        const boss = this.region.makeWarden(g.x, g.y);
        this.boss = boss;
        g.boss = boss;
        this.emit('bossSpawn', { x: boss.x, y: boss.y, name: boss.name, hp: boss.hp, crown: boss.kind === 'crown' });
        this.emit('shake', { power: 1.4 });
    }

    bossDown(e) {
        this.totals.wardens++;
        this.bossActive = false;
        this.boss = null;
        const crown = e.kind === 'crown';
        this.emit('bossDown', { x: e.x, y: e.y, name: e.name, crown });
        if (crown) {
            this.won = true;
            this.emit('runEnd', { won: true, summary: this.summary() });
            return;
        }
        this.emit('regionClear', { index: this.regionIndex, scrap: WB.num('SCRAP_REGION', 45) });
        this.gainScrap(WB.num('SCRAP_REGION', 45), e.x, e.y);
        this.regionCleared = true;
    }

    // --- enemy AI ---------------------------------------------------------------------------------
    stepEnemyCastle(c, dt) {
        const ai = c.ai || (c.ai = { state: 'roam', think: 1, tx: c.x, ty: c.y, aggro: 640, chargeCd: 8, dodgeCd: 0, stuck: 0, lastX: c.x, lastY: c.y });
        const st = c.estats || (c.estats = WB.enemyStats(c, this.scale));
        const p = this.player;
        c.hitFlash = Math.max(0, (c.hitFlash || 0) - dt * 3);
        c.stun = Math.max(0, (c.stun || 0) - dt);
        c.ramCd = Math.max(0, (c.ramCd || 0) - dt);
        ai.dodgeCd = Math.max(0, (ai.dodgeCd || 0) - dt);
        // During the region's grace seconds nothing locks onto the player: dPlayer reads as
        // "infinitely far", which disarms the hunt, the warden's charge and the patrol alike.
        const dPlayer = (p && p.alive && this.grace <= 0) ? WB.M.dist(c.x, c.y, p.x, p.y) : 1e9;

        // Repair out of combat.
        if (st.repair > 0 && c.hp < c.maxHp) c.hp = Math.min(c.maxHp, c.hp + st.repair * dt);

        // --- the warden's own routine: patrol, telegraph, charge, summon.
        if (c.boss) {
            // two rage stages: at two thirds it starts summoning and firing faster, at a third
            // it charges twice as often — a boss fight must have acts
            ai.enrage = c.hp < c.maxHp * 0.33 ? 2 : c.hp < c.maxHp * 0.66 ? 1 : 0;
            ai.chargeCd -= dt;
            ai.summonCd -= dt;
            if (ai.telegraph > 0) {
                ai.telegraph -= dt;
                c.heading = ai.chargeDir;
                c.vx = c.vy = 0;
                if (ai.telegraph <= 0) { ai.chargeT = 1.7; this.emit('chargeStart', { x: c.x, y: c.y, dir: ai.chargeDir, id: c.id }); }
                return this.driveCastle(c, dt, 0, 0, 0);
            }
            if (ai.chargeT > 0) {
                ai.chargeT -= dt;
                c.heading = ai.chargeDir;
                return this.driveCastle(c, dt, 1, 0, c.speedBase * 2.15 * (ai.enrage ? 1.15 : 1));
            }
            if (ai.chargeCd <= 0 && dPlayer < 700 && p && p.alive) {
                ai.chargeCd = (c.kind === 'crown' ? 8.5 : 11) / (1 + 0.4 * ai.enrage);
                ai.chargeDir = Math.atan2(p.y - c.y, p.x - c.x);
                ai.telegraph = 1.5;
                this.emit('chargeTelegraph', { x: c.x, y: c.y, dir: ai.chargeDir, id: c.id, time: ai.telegraph });
                return this.driveCastle(c, dt, 0, 0, 0);
            }
            if (ai.summonCd <= 0 && ai.enrage >= 1) {
                ai.summonCd = (c.kind === 'crown' ? 9 : 15) / ai.enrage;
                const n = c.kind === 'crown' ? 3 : 2;
                for (let i = 0; i < n; i++) {
                    const a = this.rnd() * WB.M.TAU;
                    const k = this.region.makeKnight(c.x + Math.cos(a) * (c.r + 40), c.y + Math.sin(a) * (c.r + 40), this.scale);
                    k.state = 'attack';
                    this.emit('summon', { x: k.x, y: k.y });
                }
            }
            // Keep the fight near the gate: patrol around it, chase when the player is close.
            const g = this.region.gate;
            if (dPlayer < ai.aggro) { ai.state = 'hunt'; ai.tx = p.x; ai.ty = p.y; }
            else {
                ai.state = 'patrol';
                ai.think -= dt;
                if (ai.think <= 0) {
                    ai.think = this.rnd.range(3, 6);
                    const a = this.rnd() * WB.M.TAU, d = this.rnd.range(60, 240);
                    ai.tx = g.x + Math.cos(a) * d; ai.ty = g.y + Math.sin(a) * d;
                }
            }
            this.dodgeShells(c, ai, dt);
            return this.steerTo(c, dt, ai.tx, ai.ty, dPlayer < 260 ? -0.4 : 1, st);
        }

        // --- a roaming fortress: eat the valley, hunt the player when he is close.
        ai.think -= dt;
        const dHome = WB.M.dist(c.x, c.y, ai.homeX, ai.homeY);
        // A hunt has a limit: past `aggro × 2.2` or after ~8 s the fortress loses interest and
        // rolls home. Without it three fortresses trailed the player all region and every
        // fight was a 1-vs-3.
        if (ai.state === 'hunt') {
            ai.huntT = (ai.huntT || 0) + dt;
            if (dPlayer > ai.aggro * 2.2 || ai.huntT > 8 || !p || !p.alive) { ai.state = 'home'; ai.huntT = 0; ai.think = 0; }
        }
        if (dHome > (ai.leash || 1e9) || ai.state === 'home') {
            ai.state = dHome < 120 ? 'roam' : 'home';
            ai.tx = ai.homeX; ai.ty = ai.homeY; ai.think = Math.max(ai.think, 1.5);
        } else if (dPlayer < ai.aggro && p && p.alive) {
            ai.state = 'hunt';
            ai.huntT = ai.huntT || 0;
            ai.tx = p.x; ai.ty = p.y;
        } else if (ai.think <= 0) {
            ai.think = this.rnd.range(5, 11);
            // Prefer the nearest village: the AI castles grow too.
            let best = null, bestD = 1e9;
            for (const v of this.region.entities) {
                if (v.dead || v.type !== 'village') continue;
                const d = WB.M.dist2(c.x, c.y, v.x, v.y);
                if (d < bestD) { bestD = d; best = v; }
            }
            if (best && bestD < 620 * 620) { ai.tx = best.x; ai.ty = best.y; ai.state = 'eat'; }
            else {
                const a = this.rnd() * WB.M.TAU, d = this.rnd.range(180, 520);
                ai.tx = WB.M.clamp(c.x + Math.cos(a) * d, -this.region.regionR + 100, this.region.regionR - 100);
                ai.ty = WB.M.clamp(c.y + Math.sin(a) * d, -this.region.regionR + 100, this.region.regionR - 100);
                ai.state = 'roam';
            }
        }
        // Do not sit on another fortress.
        for (const o of this.region.castles) {
            if (o === c || !o.alive) continue;
            const d = WB.M.dist(c.x, c.y, o.x, o.y);
            if (d < c.r + o.r + 70) { ai.tx += (c.x - o.x) / d * 120; ai.ty += (c.y - o.y) / d * 120; }
        }
        this.dodgeShells(c, ai, dt);
        return this.steerTo(c, dt, ai.tx, ai.ty, 1, st);
    }

    /** AI castles sidestep shells that are about to land on them (the fight stays fair). */
    dodgeShells(c, ai, dt) {
        if (ai.dodgeCd > 0 || !this.player) return;
        for (const pr of this.projectiles) {
            if (pr.faction === c.faction) continue;
            const d = WB.M.dist(pr.x, pr.y, c.x, c.y);
            if (d > 260) continue;
            const tti = d / Math.max(60, Math.hypot(pr.vx, pr.vy));
            if (tti > 1.1) continue;
            const px = pr.x + pr.vx * tti, py = pr.y + pr.vy * tti;
            if (WB.M.dist(px, py, c.x, c.y) < c.r + 40) {
                ai.dodgeCd = 1.6;
                const a = Math.atan2(c.y - py, c.x - px) + (this.rnd() < 0.5 ? 1.1 : -1.1);
                ai.tx = c.x + Math.cos(a) * 220; ai.ty = c.y + Math.sin(a) * 220;
                ai.think = Math.max(ai.think, 1.2);
                this.emit('dodge', { id: c.id });
                return;
            }
        }
        void dt;
    }

    /** Drive to a map point: pick a heading, then move. */
    steerTo(c, dt, tx, ty, throttle, st) {
        const want = Math.atan2(ty - c.y, tx - c.x);
        const d = WB.M.angleDelta(c.heading, want);
        const steer = WB.M.clamp(d * 2.2, -1, 1);
        const slow = Math.abs(d) > 1.1 ? 0.45 : 1;
        return this.driveCastle(c, dt, throttle * slow, steer, c.speedBase * (st && st.speed ? st.speed : 1));
    }

    /** The same physics as the player's castle, without the input layer. */
    driveCastle(c, dt, throttle, steer, speedOverride) {
        const base = c.speedBase || (c.speedBase = WB.num('MAX_SPEED', 196) * 0.72);
        const speedMax = (speedOverride || base) * this.slowFactor(c.x, c.y);
        const accel = WB.num('ACCEL', 235) * 0.8;
        const turnRate = (WB.num('TURN_RATE', 2.05) - (c.tier - 1) * WB.num('TURN_PER_TIER', 0.17)) * 0.8 * (c.stun > 0 ? 0.3 : 1);
        c.heading += steer * turnRate * dt;
        c.heading = ((c.heading + Math.PI) % WB.M.TAU + WB.M.TAU) % WB.M.TAU - Math.PI;
        const slope = this.region.slopeAt(c.x, c.y, c.heading);
        const hx = Math.cos(c.heading), hy = Math.sin(c.heading);
        c.vx += (hx * throttle * accel - hx * slope * 300) * dt;
        c.vy += (hy * throttle * accel - hy * slope * 300) * dt;
        const drag = WB.num('DRAG', 1.5) + Math.abs(slope) * WB.num('SLOPE_DRAG', 2.6);
        const d = Math.exp(-drag * dt);
        c.vx *= d; c.vy *= d;
        const sp = Math.hypot(c.vx, c.vy);
        if (sp > speedMax) { c.vx *= speedMax / sp; c.vy *= speedMax / sp; }
        const nx = c.x + c.vx * dt, ny = c.y + c.vy * dt;
        if (this.region.inside(nx, ny, c.r * 0.6)) { c.x = nx; c.y = ny; }
        else {
            const dd = Math.hypot(nx, ny) || 1, k = (this.region.regionR - c.r * 0.6) / dd;
            c.x = nx * k; c.y = ny * k; c.vx *= -0.3; c.vy *= -0.3;
            const a = Math.atan2(-c.y, -c.x);
            c.ai.tx = c.x + Math.cos(a) * 300; c.ai.ty = c.y + Math.sin(a) * 300; c.ai.think = 2;
        }
        c.speed = Math.hypot(c.vx, c.vy);
        c.h = this.region.heightAt(c.x, c.y);
        c.wheelSpin = (c.wheelSpin || 0) + (c.speed / Math.max(12, c.r * 0.42)) * dt;
        c.pitch = WB.M.clamp(this.region.slopeAt(c.x, c.y, c.heading), -0.4, 0.4);
        c.roll = WB.M.clamp(this.region.slopeAt(c.x, c.y, c.heading + Math.PI / 2), -0.4, 0.4);
        this.stepModules(c, dt);
        this.devour(c, dt);
        return c;
    }

    // --- results ---------------------------------------------------------------------------------
    summary() {
        const t = this.totals;
        return {
            won: this.won, regions: this.regionIndex + (this.won ? 1 : 0), regionIndex: this.regionIndex,
            time: Math.round(t.time),
            mass: Math.round(t.mass), scrap: Math.round(t.scrap + WB.num('SCRAP_PER_MASS', 0.012) * t.mass),
            kills: t.kills, villages: t.villages, devoured: t.devoured, damage: Math.round(t.damage),
            tier: this.player ? this.player.tier : 1,
            modules: this.player ? this.player.modules.map(m => ({ id: m.mod.id, name: m.mod.short, level: m.level })) : []
        };
    }

    /** Scrap this run is worth (legacy currency). */
    runScrap() {
        return Math.round(this.totals.scrap + WB.num('SCRAP_PER_MASS', 0.012) * this.totals.mass);
    }

    /**
     * What the HUD needs to warn the player: the closest hunting castle and its distance plus
     * how many enemies are inside a ring. A pure read of the simulation state.
     */
    threat(radius) {
        const r = radius || 900, p = this.player;
        if (!p) return { near: null, dist: 0, hunters: 0 };
        let near = null, nearD = r, hunters = 0;
        for (const c of this.region.castles) {
            if (!c.alive || c.faction !== 'enemy') continue;
            const d = WB.M.dist(p.x, p.y, c.x, c.y);
            if (d >= r) continue;
            hunters++;
            if ((c.ai && c.ai.state === 'hunt') || c.boss) { if (d < nearD) { nearD = d; near = c; } }
        }
        return { near, dist: near ? Math.round(nearD) : 0, hunters };
    }
}

WB.GRACE_SEC = 14;    // s after entering a region before the valley starts hunting the player
WB.CHUNK_SHARE = 0.34; // fraction of a thing's mass that rides in the debris (the rest is instant)
WB.OBJECTIVE_TEXT = 'Поглощай деревни и рудники · Охоться на бродячие крепости · Врата вардена откроются, когда крепостей почти не останется';
WB.Run = WBRun;
WB.Region = WBRegion;
