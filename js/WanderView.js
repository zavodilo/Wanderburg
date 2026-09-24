// WanderView.js — everything Wanderburg draws. It reads the simulation (js/Logic.js) and
// builds the 3D picture out of procedural meshes (js/WanderMesh.js): the valley and its biome
// light, the walking castles with their module turrets and spinning wheels, villages, herds,
// knights, debris, shells, particles, health bars, the minimap and the floating numbers.
//
// RULES this file lives by (skill world3d, render-conventions):
//   * 3D is a VIEW. Nothing here writes to the simulation; the frame is "read run, draw run".
//   * World objects go through World3D.addObject and die through World3D.removeObject, so ink,
//     shadows and layer bookkeeping stay consistent.
//   * Hand-built convex meshes are registered with { outline: false } — the inverted hull would
//     paint them black (skill world3d §Pitfalls). The toon bands and ink edges stay.
//   * Placement mirrors the map into the engine world: position (−x, h, y), heading through
//     World3D.rotQuat. Nothing here invents its own mirror math.
//   * Everything is CACHED or POOLED: geometry and materials per (key, color), projectiles,
//     particles, bars and floating numbers as reused entities. A region rebuild frees what it
//     made; the shared caches stay for the next region.

/** @satisfies {Record<string, any>} */
class WanderView {
    /** @param {{ location: Location3D, camera: CameraController }} app */
    constructor(app) {
        // ?nopack=1 — procedural geometry only (the A/B half of verify/packdiff.mjs)
        this.noPack = !!(typeof Game !== 'undefined' && Game.queryNoPack && Game.queryNoPack());
        this.app = app;
        this.location = app.location;
        this.camera = app.camera;
        /** @type {any} */
        this.run = null;
        this.view = app.location.view;
        this.device = this.view ? this.view.app.graphicsDevice : null;
        /** @type {Map<number, any>} sim entity id -> view record */
        this.recs = new Map();
        /** @type {any[]} */
        this.particles = [];
        /** @type {Map<string, any[]>} */
        this.shotPool = new Map();
        /** @type {any[]} */
        this.chunks = [];
        /** @type {any[]} */
        this.bars = [];
        /** @type {any[]} */
        this.texts = [];
        /** @type {any[]} */
        this.scenery = [];
        /** @type {any[]} */
        this.beams = [];
        this.telegraph = null;
        this.minimap = null;
        this.damageVeil = null;
        this._veilT = 0;
        this._shakeT = 0;
        this._frame = 0;
        this._playerSig = '';
        /** Real-time shadow casters stay OFF: see applyBiome; blob shadows carry the look. */
        this._shadowsOn = false;
        this._biomeId = '';
        this._terrainCfg = null;
        this.ready = Promise.resolve();
        // Location3D.loadGround() resolves with the DEFAULT ground texture a moment after boot
        // and would repaint the biome's ground over ours; marking the index as "already ours"
        // makes it a no-op (see Location3D.loadGround). The location's first Terrain3D is
        // replaced by buildTerrain() anyway.
        this.location._groundIndex = -99;
    }

    // --- shared caches -------------------------------------------------------------------
    /** A cached mesh of a recipe entry. */
    geoMesh(key, hex, geo) {
        return WanderMesh.mesh(this.device, key + '@' + (hex >>> 0) + '@' + geo.length, geo);
    }

    /**
     * The engine files a mesh instance into layer.shadowCasters when its render component
     * ENABLES — which happens inside app.update(), i.e. AFTER any sync of mine in game.update
     * and BEFORE the shadow pass in app.render(). A disabled-then-enabled entity (a pooled
     * particle waking up) therefore lands in the caster list with a released or uncompiled
     * shader and kills the pass. The kit offers no hook between update and render, so the
     * view installs its own renderFrame: the kit's body plus syncCasters() in the gap.
     */
    installRenderLoop() {
        const world = /** @type {any} */ (World3D);
        if (world._wbPatched) return;
        world._wbPatched = true;
        world.renderFrame = () => {
            const app = world.app;
            if (!app) return;
            const now = performance.now();
            const dt = Math.min(0.1, Math.max(0.0001, (now - (world._lastT || now)) / 1000));
            world._lastT = now;
            world._fps += (1 / dt - world._fps) * 0.05;
            const v = world.view;
            if (v && v.active) {
                v.beforeRender();
                app.update(dt);
                this.syncCasters();
                app.render();
            } else {
                app.update(dt);
                app.render();
            }
        };
    }

    // --- lifecycle -------------------------------------------------------------------------
    /**
     * Take a run and build its region. Called on a new run and on every region change.
     * @param {any} run WBRun
     */
    setRun(run) {
        this.run = run;
        this.clearWorld();
        this.applyBiome(run.region.biome);
        this.buildScenery();
        // The terrain is rebuilt with the biome's noise and ground texture; entities appear on
        // the first update() after that resolves (placeEntity reads terrain.heightAt).
        this.ready = this.buildTerrain(run.region.biome);
        return this.ready;
    }

    /** Drop every entity this view made (a region change or a new run). */
    clearWorld() {
        for (const rec of this.recs.values()) this.destroy(rec);
        this.recs.clear();
        for (const p of this.particles) this.destroy(p);
        this.particles.length = 0;
        for (const list of this.shotPool.values()) for (const s of list) this.destroy(s);
        this.shotPool.clear();
        for (const c of this.chunks) this.destroy(c);
        this.chunks.length = 0;
        for (const b of this.bars) {
            if (b.bar) {
                for (const r of [b.bar.bg, b.bar.fill]) if (r) { try { World3D.removeObject(this.view, r); } catch (e) { /* gone */ } }
                b.bar = null;
            }
        }
        this.bars.length = 0;
        for (const s of this.scenery) this.destroy(s);
        this.scenery.length = 0;
        for (const b of this.beams) this.destroy(b);
        this.beams.length = 0;
        if (this.telegraph) { this.destroy(this.telegraph); this.telegraph = null; }
        for (const t of this.texts) if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
        this.texts.length = 0;
        this._playerSig = '';
    }

    destroy(rec) {
        if (!rec || !rec.root) return;
        const mis = this.view.meshInstancesOf(rec.root);
        try { World3D.removeObject(this.view, rec.root); } catch (e) { /* already gone with the view */ }
        this.purgeCasters(mis);
        rec.root = null;
        if (rec.blob) { this.destroy(rec.blob); rec.blob = null; }
    }

    /**
     * PlayCanvas keeps an INCREMENTAL layer.shadowCasters list: an instance removed from a
     * layer (or destroyed) can stay listed there, and the next shadow pass draws it and dies
     * on its released GPU resource. Drop our instances from those lists by hand — cheap
     * (a few layers) and it makes entity churn safe no matter what the engine forgets.
     * @param {any[]} mis mesh instances of the entity being destroyed
     */
    purgeCasters(mis) {
        if (!mis || !mis.length || !this.view) return;
        const layers = this.view.app.scene.layers.layerList;
        for (const mi of mis) {
            for (const layer of layers) {
                const set = layer.shadowCastersSet;
                if (set && set.has(mi)) {
                    set.delete(mi);
                    const list = layer.shadowCasters;
                    const i = list ? list.indexOf(mi) : -1;
                    if (i >= 0) list.splice(i, 1);
                }
            }
        }
    }

    // --- biome: ground, light, sky ------------------------------------------------------------
    /** Rebuild the terrain with this biome's noise and ground texture (async: the image loads). */
    buildTerrain(biome) {
        const loc = this.location;
        const cfg = biome.terrain;
        const groundPath = Location3D.GROUNDS[WB.M.clamp(biome.ground | 0, 0, Location3D.GROUNDS.length - 1)];
        return new Promise((resolve) => {
            const img = new Image();
            const done = (image) => {
                if (loc.terrain) loc.terrain.dispose();
                loc.terrain = new Terrain3D(loc.view, {
                    worldW: loc.width, worldH: loc.height,
                    groundImage: image || null,
                    noise: { amp: cfg.amp, scale: cfg.scale, seed: cfg.seed, base: 0 }
                });
                this.raiseMountainRing(loc.terrain, this.run.region);
                loc.placeObjects();
                this._terrainCfg = cfg;
                resolve(true);
            };
            img.onload = () => done(img);
            img.onerror = () => { console.warn('WanderView: текстура земли ' + groundPath + ' не загрузилась — биом без текстуры.'); done(null); };
            img.src = groundPath;
        });
    }

    /**
     * Bake the valley's mountain ring INTO the terrain mesh: the simulation blocks hulls with
     * region.wallAt() from d = WANDER_WALL_START·R, and the eye must see exactly that wall —
     * a ridge rising out of the grass — instead of an invisible fence with peaks floating
     * above flat ground. The grid nodes are lifted, then the two geometry builders run again
     * over the lifted field (their first output is disposed).
     */
    raiseMountainRing(terrain, region) {
        if (!terrain || !region || !terrain.hgrid) return;
        const cs = terrain.cell, nx = terrain.nx, ny = terrain.ny;
        let lifted = false;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const w = region.wallAt(i * cs, j * cs);
                if (w > 0.01) { terrain.hgrid[j * nx + i] += w; lifted = true; }
            }
        }
        if (!lifted) return;
        for (const n of terrain.entities) { try { n.destroy(); } catch (e) { /* already gone */ } }
        terrain.entities = [];
        for (const m of terrain.meshes) { try { m.destroy(); } catch (e) { /* already gone */ } }
        terrain.meshes = [];
        terrain._buildGeometry();
        terrain._buildOuterRing();
    }

    /** Sun, sky and fog of a biome: the kit's constants, overridden per region. */
    applyBiome(biome) {
        if (this._biomeId === biome.id || !this.view) return;
        this._biomeId = biome.id;
        const base = World3D.cfg();
        const cfg = Object.assign({}, base, biome.render || {});
        // view.opts wins over cfg inside applyLighting/fogState, so write the biome there too.
        this.view.opts = Object.assign({}, this.view.opts, { sky: cfg.sky, fogDensity: cfg.fog });
        this.view.applyLighting(cfg);
        // The engine's incremental shadow-caster bookkeeping is not survivable across the
        // entity churn of a roguelike (see syncCasters); the toon look carries the light, and
        // every hull drops a blob shadow of its own (buildCastle), which reads cleaner from
        // this camera anyway.
        if (this.view.sun) this.view.sun.castShadows = false;
        World3D.toon.push(this.view, cfg);
        for (const m of this.view.materials()) World3D.applyMaterialConstants(m, cfg);
    }

    // --- scenery: eight angular sectors, batched by kind --------------------------------------
    /**
     * All decoration of the region in 8 sectors × 4 kinds = 32 static entities. Batching keeps
     * the draw calls flat no matter how many trees a biome has, and the sector split lets the
     * frame drop whatever is behind the camera.
     */
    buildScenery() {
        const region = this.run.region, biome = region.biome;
        const SECTORS = 8;
        /** @type {any[][]} */
        const buckets = [];
        for (let i = 0; i < SECTORS * 4; i++) buckets.push([]);
        const kindIndex = { tree: 0, rock: 1, bush: 2, peak: 3 };
        for (const s of region.scenery) {
            const ki = kindIndex[s.kind];
            if (ki == null) continue;
            let a = Math.atan2(s.y - region.cy, s.x - region.cx);
            if (a < 0) a += Math.PI * 2;
            const sec = Math.min(SECTORS - 1, Math.floor(a / (Math.PI * 2) * SECTORS));
            for (const part of this.sceneryParts(s, biome)) buckets[sec * 4 + ki].push({ geo: part.geo, hex: part.hex, s });
        }
        for (let i = 0; i < buckets.length; i++) {
            const sec = Math.floor(i / 4), ki = i % 4;
            const byColor = new Map();
            for (const item of buckets[i]) {
                let list = byColor.get(item.hex);
                if (!list) byColor.set(item.hex, list = []);
                list.push(item);
            }
            for (const [hex, list] of byColor) {
                const positions = [];
                for (const item of list) {
                    const wx = -item.s.x, wz = item.s.y, wy = item.s.h;
                    const g = item.geo;
                    for (let k = 0; k < g.length; k += 3) positions.push(g[k] + wx, g[k + 1] + wy, g[k + 2] + wz);
                }
                const key = ['tree', 'rock', 'bush', 'peak'][ki] + '-s' + sec + '-' + (hex >>> 0) + '-' + positions.length;
                const node = this.makeEntity(key, [{ hex, geo: positions }], 'prop', { ink: false, castShadow: false });
                node.root.setPosition(0, 0, 0);
                node.sector = sec;
                node.always = ki === 3;      // the mountain ring is visible from everywhere
                this.scenery.push(node);
            }
        }
    }

    /**
     * Baked CC0 pack geometry (js/WanderPackGeo.js, Kenney Nature/Castle Kits) as recipe parts:
     * [{ key, hex, geo, opts }] — the same shape the procedural builders return, so a pack model
     * costs nothing extra (it merges into whatever batch or recipe uses it). tint/t mix the pack's
     * own material colors toward the game's palette; [] when the pack is absent — the procedural
     * builders below are the fallback, per the kit's "a missing asset never holes the scene".
     */
    packParts(kind, seed, height, tint, t, pal) {
        if (this.noPack || typeof WANDER_PACK_GEO === 'undefined') return [];
        const list = WANDER_PACK_GEO[kind];
        if (!list || !list.length) return [];
        const v = list[seed % list.length];
        const yaw = ((seed >> 3) & 7) * 0.7853981 + (seed & 3) * 0.21;
        const out = [];
        for (let pi = 0; pi < v.parts.length; pi++) {
            const part = v.parts[pi];
            // The pack's own palette is Kenney's saturated mint/terracotta; the valley is the
            // biome's. Mix per PART: foliage toward the biome's leaf, wood toward its trunk, so a
            // packed tree still reads as a tree of THIS region (and a tinted castle piece keeps
            // its stone/wood reading).
            let target = tint, k = t == null ? 0.6 : t;
            if (pal) {
                const g = (part.hex >> 8) & 255, r = (part.hex >> 16) & 255;
                target = g > r ? pal.green : pal.brown;
            }
            out.push({
                key: kind + pi,
                hex: target == null ? part.hex : WB.mixHex(part.hex, target, k),
                geo: WanderMesh.xform(part.pos, { s: height, yaw: yaw }),
                opts: { ink: false }
            });
        }
        return out;
    }

    /** One scenery item as a list of { geo, hex } parts, relative to its own base. */
    sceneryParts(s, biome) {
        const scale = s.s;
        if (s.kind === 'tree') {
            const shade = (s.seed & 3) === 0 ? WB.PAL.leafDark : biome.treeColor;
            const pack = this.packParts('tree', s.seed, 116 * scale, shade, 0.82, { green: shade, brown: WB.PAL.trunk });
            return pack.length ? pack : WanderMesh.tree(s.seed, shade, scale);
        }
        if (s.kind === 'rock') {
            const pack = this.packParts('rock', s.seed, 44 * scale, biome.rockColor, 0.9, { green: biome.rockColor, brown: biome.rockColor });
            return pack.length ? pack : WanderMesh.rock(s.seed, biome.rockColor, scale);
        }
        if (s.kind === 'bush') {
            const bshade = (s.seed & 1) ? WB.PAL.leafDark : biome.treeColor;
            const pack = this.packParts('bush', s.seed, 30 * scale, bshade, 0.8, { green: bshade, brown: WB.PAL.trunk });
            return pack.length ? pack : WanderMesh.bush(s.seed, bshade, scale);
        }
        const cap = biome.ground === 2 ? 0xf4f8fb : biome.ground === 1 ? 0xe8dcc6 : 0xeaf0f4;
        return WanderMesh.peak(s.seed, biome.rockColor, scale, cap);
    }

    sceneryColor(s, biome) {
        if (s.kind === 'tree') return biome.treeColor;
        if (s.kind === 'rock') return biome.rockColor;
        if (s.kind === 'peak') return WB.PAL.rockDark;
        return WB.PAL.leafDark;
    }

    // --- entity building -----------------------------------------------------------------------
    /**
     * Recipe -> entity tree. One child entity per recipe entry (so `spin` parts can rotate),
     * registered once for the whole tree.
     * @param {string} key cache key
     * @param {any[]} recipe [{ key, hex, geo, opts?, at?, spin?, barrier? }]
     * @param {string} kind 'actor' | 'prop'
     * @param {{ ink?: boolean, castShadow?: boolean, overlay?: boolean }} [o]
     */
    makeEntity(key, recipe, kind, o) {
        const opt = o || {};
        const root = new pc.Entity(key);
        this.view.root.addChild(root);
        const spinners = [];
        let barrier = null;
        for (const p of recipe) {
            const node = new pc.Entity(key + ':' + p.key);
            root.addChild(node);
            if (p.at) node.setPosition(p.at[0], p.at[1] || 0, p.at[2] || 0);
            node.addComponent('render', { layers: [pc.LAYERID_WORLD] });
            const mesh = WanderMesh.mesh(this.device, key + '|' + p.key + '|' + (p.hex >>> 0) + '|' + p.geo.length, p.geo);
            // castShadow must be decided BEFORE the instance touches a layer: the render
            // component files a casting instance into layer.shadowCasters on the way in, and
            // that list is incremental — a later `false` (or a destroy) does not clean it, and
            // a stale entry there kills the shadow pass (see armCasters/purgeCasters).
            const mi = new pc.MeshInstance(mesh, WanderMesh.material(this.device, p.hex, p.opts), node);
            mi.castShadow = false;
            mi.receiveShadow = true;
            node.render.meshInstances = [mi];
            if (p.spin) spinners.push({ node, spin: p.spin, angle: 0 });
            if (p.barrier) barrier = node;
        }
        World3D.addObject(this.view, root, kind || 'prop', {
            ink: opt.ink !== false, outline: false, castShadow: opt.castShadow !== false
        });
        // Shadows are switched on TWO FRAMES LATER (see armCasters): the engine renders the
        // shadow pass before the main pass, and a caster whose shader the main pass has not
        // compiled yet throws inside the shadow pass — and because the throw aborts the main
        // pass, the shader would never appear and every following frame would die the same
        // way. Two frames of delay give every instance one clean main pass first.
        const rec = {
            key, root, spinners, barrier, kind: kind || 'prop',
            wantCast: opt.castShadow !== false, castOn: false, castAt: this._frame + 2
        };
        if (opt.overlay) this.view.setLayer(root, World3D.LAYER.OVERLAY);
        return rec;
    }

    /**
     * Rebuild every layer.shadowCasters list from scratch, through the engine's own
     * add/removeShadowCasters, from the entities THIS view says may cast.
     *
     * Why so blunt: the list is incremental and outlives its instances — a destroyed entity
     * (or one re-filed between layers) leaves a caster whose GPU buffers are already released,
     * and the shadow pass dies inside draw() on `indexBuffer.impl`. Measured, not guessed:
     * verify/probe2.mjs dumps the list. Rebuilding each frame costs one pass over ~30 casting
     * entities and makes entity churn (villages eaten, wrecks, regions) unbreakable.
     */
    syncCasters() {
        const layers = this.view.app.scene.layers.layerList;
        const want = [];
        if (this._shadowsOn) {
            for (const rec of this.recs.values()) {
                if (!rec.castOn || !rec.root || !rec.root.enabled) continue;
                for (const mi of this.view.meshInstancesOf(rec.root)) want.push(mi);
            }
        }
        for (const layer of layers) {
            const sc = layer.shadowCasters;
            if (sc && sc.length) layer.removeShadowCasters(sc.slice());
            if (!want.length) continue;
            const inLayer = layer.meshInstancesSet || new Set(layer.meshInstances || []);
            const add = [];
            for (const mi of want) if (inLayer.has(mi)) add.push(mi);
            if (add.length) layer.addShadowCasters(add);
        }
    }

    /** Switch shadows on for entities that already survived a main pass (see makeEntity). */
    armCasters() {
        for (const rec of this.recs.values()) {
            if (!rec.wantCast || rec.castOn || !rec.root || this._frame < rec.castAt) continue;
            for (const mi of this.view.meshInstancesOf(rec.root)) mi.castShadow = true;
            rec.castOn = true;
        }
        for (const list of this.shotPool.values()) {
            for (const rec of list) {
                if (rec.wantCast || rec.castOn || !rec.root || this._frame < rec.castAt) continue;
                void 0;   // projectiles never cast: too small, too many
            }
        }
    }

    /** A cached recipe for a prop of the world (a house of a given seed, a knight, …). */
    staticRecipe(name, build) {
        if (!this._static) this._static = new Map();
        let r = this._static.get(name);
        if (!r) { r = build(); this._static.set(name, r); }
        return r;
    }

    // --- per-entity builders -------------------------------------------------------------------
    buildFor(e) {
        switch (e.type) {
            case 'castle': return this.buildCastle(e);
            case 'village': return this.buildVillage(e);
            case 'node': return this.buildNode(e);
            case 'herd': return this.buildHerd(e);
            case 'knight': return this.buildSimple(e, 'knight', () => WanderMesh.knight(e.id * 31 + 7), 'actor');
            case 'peasant': return this.buildSimple(e, 'peasant', () => WanderMesh.peasant(e.id * 17 + 3), 'prop', false);
            case 'sheep': return this.buildSimple(e, 'sheep', () => WanderMesh.sheep(e.id * 13 + 5), 'prop', false);
            case 'wagon': return this.buildSimple(e, 'wagon', () => WanderMesh.wagon(), 'actor');
            case 'wasp': return this.buildSimple(e, 'wasp', () => WanderMesh.wasp(), 'actor', false);
            case 'chunk': return this.buildChunk(e);
            case 'gate': return this.buildGate(e);
            default: return null;
        }
    }

    /** A castle: hull + wheels on their own nodes + one yaw node per module. */
    buildCastle(c) {
        const layout = WanderMesh.castleParts(c);
        const recipe = layout.parts.slice();
        for (const w of WanderMesh.castleWheels(layout, c.faction)) recipe.push(w);
        // CC0 Castle Kit on the hull: a keep tower from tier 2, curtain walls around the deck and
        // a faction banner over it — all baked into the hull's own recipe, so they ride, tilt and
        // die with the castle and cost no setup of their own. No pack — the procedural hull stays.
        const stone = c.faction === 'player' ? WB.PAL.stone : WB.PAL.enemyIron;
        if (c.tier >= 2) {
            const keep = this.packParts('tower', (c.id || 1) * 3 + c.tier, 44 + c.tier * 12, stone, 0.55);
            for (let i = 0; i < keep.length; i++) {
                recipe.push({ key: 'keep' + i, hex: keep[i].hex, opts: keep[i].opts, geo: WanderMesh.translate(keep[i].geo, 0, layout.deckY, 0), at: null });
            }
        }
        for (let side = 0; side < 4; side++) {
            const a = side * Math.PI / 2;
            const wall = this.packParts('wall', (c.id || 1) + side, 16 + c.tier * 4, stone, 0.5);
            for (let i = 0; i < wall.length; i++) {
                const g = WanderMesh.xform(wall[i].geo, { yaw: a, dx: Math.cos(a) * layout.r * 0.86, dz: Math.sin(a) * layout.r * 0.86, dy: layout.deckY * 0.4 });
                recipe.push({ key: 'wall' + side + ':' + i, hex: wall[i].hex, opts: wall[i].opts, geo: g, at: null });
            }
        }
        const flagHex = c.faction === 'player' ? WB.PAL.banner : (c.boss ? WB.PAL.enemyDark : WB.PAL.enemy);
        const flag = this.packParts('flag', (c.id || 1) + (c.faction === 'player' ? 3 : 7), 44 + c.tier * 5, flagHex, 0.8);
        for (let i = 0; i < flag.length; i++) {
            recipe.push({ key: 'flag' + i, hex: flag[i].hex, opts: flag[i].opts, geo: WanderMesh.translate(flag[i].geo, 0, layout.deckY + (c.tier >= 2 ? 44 + c.tier * 12 : layout.wallH), 0), at: null });
        }
        const rec = this.makeEntity('castle-' + c.faction + '-' + c.kind + '-t' + c.tier, recipe, 'actor', { ink: true });
        rec.castle = c;
        rec.layout = layout;
        rec.body = rec.root;
        rec.mounts = [];
        // The blob shadow: its own entity (it must not tilt with the hull).
        rec.blob = this.makeEntity('blob', [{
            key: 'b', hex: 0x0b141a, geo: WanderMesh.blob(layout.hullL * 0.62), opts: { alpha: 0.34 }
        }], 'prop', { ink: false, castShadow: false });
        this.attachModules(rec, c);
        if (c.faction === 'enemy' || c.boss) this.attachBar(rec, c);
        return rec;
    }

    /** Rebuild the module turrets after a draft (the module list changed). */
    attachModules(rec, c) {
        for (const m of rec.mounts) if (m.node) m.node.destroy();
        rec.mounts = [];
        const layout = rec.layout;
        const n = Math.max(1, c.modules.length);
        for (let i = 0; i < c.modules.length; i++) {
            const inst = c.modules[i];
            const mod = inst.mod;
            if (!mod) continue;
            const slotAngle = WB.SLOT_ANGLE(i, n);
            const rr = layout.r * 0.9;
            // The mount stands on the deck at its slot angle; the yaw node aims the gun.
            const hold = new pc.Entity('mount' + i);
            rec.body.addChild(hold);
            const mapA = c.heading + slotAngle;   // replaced every frame; only the offset matters
            hold.setPosition(-Math.cos(slotAngle) * rr, layout.deckY + layout.wallH * 0.34, Math.sin(slotAngle) * rr);
            const yaw = new pc.Entity('turret' + i);
            hold.addChild(yaw);
            const recipe = WanderMesh.moduleParts(mod.id, inst.level, c.faction);
            for (const p of recipe) {
                const node = new pc.Entity('m:' + p.key);
                yaw.addChild(node);
                node.addComponent('render', { layers: [pc.LAYERID_WORLD] });
                const mesh = WanderMesh.mesh(this.device, 'mod|' + mod.id + '|' + inst.level + '|' + p.key + '|' + (p.hex >>> 0) + '|' + p.geo.length, p.geo);
                node.render.meshInstances = [new pc.MeshInstance(mesh, WanderMesh.material(this.device, p.hex, p.opts), node)];
            }
            World3D.addObject(this.view, yaw, 'actor', { ink: false, outline: false });
            rec.mounts.push({ node: yaw, hold, inst, slotAngle, aim: mapA });
            void mod;
        }
    }

    /** A health bar over an enemy hull: two overlay quads (background + fill). */
    attachBar(rec, c) {
        const w = Math.round(c.r * 2.1);
        const bg = this.makeEntity('bar-bg-' + w, [{ key: 'bg', hex: 0x14100e, geo: WanderMesh.quad(w, 7) }], 'prop',
            { ink: false, castShadow: false, overlay: true });
        const fill = this.makeEntity('bar-fill-' + w, [{ key: 'fill', hex: c.boss ? 0xd8402f : 0xd8b23a, geo: WanderMesh.quad(w, 5) }], 'prop',
            { ink: false, castShadow: false, overlay: true });
        const mark = () => {
            for (const r of [bg, fill]) for (const mi of this.view.meshInstancesOf(r.root)) {
                const m = /** @type {any} */ (mi.material);
                m.depthTest = false; m.depthWrite = false; m.blendType = pc.BLEND_NORMAL;
                m.opacity = 0.92; m.update();
            }
        };
        mark();
        rec.bar = { bg: bg.root, fill: fill.root, w, node: fill };
        this.bars.push(rec);
    }

    buildVillage(v) {
        const recipe = [];
        for (let i = 0; i < v.parts.length; i++) {
            const p = v.parts[i];
            const name = p.kind === 'chapel' ? 'chapel' : 'house' + (p.seed % 6);
            const parts = this.staticRecipe(name + ':' + (p.seed % 97), () =>
                p.kind === 'chapel' ? WanderMesh.chapel(1.05) : WanderMesh.house(p.seed, p.s));
            for (const q of parts) {
                recipe.push({
                    key: name + ':' + q.key + ':' + i, hex: q.hex, opts: q.opts,
                    geo: WanderMesh.translate(q.geo, -p.dx, 0, p.dy),
                    at: null
                });
            }
        }
        // CC0 hamlet dressing (Kenney Nature Kit): two tents, a fence, a campfire and a log pile
        // among the cottages — baked geometry, merged into the village's own draw calls.
        const dress = [['tent', 40, WB.PAL.thatch, 0.85], ['tent', 33, WB.PAL.thatch, 0.85],
            ['fence', 14, WB.PAL.wood, 0.8], ['campfire', 13, null, 0], ['log', 16, WB.PAL.wood, 0.7]];
        for (let i = 0; i < dress.length; i++) {
            const kind = dress[i][0], h = dress[i][1], tint = dress[i][2], t = dress[i][3];
            const vseed = v.seed || v.id || 1;
            const ang = (i / dress.length) * Math.PI * 2 + (vseed % 7) * 0.4;
            const rr = 52 + (i % 3) * 16;
            for (const p of this.packParts(kind, vseed + i * 3 + 1, h, tint, t)) {
                recipe.push({
                    key: 'pack' + kind + i + ':' + recipe.length, hex: p.hex, opts: p.opts,
                    geo: WanderMesh.translate(p.geo, Math.cos(ang) * rr, 0, Math.sin(ang) * rr), at: null
                });
            }
        }
        // Merge same-key parts so a village is a handful of draw calls, not one per house.
        const merged = new Map();
        for (const p of recipe) {
            const k = p.key.replace(/:\d+$/, '') + '|' + p.hex;
            let g = merged.get(k);
            if (!g) merged.set(k, g = { key: p.key.replace(/:\d+$/, ''), hex: p.hex, geo: [], opts: p.opts });
            for (let i = 0; i < p.geo.length; i++) g.geo.push(p.geo[i]);
        }
        const rec = this.makeEntity('village', [...merged.values()], 'prop', { ink: false });
        rec.village = v;
        this.attachBar(rec, { r: 46, boss: false });
        return rec;
    }

    buildNode(n) {
        const parts = this.staticRecipe('node:' + n.kind, () => WanderMesh.node(n.kind, 3));
        const rec = this.makeEntity('node-' + n.kind, parts, 'prop', { ink: false });
        this.attachBar(rec, { r: 34, boss: false });
        return rec;
    }

    buildHerd(h) {
        // The herd itself is invisible: its sheep are separate entities. A tiny marker keeps
        // the minimap and the culling honest.
        const rec = this.makeEntity('herd', [{ key: 'm', hex: WB.PAL.wool, geo: WanderMesh.box(1, 1, 1, 0, -50, 0) }], 'prop', { ink: false, castShadow: false });
        rec.hiddenAlways = true;
        return rec;
    }

    buildChunk(e) {
        const rec = this.makeEntity('chunk', [{ key: 'c', hex: e.color == null ? WB.PAL.wood : e.color, geo: WanderMesh.chunk().geo }], 'prop',
            { ink: false, castShadow: false });
        this.chunks.push(rec);
        return rec;
    }

    buildGate(g) {
        const parts = this.staticRecipe('gate', () => WanderMesh.gate());
        // The warden's gate is ARCHITECTURE: a Kenney Castle Kit gatehouse between two towers with
        // curtain walls, and two derelict catapults in the courtyard — baked geo merged into the
        // gate's own draw calls. The procedural doors inside still open (rec.barrier).
        const pack = this.staticRecipe('gate-pack', () => {
            const out = [];
            const put = (kind, seed, h, dx, dz, yaw) => {
                for (const p of this.packParts(kind, seed, h, null, 0)) {
                    out.push({ key: kind + out.length, hex: p.hex, opts: p.opts, geo: WanderMesh.xform(p.geo, { yaw: yaw, dx: dx, dz: dz }) });
                }
            };
            put('gate', 7, 150, 0, 0, 0);
            put('tower', 7, 150, -96, 0, 0);
            put('tower', 8, 150, 96, 0, 0);
            put('wall', 7, 80, 0, -70, Math.PI / 2);
            put('wall', 8, 80, 0, 70, Math.PI / 2);
            put('catapult', 7, 58, 165, 120, 0.7);
            put('catapult', 8, 58, -150, 140, -0.5);
            return out;
        });
        const rec = this.makeEntity('gate', [...parts, ...pack], 'actor', { ink: true });
        rec.gate = g;
        return rec;
    }

    buildSimple(e, name, build, kind, ink) {
        const parts = this.staticRecipe(name, build);
        const rec = this.makeEntity(name, parts, kind || 'prop', { ink: ink !== false, castShadow: kind === 'actor' });
        if (e.type === 'knight') this.attachBar(rec, { r: 16, boss: false });
        return rec;
    }

    // --- the frame -----------------------------------------------------------------------------
    /**
     * Draw one frame of the run.
     * @param {number} dt seconds
     * @param {any[]} events the events the simulation emitted this frame
     */
    update(dt, events) {
        if (!this.run) return;
        this._frame++;
        // The shadow pass of the engine is off for good (see applyBiome): applyLighting flips
        // castShadows back on whenever anything re-applies the render constants, so insist.
        if (this.view.sun && this.view.sun.castShadows) this.view.sun.castShadows = false;
        const run = this.run, region = run.region;
        const cam = this.camera.target;
        const viewR = WB.num('VIEW_RADIUS', 1500);
        const viewR2 = viewR * viewR;

        // --- entities: create, place, cull, destroy
        const seen = new Set();
        for (const e of region.entities) {
            seen.add(e.id);
            let rec = this.recs.get(e.id);
            if (!rec) {
                rec = this.buildFor(e);
                if (!rec) continue;
                rec.ent = e;
                this.recs.set(e.id, rec);
            }
            this.placeEntity(rec, e, cam, viewR2);
        }
        for (const [id, rec] of this.recs) {
            if (seen.has(id)) continue;
            this.destroy(rec);
            if (rec.bar) this.dropBar(rec);
            const ci = this.chunks.indexOf(rec);
            if (ci >= 0) this.chunks.splice(ci, 1);
            this.recs.delete(id);
        }

        // --- the player's castle: rebuild when the loadout or the tier changed
        const p = run.player;
        const sig = p ? (p.tier + '|' + p.modules.map(m => m.mod.id + m.level).join(',') + '|' + (p.chassis ? p.chassis.id : '')) : '';
        if (sig !== this._playerSig) {
            const old = this.recs.get(p.id);
            // Only tear the hull down once the new signature is real: on the very first frame
            // the castle has just been built, and a rebuild would flash.
            if (this._playerSig && old) {
                this.destroy(old);
                if (old.bar) this.dropBar(old);
                this.recs.delete(p.id);
            }
            this._playerSig = sig;
        }

        this.updateProjectiles(dt, cam, viewR2);
        this.updateParticles(dt);
        this.updateBars(dt, cam);
        this.updateBeams(dt);
        this.updateTelegraph(dt);
        this.updateSceneryCulling(cam, viewR);
        this.armCasters();
        this.updateMinimap();
        this.updateTexts(dt);
        this.updateVeil(dt);
        if (events) this.onEvents(events);
    }

    placeEntity(rec, e, cam, viewR2) {
        const root = rec.root;
        if (!root) return;
        const dx = e.x - cam.x, dy = e.y - cam.y;
        const far = dx * dx + dy * dy > viewR2;
        if (rec.hiddenAlways || far) { if (root.enabled) root.enabled = false; return; }
        if (!root.enabled) root.enabled = true;
        const ground = this.height(e.x, e.y);
        if (e.type === 'castle') this.placeCastle(rec, e, ground);
        else if (e.type === 'chunk') {
            root.setPosition(-e.x, ground + (e.h || 6), e.y);
            root.setLocalEulerAngles(0, (e.life || 0) * 220, 0);
            const s = WB.M.clamp((e.life || 1) / 3, 0.35, 1);
            root.setLocalScale(s, s, s);
        } else if (e.type === 'peasant' || e.type === 'sheep') {
            root.setRotation(World3D.rotQuat(0, -(e.heading || 0), 0));
            // a little hop while they run
            const hop = (e.panic || 0) > 0.1 ? Math.abs(Math.sin(this._frame * 0.35 + e.id)) * 3.4 : 0;
            root.setPosition(-e.x, ground + hop, e.y);
        } else if (e.type === 'knight' || e.type === 'wagon') {
            root.setPosition(-e.x, ground, e.y);
            root.setRotation(World3D.rotQuat(0, -(e.heading || 0), 0));
            for (const s of rec.spinners) { s.angle -= (e.speed || 120) * 0.0016; s.node.setLocalEulerAngles(0, 0, s.angle * 57.2958); }
        } else if (e.type === 'wasp') {
            root.setPosition(-e.x, ground + (e.h || 34), e.y);
            root.setRotation(World3D.rotQuat(0, -(e.heading || 0), 0));
        } else if (e.type === 'village' || e.type === 'node') {
            root.setPosition(-e.x, ground, e.y);
            root.setRotation(World3D.rotQuat(0, -(e.heading || 0), 0));
            // a village being eaten shakes and sinks
            const f = e.maxHp > 0 ? WB.M.clamp(e.hp / e.maxHp, 0, 1) : 1;
            if (f < 0.995) {
                const s = 0.55 + f * 0.45;
                root.setLocalScale(s, s, s);
                root.setPosition(-e.x + Math.sin(this._frame * 1.7 + e.id) * 1.6, ground, e.y);
            }
        } else if (e.type === 'gate') {
            root.setPosition(-e.x, ground, e.y);
            root.setRotation(World3D.rotQuat(0, -(e.heading || 0), 0));
            if (rec.barrier) {
                const open = e.open ? 1 : 0;
                rec._open = WB.M.damp(rec._open || 0, open, 3, 1 / 60);
                rec.barrier.setLocalPosition(0, 74 * (rec._open || 0), 0);
                rec.barrier.setLocalScale(1, Math.max(0.02, 1 - (rec._open || 0)), 1);
            }
        } else {
            root.setPosition(-e.x, ground + (e.h || 0), e.y);
        }
    }

    /** A castle: position, heading, terrain tilt, spinning wheels, aiming turrets, steam. */
    placeCastle(rec, c, ground) {
        const root = rec.root;
        if (rec.blob && rec.blob.root) {
            rec.blob.root.setPosition(-c.x, ground + 2.5, c.y);
            const near = (c.x - this.camera.target.x) ** 2 + (c.y - this.camera.target.y) ** 2 < 1500 * 1500;
            if (rec.blob.root.enabled !== near) rec.blob.root.enabled = near;
        }
        const ride = rec.layout.wheelR * 0.96 + WB.M.clamp(Math.abs(c.pitch || 0) * rec.layout.hullL * 0.2, 0, 14);
        root.setPosition(-c.x, ground + ride, c.y);
        root.setRotation(World3D.rotQuat(0, -(c.heading || 0), 0));
        // The hull tilts with the ground: pitch about the map's lateral axis, roll about the nose.
        rec.body.setLocalEulerAngles(WB.M.clamp(-(c.roll || 0), -0.4, 0.4) * 57.2958, 0, WB.M.clamp(c.pitch || 0, -0.4, 0.4) * 57.2958);
        // Wheels roll with the distance travelled.
        const spin = (c.wheelSpin || 0) * 57.2958;
        for (const s of rec.spinners) s.node.setLocalEulerAngles(0, 0, -spin);
        // Turrets aim.
        for (const m of rec.mounts) {
            const aim = m.inst.aim || 0;
            // The yaw node lives in the hull's local space: subtract the hull's heading, negate
            // for the mirrored world (map heading -> −rotation about y).
            const local = -(WB.M.angleDelta(c.heading || 0, aim)) * 57.2958;
            m.node.setLocalEulerAngles(0, local, 0);
        }
        // A hit flashes: a tiny scale punch (materials are shared, so no per-entity tint).
        if (c.hitFlash > 0.02) {
            const k = 1 + c.hitFlash * 0.02;
            rec.body.setLocalScale(k, 1 / k, k);
        } else if (rec.body.getLocalScale().y !== 1) rec.body.setLocalScale(1, 1, 1);
    }

    height(x, y) {
        const t = this.location.terrain;
        return t ? t.heightAt(x, y) : 0;
    }

    // --- projectiles, particles, beams -----------------------------------------------------------
    updateProjectiles(dt, cam, viewR2) {
        const run = this.run;
        for (const p of run.projectiles) {
            const kind = p.shot || 'ball';
            let rec = p._view;
            if (!rec) {
                rec = this.takeShot(kind);
                p._view = rec;
            }
            rec.busy = true;
            const dx = p.x - cam.x, dy = p.y - cam.y;
            const vis = dx * dx + dy * dy <= viewR2;
            if (rec.root.enabled !== vis) rec.root.enabled = vis;
            if (!vis) continue;
            const ground = this.height(p.x, p.y);
            rec.root.setPosition(-p.x, ground + (p.h || 14), p.y);
            const a = Math.atan2(p.vy, p.vx);
            rec.root.setRotation(World3D.rotQuat(0, -a, 0));
            if (kind === 'flame') {
                const k = 0.6 + (1 - WB.M.clamp(p.life / Math.max(0.01, p.maxLife), 0, 1)) * 1.5;
                rec.root.setLocalScale(k, k, k);
            }
            // A cannonball leaves a puff now and then.
            if ((kind === 'ball' || kind === 'shell') && this._frame % 4 === 0) {
                this.spawnParticle(p.x, p.y, ground + (p.h || 14), WB.PAL.smoke, 0.4, 9);
            }
            void dt;
        }
        // Anything that landed goes back to its pool.
        for (const [kind, list] of this.shotPool) {
            for (const rec of list) {
                if (rec.busy) { rec.busy = false; continue; }
                if (rec.root.enabled) rec.root.enabled = false;
                rec.free = true;
            }
            void kind;
        }
    }

    takeShot(kind) {
        let list = this.shotPool.get(kind);
        if (!list) this.shotPool.set(kind, list = []);
        for (const rec of list) if (rec.free) { rec.free = false; return rec; }
        const spec = WanderMesh.shot(kind);
        const rec = this.makeEntity('shot-' + kind, [spec], 'actor', { ink: false, castShadow: false });
        rec.free = false;
        rec.kind = kind;
        list.push(rec);
        return rec;
    }

    /** A debris/smoke particle: pooled cube with a life, a velocity and a growing scale. */
    spawnParticle(x, y, h, hex, life, size, vx, vy, vh) {
        let rec = null;
        for (const p of this.particles) if (p.life <= 0) { rec = p; break; }
        if (!rec) {
            if (this.particles.length >= WB.num('PARTICLE_MAX', 240)) return null;
            rec = this.makeEntity('puff', [WanderMesh.puff()], 'prop', { ink: false, castShadow: false });
            this.particles.push(rec);
        }
        rec.x = x; rec.y = y; rec.h = h;
        rec.vx = vx || 0; rec.vy = vy || 0; rec.vh = vh == null ? 34 : vh;
        rec.life = rec.max = life || 0.6;
        rec.hex = hex == null ? WB.PAL.smoke : hex;
        rec.size = size || 10;
        this.tintParticle(rec);
        rec.root.enabled = true;
        return rec;
    }

    tintParticle(rec) {
        // Particles share one material per color: keep a small set and pick the nearest cached one.
        const hex = rec.hex;
        for (const mi of this.view.meshInstancesOf(rec.root)) {
            const want = WanderMesh.material(this.device, hex);
            if (mi.material !== want) mi.material = want;
        }
    }

    updateParticles(dt) {
        const cam = this.camera.target;
        const viewR2 = 1400 * 1400;
        for (const p of this.particles) {
            if (p.life <= 0) { if (p.root.enabled) p.root.enabled = false; continue; }
            p.life -= dt;
            p.x += p.vx * dt; p.y += p.vy * dt; p.h += p.vh * dt;
            p.vh -= 62 * dt;
            p.vx *= Math.exp(-1.6 * dt); p.vy *= Math.exp(-1.6 * dt);
            const ground = this.height(p.x, p.y);
            if (p.h < ground + 3) { p.h = ground + 3; p.vh = Math.abs(p.vh) * 0.2; }
            const dx = p.x - cam.x, dy = p.y - cam.y;
            const vis = p.life > 0 && dx * dx + dy * dy < viewR2;
            if (p.root.enabled !== vis) p.root.enabled = vis;
            if (!vis) continue;
            const t = 1 - WB.M.clamp(p.life / p.max, 0, 1);
            const s = (p.size / 10) * (0.6 + t * 1.5);
            p.root.setPosition(-p.x, p.h, p.y);
            p.root.setLocalScale(s, s, s);
            p.root.setLocalEulerAngles(0, t * 160, 0);
        }
    }

    /** A tesla beam: a stretched quad between two points, fading out. */
    addBeam(b) {
        const len = Math.max(20, WB.M.dist(b.x1, b.y1, b.x2, b.y2));
        const rec = this.makeEntity('beam', [{ key: 'b', hex: WB.PAL.arcane, geo: WanderMesh.box(len, 3.4, 3.4, -len / 2, 0, 0), opts: { glow: 1, glowColor: WB.PAL.arcane } }],
            'actor', { ink: false, castShadow: false, overlay: true });
        for (const mi of this.view.meshInstancesOf(rec.root)) {
            const m = /** @type {any} */ (mi.material);
            m.depthTest = false; m.depthWrite = false; m.blendType = pc.BLEND_ADDITIVE; m.opacity = 0.95; m.update();
        }
        const h1 = this.height(b.x1, b.y1) + 40, h2 = this.height(b.x2, b.y2) + 30;
        rec.root.setPosition(-b.x1, h1, b.y1);
        const a = Math.atan2(b.y2 - b.y1, b.x2 - b.x1);
        const pitch = Math.atan2(h2 - h1, len);
        rec.root.setRotation(World3D.rotQuat(pitch, -a, 0));
        rec.life = b.life || 0.16; rec.max = rec.life;
        this.beams.push(rec);
        return rec;
    }

    updateBeams(dt) {
        for (let i = this.beams.length - 1; i >= 0; i--) {
            const b = this.beams[i];
            b.life -= dt;
            if (b.life <= 0) { this.destroy(b); this.beams.splice(i, 1); continue; }
            const k = WB.M.clamp(b.life / b.max, 0, 1);
            b.root.setLocalScale(1, 0.4 + k * 1.2, 0.4 + k * 1.2);
        }
    }

    /** The warden's charge warning: a red strip on the ground along the charge direction. */
    showTelegraph(x, y, dir, time) {
        if (!this.telegraph) {
            this.telegraph = this.makeEntity('telegraph', [{ key: 't', hex: 0xd8402f, geo: WanderMesh.quad(900, 46) }], 'prop',
                { ink: false, castShadow: false, overlay: true });
            for (const mi of this.view.meshInstancesOf(this.telegraph.root)) {
                const m = /** @type {any} */ (mi.material);
                m.depthTest = false; m.depthWrite = false; m.blendType = pc.BLEND_ADDITIVE; m.opacity = 0.5; m.update();
            }
        }
        const t = this.telegraph;
        t.root.enabled = true;
        t.life = time; t.max = time;
        t.x = x; t.y = y; t.dir = dir;
    }

    updateTelegraph(dt) {
        const t = this.telegraph;
        if (!t) return;
        if (t.life == null) { if (t.root.enabled) t.root.enabled = false; return; }
        t.life -= dt;
        if (t.life <= 0) { t.root.enabled = false; t.life = null; return; }
        const k = 1 - WB.M.clamp(t.life / t.max, 0, 1);
        const len = 260 + k * 620;
        const mx = t.x - Math.cos(t.dir) * 40, my = t.y - Math.sin(t.dir) * 40;
        t.root.setPosition(-mx - Math.cos(t.dir) * len / 2, this.height(mx, my) + 3, my - Math.sin(t.dir) * len / 2);
        t.root.setRotation(World3D.rotQuat(0, -t.dir, 0));
        t.root.setLocalScale(len / 900, 1, 0.6 + Math.sin(this._frame * 0.5) * 0.3);
    }

    // --- health bars ------------------------------------------------------------------------------
    dropBar(rec) {
        if (!rec.bar) return;
        for (const r of [rec.bar.bg, rec.bar.fill]) {
            if (r) { try { World3D.removeObject(this.view, r); } catch (e) { /* gone */ } }
        }
        const i = this.bars.indexOf(rec);
        if (i >= 0) this.bars.splice(i, 1);
        rec.bar = null;
    }

    updateBars(dt, cam) {
        void dt;
        const pitch = this.camera.pitch || 1.05;   // radians (CameraController keeps it so)
        for (const rec of this.bars) {
            if (!rec.bar || !rec.root) continue;
            const e = rec.ent || rec.castle;
            if (!e || e.dead) continue;
            const d2 = (e.x - cam.x) * (e.x - cam.x) + (e.y - cam.y) * (e.y - cam.y);
            const vis = d2 < 1200 * 1200 && (e.hp == null || e.hp < e.maxHp || e.type === 'castle');
            const show = vis && (e.type !== 'castle' ? (e.hp < e.maxHp) : true);
            if (rec.bar.bg.enabled !== show) { rec.bar.bg.enabled = show; rec.bar.fill.enabled = show; }
            if (!show) continue;
            const h = this.height(e.x, e.y) + (e.type === 'castle' ? e.r * 1.9 + 46 : 54);
            const x = -e.x, z = e.y;
            rec.bar.bg.setPosition(x, h, z);
            rec.bar.fill.setPosition(x, h, z);
            // Face the camera: a fixed pitch tilt is enough for a bar (no per-frame billboard).
            const q = World3D.rotQuat(-(Math.PI / 2 - pitch), 0, 0);
            rec.bar.bg.setRotation(q);
            rec.bar.fill.setRotation(q);
            const f = e.maxHp > 0 ? WB.M.clamp(e.hp / e.maxHp, 0, 1) : 0;
            rec.bar.fill.setLocalScale(Math.max(0.001, f), 1, 1);
            rec.bar.fill.setLocalPosition(-(rec.bar.w * (1 - f)) / 2, 0, 0);
        }
    }

    // --- scenery culling ----------------------------------------------------------------------------
    /**
     * The valley (r = WANDER_REGION_R) is narrower than the view radius, so from anywhere inside
     * it the whole ring of mountains and most of the scenery is on screen: the sector split
     * exists for the draw-call budget, not for culling. Everything stays enabled.
     */
    updateSceneryCulling(cam, viewR) {
        void cam; void viewR;
    }

    // --- the minimap --------------------------------------------------------------------------------
    /** Build the minimap canvas inside the HUD panel that UILayout reserves for it. */
    initMinimap() {
        const panel = UI.get('minimap');
        if (!panel || this.minimap) return null;
        const c = document.createElement('canvas');
        const size = WB.num('MINIMAP_SIZE', 168);
        c.width = size * 2; c.height = size * 2;
        Object.assign(c.style, { position: 'absolute', left: '0px', top: '0px', width: size + 'px', height: size + 'px', pointerEvents: 'none' });
        panel.el.appendChild(c);
        this.minimap = { canvas: c, ctx: c.getContext('2d'), size };
        return this.minimap;
    }

    updateMinimap() {
        const mm = this.minimap || this.initMinimap();
        if (!mm || !this.run) return;
        if ((this._frame & 1) !== 0) return;      // every other frame is plenty for 168 px
        const ctx = mm.ctx, S = mm.canvas.width, R = this.run.region.regionR;
        const k = (S / 2 - 6) / R;
        const biome = this.run.region.biome;
        ctx.clearRect(0, 0, S, S);
        // the valley
        ctx.beginPath(); ctx.arc(S / 2, S / 2, R * k, 0, Math.PI * 2);
        ctx.fillStyle = biome.ground === 2 ? '#c9d6df' : biome.ground === 1 ? '#a08a63' : '#4d7a44';
        ctx.fill();
        ctx.lineWidth = 5; ctx.strokeStyle = '#2a241d'; ctx.stroke();
        const R0 = this.run.region;
        const px = (x) => S / 2 + (x - R0.cx) * k, py = (y) => S / 2 + (y - R0.cy) * k;
        // entities
        for (const e of this.run.region.entities) {
            if (e.dead) continue;
            let col = null, r = 3;
            if (e.type === 'village') { col = '#e8d9a8'; r = 5; }
            else if (e.type === 'node') { col = '#b08a52'; r = 5; }
            else if (e.type === 'herd') { col = '#f0ece0'; r = 3; }
            else if (e.type === 'knight') { col = '#8fa2b8'; r = 3; }
            else if (e.type === 'castle') { col = e.faction === 'player' ? '#6fb3e8' : e.boss ? '#ff5a3c' : '#e0503c'; r = e.boss ? 9 : 6; }
            else if (e.type === 'gate') { col = e.open ? '#7ce88a' : '#e0503c'; r = 8; }
            if (!col) continue;
            ctx.beginPath(); ctx.arc(px(e.x), py(e.y), r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
        }
        // the camera's view cone and the player's heading
        const p = this.run.player;
        if (p) {
            ctx.save();
            ctx.translate(px(p.x), py(p.y));
            ctx.rotate(-(p.heading || 0) + Math.PI / 2);
            ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(-8, 8); ctx.lineTo(8, 8); ctx.closePath();
            ctx.fillStyle = '#ffffff'; ctx.fill();
            ctx.restore();
        }
    }

    // --- floating numbers ----------------------------------------------------------------------------
    /** A DOM number over a map point. The kit's UI owns the HUD chrome; these are world-anchored
     *  damage/mass popups, positioned through View3D.projectToScreen, and they live in a pool. */
    addText(x, y, text, color, size) {
        const root = UI.root;
        if (!root) return;
        let t = null;
        for (const c of this.texts) if (c.life <= 0) { t = c; break; }
        if (!t) {
            if (this.texts.length >= WB.num('FLOAT_TEXT_MAX', 14)) return;
            const el = document.createElement('div');
            el.className = 'wb-float';
            Object.assign(el.style, {
                position: 'absolute', left: '0px', top: '0px', pointerEvents: 'none',
                font: '700 15px ' + UI.FONT, color: color || '#ffffff', whiteSpace: 'pre',
                textShadow: '0 1px 2px #14100e, 0 0 6px #14100e', transform: 'translate(-50%, -50%)', willChange: 'transform, opacity'
            });
            root.appendChild(el);
            t = { el, life: 0 };
            this.texts.push(t);
        }
        t.el.textContent = text;
        t.el.style.color = color || '#ffffff';
        t.el.style.fontSize = (size || 15) + 'px';
        t.el.style.display = 'block';
        t.x = x; t.y = y; t.life = t.max = 1.05; t.rise = 0;
    }

    updateTexts(dt) {
        const view = this.view;
        for (const t of this.texts) {
            if (t.life <= 0) { if (t.el.style.display !== 'none') t.el.style.display = 'none'; continue; }
            t.life -= dt;
            t.rise += dt * 46;
            const s = view.projectToScreen(t.x, t.y, this.height(t.x, t.y) + 40 + t.rise);
            if (!s || !s.visible || s.behind) { t.el.style.display = 'none'; continue; }
            const scale = UI.scale();
            t.el.style.display = 'block';
            t.el.style.transform = 'translate(-50%, -50%) translate(' + (s.x / scale) + 'px, ' + (s.y / scale) + 'px)';
            t.el.style.opacity = String(WB.M.clamp(t.life / t.max * 1.4, 0, 1));
        }
    }

    // --- the damage veil and the shake ---------------------------------------------------------------
    initVeil() {
        const root = UI.root;
        if (!root || this.damageVeil) return;
        const el = document.createElement('div');
        el.className = 'wb-veil';
        Object.assign(el.style, {
            position: 'absolute', left: '0px', top: '0px', right: '0px', bottom: '0px', pointerEvents: 'none',
            opacity: '0', background: 'radial-gradient(ellipse at center, rgba(140,20,16,0) 42%, rgba(150,22,18,0.72) 100%)',
            transition: 'opacity 120ms linear'
        });
        root.appendChild(el);
        this.damageVeil = el;
    }

    flashVeil(power) {
        this.initVeil();
        if (!this.damageVeil) return;
        const meta = WB.Save.meta;
        if (meta && meta.settings && meta.settings.shake === 0) return;
        this._veilT = Math.max(this._veilT, WB.M.clamp(power, 0.15, 1));
        this.damageVeil.style.opacity = String(this._veilT * 0.85);
    }

    updateVeil(dt) {
        if (!this.damageVeil || this._veilT <= 0) return;
        this._veilT = Math.max(0, this._veilT - dt / WB.num('DAMAGE_FLASH', 0.5));
        this.damageVeil.style.opacity = String(this._veilT * 0.85);
    }

    shake(power) {
        const meta = WB.Save.meta;
        if (meta && meta.settings && meta.settings.shake === 0) return;
        if (this.camera && this.camera.shake) this.camera.shake(220, WB.M.clamp(power * 12, 2, 26));
    }

    // --- events -> picture -----------------------------------------------------------------------------
    /** Turn the simulation's event list into particles, floating numbers, beams and shake. */
    onEvents(events) {
        for (const ev of events) {
            switch (ev.type) {
                case 'shot': {
                    const g = this.height(ev.x, ev.y) + 26;
                    for (let i = 0; i < (ev.kind === 'bullet' ? 1 : 3); i++) {
                        this.spawnParticle(ev.x + Math.cos(ev.aim) * 12, ev.y + Math.sin(ev.aim) * 12, g,
                            WB.PAL.smoke, 0.42, ev.kind === 'shell' ? 14 : 8,
                            Math.cos(ev.aim) * 40, Math.sin(ev.aim) * 40, 22);
                    }
                    if (ev.kind === 'shell' || ev.boss) this.shake(0.3);
                    break;
                }
                case 'impact':
                    for (let i = 0; i < 3; i++) {
                        this.spawnParticle(ev.x, ev.y, this.height(ev.x, ev.y) + 14, WB.PAL.smoke, 0.34, 7);
                    }
                    break;
                case 'boom': {
                    const n = WB.M.clamp(Math.round(ev.r / 14), 6, 20);
                    for (let i = 0; i < n; i++) {
                        const a = (i / n) * Math.PI * 2 + (i % 3) * 0.3;
                        const s = ev.r * 1.5;
                        this.spawnParticle(ev.x, ev.y, this.height(ev.x, ev.y) + 12,
                            i % 3 === 0 ? WB.PAL.flame : WB.PAL.smoke, 0.75, 16 + (i % 4) * 5,
                            Math.cos(a) * s, Math.sin(a) * s, 60 + (i % 3) * 40);
                    }
                    this.shake(ev.power * WB.num('SHAKE_BOOM', 16) / 16);
                    break;
                }
                case 'zap': this.addBeam(ev); break;
                case 'flame': {
                    for (let i = 0; i < 5; i++) {
                        const a = ev.aim + (i - 2) * 0.16;
                        this.spawnParticle(ev.x, ev.y, this.height(ev.x, ev.y) + 18, WB.PAL.flame, 0.36, 13,
                            Math.cos(a) * 130, Math.sin(a) * 130, 16);
                    }
                    break;
                }
                case 'ram':
                    for (let i = 0; i < 8; i++) {
                        const a = (i / 8) * Math.PI * 2;
                        this.spawnParticle(ev.x, ev.y, this.height(ev.x, ev.y) + 16,
                            i % 2 ? WB.PAL.stoneDark : WB.PAL.smoke, 0.6, 12, Math.cos(a) * 130, Math.sin(a) * 130, 50);
                    }
                    this.shake(ev.power * WB.num('SHAKE_RAM', 9) / 9);
                    break;
                case 'damage':
                    if (ev.dmg > 3) {
                        this.addText(ev.x, ev.y, (ev.crit ? '★' : '') + Math.round(ev.dmg),
                            ev.crit ? '#ffd257' : ev.target === 'castle' ? '#ffffff' : '#ffd9c0', ev.crit ? 19 : 14);
                    }
                    break;
                case 'hurt':
                    this.flashVeil(WB.M.clamp(ev.dmg / 90, 0.2, 1));
                    break;
                case 'devoured':
                    this.addText(ev.x, ev.y, ev.name + '  +' + Math.round(ev.mass), '#a8e06a', 17);
                    for (let i = 0; i < 10; i++) {
                        const a = (i / 10) * Math.PI * 2;
                        this.spawnParticle(ev.x, ev.y, this.height(ev.x, ev.y) + 20, WB.PAL.wood, 0.7, 10,
                            Math.cos(a) * 90, Math.sin(a) * 90, 70);
                    }
                    break;
                case 'gulp':
                    this.spawnParticle(ev.x, ev.y, this.height(ev.x, ev.y) + 12, WB.PAL.peasantCloth, 0.3, 8);
                    break;
                case 'castleDown':
                    for (let i = 0; i < 22; i++) {
                        const a = (i / 22) * Math.PI * 2;
                        this.spawnParticle(ev.x, ev.y, this.height(ev.x, ev.y) + 20,
                            i % 3 === 0 ? WB.PAL.flame : WB.PAL.smoke, 1.1, 20, Math.cos(a) * 170, Math.sin(a) * 170, 90);
                    }
                    this.shake(1.5);
                    break;
                case 'playerDown': this.shake(2.2); break;
                case 'bossSpawn': this.shake(1.2); break;
                case 'chargeTelegraph': this.showTelegraph(ev.x, ev.y, ev.dir, ev.time); break;
                case 'tierUp': this.shake(0.7); break;
                case 'surrender':
                    this.addText(ev.x, ev.y, 'сдаётся', '#ffe9a8', 12);
                    break;
                default: break;
            }
        }
    }
}

/** Translate a geometry list by (dx, dy, dz) in WORLD space. */
WanderMesh.translate = function (geo, dx, dy, dz) {
    const out = new Array(geo.length);
    for (let i = 0; i < geo.length; i += 3) { out[i] = geo[i] + dx; out[i + 1] = geo[i + 1] + dy; out[i + 2] = geo[i + 2] + dz; }
    return out;
};
