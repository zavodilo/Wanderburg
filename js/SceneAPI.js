// SceneAPI.js — the semantic AI-facing layer over the kit (ROADMAP phase B).
//
// Agents (and game code that prefers declarations over engine calls) drive the scene
// through this namespace instead of pc.* / World3D.*: every method takes and returns
// plain JSON-able data, validates it against SCENE_SCHEMA (js/SceneSchema.js, generated
// by tools/manifest.mjs) and fails with a readable Error instead of a broken frame.
//
//   Scene.spawn('assets/models/mill.fbx', { kind: 'prop', x: 800, y: 900, heading: 30 })
//   Scene.move('mill-2', { x: 820, clip: 'idle' })
//   Scene.query({ kind: 'actor' })          -> snapshots
//   await Scene.inspect()                   -> { objects, loaded, errors, triangles, fps, findings }
//
// The canon stays where it was: records live in Location3D.objects (def objects of
// Objects.js), the editor edits the same defs, and nothing here bypasses
// World3D.addObject / placeObject — this file only adds validation and a stable surface.

/** @satisfies {Record<string, any>} */
const Scene = {
    // --- context ---------------------------------------------------------------

    _location() {
        const app = /** @type {any} */ (window).app;
        const loc = app && app.location;
        if (!loc) throw new Error('Scene: the game is not booted yet (window.app.location is missing)');
        return loc;
    },

    manifest() {
        return typeof SCENE_SCHEMA !== 'undefined' ? SCENE_SCHEMA : null;
    },

    // --- validation ------------------------------------------------------------

    _num(v, what) {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Scene: ' + what + ' must be a finite number, got ' + JSON.stringify(v));
        return v;
    },

    _defFrom(model, opts) {
        const o = opts || {};
        const kind = o.kind != null ? o.kind : 'prop';
        if (kind !== 'prop' && kind !== 'actor') throw new Error("Scene: kind must be 'prop' or 'actor', got " + JSON.stringify(kind));
        if (typeof model !== 'string' || !/^assets\//.test(model)) {
            throw new Error('Scene: model must be a literal path from the game root (the assets/ directory, like in Objects.js), got ' + JSON.stringify(model));
        }
        const scale = o.scale != null ? o.scale : [1, 1, 1];
        if (!Array.isArray(scale) || scale.length !== 3) throw new Error('Scene: scale must be [x, y, z], got ' + JSON.stringify(scale));
        scale.forEach((v, i) => {
            const n = this._num(v, 'scale[' + i + ']');
            if (n <= 0) throw new Error('Scene: scale[' + i + '] must be > 0, got ' + n);
        });
        const rot = o.rot != null ? o.rot : [0, o.heading != null ? this._num(o.heading, 'heading') : 0, 0];
        if (!Array.isArray(rot) || rot.length !== 3) throw new Error('Scene: rot must be [x, y, z] degrees, got ' + JSON.stringify(rot));
        rot.forEach((v, i) => this._num(v, 'rot[' + i + ']'));
        const def = {
            name: typeof o.name === 'string' && o.name ? o.name : this._unique(String(model).replace(/^.*\//, '').replace(/\.[a-z]+$/i, '')),
            model: model,
            kind: kind,
            x: this._num(o.x != null ? o.x : 0, 'x'),
            y: this._num(o.y != null ? o.y : 0, 'y'),
            h: this._num(o.h != null ? o.h : 0, 'h'),
            rot: rot.map(Number),
            scale: scale.map(Number)
        };
        if (o.clip != null) {
            if (typeof o.clip !== 'string') throw new Error('Scene: clip must be a string, got ' + JSON.stringify(o.clip));
            def.clip = o.clip;
        }
        if (o.anim != null) def.anim = o.anim;
        return def;
    },

    _unique(base) {
        const names = new Set(this._location().objects.map(r => r.def.name));
        const stem = String(base || 'object').replace(/-\d+$/, '');
        if (!names.has(stem)) return stem;
        for (let i = 2; ; i++) if (!names.has(stem + '-' + i)) return stem + '-' + i;
    },

    _rec(name) {
        const rec = this._location().objects.find(r => r.def.name === name);
        if (!rec) throw new Error('Scene: no object named ' + JSON.stringify(name) + ' (Scene.query() lists the scene)');
        return rec;
    },

    // --- commands --------------------------------------------------------------

    // model — a literal path from the game root (the assets/ directory); opts — { name?, kind?, x?, y?, h?, heading?, rot?,
    // scale?, clip?, anim? }. The object appears when the file loads (handle.loaded).
    spawn(model, opts) {
        const loc = this._location();
        const def = this._defFrom(model, opts);
        if (loc.objects.some(r => r.def.name === def.name)) throw new Error('Scene: an object named ' + JSON.stringify(def.name) + ' already exists');
        const rec = loc.addObject(def);
        return { name: def.name, def: def, loaded: rec.loaded };
    },

    // patch — any of { x, y, h, heading, rot, scale, clip, kind }: the def is edited
    // in place and re-placed, exactly like an editor field edit.
    move(name, patch) {
        const rec = this._rec(name);
        Scene._validatePatch(patch);
        const p = patch || {}, d = rec.def;
        for (const k of ['x', 'y', 'h']) if (p[k] != null) d[k] = p[k];
        if (p.heading != null) d.rot = [d.rot[0], p.heading, d.rot[2]];
        if (p.rot != null) d.rot = p.rot.slice();
        if (p.scale != null) d.scale = p.scale.slice();
        if (p.kind != null) d.kind = p.kind;
        if (p.clip !== undefined) {
            if (p.clip === null || p.clip === '') delete d.clip;
            else d.clip = p.clip;
        }
        this._location().placeObject(rec);
        return this.snapshot(rec);
    },

    // Pure validation of a move/patch against the schema (no mutation) — Edit.validate
    // dry-runs every op through it before anything touches the scene.
    _validatePatch(patch) {
        const p = patch || {};
        for (const k of ['x', 'y', 'h']) if (p[k] != null) this._num(p[k], k);
        if (p.heading != null) this._num(p.heading, 'heading');
        if (p.rot != null) {
            if (!Array.isArray(p.rot) || p.rot.length !== 3) throw new Error('Scene: rot must be [x, y, z] degrees');
            p.rot.forEach((v, i) => this._num(v, 'rot[' + i + ']'));
        }
        if (p.scale != null) {
            if (!Array.isArray(p.scale) || p.scale.length !== 3) throw new Error('Scene: scale must be [x, y, z]');
            p.scale.forEach((v, i) => {
                const n = this._num(v, 'scale[' + i + ']');
                if (n <= 0) throw new Error('Scene: scale[' + i + '] must be > 0');
            });
        }
        if (p.kind != null && p.kind !== 'prop' && p.kind !== 'actor') throw new Error("Scene: kind must be 'prop' or 'actor'");
        if (p.clip !== undefined && p.clip !== null && typeof p.clip !== 'string') throw new Error('Scene: clip must be a string or null');
        return true;
    },

    remove(name) {
        const loc = this._location();
        const rec = loc.objects.find(r => r.def.name === name);
        if (!rec) return false;
        loc.removeObject(rec);
        return true;
    },

    follow(name) {
        const app = /** @type {any} */ (window).app;
        if (!app || !app.camera) throw new Error('Scene: the camera is not ready yet');
        if (name == null) { app.camera.follow(null); return null; }
        const rec = this._rec(name);
        // follow reads x/y every frame: hand it a live view of the def
        app.camera.follow({ get x() { return rec.def.x; }, get y() { return rec.def.y; } });
        return rec.def.name;
    },

    // --- queries ---------------------------------------------------------------

    snapshot(rec) {
        const d = rec.def;
        return {
            name: d.name, model: d.model, kind: d.kind,
            x: d.x, y: d.y, h: d.h, rot: d.rot.slice(), scale: d.scale.slice(),
            clip: d.clip != null ? d.clip : null,
            loaded: !!rec.mesh, error: rec.error
        };
    },

    // filter — { kind? , model? , name? } or a predicate; none — the whole scene.
    query(filter) {
        let recs = this._location().objects;
        if (typeof filter === 'function') recs = recs.filter(filter);
        else if (filter) recs = recs.filter(r =>
            (filter.kind == null || r.def.kind === filter.kind) &&
            (filter.model == null || r.def.model === filter.model) &&
            (filter.name == null || r.def.name === filter.name));
        return recs.map(r => this.snapshot(r));
    },

    // The agent's self-check: scene totals + the kit's lint, silent and frame-free.
    // filter — { kind?, name?, model?, area?: [x0, y0, x1, y1] } (map px): the same
    // selectors as query(), plus a rectangle. The report is machine-readable:
    //   { objects, loaded, errors, triangles, fps, findings,   // backwards compatible
    //     entities, camera, warnings }                        // review-shaped
    async inspect(filter) {
        const loc = this._location();
        const snaps = this.query(filter);
        const area = filter && Array.isArray(filter.area) ? filter.area : null;
        const entities = area
            ? snaps.filter(sn => sn.x >= area[0] && sn.y >= area[1] && sn.x <= area[2] && sn.y <= area[3])
            : snaps;
        const view = /** @type {any} */ (window).World3D ? /** @type {any} */ (window).World3D.view : null;
        let findings = [];
        let triangles = 0;
        if (view && /** @type {any} */ (window).Debug3D) {
            const r = await /** @type {any} */ (window).Debug3D.lint(view, { silent: true, frame: false });
            findings = r.findings;
            triangles = r.stats ? r.stats.triangles : 0;
        }
        const app = /** @type {any} */ (window).app;
        const cam = app && app.camera && app.camera.target ? app.camera : null;   // a bare follow() stub has no pose
        const D = 180 / Math.PI;
        return {
            objects: snaps.length,
            loaded: snaps.filter(sn => sn.loaded).length,
            errors: snaps.filter(sn => sn.error).map(sn => ({ name: sn.name, error: sn.error })),
            triangles: triangles,
            fps: /** @type {any} */ (window).World3D ? Math.round(/** @type {any} */ (window).World3D.fps()) : 0,
            findings: findings,
            entities: entities.map(sn => ({
                id: sn.name, kind: sn.kind, model: sn.model,
                position: [sn.x, sn.y, sn.h], rot: sn.rot, scale: sn.scale,
                clip: sn.clip, loaded: sn.loaded, error: sn.error
            })),
            camera: cam ? {
                azimuthDeg: Math.round(cam.azimuth * D), pitchDeg: Math.round(cam.pitch * D),
                zoom: Math.round(cam.zoom * 100) / 100,
                target: { x: Math.round(cam.target.x), y: Math.round(cam.target.y), h: Math.round(cam.target.h) }
            } : null,
            warnings: findings.filter(f => f.level !== 'error')
        };
    },

    // --- determinism: the agent-facing PRNG (ROADMAP phase B+) -------------------
    // Scene.seed(n) fixes every stochastic choice an agent or a starter makes through
    // Scene.random(); the terrain noise is seeded by the TERRAIN_NOISE_SEED constant and
    // does NOT depend on this seed (it is editor-tunable).
    _seed: 1,
    _prng: null,
    _journal: [],

    /** @param {number} [n] */
    seed(n) {
        Scene._seed = Number.isFinite(n) ? (n >>> 0) : 1;
        let a = Scene._seed;
        Scene._prng = () => {           // mulberry32: tiny, stable, good enough for tests
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        return Scene._seed;
    },

    /** Stable [0, 1) pseudo-random for agent sessions and starters (never Math.random). */
    random() { return Scene._prng(); },

    /** The journal of committed/rolledback/rejected/discarded transactions (last 100). */
    journal() { return JSON.parse(JSON.stringify(Scene._journal)); }
};

Scene.seed(1);   // default deterministic stream; agents re-seed per session

// --- edit transactions ----------------------------------------------------------
// A composite AI edit is a journal of ops applied atomically: commit() validates every
// op FIRST, then applies them over a snapshot; any failure rolls the snapshot back and
// rethrows, so a half-applied edit never leaves the scene undefined. rollback() drops a
// pending transaction. Scene.journal() lists the outcomes.
Scene._journal = [];

/** @param {string} [label] */
const EditBegin = function (label) {
    /** @type {{ op: string, args: any[] }[]} */
    const ops = [];
    const tx = {
        label: label || 'edit-' + (Scene._journal.length + 1),
        add(model, opts) { ops.push({ op: 'add', args: [model, opts || {}] }); return tx; },
        update(name, patch) { ops.push({ op: 'update', args: [name, patch || {}] }); return tx; },
        remove(name) { ops.push({ op: 'remove', args: [name] }); return tx; },
        ops: () => JSON.parse(JSON.stringify({ label: tx.label, ops })),

        // Dry validation of every op against the current scene + schema (no mutation).
        validate() {
            const loc = Scene._location();
            const names = new Set(loc.objects.map(r => r.def.name));
            for (const o of ops) {
                if (o.op === 'add') {
                    const def = Scene._defFrom(o.args[0], o.args[1]);
                    const nm = (o.args[1] && o.args[1].name) || def.name;
                    if (names.has(nm)) throw new Error('Edit[' + tx.label + ']: duplicate name ' + JSON.stringify(nm));
                    names.add(nm);
                } else if (o.op === 'update') {
                    // names tracks the scene AS THE TRANSACTION SEES IT (adds/removes applied in order)
                    if (!names.has(o.args[0])) throw new Error('Edit[' + tx.label + ']: no object named ' + JSON.stringify(o.args[0]));
                    Scene._validatePatch(o.args[1]);
                } else if (o.op === 'remove') {
                    if (!names.has(o.args[0])) throw new Error('Edit[' + tx.label + ']: no object named ' + JSON.stringify(o.args[0]));
                    names.delete(o.args[0]);
                } else {
                    throw new Error('Edit[' + tx.label + ']: unknown op ' + o.op);
                }
            }
            return true;
        },

        commit() {
            const loc = Scene._location();
            try {
                tx.validate();
            } catch (e) {
                Scene._journal.push({ label: tx.label, ops: tx.ops(), status: 'rejected', error: (e && e.message) || String(e), at: Date.now() });
                if (Scene._journal.length > 100) Scene._journal.shift();
                throw e;
            }
            // snapshot: deep copies of the defs + order (the canon the editor writes)
            const snap = loc.objects.map(r => JSON.parse(JSON.stringify(r.def)));
            const applied = [];
            const entry = { label: tx.label, ops: tx.ops(), status: 'committed', error: null, at: Date.now() };
            try {
                for (const o of ops) {
                    if (o.op === 'add') { const h = Scene.spawn(o.args[0], o.args[1]); applied.push(['add', h.name]); }
                    else if (o.op === 'update') { Scene.move(o.args[0], o.args[1]); applied.push(['update', o.args[0]]); }
                    else { Scene.remove(o.args[0]); applied.push(['remove', o.args[0]]); }
                }
            } catch (e) {
                // roll back: restore the snapshot exactly (removed objects are re-added,
                // added ones removed, defs replaced in place and re-placed)
                const now = new Map(loc.objects.map(r => [r.def.name, r]));
                for (const [name, rec] of now) if (!snap.some(d => d.name === name)) loc.removeObject(rec);
                for (const d of snap) {
                    const rec = loc.objects.find(r => r.def.name === d.name);
                    if (!rec) loc.addObject(JSON.parse(JSON.stringify(d)));
                    else {
                        for (const k of Object.keys(rec.def)) delete rec.def[k];
                        Object.assign(rec.def, JSON.parse(JSON.stringify(d)));
                        loc.placeObject(rec);
                    }
                }
                entry.status = 'rolledback';
                entry.error = (e && e.message) || String(e);
                Scene._journal.push(entry);
                if (Scene._journal.length > 100) Scene._journal.shift();
                throw e;
            }
            Scene._journal.push(entry);
            if (Scene._journal.length > 100) Scene._journal.shift();
            return { label: tx.label, applied };
        },

        rollback() {
            const entry = { label: tx.label, ops: tx.ops(), status: 'discarded', error: null, at: Date.now() };
            Scene._journal.push(entry);
            if (Scene._journal.length > 100) Scene._journal.shift();
            return entry;
        }
    };
    return tx;
};

/** The transactions namespace: Edit.begin(label) -> tx (add/update/remove/ops/commit/rollback). */
const Edit = { begin: (label) => EditBegin(label) };


// --- Kit.*: game loop, state, clocks (the semantic half of a game) ---------------
// The name Game.* is deliberately NOT used: every scaffolded game defines its own
// `class Game` in js/Game.js (the kit sample does), and a global Game would collide.
const Kit = {
    _state: new Map(),
    _frames: new Map(),
    _t: 0,
    _dt: 0,

    /** KV state of the game logic: Kit.state('score') / Kit.state('score', 10). */
    state(key, value) {
        if (arguments.length < 2) return Kit._state.has(key) ? Kit._state.get(key) : undefined;
        Kit._state.set(key, value);
        return value;
    },

    /** Per-frame hook by name (replaceable): Kit.onFrame('ai', dt => …). */
    onFrame(name, fn) {
        if (typeof fn !== 'function') throw new Error('Kit.onFrame: fn must be a function');
        Kit._frames.set(String(name), fn);
        return name;
    },

    offFrame(name) { return Kit._frames.delete(String(name)); },

    /** Seconds since the game loop started / last frame dt / smoothed fps. */
    time: () => Kit._t,
    dt: () => Kit._dt,
    fps: () => (/** @type {any} */ (window).World3D ? Math.round(/** @type {any} */ (window).World3D.fps()) : 0),

    // called by the kit loop (main.js) — not part of the agent contract
    _run(dt) {
        Kit._dt = dt;
        Kit._t += dt;
        for (const [name, fn] of [...Kit._frames]) {
            try { fn(dt, Kit._t); } catch (e) { console.error('Kit.onFrame[' + name + ']:', e); Kit._frames.delete(name); }
        }
    }
};

// --- UI.* semantic additions ------------------------------------------------------
// The canon UI object (js/UI.js) already has get/add/remove; the semantic layer adds
// schema-validated patches and JSON snapshots for agents.
Object.assign(UI, {
query() {
    return (UI.layout || []).map(d => JSON.parse(JSON.stringify(d)));
},

/** patch — any fields of the record kind (validated against SCENE_SCHEMA.ui.kinds). */
patch(id, patch) {
    const def = UI.def(id);
    if (!def) throw new Error('UI.patch: no element with id ' + JSON.stringify(id) + ' (UI.query() lists the layout)');
    const schema = typeof SCENE_SCHEMA !== 'undefined' ? SCENE_SCHEMA : null;
    const kinds = schema && schema.ui && schema.ui.kinds ? schema.ui.kinds : null;
    const allowed = kinds && kinds[def.kind] ? Object.keys(kinds[def.kind]) : null;
    for (const k of Object.keys(patch || {})) {
        if (k === 'id' || k === 'kind') throw new Error('UI.patch: ' + k + ' is immutable (remove + add instead)');
        if (allowed && !allowed.includes(k) && k !== 'anchor') {
            throw new Error('UI.patch: unknown field ' + JSON.stringify(k) + ' for kind ' + def.kind);
        }
        if (allowed && allowed.includes(k) && typeof kinds[def.kind][k] === 'number' && !Number.isFinite(patch[k])) {
            throw new Error('UI.patch: ' + k + ' must be a finite number');
        }
    }
    Object.assign(def, patch);
    UI.applyLayout(UI.layout);
    return JSON.parse(JSON.stringify(def));
}
});

// --- Asset.*: preload and introspection without pc.* ------------------------------
const Asset = {
    /** Warm the model cache (FBX parse / GLB container) — the promise of the load. */
    preload(path) {
        const loc = Scene._location();
        return Model3D.load(path, loc.view).then(() => true, (e) => { throw e; });
    },

    /** Everything the location references + everything preloaded, with load states. */
    list() {
        const loc = Scene._location();
        const seen = new Map();
        for (const r of loc.objects) seen.set(r.def.model, { path: r.def.model, usedBy: r.def.name, loaded: !!r.mesh, error: r.error });
        for (const [path, p] of (Model3D._cache || [])) {
            if (!seen.has(path)) seen.set(path, { path, usedBy: null, loaded: true, error: null });
        }
        return [...seen.values()];
    },

    loaded(path) {
        const e = Asset.list().find(x => x.path === path);
        return e ? e.loaded : false;
    }
};
