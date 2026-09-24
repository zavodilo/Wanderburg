// Visual3D.js — the engine backend of the presentation layer.
//
// This is the ONLY file that turns a semantic visual binding into PlayCanvas objects. It
// implements the backend contract the presentation layer calls:
//
//     camera(params)      -> Camera3D + the kit's CameraController (projection, pose, follow)
//     lighting(state)     -> Lighting3D (World3D.cfg overrides: sun, toon, ink, shadows)
//     world(spec, config) -> ground shape (flat / hills / terrain) + logical tiles
//     visual(binding)     -> sprite (Sprite2D) | model (Location3D/Model3D) | primitive
//     animation(id,state) -> sprite frames or skeletal clips — the same semantic state
//     screenToWorld / worldToScreen / target / shake / stats / renderCheck
//
// Reuse over invention: a model binding becomes a Location3D record, so loading, placement
// on the ground, the missing-file fallback (Procedural3D) and clip playback are the kit's
// proven paths. A sprite binding becomes a Sprite2D handle.
//
// Attaching is one call from main.js:
//     Visual3D.attach({ view, location, camera, canvas });
// which installs itself into RenderProfile/Camera/Lighting/VisualEntity/GameAnimation.

/** @satisfies {Record<string, any>} */
const Visual3D = {
    /** @type {{ view: any, location: any, camera: any, canvas: any } | null} */
    _ctx: null,
    /** @type {Map<string, any>} entityId -> { kind, handle, rec, binding } */
    _objects: new Map(),
    /** @type {Map<string, any>} tile/prop key -> handle */
    _world: new Map(),
    /** @type {any | null} */
    _worldConfig: null,
    /** Per-frame follow bookkeeping for the semantic camera. */
    _follow: null,

    get MAX_TILES() { return (typeof PROFILE_MAX_TILES !== 'undefined' && PROFILE_MAX_TILES > 0) ? PROFILE_MAX_TILES : 1500; },

    // --- attach ---------------------------------------------------------------------------

    /** Install the backend. ctx — { view, location, camera, canvas }. */
    attach(ctx) {
        const c = ctx || {};
        if (!c.view || !c.location) throw new Error('Visual3D.attach: { view, location } are required');
        Visual3D._ctx = { view: c.view, location: c.location, camera: c.camera || null, canvas: c.canvas || null };
        if (typeof Sprite2D !== 'undefined') Sprite2D.assetBase = (c.location && c.location.opts && c.location.opts.assetBase) || '';
        const backend = Visual3D.backend();
        if (typeof RenderProfile !== 'undefined') RenderProfile.attachBackend(backend);
        if (typeof Input !== 'undefined') Input.setWorldProjector((px, py) => Visual3D.screenToWorld(px, py));
        if (typeof GameAudio !== 'undefined') {
            GameAudio.setBackend({
                play: (src, opts) => (typeof Sound3D !== 'undefined' ? Sound3D.play(src, opts) : null),
                stop: () => (typeof Sound3D !== 'undefined' ? Sound3D.stopAll() : false),
                volume: (ch, v) => Visual3D._channelVolume(ch, v),
                mute: (on) => (typeof Sound3D !== 'undefined' ? Sound3D.setMuted(on) : false)
            });
        }
        return backend;
    },

    detach() {
        if (typeof RenderProfile !== 'undefined') RenderProfile.attachBackend(null);
        Visual3D._ctx = null;
        return true;
    },

    /** The backend object handed to the presentation layer. */
    backend() {
        return {
            view: () => Visual3D._ctx && Visual3D._ctx.view,
            camera: (params, opts) => Visual3D.camera(params, opts),
            update: (dt, opts) => Visual3D.update(dt, opts),
            lighting: (state, opts) => Visual3D.lighting(state, opts),
            world: (payload, opts) => Visual3D.world(payload, opts),
            visual: (binding, opts) => Visual3D.visual(binding, opts),
            visualUpdate: (binding, opts) => Visual3D.visualUpdate(binding, opts),
            visualDestroy: (binding) => Visual3D.visualDestroy(binding),
            animation: (id, state, opts) => Visual3D.animation(id, state, opts),
            animationStop: (id) => Visual3D.animationStop(id),
            screenToWorld: (px, py) => Visual3D.screenToWorld(px, py),
            worldToScreen: (v) => Visual3D.worldToScreen(v),
            target: () => Visual3D.target(),
            shake: (ms, amp) => Visual3D.shake(ms, amp),
            stats: () => Visual3D.stats(),
            renderCheck: (opts) => Visual3D.renderCheck(opts),
            present: (profileId, cfg) => Visual3D.present(profileId, cfg),
            inspect: () => Visual3D.inspect()
        };
    },

    ctx() { return Visual3D._ctx; },

    /** A channel bus gain (Sound3D.buses) — 'master' is the master gain. */
    _channelVolume(channel, v) {
        if (typeof Sound3D === 'undefined') return false;
        const g = Math.max(0, Math.min(1, Number(v) || 0));
        if (String(channel) === 'master' && Sound3D.master) { Sound3D.master.gain.value = g; return true; }
        const bus = Sound3D.buses && Sound3D.buses[String(channel)];
        if (bus && bus.gain) { bus.gain.value = g; return true; }
        return false;
    },

    // --- camera ------------------------------------------------------------------------------

    camera(params, opts) {
        const ctx = Visual3D._ctx;
        if (!ctx || !ctx.camera) return { applied: false, reason: 'no camera controller' };
        const r = Camera3D.apply(ctx.camera, params, opts || {});
        // Following a logical entity: the controller reads {x, y} in MAP coordinates every
        // frame, so it is handed a live view of the entity's canonical position.
        const followId = params && params.follow ? String(params.follow) : null;
        Visual3D._follow = followId;
        if (followId && typeof GameModel !== 'undefined' && GameModel.entity(followId)) {
            const e = GameModel.entity(followId);
            ctx.camera.follow({ get x() { return e.position.x; }, get y() { return e.position.z; } });
            r.follow = followId;
        } else {
            ctx.camera.follow(null);
            r.follow = null;
        }
        r.mode = (params && params.mode) || null;
        return r;
    },

    update(dt, opts) {
        const ctx = Visual3D._ctx;
        if (!ctx) return false;
        const o = opts || {};
        const params = o.params || (typeof Camera !== 'undefined' ? Camera.params() : null);
        // A side view keeps its look-at point at the height of what it follows.
        let lift = null;
        if (params && Camera3D.SIDE_MODES.includes(params.mode) && o.target) lift = (o.target.y || 0) + Camera3D.SIDE_EYE_PX * 0.5;
        Camera3D.update(ctx.camera, params, { lift: lift });
        // logical transform -> visual transform
        for (const [id, obj] of Visual3D._objects) Visual3D._place(id, obj);
        return true;
    },

    target() {
        const ctx = Visual3D._ctx;
        return ctx && ctx.camera ? Camera3D.target(ctx.camera) : null;
    },

    screenToWorld(px, py) {
        const ctx = Visual3D._ctx;
        if (!ctx) return null;
        return Camera3D.screenToWorld(ctx.view, px, py, { terrain: ctx.location ? ctx.location.terrain : null });
    },

    worldToScreen(v) {
        const ctx = Visual3D._ctx;
        return ctx ? Camera3D.worldToScreen(ctx.view, v) : null;
    },

    shake(ms, amp) {
        const ctx = Visual3D._ctx;
        if (!ctx || !ctx.camera || typeof ctx.camera.shake !== 'function') return { applied: false };
        ctx.camera.shake(ms, amp);
        return { applied: true };
    },

    // --- lighting -------------------------------------------------------------------------------

    lighting(state, opts) {
        const ctx = Visual3D._ctx;
        if (!ctx) return { applied: false, reason: 'no view' };
        return Lighting3D.apply(ctx.view, state, opts || {});
    },

    // --- world presentation ------------------------------------------------------------------------

    /**
     * Present the logical world for a profile: the ground shape and the tiles that have a
     * visual. The WorldMap itself is never modified — that is what makes a level convertible.
     */
    world(payload, opts) {
        const ctx = Visual3D._ctx;
        if (!ctx || !payload) return { presented: false, reason: 'no view' };
        const cfg = payload.config || {};
        const spec = payload.world || null;
        const o = opts || {};
        const out = { presented: true, profile: cfg.id || null, ground: (cfg.world && cfg.world.ground) || null, tiles: 0, tilesCapped: false, groundShape: null };

        // 1. the ground: a flat plane for the 2D profiles, the authored height field for 3D
        const flat = !!(cfg.world && (cfg.world.height === 'flat' || cfg.world.flatten));
        if (ctx.location && typeof ctx.location.setTerrainNoise === 'function') {
            const before = ctx.location.opts.noise ? 'override' : 'constants';
            ctx.location.setTerrainNoise(flat ? { amp: 0 } : null);
            out.groundShape = flat ? 'flat' : 'heightfield';
            out.terrainRebuilt = before !== (flat ? 'override' : 'constants') || o.force === true;
        }

        // 2. tiles: everything the previous presentation drew is dropped first
        Visual3D.clearWorld();
        Visual3D._worldConfig = cfg;
        if (!spec || !spec.tiles || !spec.tiles.length) { out.tiles = 0; return out; }
        const tileSize = Number((cfg.world && cfg.world.tilePx) || spec.tileSize || 64);
        const budget = (cfg.performance && cfg.performance.maxDrawCalls) || Visual3D.MAX_TILES;
        const cap = Math.min(Visual3D.MAX_TILES, Math.max(16, budget));
        const skip = Visual3D._skipKinds(spec, cap);
        let n = 0;
        for (const t of spec.tiles) {
            if (skip.includes(t.kind)) continue;
            if (n >= cap) { out.tilesCapped = true; break; }
            const role = (typeof World !== 'undefined' && World.roleFor(t.kind)) || null;
            const handle = Visual3D._tile(t, role, cfg, tileSize);
            if (handle) { Visual3D._world.set('tile:' + t.x + ',' + t.z, handle); n++; }
        }
        // 3. world props (static dressing declared by the world, not by a system)
        for (const p of spec.props || []) {
            const handle = Visual3D._prop(p, cfg);
            if (handle) { Visual3D._world.set('prop:' + p.id, handle); n++; }
        }
        out.tiles = n;
        out.skippedKinds = skip;
        return out;
    },

    /** Floor tiles are the ground texture's job when there are many of them. */
    _skipKinds(spec, cap) {
        const counts = {};
        for (const t of spec.tiles || []) counts[t.kind] = (counts[t.kind] || 0) + 1;
        const skip = [];
        if ((counts.floor || 0) > Math.min(256, cap / 2)) skip.push('floor');
        for (const k of ['empty', 'trigger', 'spawn', 'enemySpawn']) if (counts[k]) skip.push(k);
        return skip;
    },

    /** One logical tile -> a sprite (2D/2.5D) or a low box (the 3D profiles). */
    _tile(t, role, cfg, tileSize) {
        const ctx = Visual3D._ctx;
        const pid = cfg.id || '2d';
        const res = role && typeof AssetRegistry !== 'undefined' ? AssetRegistry.resolve(role, pid, { entityType: 'terrain' }) : null;
        const center = { x: (t.x + 0.5) * tileSize, y: 0, z: (t.z + 0.5) * tileSize };
        const useSprite = res ? (res.type === 'sprite' || res.type === 'billboard' || res.type === 'tile') : (RenderProfile.dimension(pid) < 3);
        const order = Visual3D.TILE_ORDER[t.kind] != null ? Visual3D.TILE_ORDER[t.kind] : 5;
        if (useSprite) {
            const size = (res && res.size && res.size.length) ? res.size : [tileSize, tileSize];
            const handle = Sprite2D.create(ctx.view, {
                name: 'tile-' + t.kind + '-' + t.x + '-' + t.z,
                texture: res && res.asset ? res.asset : null,
                placeholder: res && res.placeholder ? res.placeholder : { color: Visual3D.TILE_COLOR[t.kind] || '#8a8f98', label: t.kind, width: 64, height: 64 },
                w: size[0], h: size[1] || size[0],
                drawOrder: order * 10, depthTest: RenderProfile.dimension(pid) >= 3, flat: false
            });
            if (!handle) return null;
            handle.tile = t;
            Sprite2D.place(handle, center, { ground: Visual3D._groundAt(center), bias: 0.5 + order * 0.05, anchor: 'center' });
            return { kind: 'sprite', handle: handle, tile: t };
        }
        // 3D: a low box/primitive per blocking tile, the ground shows the rest
        const height = Visual3D.TILE_HEIGHT[t.kind] != null ? Visual3D.TILE_HEIGHT[t.kind] : tileSize * 0.6;
        const node = Procedural3D.spawn(ctx.view, Visual3D.TILE_KIND3D[t.kind] || 'box', {
            name: 'tile-' + t.kind + '-' + t.x + '-' + t.z,
            x: center.x, y: center.y, h: 0, kind: 'prop',
            scale: Math.max(0.05, tileSize / 64) * (Visual3D.TILE_SCALE[t.kind] || 1),
            seed: Procedural3D.hashName(t.kind + t.x + ',' + t.z)
        });
        if (!node) return null;
        node.setLocalScale(Math.max(0.05, tileSize / 64), Math.max(0.05, height / 64), Math.max(0.05, tileSize / 64));
        return { kind: 'primitive', handle: null, node: node, tile: t, height: height };
    },

    TILE_ORDER: { floor: 1, water: 2, loot: 3, door: 4, wall: 5, obstacle: 6 },
    TILE_COLOR: { floor: '#6f8f57', wall: '#5b5f6b', water: '#3f6f9f', obstacle: '#7a6a55', door: '#8a6a3f', loot: '#c9a227' },
    TILE_HEIGHT: { wall: 96, obstacle: 48, door: 80, water: 4, loot: 16, floor: 2 },
    TILE_KIND3D: { wall: 'box', obstacle: 'crate', door: 'box', water: 'box', loot: 'crate', floor: 'box' },
    TILE_SCALE: { wall: 1, obstacle: 0.8, door: 0.9, water: 1, loot: 0.35, floor: 1 },

    /** A world prop: a role-resolved visual at a canonical position. */
    _prop(p, cfg) {
        const role = p.role || ('world.' + p.id + '.visual');
        const binding = {
            entityId: 'prop:' + p.id, entityType: 'prop', profile: cfg.id, type: null, role: role,
            asset: null, resolvedBy: 'unresolved', placeholder: null, kind: null, size: null,
            clips: null, frames: null, renderLayer: 'world', drawOrder: 500, zIndex: 0,
            position: { x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 },
            rotation: { x: 0, y: Number(p.heading) || 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }
        };
        const res = typeof AssetRegistry !== 'undefined' ? AssetRegistry.resolve(role, cfg.id, { entityType: 'prop' }) : null;
        if (res) {
            binding.type = res.type; binding.asset = res.asset; binding.resolvedBy = res.resolvedBy;
            binding.placeholder = res.placeholder; binding.kind = res.kind; binding.size = res.size;
            binding.clips = res.clips; binding.frames = res.frames;
        } else binding.type = 'primitive';
        const obj = Visual3D.visual(binding, {});
        return obj ? Object.assign({ prop: p }, obj) : null;
    },

    clearWorld() {
        for (const [, w] of Visual3D._world) {
            if (w.handle) Sprite2D.destroy(w.handle);
            else if (w.node) World3D.removeObject(Visual3D._ctx.view, w.node);
        }
        Visual3D._world.clear();
        return true;
    },

    _groundAt(pos) {
        const ctx = Visual3D._ctx;
        if (!ctx || !ctx.location || !ctx.location.terrain) return 0;
        return ctx.location.terrain.heightAt(pos.x, pos.z) || 0;
    },

    // --- entity visuals -----------------------------------------------------------------------------

    /**
     * Create or update the engine object of a binding. Returns { applied, handle, kind, error }.
     * The binding's entityId is the LOGICAL id: it never changes across profiles.
     */
    visual(binding, opts) {
        const ctx = Visual3D._ctx;
        if (!ctx) return { applied: false, reason: 'no view' };
        const b = binding;
        const id = String(b.entityId);
        const prev = Visual3D._objects.get(id);
        const wantSprite = b.type === 'sprite' || b.type === 'billboard' || b.type === 'tile';
        const wantKind = wantSprite ? 'sprite' : (b.type === 'primitive' ? 'primitive' : 'model');
        if (prev && prev.kind !== wantKind) { Visual3D.visualDestroy(prev.binding || prev); }
        // The editor's own record of the same object (Objects.js) is suppressed while a
        // profile presents the entity as something else — a sprite in 2D, a model in 3D.
        // Suppression is presentation state, it never rewrites Objects.js.
        Visual3D.suppressLocationObject(id, wantKind !== 'model');

        if (wantKind === 'sprite') return Visual3D._sprite(b, opts);
        if (wantKind === 'primitive') return Visual3D._primitive(b, opts);
        return Visual3D._model(b, opts);
    },

    _sprite(b, opts) {
        const ctx = Visual3D._ctx;
        const id = String(b.entityId);
        const size = (b.size && b.size.length) ? b.size : [64, 96];
        const ph = b.placeholder || (typeof AssetRegistry !== 'undefined' ? AssetRegistry.placeholder(null, b.profile, b.entityType || 'prop', b.role || id) : null);
        let obj = Visual3D._objects.get(id);
        if (!obj || obj.kind !== 'sprite' || !obj.handle || obj.handle.disposed) {
            const handle = Sprite2D.create(ctx.view, {
                name: id, texture: b.asset || null, placeholder: ph,
                w: size[0], h: size[1] || size[0],
                drawOrder: b.drawOrder || 500,
                depthTest: RenderProfile.dimension(b.profile) >= 3,
                frames: b.frames || null
            });
            if (!handle) return { applied: false, error: 'sprite creation failed' };
            obj = { kind: 'sprite', handle: handle, rec: null, node: null, binding: b };
            Visual3D._objects.set(id, obj);
        } else {
            obj.binding = b;
            const h = obj.handle;
            if (h.textureKey !== 'file:' + b.asset && b.asset) Sprite2D.setTexture(h, b.asset, ph);
            else if (!b.asset && !h.placeholder) Sprite2D.setPlaceholder(h, ph);
            if (h.w !== size[0] || h.h !== (size[1] || size[0])) Sprite2D.setSize(h, size[0], size[1] || size[0]);
            if (h.drawOrder !== (b.drawOrder || 500)) Sprite2D.setDrawOrder(h, b.drawOrder || 500);
            if (b.frames && !h.frames) h.frames = b.frames;
        }
        Visual3D._place(id, obj);
        if (b.animation && b.animation.default) Visual3D.animation(id, b.animation.default, {});
        return { applied: true, kind: 'sprite', handle: obj.handle, representation: 'sprite', placeholder: !!(b.asset == null) };
    },

    _primitive(b, opts) {
        const ctx = Visual3D._ctx;
        const id = String(b.entityId);
        let obj = Visual3D._objects.get(id);
        const kind = b.kind || (typeof AssetRegistry !== 'undefined' ? (AssetRegistry.PRIMITIVE_FOR[b.entityType] || 'box') : 'box');
        const realKind = Procedural3D.KINDS.includes(kind) ? kind : 'box';
        if (!obj || obj.kind !== 'primitive' || obj.primKind !== realKind) {
            if (obj) Visual3D.visualDestroy(obj.binding || obj);
            const scale = Math.max(0.05, (b.scale && b.scale.x) || 1);
            const node = Procedural3D.spawn(ctx.view, realKind, {
                name: id, x: b.position.x, y: b.position.z, h: b.position.y,
                kind: Visual3D._groupOf(b.entityType), heading: b.rotation.y || 0, scale: scale,
                seed: Procedural3D.hashName(id)
            });
            obj = { kind: 'primitive', handle: null, rec: null, node: node, binding: b, primKind: realKind };
            Visual3D._objects.set(id, obj);
        } else {
            obj.binding = b;
        }
        Visual3D._place(id, obj);
        return { applied: true, kind: 'primitive', handle: obj.node, representation: 'primitive:' + realKind };
    },

    /** A model binding becomes a Location3D record: loading, ground placement and the
     *  missing-file fallback (Procedural3D) are the kit's proven paths. */
    _model(b, opts) {
        const ctx = Visual3D._ctx;
        const loc = ctx.location;
        const id = String(b.entityId);
        let obj = Visual3D._objects.get(id);
        const def = Visual3D._defOf(b);
        if (!obj || obj.kind !== 'model') {
            // adopt the editor's own record when it carries the same name or tag: the kit's
            // Objects.js and the semantic model describe the same things.
            const existing = loc.objects.find(r => r.def.name === id || r.def.tag === id);
            if (existing) {
                obj = { kind: 'model', handle: null, rec: existing, node: null, binding: b, adopted: true, model: existing.def.model };
                Visual3D._objects.set(id, obj);
            } else {
                const rec = loc.addObject(def);
                obj = { kind: 'model', handle: null, rec: rec, node: null, binding: b, model: def.model };
                Visual3D._objects.set(id, obj);
                return { applied: true, kind: 'model', handle: rec, representation: 'model', loading: true, asset: def.model };
            }
        } else {
            obj.binding = b;
        }
        const rec = obj.rec;
        if (!rec) return { applied: false, error: 'no location record' };
        // a different asset (a migration!) — swap the record, keep the id
        if (obj.model !== def.model) {
            const wasAdopted = obj.adopted;
            loc.removeObject(rec);
            const fresh = loc.addObject(def);
            obj.rec = fresh;
            obj.model = def.model;
            obj.adopted = wasAdopted;
            return { applied: true, kind: 'model', handle: fresh, representation: 'model', loading: true, asset: def.model, swapped: true };
        }
        Object.assign(rec.def, def);
        loc.placeObject(rec);
        return { applied: true, kind: 'model', handle: rec, representation: 'model', loaded: !!rec.mesh, asset: def.model };
    },

    /** A binding -> a LOCATION_OBJECTS-shaped def (map coordinates, kit conventions). */
    _defOf(b) {
        const map = Coords.toMap(b.position || { x: 0, y: 0, z: 0 });
        const scale = b.scale || { x: 1, y: 1, z: 1 };
        const def = {
            name: String(b.entityId),
            model: b.asset || ('assets/visual/' + b.profile + '/' + String(b.role || b.entityId).replace(/[^a-z0-9.]+/gi, '-') + '.glb'),
            kind: Visual3D._groupOf(b.entityType),
            x: map.x, y: map.y, h: map.h,
            rot: Coords.rotToMap(b.rotation || { x: 0, y: 0, z: 0 }),
            scale: [Math.max(0.001, scale.x), Math.max(0.001, scale.y), Math.max(0.001, scale.z)],
            tag: String(b.entityId)
        };
        // the fallback of the manifest's chain: a missing model becomes primitive geometry
        const ph = b.placeholder || null;
        const kind = (ph && (ph.primitive || ph.kind)) || b.kind || null;
        if (kind && Procedural3D.KINDS.includes(kind)) def.fallback = kind;
        else if (!b.asset) def.fallback = (typeof AssetRegistry !== 'undefined' && AssetRegistry.PRIMITIVE_FOR[b.entityType]) || 'box';
        const state = b.animation && b.animation.default ? b.animation.default : null;
        const clip = state ? Visual3D._clipName(b, state) : null;
        if (clip) def.clip = clip;
        return def;
    },

    _groupOf(entityType) {
        return (entityType === 'character' || entityType === 'creature' || entityType === 'vehicle') ? 'actor' : 'prop';
    },

    /** A semantic state -> the clip name of this binding's model (registry clips map). */
    _clipName(b, state) {
        const map = (b.clips || (b.binding && b.binding.clips)) || null;
        if (map && map[state]) return map[state];
        return String(state);
    },

    /** Push a logical transform into the engine object. */
    _place(id, obj) {
        const b = obj.binding;
        if (!b) return false;
        if (obj.kind === 'sprite' && obj.handle && !obj.handle.disposed) {
            // A sprite's authored size (the registry entry) is its final size: the entity's
            // scale belongs to models (cm -> px of a file). With no authored size the default
            // sprite size is a guess, and then the entity scale does refine it.
            const authored = !!(b.size && b.size.length);
            Sprite2D.place(obj.handle, b.position, {
                ground: RenderProfile.dimension(b.profile) >= 3 ? Visual3D._groundAt(b.position) : 0,
                anchor: 'bottom',
                heading: b.rotation ? b.rotation.y : 0,
                scaleX: authored ? 1 : (b.scale ? b.scale.x : 1),
                scaleY: authored ? 1 : (b.scale ? b.scale.y : 1),
                bias: (b.zIndex || 0) * 0.01
            });
            return true;
        }
        if (obj.kind === 'primitive' && obj.node) {
            const map = Coords.toMap(b.position);
            const ground = Visual3D._groundAt(b.position);
            obj.node.setPosition(-map.x, ground + map.h, map.y);
            obj.node.setEulerAngles(0, -(b.rotation.y || 0), 0);
            return true;
        }
        if (obj.kind === 'model' && obj.rec) {
            const map = Coords.toMap(b.position);
            obj.rec.def.x = map.x; obj.rec.def.y = map.y; obj.rec.def.h = map.h;
            obj.rec.def.rot = Coords.rotToMap(b.rotation || { x: 0, y: 0, z: 0 });
            if (obj.rec.mesh) obj.rec.location = obj.rec.location || null;
            if (Visual3D._ctx && Visual3D._ctx.location) Visual3D._ctx.location.placeObject(obj.rec);
            return true;
        }
        return false;
    },

    visualUpdate(binding, opts) {
        const id = String((binding && binding.entityId) || '');
        const obj = Visual3D._objects.get(id);
        if (!obj) return null;
        if (binding) obj.binding = Object.assign(obj.binding || {}, binding);
        Visual3D._place(id, obj);
        return { applied: true, kind: obj.kind };
    },

    /** Hide/show the editor's own record of an object (Objects.js) for presentation reasons. */
    suppressLocationObject(id, on) {
        const ctx = Visual3D._ctx;
        if (!ctx || !ctx.location) return false;
        const rec = ctx.location.objects.find(r => r.def.name === id || r.def.tag === id);
        if (!rec) return false;
        if (typeof ctx.location.setSuppressed === 'function') return ctx.location.setSuppressed(rec, on);
        return false;
    },

    /** Remove the engine object of an entity. The logical entity is untouched. */
    visualDestroy(binding) {
        const id = String((binding && binding.entityId) || binding || '');
        const obj = Visual3D._objects.get(id);
        if (!obj) return false;
        const ctx = Visual3D._ctx;
        if (obj.kind === 'sprite' && obj.handle) Sprite2D.destroy(obj.handle);
        else if (obj.kind === 'primitive' && obj.node && ctx) World3D.removeObject(ctx.view, obj.node);
        else if (obj.kind === 'model' && obj.rec && ctx && !obj.adopted) ctx.location.removeObject(obj.rec);
        else if (obj.kind === 'model' && obj.rec && ctx) {
            // an adopted editor object (Objects.js) stays in the project: presentation only
            // suppresses it, and never writes def.hidden (that field belongs to the editor)
            ctx.location.setSuppressed(obj.rec, true);
        }
        Visual3D._objects.delete(id);
        return true;
    },

    // --- animation ---------------------------------------------------------------------------------

    /** The same semantic state drives sprite frames or skeletal clips. */
    animation(entityId, state, opts) {
        const id = String(entityId);
        const obj = Visual3D._objects.get(id);
        if (!obj) return { applied: false, reason: 'no visual for ' + id, headless: true };
        const o = opts || {};
        if (obj.kind === 'sprite' && obj.handle) {
            const r = Sprite2D.play(obj.handle, state, { fps: o.fps });
            return { applied: true, representation: 'sprite-frames', state: state, frame: r ? r.frame : 0 };
        }
        if (obj.kind === 'model' && obj.rec) {
            const rec = obj.rec;
            rec.def.clip = Visual3D._clipName(obj.binding || {}, state);
            if (!rec.mesh) return { applied: false, representation: 'skeletal', state: state, loading: true };
            const clips = (typeof Model3D !== 'undefined' && Model3D.clips) ? Model3D.clips(rec.mesh) : null;
            if (!clips) return { applied: false, representation: 'skeletal', state: state, reason: 'no clips' };
            const name = Visual3D._clipName(obj.binding || {}, state);
            if (clips.has && !clips.has(name)) {
                // an unmapped state: try the file's own names, else keep the current clip
                const alt = (clips.names ? clips.names() : []).find(n => String(n).toLowerCase() === String(name).toLowerCase());
                if (!alt) return { applied: false, representation: 'skeletal', state: state, clip: name, reason: 'clip not in the model', available: clips.names ? clips.names() : [] };
                rec.def.clip = alt;
                clips.play(alt, { loop: o.loop !== false, speed: o.speed });
                return { applied: true, representation: 'skeletal', state: state, clip: alt };
            }
            clips.play(name, { loop: o.loop !== false, speed: o.speed });
            return { applied: true, representation: 'skeletal', state: state, clip: name };
        }
        return { applied: false, representation: obj.kind, state: state, reason: 'a ' + obj.kind + ' does not animate' };
    },

    animationStop(entityId) {
        const obj = Visual3D._objects.get(String(entityId));
        if (!obj) return { applied: false };
        if (obj.kind === 'sprite' && obj.handle) { obj.handle.frames = null; return { applied: true }; }
        if (obj.kind === 'model' && obj.rec) { delete obj.rec.def.clip; return { applied: true }; }
        return { applied: false };
    },

    // --- profile extras -----------------------------------------------------------------------------

    /** Profile-specific engine work (pixel-art sampling, sprite depth, post effects). */
    present(profileId, cfg) {
        const ctx = Visual3D._ctx;
        if (!ctx) return { applied: false };
        const p = (typeof RENDER_PROFILES !== 'undefined' && RENDER_PROFILES.profiles[profileId]) || {};
        Sprite2D.pixelArt = profileId === '2d' || profileId === '2.5d';
        const out = { applied: true, profile: profileId, pixelArt: Sprite2D.pixelArt };
        // a 2D presentation wants no fog and no sky gradient in the way of flat sprites
        if (p.projection === 'orthographic' && RenderProfile.dimension(profileId) < 3) out.flat = true;
        out.sprites = Sprite2D.count(ctx.view);
        out.objects = Visual3D._objects.size;
        return out;
    },

    // --- verification -------------------------------------------------------------------------------

    /** Draw calls, triangles, textures — the numbers a budget check reads. */
    stats() {
        const ctx = Visual3D._ctx;
        if (!ctx || typeof Debug3D === 'undefined') return null;
        const app = ctx.view.app;
        const dev = app && app.graphicsDevice;
        return {
            fps: World3D.fps(),
            drawCalls: dev ? dev._drawCallsTotal != null ? dev._drawCallsTotal : (dev.drawCalls != null ? dev.drawCalls : null) : null,
            triangles: dev && dev._primsTotal != null ? dev._primsTotal[0] : null,
            sprites: Sprite2D.count(ctx.view),
            objects: Visual3D._objects.size,
            worldObjects: Visual3D._world.size,
            projection: ctx.camera ? ctx.camera.projection : null,
            orthoHeight: ctx.camera && ctx.camera.projection === 'orthographic' ? ctx.camera.orthoHeight() : null
        };
    },

    /**
     * The render check of a migration/conversion: draw a frame, lint the scene, count what
     * is on screen. Errors here roll the conversion back.
     */
    renderCheck(opts) {
        const ctx = Visual3D._ctx;
        const o = opts || {};
        const out = { renderTests: 0, visualTests: 0, errors: [], stats: null };
        if (!ctx) { out.errors.push('no engine context'); return out; }
        try {
            World3D.renderFrame();
            out.renderTests++;
        } catch (e) { out.errors.push('renderFrame: ' + ((e && e.message) || e)); }
        if (typeof Debug3D !== 'undefined' && Debug3D.lint) {
            return Debug3D.lint(ctx.view, { silent: true, frame: false }).then((r) => {
                for (const f of (r.findings || [])) if (f.level === 'error') out.errors.push(f.message || f.code || 'lint');
                out.renderTests += 1;
                out.visualTests = (r.findings || []).length >= 0 ? 1 : 0;
                out.stats = r.stats || null;
                out.findings = (r.findings || []).length;
                return out;
            }, (e) => { out.errors.push('lint: ' + ((e && e.message) || e)); return out; });
        }
        return out;
    },

    /** Everything the backend holds — the editor's profile panel and the reports read this. */
    inspect() {
        const ctx = Visual3D._ctx;
        return {
            attached: !!ctx,
            objects: Visual3D._objects.size,
            byKind: Visual3D.counts(),
            world: Visual3D._world.size,
            sprites: ctx ? Sprite2D.inspect(ctx.view) : null,
            camera: ctx && ctx.camera ? Camera3D.inspect(ctx.camera) : null,
            lighting: ctx ? Lighting3D.inspect(ctx.view) : null,
            stats: Visual3D.stats()
        };
    },

    counts() {
        const out = {};
        for (const obj of Visual3D._objects.values()) out[obj.kind] = (out[obj.kind] || 0) + 1;
        return out;
    },

    /** The engine object of an entity (null when it has no visual). */
    objectOf(entityId) { return Visual3D._objects.get(String(entityId)) || null; },

    /** Drop everything the backend created (a variant switch rebuilds it). */
    clear() {
        for (const id of [...Visual3D._objects.keys()]) Visual3D.visualDestroy({ entityId: id });
        Visual3D.clearWorld();
        return true;
    }
};
