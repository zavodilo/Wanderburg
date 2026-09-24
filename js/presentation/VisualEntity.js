// VisualEntity.js — the bridge between a logical entity and its visual representation.
//
// Every logical entity has an INDEPENDENT visual representation per profile:
//
//     { id: 'player', type: 'character', logic: { health: 100 },
//       visual: { role: 'player.visual' } }
//
//     2d          -> sprite      assets/visual/2d/player.png
//     2.5d        -> billboard   the same sprite in a 3D world
//     isometric3d -> model       assets/visual/isometric3d/player.glb
//     lowpoly3d   -> model       assets/visual/lowpoly3d/player.glb
//     full3d      -> model       assets/visual/full3d/player.glb
//
// This file computes WHAT should be shown (representation, asset or placeholder, depth,
// size, transform) and hands it to the engine backend (js/engine/Visual3D.js), which
// creates the actual sprite/model/primitive. It never touches pc.* and gameplay never
// touches it: an entity's `id` and `logic` are the same in every profile, only its
// binding changes. That is why "convert this game from 2D to 3D" is a presentation
// migration and not a rewrite.

/** @typedef {{ entityId: string, entityType: string, profile: string, type: string, role: string | null, asset: string | null, resolvedBy: string, fallbackFrom: string | null, placeholder: any | null, kind: string | null, size: number[] | null, clips: any | null, frames: any | null, renderLayer: string | null, drawOrder: number, zIndex: number, position: ArcVec3Like, rotation: ArcVec3Like, scale: ArcVec3Like, animation: any | null, handle: any, applied?: boolean, headless?: boolean, error?: string | null }} VisualBinding */

/** @satisfies {Record<string, any>} */
const VisualEntity = {
    /** @type {Map<string, VisualBinding>} */
    _bindings: new Map(),
    /** @type {any | null} */
    _backend: null,
    /** The world presentation currently on screen (ground/tiles/terrain). */
    worldBinding: null,
    /** Default sprite size in world px (Constants.js PROFILE_SPRITE_*). */
    get SPRITE_H() { return (typeof PROFILE_SPRITE_HEIGHT !== 'undefined' && PROFILE_SPRITE_HEIGHT > 0) ? PROFILE_SPRITE_HEIGHT : 96; },
    get SPRITE_ASPECT() { return (typeof PROFILE_SPRITE_ASPECT !== 'undefined' && PROFILE_SPRITE_ASPECT > 0) ? PROFILE_SPRITE_ASPECT : 0.75; },

    // --- what should be shown ---------------------------------------------------------------

    /**
     * The representation an entity wants in a config's profile, fully resolved:
     * type, asset (or a generated placeholder), size, depth and canonical transform.
     * null — the entity has no visual (triggers, zones, spawn points).
     * @returns {VisualBinding | null}
     */
    desired(entity, cfg) {
        const profileId = cfg && cfg.id ? cfg.id : (typeof RenderProfile !== 'undefined' ? RenderProfile.id() : '2d');
        const req = entity.visualRequest(profileId);
        if (!req || req.type === 'none') return null;
        let res = null;
        if (req.asset) {
            // an explicit per-profile override in the entity's visual block
            res = {
                role: req.role, profile: profileId, type: req.type, asset: req.asset,
                resolvedBy: (typeof AssetRegistry !== 'undefined' && AssetRegistry.exists(req.asset)) ? 'variant' : 'placeholder',
                fallbackFrom: null, chain: [profileId], placeholder: null,
                missing: !(typeof AssetRegistry !== 'undefined' && AssetRegistry.exists(req.asset)),
                clips: null, frames: null, size: req.size, generated: false, kind: req.kind || null, overlay: null
            };
        } else if (req.role && typeof AssetRegistry !== 'undefined') {
            res = AssetRegistry.resolve(req.role, profileId, { entityType: entity.type });
        } else {
            res = {
                role: null, profile: profileId, type: req.type, asset: null, resolvedBy: 'placeholder',
                fallbackFrom: null, chain: [profileId],
                placeholder: (typeof AssetRegistry !== 'undefined') ? AssetRegistry.placeholder(null, profileId, entity.type, entity.id) : { kind: 'box', color: '#888888', label: entity.id, generated: true },
                missing: true, clips: null, frames: null, size: req.size, generated: true, kind: req.kind || null, overlay: null
            };
        }
        const type = res.type && res.type !== 'none' ? res.type : req.type;
        return {
            entityId: entity.id,
            entityType: entity.type,
            profile: profileId,
            type: type,
            role: req.role,
            asset: res.asset,
            resolvedBy: res.resolvedBy,
            fallbackFrom: res.fallbackFrom || null,
            placeholder: res.placeholder || null,
            kind: res.kind || req.kind || null,
            size: VisualEntity._size(res, req, type, cfg),
            clips: res.clips || null,
            frames: res.frames || null,
            renderLayer: req.renderLayer || VisualEntity.defaultLayer(entity, cfg),
            drawOrder: req.drawOrder != null ? req.drawOrder : VisualEntity.defaultDrawOrder(entity, cfg),
            zIndex: req.zIndex != null ? req.zIndex : 0,
            position: Coords.clone(entity.position),
            rotation: Coords.clone(entity.rotation),
            scale: Coords.clone(entity.scale),
            animation: (entity.visual && entity.visual.animation) || null,
            handle: null
        };
    },

    _size(res, req, type, cfg) {
        if (req.size && req.size.length) return req.size.slice();
        if (res.size && res.size.length) return res.size.slice();
        if (type === 'sprite' || type === 'billboard') {
            const h = VisualEntity.SPRITE_H;
            return [Math.round(h * VisualEntity.SPRITE_ASPECT), h];
        }
        if (type === 'tile') {
            const t = (cfg && cfg.world && cfg.world.tilePx) || (typeof PROFILE_TILE_PX !== 'undefined' ? PROFILE_TILE_PX : 64);
            return [t, t];
        }
        return null;
    },

    /** The declarative depth layer of an entity (2D: data, never computed by gameplay). */
    defaultLayer(entity, cfg) {
        const depth = (cfg && cfg.depth) || {};
        const layers = depth.layers || { ground: 0, world: 1, actors: 2, overlay: 3, ui: 4 };
        if (entity.type === 'terrain') return 'ground';
        if (entity.type === 'character' || entity.type === 'creature' || entity.type === 'vehicle') return 'actors';
        if (entity.type === 'effect' || entity.type === 'projectile') return 'overlay';
        return Object.keys(layers).includes('world') ? 'world' : 'world';
    },

    /** Draw order inside a layer: stable, derived from the entity (never from the camera). */
    defaultDrawOrder(entity, cfg) {
        const layer = VisualEntity.defaultLayer(entity, cfg);
        const depth = (cfg && cfg.depth) || {};
        const layers = depth.layers || { ground: 0, world: 1, actors: 2, overlay: 3, ui: 4 };
        const base = (layers[layer] != null ? layers[layer] : 1) * 1000;
        // painter's order on the depth axis: farther (smaller z) draws first
        const z = Math.round(entity.position.z);
        return base + Math.max(0, Math.min(999, 500 - Math.round(z / 4)));
    },

    // --- binding -----------------------------------------------------------------------------

    /**
     * Make the scene show a set of entities in a config's profile: create what is new,
     * update what changed, remove what is gone. Returns a machine-readable report — the
     * numbers a migration plan and the editor's profile panel show.
     */
    sync(entities, cfg, opts) {
        const o = opts || {};
        const list = entities || (GameModel.booted() ? GameModel.entities : []);
        const c = cfg || (typeof RenderProfile !== 'undefined' ? RenderProfile.config() : { id: '2d' });
        const report = {
            profile: c.id, variant: c.variant || null, bindings: 0, created: 0, updated: 0, removed: 0,
            unchanged: 0, placeholders: 0, fallbacks: 0, missing: 0, byType: {}, headless: !VisualEntity._backend, deferred: [],
            // A project may present its own entities (a custom view module on the engine layer:
            // Wanderburg builds every mesh in js/WanderMesh.js). Such an entity declares
            // representation 'none', gets no binding, and must still COUNT as presented — without
            // this a self-presenting game looked like "the profile presents nothing".
            selfPresented: 0, selfPresentedIds: [], invisible: 0
        };
        const wanted = new Map();
        for (const e of list) {
            const d = VisualEntity.desired(e, c);
            if (!d) {
                const req = (e && typeof e.visualRequest === 'function') ? e.visualRequest(c.id) : null;
                if (req && req.type === 'none') { report.selfPresented++; report.selfPresentedIds.push(e.id); }
                else report.invisible++;          // a trigger, a zone, a spawn point: no visual by nature
                continue;
            }
            wanted.set(e.id, d);
            report.byType[d.type] = (report.byType[d.type] || 0) + 1;
            if (d.resolvedBy === 'placeholder') report.placeholders++;
            else if (d.resolvedBy === 'fallback') report.fallbacks++;
            if (!d.asset) report.missing++;
        }
        // remove what is no longer wanted (or belongs to another profile)
        for (const [id, b] of [...VisualEntity._bindings]) {
            if (wanted.has(id) && wanted.get(id).profile === b.profile) continue;
            VisualEntity.unbind(id);
            report.removed++;
        }
        // create / update
        for (const [id, d] of wanted) {
            const prev = VisualEntity._bindings.get(id);
            if (prev && VisualEntity._same(prev, d)) { report.unchanged++; continue; }
            const isNew = !prev;
            const binding = VisualEntity._commit(d, o);
            if (binding) { report[isNew ? 'created' : 'updated']++; }
            else report.deferred.push(id);
        }
        report.bindings = VisualEntity._bindings.size;
        return report;
    },

    /** Two bindings are the same when nothing the engine cares about changed. */
    _same(a, b) {
        return a.profile === b.profile && a.type === b.type && a.asset === b.asset &&
            a.kind === b.kind && a.resolvedBy === b.resolvedBy &&
            JSON.stringify(a.size) === JSON.stringify(b.size) &&
            Coords.equals(a.position, b.position, 0.001) &&
            Coords.equals(a.rotation, b.rotation, 0.001) &&
            Coords.equals(a.scale, b.scale, 0.001) &&
            a.renderLayer === b.renderLayer && a.drawOrder === b.drawOrder && a.zIndex === b.zIndex;
    },

    /** Hand a desired representation to the engine and remember the binding. */
    _commit(d, o) {
        const prev = VisualEntity._bindings.get(d.entityId) || null;
        const binding = Object.assign({}, d);
        if (VisualEntity._backend && typeof VisualEntity._backend.visual === 'function') {
            const r = VisualEntity._backend.visual(binding, o || {}) || {};
            binding.handle = r.handle != null ? r.handle : null;
            binding.applied = r.applied !== false;
            if (r.error) binding.error = r.error;
        } else {
            binding.applied = false;
            binding.headless = true;
        }
        // A migration swaps the representation under the same entity id: the old engine
        // object goes away, the logical entity and its id stay.
        if (prev && prev.handle != null && prev.handle !== binding.handle &&
            VisualEntity._backend && typeof VisualEntity._backend.visualDestroy === 'function') {
            VisualEntity._backend.visualDestroy(prev);
        }
        VisualEntity._bindings.set(binding.entityId, binding);
        if (typeof GameModel !== 'undefined' && GameModel.booted()) {
            const e = GameModel.entity(binding.entityId);
            if (e) e.visualBinding = binding.entityId;
        }
        return binding;
    },

    /** Bind one entity (a spawn mid-frame). */
    bind(entity, cfg, opts) {
        const d = VisualEntity.desired(entity, cfg);
        if (!d) return null;
        return VisualEntity._commit(d, opts || {});
    },

    /** Remove the visual of one entity (the logical entity stays). */
    unbind(entityId) {
        const b = VisualEntity._bindings.get(String(entityId));
        if (!b) return false;
        if (VisualEntity._backend && typeof VisualEntity._backend.visualDestroy === 'function') VisualEntity._backend.visualDestroy(b);
        VisualEntity._bindings.delete(String(entityId));
        if (typeof GameModel !== 'undefined' && GameModel.booted()) {
            const e = GameModel.entity(String(entityId));
            if (e) e.visualBinding = null;
        }
        return true;
    },

    /** Push an entity's transform/depth to its visual (called after gameplay moves it). */
    update(entityId, opts) {
        const b = VisualEntity._bindings.get(String(entityId));
        if (!b) return null;
        const e = typeof GameModel !== 'undefined' && GameModel.booted() ? GameModel.entity(String(entityId)) : null;
        if (e) {
            b.position = Coords.clone(e.position);
            b.rotation = Coords.clone(e.rotation);
            b.scale = Coords.clone(e.scale);
        }
        if (VisualEntity._backend && typeof VisualEntity._backend.visualUpdate === 'function') return VisualEntity._backend.visualUpdate(b, opts || {});
        return { entityId: b.entityId, applied: false, headless: true };
    },

    /** Push every binding (the frame loop; cheap — the backend diffs). */
    updateAll(opts) {
        let n = 0;
        for (const id of VisualEntity._bindings.keys()) if (VisualEntity.update(id, opts)) n++;
        return n;
    },

    /** @returns {VisualBinding | null} */
    binding(entityId) {
        const b = VisualEntity._bindings.get(String(entityId));
        return b ? JSON.parse(JSON.stringify(Object.assign({}, b, { handle: b.handle != null ? '[handle]' : null }))) : null;
    },

    bindings() { return [...VisualEntity._bindings.keys()].map(id => VisualEntity.binding(id)); },

    /** What an entity looks like right now: { type, asset, resolvedBy, profile }. */
    representationOf(entityId) {
        const b = VisualEntity._bindings.get(String(entityId));
        return b ? { entityId: b.entityId, type: b.type, asset: b.asset, resolvedBy: b.resolvedBy, profile: b.profile, placeholder: !!b.placeholder } : null;
    },

    // --- world presentation ----------------------------------------------------------------------

    /**
     * Present the LOGICAL world (GameModel.world) for a profile: a tilemap in 2D, a plane
     * with sprites in 2.5D, 3D tiles in isometric, a low-poly terrain or a full terrain.
     * The world data itself is untouched — that is what makes a level convertible.
     */
    presentWorld(cfg, opts) {
        const c = cfg || (typeof RenderProfile !== 'undefined' ? RenderProfile.config() : null);
        if (!c || !GameModel.booted() || !GameModel.world) return { presented: false, reason: 'no world' };
        const w = GameModel.world;
        const rep = {
            presented: true, profile: c.id, ground: (c.world && c.world.ground) || 'plane',
            tiles: w._tiles ? w._tiles.size : 0, tileCounts: w.tileCounts(),
            tileSize: (c.world && c.world.tilePx) || w.tileSize,
            zones: w.zones.length, triggers: w.triggers.length, spawns: w.spawns.length, props: w.props.length,
            flatten: !!(c.world && (c.world.height === 'flat' || c.world.flatten)),
            headless: !VisualEntity._backend
        };
        if (VisualEntity._backend && typeof VisualEntity._backend.world === 'function') {
            const r = VisualEntity._backend.world({ world: w.toSpec(), config: c }, opts || {}) || {};
            Object.assign(rep, r);
        }
        VisualEntity.worldBinding = rep;
        return rep;
    },

    // --- reports ---------------------------------------------------------------------------------

    /** Bindings whose asset is missing (shown through a placeholder). */
    missing() { return VisualEntity.bindings().filter(b => b.resolvedBy === 'placeholder' || !b.asset); },

    placeholders() { return VisualEntity.bindings().filter(b => b.resolvedBy === 'placeholder'); },

    fallbacks() { return VisualEntity.bindings().filter(b => b.resolvedBy === 'fallback'); },

    counts() {
        const out = { bindings: VisualEntity._bindings.size, byType: {}, byResolution: {} };
        for (const b of VisualEntity._bindings.values()) {
            out.byType[b.type] = (out.byType[b.type] || 0) + 1;
            out.byResolution[b.resolvedBy] = (out.byResolution[b.resolvedBy] || 0) + 1;
        }
        return out;
    },

    /**
     * Does a set of entities fit a profile's machine-readable budget? Returns warnings
     * (maxAnimatedEntities, maxDrawCalls, maxParticles…) — the numbers an agent must respect
     * when it creates a variant.
     */
    overBudget(entities, budget) {
        const b = budget || {};
        const list = entities || (GameModel.booted() ? GameModel.entities : []);
        const warnings = [];
        const animated = list.filter(e => e.visual && e.visual.animation).length;
        if (typeof b.maxAnimatedEntities === 'number' && animated > b.maxAnimatedEntities) {
            warnings.push('maxAnimatedEntities ' + animated + ' > ' + b.maxAnimatedEntities);
        }
        // What this presentation actually draws: an entity is invisible to the budget when it
        // declares 'none' (self-presented) — globally or for the profile being checked.
        const pid = (typeof RenderProfile !== 'undefined' && RenderProfile.id) ? RenderProfile.id() : null;
        const selfPresented = (e) => {
            if (!e || !e.visual) return false;
            if (pid && e.visual.profiles && e.visual.profiles[pid] && e.visual.profiles[pid].type === 'none') return true;
            return e.visual.representation === 'none';
        };
        const visible = list.filter(e => !selfPresented(e)).length;
        if (typeof b.maxDrawCalls === 'number' && visible > b.maxDrawCalls) {
            warnings.push('maxDrawCalls: ' + visible + ' visible entities exceed the budget (batch or instance them)');
        }
        return warnings;
    },

    inspect() {
        return Object.assign({
            backend: !!VisualEntity._backend,
            headless: !VisualEntity._backend,
            profile: typeof RenderProfile !== 'undefined' ? RenderProfile.id() : null,
            world: VisualEntity.worldBinding ? { ground: VisualEntity.worldBinding.ground, tiles: VisualEntity.worldBinding.tiles } : null,
            missing: VisualEntity.missing().length
        }, VisualEntity.counts());
    },

    attachBackend(backend) {
        VisualEntity._backend = backend && typeof backend.visual === 'function' ? backend : (backend || null);
        return !!VisualEntity._backend;
    },

    backend() { return VisualEntity._backend; },

    /** Drop every engine object (a variant switch rebuilds them). */
    clear() {
        for (const id of [...VisualEntity._bindings.keys()]) VisualEntity.unbind(id);
        VisualEntity.worldBinding = null;
        return true;
    }
};
