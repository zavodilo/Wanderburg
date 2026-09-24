// World.js — the logical world of the semantic core (WorldMap).
//
// ONE world for every render profile. It holds what gameplay reasons about:
//
//     ground (tiles)   floor / wall / water / obstacle / door / loot …
//     height           the logical height field a rule may read (never the rendered terrain)
//     obstacles        what blocks movement (tile kinds + entity colliders)
//     spawn points     player / enemy / loot
//     zones            named areas (a village, a dungeon room)
//     triggers         "when the player enters r px of this point, fire an event"
//     props            static dressing placed by the world, not by a system
//     navigation       grid queries + pathfinding
//
// How a wall LOOKS is the profile's business: the same `wall` tile is a 2D tile sprite,
// a 2.5D sprite or 3D wall, an isometric 3D tile, a low-poly mesh or a detailed mesh
// (manifest/render-profiles.json -> tileKinds[*].visual gives the asset ROLE for each).
// Nothing here knows the renderer, so converting a level never rebuilds it.

class WorldMap {
    /** @param {any} spec */
    constructor(spec) {
        const s = World.validate(spec);
        this.id = s.id;
        this.width = Number(s.size && s.size.width) || 2048;
        this.height = Number(s.size && s.size.height) || 2048;
        this.tileSize = Math.max(1, Number(s.tileSize) || World.TILE_PX);
        /** @type {Map<string, { kind: string, data: any }>} */
        this._tiles = new Map();
        /** @type {any[]} */
        this.zones = [];
        /** @type {any[]} */
        this.triggers = [];
        /** @type {any[]} */
        this.spawns = [];
        /** @type {any[]} */
        this.props = [];
        this.navigation = Object.assign({ grid: true, diagonal: false }, s.navigation || {});
        this.heightField = Object.assign({ base: 0, amplitude: 0 }, s.height || {});
        /** Triggers that already fired with once: true. */
        this._fired = new Set();

        for (const r of s.rects || []) this.fillRect(r.x, r.z, r.w, r.h, r.kind, r.data);
        for (const t of s.tiles || []) this.setTile(t.x, t.z, t.kind, t.data);
        for (const z of s.zones || []) this.addZone(z);
        for (const t of s.triggers || []) this.addTrigger(t);
        for (const p of s.spawns || []) this.addSpawn(p);
        for (const p of s.props || []) this.addProp(p);
    }

    get cols() { return Math.max(1, Math.round(this.width / this.tileSize)); }
    get rows() { return Math.max(1, Math.round(this.height / this.tileSize)); }

    // --- tiles --------------------------------------------------------------------

    static key(tx, tz) { return tx + ',' + tz; }

    /** World px -> tile index (the map origin is its top-left corner, x right, z down). */
    tileIndex(x, z) {
        return { tx: Math.floor(x / this.tileSize), tz: Math.floor(z / this.tileSize) };
    }

    /** Tile index -> the world px of its center. */
    tileCenter(tx, tz) {
        return { x: (tx + 0.5) * this.tileSize, y: 0, z: (tz + 0.5) * this.tileSize };
    }

    /** @returns {{ kind: string, data: any } | null} */
    tile(tx, tz) { return this._tiles.get(WorldMap.key(tx, tz)) || null; }

    /** Tile kind at a tile index ('empty' where nothing was set). */
    kindAt(tx, tz) { const t = this.tile(tx, tz); return t ? t.kind : 'empty'; }

    /** Tile kind at a world position. */
    kindAtWorld(x, z) { const i = this.tileIndex(x, z); return this.kindAt(i.tx, i.tz); }

    /** @returns {{ kind: string, data: any } | null} the record (live: data is editable) */
    setTile(tx, tz, kind, data) {
        if (!World.KINDS.includes(kind)) throw new Error('WorldMap.setTile: unknown tile kind ' + JSON.stringify(kind));
        const txi = Math.round(tx), tzi = Math.round(tz);
        if (txi < 0 || tzi < 0 || txi >= this.cols || tzi >= this.rows) return null;   // outside the map is not an error
        if (kind === 'empty' && !data) { this._tiles.delete(WorldMap.key(txi, tzi)); return null; }
        const rec = { kind: kind, data: data ? JSON.parse(JSON.stringify(data)) : null };
        this._tiles.set(WorldMap.key(txi, tzi), rec);
        return rec;
    }

    setTileWorld(x, z, kind, data) { const i = this.tileIndex(x, z); return this.setTile(i.tx, i.tz, kind, data); }

    fillRect(tx, tz, w, h, kind, data) {
        let n = 0;
        for (let z = Math.round(tz); z < Math.round(tz) + Math.round(h); z++) {
            for (let x = Math.round(tx); x < Math.round(tx) + Math.round(w); x++) if (this.setTile(x, z, kind, data)) n++;
        }
        return n;
    }

    /** Every set tile as { tx, tz, kind, data } (sorted, stable for diffs and saves). */
    tiles() {
        const out = [];
        for (const [k, rec] of this._tiles) {
            const p = k.split(',');
            out.push({ tx: Number(p[0]), tz: Number(p[1]), kind: rec.kind, data: rec.data });
        }
        return out.sort((a, b) => a.tz - b.tz || a.tx - b.tx);
    }

    tileCounts() {
        const c = {};
        for (const rec of this._tiles.values()) c[rec.kind] = (c[rec.kind] || 0) + 1;
        return c;
    }

    // --- queries ------------------------------------------------------------------

    /** Is a world position inside the map? */
    inside(x, z) { return x >= 0 && z >= 0 && x < this.width && z < this.height; }

    /** Does the tile kind block movement? (canon: manifest tileKinds[*].blocked) */
    isBlockedTile(kind) {
        const info = World.kindInfo(kind);
        return !!(info && info.blocked);
    }

    /** Movement query in world px: outside the map or a blocking kind -> true. */
    blocked(x, z) {
        if (!this.inside(x, z)) return true;
        return this.isBlockedTile(this.kindAtWorld(x, z));
    }

    blockedTile(tx, tz) {
        if (tx < 0 || tz < 0 || tx >= this.cols || tz >= this.rows) return true;
        return this.isBlockedTile(this.kindAt(tx, tz));
    }

    /**
     * The logical ground height at a world position. This is the height GAMEPLAY uses
     * (invariant: 3D is a view — logic never asks the renderer for a height).
     */
    heightAt(x, z) {
        const base = Number(this.heightField.base) || 0;
        const t = this.tile(x == null ? 0 : Math.floor(x / this.tileSize), z == null ? 0 : Math.floor(z / this.tileSize));
        if (t && t.data && typeof t.data.height === 'number') return t.data.height;
        return base;
    }

    /** @returns {any | null} the innermost zone containing the point */
    zoneAt(x, z) {
        for (let i = this.zones.length - 1; i >= 0; i--) {
            const r = this.zones[i];
            if (x >= r.x && z >= r.z && x <= r.x + r.w && z <= r.z + r.h) return r;
        }
        return null;
    }

    zonesAt(x, z) {
        return this.zones.filter(r => x >= r.x && z >= r.z && x <= r.x + r.w && z <= r.z + r.h);
    }

    /** Triggers whose radius covers the point; `once` triggers report only the first time. */
    triggersAt(x, z) {
        const out = [];
        for (const t of this.triggers) {
            const r = Number(t.r) || this.tileSize;
            if (Math.hypot(x - t.x, z - t.z) > r) continue;
            if (t.once) {
                if (this._fired.has(t.id)) continue;
                this._fired.add(t.id);
            }
            out.push(t);
        }
        return out;
    }

    resetTriggers() { this._fired.clear(); }

    /** @param {string} [kind] 'player' | 'enemy' | 'loot' | 'generic' */
    spawnPoints(kind) { return kind ? this.spawns.filter(s => s.kind === kind) : this.spawns.slice(); }

    /** The first spawn of a kind (null when the world has none). */
    spawn(kind) { const s = this.spawnPoints(kind || 'player')[0]; return s ? { x: s.x, y: s.y || 0, z: s.z } : null; }

    // --- mutation -----------------------------------------------------------------

    addZone(z) {
        if (!z || !z.id) throw new Error('WorldMap.addZone: id is required');
        if (this.zones.some(x => x.id === z.id)) throw new Error('WorldMap.addZone: duplicate zone ' + z.id);
        const rec = { id: String(z.id), kind: z.kind || 'area', x: Number(z.x) || 0, z: Number(z.z) || 0, w: Number(z.w) || 0, h: Number(z.h) || 0, data: z.data ? JSON.parse(JSON.stringify(z.data)) : null };
        this.zones.push(rec);
        return rec;
    }

    addTrigger(t) {
        if (!t || !t.id) throw new Error('WorldMap.addTrigger: id is required');
        if (this.triggers.some(x => x.id === t.id)) throw new Error('WorldMap.addTrigger: duplicate trigger ' + t.id);
        const rec = { id: String(t.id), x: Number(t.x) || 0, z: Number(t.z) || 0, r: Number(t.r) || this.tileSize, event: String(t.event || t.id), once: !!t.once, data: t.data ? JSON.parse(JSON.stringify(t.data)) : null };
        this.triggers.push(rec);
        return rec;
    }

    addSpawn(s) {
        if (!s || !s.id) throw new Error('WorldMap.addSpawn: id is required');
        if (this.spawns.some(x => x.id === s.id)) throw new Error('WorldMap.addSpawn: duplicate spawn ' + s.id);
        const rec = { id: String(s.id), kind: s.kind || 'generic', x: Number(s.x) || 0, y: Number(s.y) || 0, z: Number(s.z) || 0 };
        this.spawns.push(rec);
        return rec;
    }

    addProp(p) {
        if (!p || !p.id) throw new Error('WorldMap.addProp: id is required');
        if (this.props.some(x => x.id === p.id)) throw new Error('WorldMap.addProp: duplicate prop ' + p.id);
        const rec = { id: String(p.id), role: p.role || ('world.' + p.id + '.visual'), x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0, heading: Number(p.heading) || 0, data: p.data ? JSON.parse(JSON.stringify(p.data)) : null };
        this.props.push(rec);
        return rec;
    }

    removeZone(id) { const i = this.zones.findIndex(z => z.id === id); if (i < 0) return false; this.zones.splice(i, 1); return true; }
    removeTrigger(id) { const i = this.triggers.findIndex(z => z.id === id); if (i < 0) return false; this.triggers.splice(i, 1); return true; }
    removeSpawn(id) { const i = this.spawns.findIndex(z => z.id === id); if (i < 0) return false; this.spawns.splice(i, 1); return true; }
    removeProp(id) { const i = this.props.findIndex(z => z.id === id); if (i < 0) return false; this.props.splice(i, 1); return true; }

    // --- navigation ----------------------------------------------------------------

    /** Walkable tile neighbours (4-connected, or 8 when navigation.diagonal). */
    neighbors(tx, tz) {
        const d = this.navigation.diagonal
            ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
            : [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const out = [];
        for (const [dx, dz] of d) {
            const x = tx + dx, z = tz + dz;
            if (!this.blockedTile(x, z)) out.push({ tx: x, tz: z });
            else if (dx && dz) { /* a diagonal squeeze between two blockers is not a path */ }
        }
        return out;
    }

    /**
     * A* on the logical grid. from/to — world px or { tx, tz }; returns world positions
     * of tile centers (the first is the start tile, the last the goal) or null.
     * Renderer-independent: the same path in every profile.
     */
    findPath(from, to, opts) {
        const a = from.tx != null ? { tx: from.tx, tz: from.tz } : this.tileIndex(from.x || 0, from.z || 0);
        const b = to.tx != null ? { tx: to.tx, tz: to.tz } : this.tileIndex(to.x || 0, to.z || 0);
        const maxNodes = (opts && opts.maxNodes) || World.MAX_PATH_NODES;
        if (this.blockedTile(b.tx, b.tz)) return null;
        const h = (n) => Math.abs(n.tx - b.tx) + Math.abs(n.tz - b.tz);
        const start = WorldMap.key(a.tx, a.tz);
        const open = [{ tx: a.tx, tz: a.tz, g: 0, f: h(a) }];
        const gScore = new Map([[start, 0]]);
        const came = new Map();
        const closed = new Set();
        let seen = 0;
        while (open.length) {
            let bi = 0;
            for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
            const cur = open.splice(bi, 1)[0];
            const ck = WorldMap.key(cur.tx, cur.tz);
            if (closed.has(ck)) continue;
            closed.add(ck);
            if (++seen > maxNodes) return null;
            if (cur.tx === b.tx && cur.tz === b.tz) {
                const path = [];
                let k = ck;
                while (k) {
                    const p = k.split(',');
                    path.unshift(this.tileCenter(Number(p[0]), Number(p[1])));
                    k = came.get(k);
                }
                return path;
            }
            for (const n of this.neighbors(cur.tx, cur.tz)) {
                const nk = WorldMap.key(n.tx, n.tz);
                if (closed.has(nk)) continue;
                const g = cur.g + (n.tx !== cur.tx && n.tz !== cur.tz ? 1.4142 : 1);
                if (g < (gScore.has(nk) ? gScore.get(nk) : Infinity)) {
                    gScore.set(nk, g);
                    came.set(nk, ck);
                    open.push({ tx: n.tx, tz: n.tz, g: g, f: g + h(n) });
                }
            }
        }
        return null;
    }

    /** Is there a walkable line between two world points (coarse, tile-stepped)? */
    lineOfSight(a, b) {
        const steps = Math.max(1, Math.ceil(Coords.distXZ(Coords.from(a), Coords.from(b)) / (this.tileSize * 0.5)));
        for (let i = 1; i < steps; i++) {
            const t = i / steps;
            const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
            if (this.blocked(x, z)) return false;
        }
        return true;
    }

    // --- serialization --------------------------------------------------------------

    /** The spec shape of game-schema.json#/definitions/world. */
    toSpec() {
        return {
            id: this.id,
            size: { width: this.width, height: this.height },
            tileSize: this.tileSize,
            tiles: this.tiles().map(t => t.data ? { x: t.tx, z: t.tz, kind: t.kind, data: JSON.parse(JSON.stringify(t.data)) } : { x: t.tx, z: t.tz, kind: t.kind }),
            height: JSON.parse(JSON.stringify(this.heightField)),
            zones: JSON.parse(JSON.stringify(this.zones)),
            triggers: JSON.parse(JSON.stringify(this.triggers)),
            spawns: JSON.parse(JSON.stringify(this.spawns)),
            props: JSON.parse(JSON.stringify(this.props)),
            navigation: JSON.parse(JSON.stringify(this.navigation))
        };
    }

    /** Replace the whole content from a spec (used by a migration rollback and by Save). */
    restore(spec) {
        const s = World.validate(spec);
        this._tiles.clear();
        this.zones.length = 0; this.triggers.length = 0; this.spawns.length = 0; this.props.length = 0;
        this._fired.clear();
        this.width = Number(s.size && s.size.width) || this.width;
        this.height = Number(s.size && s.size.height) || this.height;
        this.tileSize = Math.max(1, Number(s.tileSize) || this.tileSize);
        this.heightField = Object.assign({ base: 0, amplitude: 0 }, s.height || {});
        this.navigation = Object.assign({ grid: true, diagonal: false }, s.navigation || {});
        for (const r of s.rects || []) this.fillRect(r.x, r.z, r.w, r.h, r.kind, r.data);
        for (const t of s.tiles || []) this.setTile(t.x, t.z, t.kind, t.data);
        for (const z of s.zones || []) this.addZone(z);
        for (const t of s.triggers || []) this.addTrigger(t);
        for (const p of s.spawns || []) this.addSpawn(p);
        for (const p of s.props || []) this.addProp(p);
        return this;
    }

    /** Machine-readable summary for agents, the editor and the migration plan. */
    inspect() {
        return {
            id: this.id,
            size: { width: this.width, height: this.height },
            tileSize: this.tileSize,
            grid: { cols: this.cols, rows: this.rows },
            tiles: this._tiles.size,
            tileCounts: this.tileCounts(),
            zones: this.zones.length,
            triggers: this.triggers.length,
            spawns: this.spawns.length,
            props: this.props.length,
            height: JSON.parse(JSON.stringify(this.heightField)),
            navigation: JSON.parse(JSON.stringify(this.navigation))
        };
    }
}

WorldMap.MAX_PATH_NODES = 20000;

/** @satisfies {Record<string, any>} */
const World = {
    /** Logical tile kinds (canon: manifest/render-profiles.json -> tileKinds). */
    KINDS: (typeof RENDER_PROFILES !== 'undefined' ? Object.keys(RENDER_PROFILES.tileKinds) : ['empty', 'floor', 'wall', 'water', 'obstacle', 'door', 'trigger', 'spawn', 'enemySpawn', 'loot']),

    /** px per logical tile when the spec does not say (Constants.js PROFILE_TILE_PX). */
    get TILE_PX() { return (typeof PROFILE_TILE_PX !== 'undefined' && PROFILE_TILE_PX > 0) ? PROFILE_TILE_PX : 64; },

    MAX_PATH_NODES: WorldMap.MAX_PATH_NODES,

    /** The manifest record of a tile kind: { blocked, visual, note }. */
    kindInfo(kind) {
        if (typeof RENDER_PROFILES === 'undefined') return { blocked: kind === 'wall' || kind === 'water' || kind === 'obstacle' || kind === 'door', visual: null };
        return RENDER_PROFILES.tileKinds[kind] || null;
    },

    /**
     * The asset ROLE that dresses a tile kind (null — the kind has no visual: triggers,
     * spawn points). The profile turns that role into a tile sprite, a 3D tile or a mesh.
     */
    roleFor(kind) { const i = World.kindInfo(kind); return i ? i.visual || null : null; },

    /** Does this kind block movement? */
    blocks(kind) { return !!World.isBlocked(kind); },

    isBlocked(kind) { const i = World.kindInfo(kind); return !!(i && i.blocked); },

    /** @param {any} spec @returns {WorldMap} */
    map(spec) { return new WorldMap(spec); },

    /** Validate a world spec; returns the normalized spec (throws with a readable message). */
    validate(spec) {
        const s = spec || {};
        if (typeof s.id !== 'string' || !s.id) throw new Error('World: id is required');
        if (s.size != null && (typeof s.size !== 'object' || !(Number(s.size.width) > 0) || !(Number(s.size.height) > 0))) {
            throw new Error('World ' + s.id + ': size must be { width > 0, height > 0 }');
        }
        if (s.tileSize != null && !(Number(s.tileSize) > 0)) throw new Error('World ' + s.id + ': tileSize must be > 0');
        const kinds = typeof RENDER_PROFILES !== 'undefined' ? Object.keys(RENDER_PROFILES.tileKinds) : World.KINDS;
        for (const t of s.tiles || []) {
            if (!kinds.includes(t.kind)) throw new Error('World ' + s.id + ': unknown tile kind ' + JSON.stringify(t.kind));
            if (!Number.isInteger(t.x) || !Number.isInteger(t.z)) throw new Error('World ' + s.id + ': tile x/z must be integers');
        }
        for (const r of s.rects || []) if (!kinds.includes(r.kind)) throw new Error('World ' + s.id + ': unknown rect kind ' + JSON.stringify(r.kind));
        for (const list of ['zones', 'triggers', 'spawns', 'props']) {
            for (const rec of s[list] || []) if (!rec || !rec.id) throw new Error('World ' + s.id + ': every ' + list + ' record needs an id');
        }
        const ids = new Set();
        for (const list of ['zones', 'triggers', 'spawns', 'props']) {
            for (const rec of s[list] || []) {
                const k = list + ':' + rec.id;
                if (ids.has(k)) throw new Error('World ' + s.id + ': duplicate ' + k);
                ids.add(k);
            }
        }
        return s;
    },

    /** A minimal world for tests and agents: an open floor with a border wall. */
    sample(opts) {
        const o = opts || {};
        const cols = o.cols || 16, rows = o.rows || 16;
        const tiles = [];
        for (let z = 0; z < rows; z++) {
            for (let x = 0; x < cols; x++) {
                const border = x === 0 || z === 0 || x === cols - 1 || z === rows - 1;
                tiles.push({ x: x, z: z, kind: border ? 'wall' : 'floor' });
            }
        }
        return new WorldMap({
            id: o.id || 'world',
            size: { width: cols * World.TILE_PX, height: rows * World.TILE_PX },
            tileSize: World.TILE_PX,
            tiles: tiles,
            spawns: [{ id: 'player-spawn', kind: 'player', x: 1.5 * World.TILE_PX, y: 0, z: 1.5 * World.TILE_PX }]
        });
    }
};
