// World3D.js — the kit's 3D engine: PlayCanvas 2 on a canvas, the scene view (View3D:
// camera, light, shadows, screen <-> world projections), render constants (cfg), toon
// shader (ArcToon: shader chunks on StandardMaterial), ink edges and silhouette outline,
// world object registration.
//
// Coordinates: the kit's map space (x right, y down, px; height up) is RIGHT-HANDED by
// tradition (heading rad -> rotation.y = -heading, like the old Babylon backend).
// PlayCanvas is a LEFT-HANDED engine, so everything crosses the border MIRRORED on X:
//     pc world = ( -x, h, y )     — see World3D.mirror() / unmirror()
// Mirroring the world AND the camera together with the chirality flip of the projection
// cancels out on screen: the picture is the same as in the right-handed scene (east on the
// right with north up). Geometry is BUILT mirrored (positions/normals: x negated; winding
// as authored), entity transforms are mirrored at placement (Location3D.placeObject),
// light directions and rotations are mirrored where they are applied.
//
// The frame is drawn by the loop owner: World3D.renderFrame() from its own
// requestAnimationFrame (the game's main.js, the editor's lab.js), after camera.update().
// renderFrame() steps the app (components, animation) and draws one frame.
//
// One light for the whole world: the azimuth WORLD3D_SUN_AZIMUTH_DEG sets WHERE the
// shadow falls, the sun elevation is WORLD3D_SUN_ELEVATION_DEG. Shadows are real
// (directional light with a shadow map; PlayCanvas fits the ortho frustum to the shadow
// casters in view, like the old fitShadowFrustum did by hand).
//
// SHADOWS — ONE COLOR FOR EVERYTHING. The sun only provides visibility; the shadow is
// colored in the fragment shader (ArcToon chunks): the light loop records the sun's
// hidden fraction (arcShadowA) and the hidden light (arcSunAdd); the unshadowed light is
// reconstructed and multiplied by mix(white, WORLD3D_SHADOW_COLOR, strength).
//
// RENDER CONSTANTS are read in one place — World3D.cfg(). applyRenderConstants(view)
// applies them to the live scene without a rebuild: light, sky, fog and shadows
// (View3D.applyLighting), materials by group (mat.arc.group: 'ground' | 'prop' | 'actor'),
// toon (uniforms — immediately), ink edges and outline.
//
// WORLD OBJECTS are registered by addObject(view, entity, kind): material group, shadow,
// ink edges and outline. kind: 'actor' — the main objects of the frame (characters, cars),
// 'prop' — environment (cubes, walls, trees). Objects are pc.Entity trees; a built model's
// root entity plays the role the root mesh played before (LocationObject.mesh).

/** @satisfies {Record<string, any>} */
const World3D = {
    /** @type {pc.Application | null} */
    app: null,
    /** @type {pc.Application | null} */
    engine: null,          // the app under the old name (game code and the editor)
    /** @type {HTMLCanvasElement | null} */
    canvas: null,
    /** @type {View3D | null} */
    view: null,            // the active View3D (drawn by renderFrame)
    /** @type {typeof ArcToon} */
    toon: null,            // toon shader state — ArcToon below
    _fps: 60,
    _lastT: 0,
    _lastDt: 0,

    // Render layers (pc.Layer order), the depth buffer is SHARED (see View3D):
    //   WORLD   — the ground and everything standing on it (the engine's World layer);
    //   OVERLAY — marks on top of the world (selection, paths): their materials get
    //             depthTest off and depthWrite off — the terrain does not cut them,
    //             and the world depth stays intact;
    //   ACTOR   — objects that go last: OVERLAY paint does not land on top of them,
    //             but they hide behind walls honestly.
    LAYER: { WORLD: 0, OVERLAY: 1, ACTOR: 2 },
    LAYER_ID: { OVERLAY: 11, ACTOR: 12, SPRITE: 13 },   // pc.Layer ids (0..10 are the engine's own)

    // Presentation-layer overrides of the render constants (a variant's lighting preset,
    // js/engine/Lighting3D.js). cfg() merges them, so the editor's Constants.js edits and a
    // render profile compose instead of fighting — and no constant is ever rewritten.
    /** @type {any | null} */
    lightOverrides: null,

    /** Set/clear the overrides (null — the constants alone decide). */
    setLightOverrides(o) {
        World3D.lightOverrides = (o && Object.keys(o).length) ? Object.assign({}, o) : null;
        return World3D.lightOverrides;
    },

    available() {
        return typeof pc !== 'undefined' && !!this.app;
    },

    // map (x, h, y-map) -> pc world; and back.
    mirror(x, h, y) { return [-x, h, y]; },
    unmirror(px, py, pz) { return [-px, py, pz]; },

    // Brings up the engine on the canvas (one per page). false — no PlayCanvas or WebGL.
    init(canvas) {
        if (typeof pc === 'undefined') {
            console.warn('World3D: libs/playcanvas.min.js не загружен — 3D-мир недоступен.');
            return false;
        }
        if (this.app) return true;
        this.canvas = canvas;
        try {
            this.app = this.engine = new pc.Application(canvas, {
                graphicsDeviceOptions: {
                    antialias: true,
                    alpha: false,
                    depth: true,
                    stencil: true,          // the silhouette outline and the editor gizmo may need stencil
                    powerPreference: 'high-performance',
                    preserveDrawingBuffer: false
                }
            });
        } catch (e) {
            console.error('World3D: WebGL недоступен', e);
            this.app = this.engine = null;
            return false;
        }
        const app = this.app;
        // Sharpness on HiDPI: render in physical pixels (on mobile — no more than
        // 1.5x, otherwise fill rate eats the frame).
        const dpr = window.devicePixelRatio || 1;
        app.graphicsDevice.maxPixelRatio = Math.min(dpr, IS_MOBILE ? 1.5 : 2);
        // The canvas size comes from CSS; only the drawing buffer follows it.
        app.setCanvasFillMode(pc.FILLMODE_NONE);
        app.setCanvasResolution(pc.RESOLUTION_AUTO);
        // The look: no tone mapping, unit exposure — colors reach the screen as authored
        // (the toon shader quantizes them itself), sRGB output like the old pipeline.
        app.scene.toneMapping = pc.TONEMAP_LINEAR;
        app.scene.exposure = 1;
        // Render layers beyond the engine's World: overlay marks and late actors.
        const comp = app.scene.layers;
        comp.push(new pc.Layer({
            name: 'overlay', id: this.LAYER_ID.OVERLAY,
            clearColorBuffer: false, clearDepthBuffer: false,
            opaqueSortMode: pc.SORTMODE_NONE, transparentSortMode: pc.SORTMODE_NONE
        }));
        comp.push(new pc.Layer({
            name: 'actor', id: this.LAYER_ID.ACTOR,
            clearColorBuffer: false, clearDepthBuffer: false
        }));
        this.toon.register();
        this.resize();
        return true;
    },

    resize() {
        if (this.app) this.app.resizeCanvas();
    },

    fps() { return this._fps; },

    renderFrame() {
        const app = this.app;
        if (!app) return;
        const now = performance.now();
        const dt = Math.min(0.1, Math.max(0.0001, (now - (this._lastT || now)) / 1000));
        this._lastT = now;
        this._lastDt = dt;      // sprite frame animation (Sprite2D) advances on this
        this._fps += (1 / dt - this._fps) * 0.05;
        const v = this.view;
        if (v && v.active) {
            v.beforeRender();
            app.update(dt);
            app.render();
        } else {
            // No view: clear to the neutral gray, like the old engine did.
            app.update(dt);
            app.render();
        }
    },

    createView(opts) {
        if (!this.available()) return null;
        return new View3D(this, opts || {});
    },

    // --- Render constants -----------------------------------------------------

    // All render constants with defaults (Constants.js may be older than the code).
    // In the game the constants are lexical const: they cannot be read by name via
    // window, only by typeof on the identifier.
    cfg() {
        const U = 'undefined';
        const c = {
            sunAz: typeof WORLD3D_SUN_AZIMUTH_DEG !== U ? WORLD3D_SUN_AZIMUTH_DEG : 53,
            sunEl: typeof WORLD3D_SUN_ELEVATION_DEG !== U ? WORLD3D_SUN_ELEVATION_DEG : 48,
            sunIntensity: typeof WORLD3D_SUN_INTENSITY !== U ? WORLD3D_SUN_INTENSITY : 0.8,
            sunColor: typeof WORLD3D_SUN_COLOR !== U ? WORLD3D_SUN_COLOR : 0xfff7e6,
            skyIntensity: typeof WORLD3D_SKYLIGHT_INTENSITY !== U ? WORLD3D_SKYLIGHT_INTENSITY : 0.45,
            skyLight: typeof WORLD3D_SKYLIGHT_COLOR !== U ? WORLD3D_SKYLIGHT_COLOR : 0xf2f7ff,
            groundLight: typeof WORLD3D_GROUNDLIGHT_COLOR !== U ? WORLD3D_GROUNDLIGHT_COLOR : 0x4f6b52,
            sky: typeof WORLD3D_SKY_COLOR !== U ? WORLD3D_SKY_COLOR : 0x8fc3e0,
            fog: typeof WORLD3D_FOG_DENSITY !== U ? WORLD3D_FOG_DENSITY : 0.00032,
            shadowMap: typeof WORLD3D_SHADOW_MAP !== U ? WORLD3D_SHADOW_MAP : 2048,
            shadowColor: typeof WORLD3D_SHADOW_COLOR !== U ? WORLD3D_SHADOW_COLOR : 0x012d3c,
            shadowStrength: typeof WORLD3D_SHADOW_STRENGTH !== U ? WORLD3D_SHADOW_STRENGTH : 0.36,
            shadowSoft: typeof WORLD3D_SHADOW_SOFT !== U ? WORLD3D_SHADOW_SOFT : 2,
            shadowRadius: typeof WORLD3D_SHADOW_RADIUS !== U ? WORLD3D_SHADOW_RADIUS : 720,
            shadowBias: typeof WORLD3D_SHADOW_BIAS !== U ? WORLD3D_SHADOW_BIAS : 0.0005,
            shadowNormalBias: typeof WORLD3D_SHADOW_NORMAL_BIAS !== U ? WORLD3D_SHADOW_NORMAL_BIAS : 0.8,
            groundSpecular: typeof WORLD3D_GROUND_SPECULAR !== U ? WORLD3D_GROUND_SPECULAR : 0.04,
            groundSpecPower: typeof WORLD3D_GROUND_SPEC_POWER !== U ? WORLD3D_GROUND_SPEC_POWER : 24,
            outerTint: typeof WORLD3D_OUTER_TINT !== U ? WORLD3D_OUTER_TINT : 1,
            propSpecular: typeof WORLD3D_PROP_SPECULAR !== U ? WORLD3D_PROP_SPECULAR : 0.05,
            propSpecPower: typeof WORLD3D_PROP_SPEC_POWER !== U ? WORLD3D_PROP_SPEC_POWER : 32,
            actorSpecular: typeof WORLD3D_ACTOR_SPECULAR !== U ? WORLD3D_ACTOR_SPECULAR : 0.22,
            actorSpecPower: typeof WORLD3D_ACTOR_SPEC_POWER !== U ? WORLD3D_ACTOR_SPEC_POWER : 28,
            toon: typeof WORLD3D_TOON !== U ? WORLD3D_TOON : 1,
            toonBands: typeof WORLD3D_TOON_BANDS !== U ? WORLD3D_TOON_BANDS : 3,
            toonSoft: typeof WORLD3D_TOON_SOFT !== U ? WORLD3D_TOON_SOFT : 0.06,
            toonLow: typeof WORLD3D_TOON_LOW !== U ? WORLD3D_TOON_LOW : 0.35,
            toonGround: typeof WORLD3D_TOON_GROUND !== U ? WORLD3D_TOON_GROUND : 1,
            toonSpec: typeof WORLD3D_TOON_SPEC !== U ? WORLD3D_TOON_SPEC : 1,
            toonSpecSize: typeof WORLD3D_TOON_SPEC_SIZE !== U ? WORLD3D_TOON_SPEC_SIZE : 0.12,
            toonRim: typeof WORLD3D_TOON_RIM !== U ? WORLD3D_TOON_RIM : 0.25,
            toonRimWidth: typeof WORLD3D_TOON_RIM_WIDTH !== U ? WORLD3D_TOON_RIM_WIDTH : 0.35,
            outline: typeof WORLD3D_TOON_OUTLINE !== U ? WORLD3D_TOON_OUTLINE : 2,
            outlineActorWidth: typeof WORLD3D_TOON_OUTLINE_ACTOR_WIDTH !== U ? WORLD3D_TOON_OUTLINE_ACTOR_WIDTH : 2,
            outlinePropWidth: typeof WORLD3D_TOON_OUTLINE_PROP_WIDTH !== U ? WORLD3D_TOON_OUTLINE_PROP_WIDTH : 0.5,
            ink: typeof WORLD3D_TOON_INK !== U ? WORLD3D_TOON_INK : 2,
            inkWidth: typeof WORLD3D_TOON_INK_WIDTH !== U ? WORLD3D_TOON_INK_WIDTH : 100,
            inkColor: typeof WORLD3D_TOON_INK_COLOR !== U ? WORLD3D_TOON_INK_COLOR : 0x10141a,
            inkAngle: typeof WORLD3D_TOON_INK_ANGLE !== U ? WORLD3D_TOON_INK_ANGLE : 40
        };
        // A variant's lighting preset is the last word (see setLightOverrides).
        return World3D.lightOverrides ? Object.assign(c, World3D.lightOverrides) : c;
    },

    // Live application of render constants to the view (editor): light, shadows,
    // sky, materials by group, toon, ink edges and outlines. Rebuilds nothing.
    applyRenderConstants(view) {
        if (!view || !view.root) return;
        const c = this.cfg();
        view.applyLighting(c);
        this.toon.apply(c);
        for (const m of view.materials()) this.applyMaterialConstants(m, c);
        this.toon.push(view, c);
        this.applyInk(view, c);
        this.applyOutlines(view, c);
    },

    // Material specular highlight by group (mat.arc.group): ground, environment, main
    // objects. The old specularPower maps onto PlayCanvas gloss of the Blinn lobe
    // (specPow = exp2(gloss * 11)). The ground ring beyond the edge (mat.arc.outer) —
    // also the WORLD3D_OUTER_TINT brightness.
    /** @param {ArcMaterial} m @param {any} [c] */
    applyMaterialConstants(m, c) {
        m = /** @type {ArcMaterial} */ (m);
        const g = m && m.arc && m.arc.group;
        if (!g || !(m instanceof pc.StandardMaterial)) return;
        c = c || this.cfg();
        let spec = 0, power = m.arc.specPower || 32;
        if (g === 'ground') { spec = c.groundSpecular; power = c.groundSpecPower; }
        else if (g === 'prop') { spec = c.propSpecular; power = c.propSpecPower; }
        else if (g === 'actor') { spec = c.actorSpecular; power = c.actorSpecPower; }
        m.arc.specPower = power;
        m.specular = new pc.Color(spec, spec, spec);
        m.gloss = Math.max(0, Math.min(1, Math.log2(Math.max(1, power)) / 11));
        if (m.arc.outer) {
            const t = Math.max(0, c.outerTint);
            m.diffuse = new pc.Color(t, t, t);
        }
    },

    // --- World objects -----------------------------------------------------------

    // Object registration: materials (of child meshes too) — into the kind group (specular
    // highlight from constants, toon), the render instances — shadow receive/cast, creased
    // edges — into the ink edges, the silhouette — into the outline. kind: 'actor' | 'prop'.
    // opts: { castShadow, receiveShadows, ink, outline } — all true by default.
    addObject(view, entity, kind, opts) {
        if (!view || !entity) return entity;
        const o = opts || {};
        const k = kind === 'prop' ? 'prop' : 'actor';
        const c = this.cfg();
        for (const mi of view.meshInstancesOf(entity)) {
            const mat = /** @type {ArcMaterial} */ (mi.material);
            if (mat && mat instanceof pc.StandardMaterial) {
                mat.arc = Object.assign({ group: k }, mat.arc);
                if (mat.useLighting !== false) this.toon.attach(view, mat);
                this.applyMaterialConstants(mat, c);
            }
            mi.receiveShadow = o.receiveShadows !== false;
            const solid = mi.mesh && mi.mesh.vertexBuffer && mi.mesh.vertexBuffer.numVertices > 0;
            // A skinned mesh gets no ink edges: the line mesh is built once from the rest
            // pose and would stay behind while the bones move the mesh.
            if (solid && o.ink !== false && !mi.skinInstance) this.inkMesh(view, mi, k, c);
            // All parts — into ONE outline pass per kind: the line follows the overall
            // silhouette, not a part.
            if (solid && o.outline !== false) this.outlineAdd(view, mi, k, c);
        }
        if (o.castShadow !== false) view.addShadowCaster(entity, true);
        return entity;
    },

    // Remove an object: outline, ink, shadows, the entity with its children.
    removeObject(view, entity) {
        if (!entity) return;
        if (view) {
            for (const mi of view.meshInstancesOf(entity)) {
                this.outlineRemove(view, mi);
                this.inkRemove(view, mi);
                mi.castShadow = false;
                // Custom layers keep their own instance lists: a mesh instance destroyed
                // while still listed leaves a dangling entry (pc crashes on its stale aabb
                // next cull). Drop FIRST, destroy after.
                view.dropFromLayers(mi);
            }
        }
        entity.destroy();
    },

    // --- Ink edges (creased edges as fat lines) ----------------------------------

    // Mesh edges creased sharper than WORLD3D_TOON_INK_ANGLE are drawn as lines in the ink
    // color. group: 'actor' (level 1) | 'prop' (level 2). The line is a screen-facing quad
    // ribbon of WORLD-space width inkWidth/50 px (as wide as it looks at zoom 1, thinner
    // when the camera moves away — the old Babylon semantics). WebGL line primitives are
    // 1px and unfilterable, hence the ribbon.
    inkMesh(view, mi, group, c) {
        if (!mi || !mi.mesh) return;
        c = c || this.cfg();
        const rec = view._inks || (view._inks = new Map());
        const want = c.ink >= (group === 'prop' ? 2 : 1) && c.inkWidth > 0;
        if (!want) { this.inkRemove(view, mi); return; }
        let e = rec.get(mi);
        if (!e) {
            const mesh = this._inkEdgeMesh(view, mi.mesh, c);
            if (!mesh) return;
            const line = new pc.MeshInstance(mesh, view.inkMaterial(c), mi.node);
            line.castShadow = false;
            line.receiveShadow = false;
            view.putInLayer(line, view.layerOf(mi));
            e = { mi: line, group: group, mesh: mesh };
            rec.set(mi, e);
        }
        // Ribbon width in world px: the old Babylon edges read ~1 screen px per 25 units
        // of WORLD3D_TOON_INK_WIDTH at zoom 1 (measured against the reference).
        e.mi.material.setParameter('arcInkWidth', Math.max(0.5, c.inkWidth) / 25);
        const col = this.hexColor3(c.inkColor);
        e.mi.material.setParameter('arcInkColor', [col.r, col.g, col.b]);
    },

    inkRemove(view, mi) {
        const rec = view && view._inks;
        const e = rec && rec.get(mi);
        if (!e) return;
        view.dropFromLayers(e.mi);
        e.mesh.destroy();
        rec.delete(mi);
    },

    applyInk(view, c) {
        if (!view) return;
        c = c || this.cfg();
        const rec = view._inks;
        // Drop the lines of meshes that no longer want ink; re-width and recolor the rest.
        for (const [mi, e] of [...(rec || [])]) {
            if (!mi.node || mi.node._destroyed) { rec.delete(mi); continue; }
            this.inkMesh(view, mi, e.group, c);
        }
        // Pick up meshes registered while ink was off for their group.
        for (const mi of view.allMeshInstances()) {
            const g = mi.material && mi.material.arc && mi.material.arc.group;
            if (!g || mi.skinInstance) continue;
            if (rec && rec.has(mi)) continue;
            if (c.ink >= (g === 'prop' ? 2 : 1) && c.inkWidth > 0) this.inkMesh(view, mi, g, c);
        }
    },

    // Creased edges of a mesh -> a line-ribbon pc.Mesh (positions + edge data attributes).
    // Adjacency is by WELDED positions (flat-shaded lowpoly keeps its corners separate);
    // an edge is inked when the face normals crease sharper than the angle constant.
    _inkEdgeMesh(view, mesh, c) {
        if (mesh._arcInkCache && mesh._arcInkCache.angle === c.inkAngle) return mesh._arcInkCache.mesh;
        const vb = mesh.vertexBuffer;
        if (!vb) return null;
        const fmt = vb.format;
        const iP = fmt.elements.find(el => el.name === pc.SEMANTIC_POSITION);
        const idxBuf = mesh.indexBuffer && mesh.indexBuffer[0];
        const idx = idxBuf ? idxBuf.lock() : null;
        const vCount = vb.numVertices;
        const strideF = fmt.size / 4;
        const PF = new Float32Array(/** @type {ArrayBuffer} */ (vb.lock()));
        const oP = (iP ? iP.offset : 0) / 4;
        const nTri = idx ? idx.length / 3 : vCount / 3;
        // Face normals (the winding sign cancels in the crease test).
        const tri = (t) => idx ? [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]] : [t * 3, t * 3 + 1, t * 3 + 2];
        const fn = [];
        const px = (v) => PF[v * strideF + oP], py = (v) => PF[v * strideF + oP + 1], pz = (v) => PF[v * strideF + oP + 2];
        for (let t = 0; t < nTri; t++) {
            const [a, b, d] = tri(t);
            const ux = px(b) - px(a), uy = py(b) - py(a), uz = pz(b) - pz(a);
            const vx = px(d) - px(a), vy = py(d) - py(a), vz = pz(d) - pz(a);
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const l = Math.hypot(nx, ny, nz) || 1;
            fn.push([nx / l, ny / l, nz / l]);
        }
        // Edge -> the two faces sharing it (welded by quantized position).
        const key = (v) => px(v).toFixed(2) + '|' + py(v).toFixed(2) + '|' + pz(v).toFixed(2);
        const eps = Math.cos(Math.max(1, Math.min(89, c.inkAngle)) * Math.PI / 180);
        const edges = new Map();
        for (let t = 0; t < nTri; t++) {
            const [a, b, d] = tri(t);
            const vs = [a, b, d];
            for (let i2 = 0; i2 < 3; i2++) {
                const v0 = vs[i2], v1 = vs[(i2 + 1) % 3];
                const k0 = key(v0), k1 = key(v1);
                const k = k0 < k1 ? k0 + '#' + k1 : k1 + '#' + k0;
                let e = edges.get(k);
                if (!e) edges.set(k, (e = { v: [v0, v1], faces: [] }));
                if (e.faces.length < 2) e.faces.push(fn[t]);
            }
        }
        const posArr = [], otherArr = [], signArr = [], idxArr = [];
        let n = 0;
        for (const e of edges.values()) {
            if (e.faces.length !== 2) continue;
            const dot = e.faces[0][0] * e.faces[1][0] + e.faces[0][1] * e.faces[1][1] + e.faces[0][2] * e.faces[1][2];
            if (dot >= eps) continue;   // not creased enough
            const p = [px(e.v[0]), py(e.v[0]), pz(e.v[0])];
            const q = [px(e.v[1]), py(e.v[1]), pz(e.v[1])];
            posArr.push(...p, ...p, ...q, ...q);
            otherArr.push(...q, ...q, ...p, ...p);
            signArr.push(-1, 1, -1, 1);
            idxArr.push(n, n + 1, n + 2, n + 2, n + 1, n + 3);
            n += 4;
        }
        vb.unlock();
        if (idxBuf) idxBuf.unlock();
        if (!n) { mesh._arcInkCache = { angle: c.inkAngle, mesh: null }; return null; }
        const out = new pc.Mesh(view.world.app.graphicsDevice);
        out.setPositions(posArr);
        out.setVertexStream(pc.SEMANTIC_ATTR6, otherArr, 3);   // the other end of the edge
        out.setVertexStream(pc.SEMANTIC_ATTR7, signArr, 1);    // quad corner sign
        out.setIndices(idxArr);
        out.update(pc.PRIMITIVE_TRIANGLES);
        mesh._arcInkCache = { angle: c.inkAngle, mesh: out };
        return out;
    },

    // --- Silhouette outline: inverted hull ----------------------------------------
    //
    // "Stroke like in Photoshop", PlayCanvas edition: a second render instance of the
    // same mesh with a hull shader — vertices pushed along their normals, back faces
    // only, ink color. The line follows the OUTER boundary of the silhouette, ONE per
    // whole object, width in screen pixels (constant with distance). Depth-tested, so
    // an outlined object hides behind walls honestly (the old post-effect layer drew
    // over everything — the hull is the calmer behaviour, and free of the mask passes).
    // Scene fog tints the line in the shader itself (the old per-frame CPU tone is gone).
    //
    // Each object kind ('actor' / 'prop') has its own width — a material per kind.

    outlineKind(kind) { return kind === 'prop' ? 'prop' : 'actor'; },

    // Outline width of an object kind in screen px (frame pixels).
    outlineWidthOf(kind, c) {
        c = c || this.cfg();
        return this.outlineKind(kind) === 'prop' ? c.outlinePropWidth : c.outlineActorWidth;
    },

    // The hull material of one kind, created per view on demand.
    outlineMaterial(view, kind, c) {
        c = c || this.cfg();
        const store = view._outlineMats || (view._outlineMats = {});
        const k = this.outlineKind(kind);
        if (store[k]) return store[k];
        const mat = new pc.ShaderMaterial({
            uniqueName: 'arcOutline-' + k,
            attributes: { vertex_position: pc.SEMANTIC_POSITION, vertex_normal: pc.SEMANTIC_NORMAL },
            vertexGLSL: ArcOutline.VS,
            fragmentGLSL: ArcOutline.FS
        });
        // The hull keeps the faces the object itself culls: with the kit's winding in the
        // mirrored world that is CULLFACE_BACK (measured, see skill render-conventions).
        mat.cull = pc.CULLFACE_BACK;
        mat.depthWrite = true;
        mat.blendType = pc.BLEND_NONE;
        store[k] = mat;
        return mat;
    },

    // Put a mesh instance into the outline. kind: 'actor' (level 1) | 'prop' (level 2).
    outlineAdd(view, mi, kind, c) {
        if (!view || !mi) return;
        c = c || this.cfg();
        const k = this.outlineKind(kind);
        mi._arcOutline = k;
        this.outlineRemove(view, mi);
        // Toon is off — no outline; applyOutlines brings it back when toon is turned on.
        const want = c.toon > 0 && c.outline >= (k === 'prop' ? 2 : 1) && this.outlineWidthOf(k, c) > 0;
        if (!want) return;
        const mat = this.outlineMaterial(view, k, c);
        const hull = new pc.MeshInstance(mi.mesh, mat, mi.node);
        hull.castShadow = false;
        hull.receiveShadow = false;
        if (mi.skinInstance) hull.skinInstance = mi.skinInstance;   // the hull dances with the bones
        view.putInLayer(hull, view.layerOf(mi));
        (view._outlines || (view._outlines = new Map())).set(mi, hull);
        this._outlineParams(view, mat, k, c);
    },

    _outlineParams(view, mat, k, c) {
        c = c || this.cfg();
        mat.setParameter('arcOutlineWidth', this.outlineWidthOf(k, c));
        const dev = view.world.app.graphicsDevice;
        mat.setParameter('arcOutlineNdc', [2 / Math.max(1, dev.width), 2 / Math.max(1, dev.height)]);
        const col = this.hexColor3(c.inkColor);
        mat.setParameter('arcInkColor', [col.r, col.g, col.b]);
        const fog = view.fogState(c);
        mat.setParameter('arcFogColor', [fog.r, fog.g, fog.b]);
        mat.setParameter('arcFogDensity', fog.density);
    },

    outlineRemove(view, mi) {
        const store = view && view._outlines;
        const hull = store && store.get(mi);
        if (!hull) return;
        view.dropFromLayers(hull);
        store.delete(mi);
        mi._arcOutline = null;
    },

    // Constants edit: widths and color onto live materials, levels — a rebuild of the set.
    applyOutlines(view, c) {
        if (!view || !view.root) return;
        c = c || this.cfg();
        for (const [mi, hull] of [...(view._outlines || [])]) {
            if (!mi.node || mi.node._destroyed) { view._outlines.delete(mi); continue; }
            const k = mi._arcOutline;
            this.outlineRemove(view, mi);
            if (k) this.outlineAdd(view, mi, k, c);
        }
        for (const mat of Object.values(view._outlineMats || {})) {
            for (const k of ['actor', 'prop']) if (view._outlineMats[k] === mat) this._outlineParams(view, mat, k, c);
        }
    },

    // --- Utilities -------------------------------------------------------------

    // The "where the sun shines" vector (unit, downward) in PC WORLD space: azimuth on the
    // map (0 — right, 90 — down), elevation above the horizon; then mirrored on X.
    sunDirection(c) {
        c = c || this.cfg();
        const az = c.sunAz * Math.PI / 180;
        const el = c.sunEl * Math.PI / 180;
        const ce = Math.cos(el);
        return new pc.Vec3(-Math.cos(az) * ce, -Math.sin(el), Math.sin(az) * ce);
    },

    hexColor3(v) {
        const col = new pc.Color(1, 1, 1);
        if (typeof v === 'string') col.fromString(v);
        else {
            const n = (v >>> 0) & 0xffffff;
            col.set(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1);
        }
        return col;
    },

    // --- Rotations across the mirror ------------------------------------------------
    //
    // Map-space euler angles in the right-handed tradition (Babylon's mesh.rotation:
    // yaw about Y, then pitch about X, then roll about Z) -> a quaternion of the mirrored
    // PlayCanvas world. The engine's own euler order differs from the old one on compound
    // tilts, hence the matrix route, not setFromEulerAngles.
    rotQuat(rx, ry, rz) {
        const c1 = Math.cos(rx), s1 = Math.sin(rx);
        const c2 = Math.cos(ry), s2 = Math.sin(ry);
        const c3 = Math.cos(rz), s3 = Math.sin(rz);
        // Row-vector M = Ry·Rx·Rz (the old rotation chain), then R = Mᵀ (column-vector),
        // then the mirror R' = S·R·S with S = diag(-1, 1, 1): signs on the x row/column.
        const M = [
            c2 * c3 - s1 * s2 * s3, c2 * s3 + s1 * s2 * c3, -c1 * s2,
            -c1 * s3, c1 * c3, s1,
            s2 * c3 + c2 * s1 * s3, s2 * s3 - c2 * s1 * c3, c1 * c2
        ];
        const r = (i, j) => {           // R' column-vector element (i, j), mirrored
            const v = M[j * 3 + i];      // transpose
            const sx = (i === 0 ? -1 : 1), sy = (j === 0 ? -1 : 1);
            return v * sx * sy;
        };
        // Standard column-vector matrix -> quaternion.
        const m00 = r(0, 0), m11 = r(1, 1), m22 = r(2, 2);
        const tr = m00 + m11 + m22;
        const q = new pc.Quat();
        if (tr > 0) {
            const s = Math.sqrt(tr + 1) * 2;
            q.set((r(2, 1) - r(1, 2)) / s, (r(0, 2) - r(2, 0)) / s, (r(1, 0) - r(0, 1)) / s, s / 4);
        } else if (m00 > m11 && m00 > m22) {
            const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
            q.set(s / 4, (r(0, 1) + r(1, 0)) / s, (r(0, 2) + r(2, 0)) / s, (r(2, 1) - r(1, 2)) / s);
        } else if (m11 > m22) {
            const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
            q.set((r(0, 1) + r(1, 0)) / s, s / 4, (r(1, 2) + r(2, 1)) / s, (r(0, 2) - r(2, 0)) / s);
        } else {
            const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
            q.set((r(0, 2) + r(2, 0)) / s, (r(1, 2) + r(2, 1)) / s, s / 4, (r(1, 0) - r(0, 1)) / s);
        }
        return q;
    },

    // The way back (editor gizmo -> def.rot degrees): quaternion of the mirrored world ->
    // map-space euler angles of the right-handed tradition.
    eulerFromQuat(q) {
        // Column-vector rotation matrix of the quaternion.
        const x = q.x, y = q.y, z = q.z, w = q.w;
        const R = [
            1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
            2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
            2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)
        ];
        // Un-mirror (S·R'·S), then back to the row-vector M = Rᵀ.
        const rp = (i, j) => R[i * 3 + j] * (i === 0 ? -1 : 1) * (j === 0 ? -1 : 1);
        const M = (i, j) => rp(j, i);
        const D = 180 / Math.PI;
        const px = Math.asin(Math.max(-1, Math.min(1, M(1, 2))));
        const py = Math.atan2(-M(0, 2), M(2, 2));
        const pz = Math.atan2(-M(1, 0), M(1, 1));
        return [px * D, py * D, pz * D];
    }
};

// --- Toon material chunks -------------------------------------------------------
//
// Chunks on every lit StandardMaterial of the world (ArcToon.attach). Everything is
// uniform-driven: no shader rebuild when the editor flips toon on/off or moves a slider
// (the old Babylon plugin recompiled on toon on/off).
//
//   arcToonA      = (bands, softness, lowest band, specular strength)
//   arcToonB      = (specular threshold, rim strength, rim width, on/off gate)
//   arcShadowColor= (shadow color, strength)
//   arcHemi       = (sky light color, intensity)      — hemispheric ambient
//   arcHemiGround = ground fill color
// The sun's hidden fraction (arcShadowA) and the hidden light (arcSunAdd) are recorded
// in the light loop; endPS reconstructs the unshadowed light, colors the shadow and
// quantizes the sum into bands — the same place the old plugin injected (after all
// lights are summed, before albedo), then the rim light rides on before the fog.
const ArcToonChunks = {
    DECL: `
uniform vec4 arcToonA;
uniform vec4 arcToonB;
uniform vec4 arcShadowColor;
uniform vec4 arcHemi;
uniform vec3 arcHemiGround;
float arcShadowA;
vec3 arcSunAdd;
float arcToonLevel(float v) {
    float bands = arcToonA.x;
    if (bands < 1.5 || arcToonB.w < 0.5) return v;
    float lo = arcToonA.z;
    float t = clamp((v - lo) / max(1e-4, 1.0 - lo), 0.0, 1.0);
    float x = t * (bands - 1.0);
    float k = floor(x + 0.5);
    float d = x - k;
    float s = max(1e-3, arcToonA.y);
    float q = k + smoothstep(0.5 - s, 0.5 + s, d) - smoothstep(0.5 - s, 0.5 + s, -d);
    return lo + clamp(q / (bands - 1.0), 0.0, 1.0) * (1.0 - lo);
}
`,
    // Hemispheric ambient, like Babylon's hemispheric light: sky color from above,
    // ground fill from below, interpolated by the world normal.
    AMBIENT: `
void addAmbient(vec3 worldNormal) {
    float up = worldNormal.y * 0.5 + 0.5;
    dDiffuseLight += mix(arcHemiGround, arcHemi.rgb, up) * arcHemi.a;
}
`,
    // The light loop, patched at runtime: after the sun's shadow attenuates the light,
    // remember what it hid (see ArcToon.lightPatch).
    INJECT: `
#if LIGHT{i}TYPE == DIRECTIONAL
    arcShadowA = 1.0 - shadow;
    arcSunAdd += lightColor * max(dot(litArgs_worldNormal, -dLightDirNormW), 0.0) * arcShadowA;
#endif
`,
    END: `
{
    // Colored shadow: reconstruct the unshadowed light, tint what the sun lost. The tint
    // factor is authored in display space (like the whole kit), so it enters the linear
    // light through the sRGB decode.
    vec3 arcU = max(vec3(0.0), dDiffuseLight + arcSunAdd);
    dDiffuseLight = arcU * decodeGamma(mix(vec3(1.0), arcShadowColor.rgb, arcShadowA * arcShadowColor.a));
    dSpecularLight *= 1.0 - arcShadowA;
    // Light bands and the toon glint, over the whole sum (sun + sky, with shadow).
    // The old pipeline quantized the RAW (gamma-space) light; this one computes in
    // linear — quantize the sRGB-encoded value and fold the step back as a ratio, so the
    // bands land where the author tuned them.
    if (arcToonB.w > 0.5 && arcToonA.x >= 1.5) {
        vec3 arcEnc = gammaCorrectOutput(max(dDiffuseLight, vec3(0.0)));
        float arcV = max(arcEnc.r, max(arcEnc.g, arcEnc.b));
        float arcQ = arcToonLevel(arcV);
        dDiffuseLight *= arcV > 1e-4 ? arcQ / arcV : 1.0;
        vec3 arcEncS = gammaCorrectOutput(max(dSpecularLight, vec3(0.0)));
        float arcS = max(arcEncS.r, max(arcEncS.g, arcEncS.b));
        float arcW = max(0.005, arcToonA.y * 0.25);
        float arcH = smoothstep(arcToonB.x - arcW, arcToonB.x + arcW, arcS) * arcToonA.w;
        dSpecularLight = arcS > 1e-5 ? dSpecularLight * (arcH / arcS) : vec3(0.0);
    }
    gl_FragColor.rgb = combineColor(litArgs_albedo, litArgs_sheen_specularity, litArgs_clearcoat_specularity);
    gl_FragColor.rgb += litArgs_emission;
    // Rim light along the silhouette edge — lighter than the base color, fades in shadow.
    if (arcToonB.w > 0.5 && arcToonB.y > 0.0) {
        float arcF = 1.0 - max(0.0, dot(litArgs_worldNormal, dViewDirW));
        float arcE = 1.0 - arcToonB.z;
        float arcR = smoothstep(arcE - 0.05, arcE + 0.05, arcF) * arcToonB.y * (1.0 - arcShadowA);
        gl_FragColor.rgb += litArgs_albedo * arcR;
    }
    gl_FragColor.rgb = addFog(gl_FragColor.rgb);
    gl_FragColor.rgb = toneMap(gl_FragColor.rgb);
    gl_FragColor.rgb = gammaCorrectOutput(gl_FragColor.rgb);
}
`
};

/** @satisfies {Record<string, any>} */
const ArcToon = {
    s: { on: true, bands: 3, soft: 0.06, low: 0.35, ground: true, spec: 1, specSize: 0.12, rim: 0.25, rimWidth: 0.35 },
    registered: false,
    _lightBase: null,     // the engine's lightFunctionLightPS with our injection

    // Once per page: prepare the patched light-loop chunk. Materials get the chunks in
    // attach() — PlayCanvas has no global material factory hook, and every lit material
    // of the kit is created by the kit itself (terrain, FBX, GLB conversion).
    register() {
        if (this.registered || typeof pc === 'undefined') return;
        this.registered = true;
        const base = pc.ShaderChunks.get(World3D.app.graphicsDevice, pc.SHADERLANGUAGE_GLSL).get('lightFunctionLightPS');
        const ANCHOR = 'dAtten *= shadow;';
        this._lightBase = base && base.includes(ANCHOR)
            ? /** @type {string} */ (base).replace(ANCHOR, ANCHOR + ArcToonChunks.INJECT)
            : /** @type {string} */ (base);
        this.load(World3D.cfg());
    },

    load(c) {
        this.s = {
            on: c.toon > 0,
            bands: Math.max(2, Math.min(8, Math.round(c.toonBands))),
            soft: Math.max(0, Math.min(0.5, c.toonSoft)),
            low: Math.max(0, Math.min(0.95, c.toonLow)),
            ground: c.toonGround > 0,
            spec: Math.max(0, c.toonSpec),
            specSize: Math.max(0.005, c.toonSpecSize),
            rim: Math.max(0, c.toonRim),
            rimWidth: Math.max(0.02, Math.min(0.95, c.toonRimWidth))
        };
    },

    // The toon chunks onto one lit StandardMaterial. Idempotent.
    attach(view, mat) {
        mat = /** @type {ArcMaterial} */ (mat);
        if (!mat || mat.arcToon) return mat;
        mat.arcToon = true;
        const chunks = mat.shaderChunks.glsl;
        chunks.set('litUserDeclarationPS', ArcToonChunks.DECL);
        chunks.set('ambientPS', ArcToonChunks.AMBIENT);
        chunks.set('lightFunctionLightPS', this._lightBase);
        chunks.set('endPS', ArcToonChunks.END);
        (view._toonMats || (view._toonMats = new Set())).add(mat);
        this.pushOne(mat, World3D.cfg(), view);
        mat.update();
        return mat;
    },

    // New constants -> uniforms of one material. Bands 0 on the ground group when
    // WORLD3D_TOON_GROUND is off; rim 0 there too (the old branching in the shader, not in
    // a define — editor toggles do not recompile shaders).
    pushOne(mat, c, view) {
        const s = this.s;
        const ground = !!(mat.arc && mat.arc.group === 'ground');
        const bands = (ground && !s.ground) ? 0 : s.bands;
        mat.setParameter('arcToonA', [bands, s.soft, s.low, s.spec]);
        mat.setParameter('arcToonB', [s.specSize, ground ? 0 : s.rim, s.rimWidth, s.on ? 1 : 0]);
        const sc = World3D.hexColor3(c.shadowColor);
        mat.setParameter('arcShadowColor', [sc.r, sc.g, sc.b, Math.max(0, Math.min(1, c.shadowStrength))]);
        const sky = World3D.hexColor3(c.skyLight);
        const gnd = World3D.hexColor3(view && view.opts && view.opts.groundTint != null ? view.opts.groundTint : c.groundLight);
        mat.setParameter('arcHemi', [sky.r, sky.g, sky.b, Math.max(0, c.skyIntensity)]);
        mat.setParameter('arcHemiGround', [gnd.r, gnd.g, gnd.b]);
    },

    // New constants: values — as uniforms right away; the view re-pushes them all.
    apply(c) {
        this.load(c || World3D.cfg());
    },

    push(view, c) {
        if (!view) return;
        c = c || World3D.cfg();
        for (const mat of (view._toonMats || [])) this.pushOne(mat, c, view);
    }
};
World3D.toon = ArcToon;

// --- Outline hull shader ---------------------------------------------------------
const ArcOutline = {
    VS: `
#include "transformCoreVS"
#include "normalCoreVS"
uniform float arcOutlineWidth;
uniform vec2 arcOutlineNdc;
varying float vArcDepth;
void main(void) {
    mat4 model = getModelMatrix();
    vec3 lp = getLocalPosition(vertex_position.xyz);
    vec4 posW = model * vec4(lp, 1.0);
    vec3 nW = mat3(model) * getLocalNormal(vertex_normal);\n    nW = normalize(nW + vec3(1e-9, 1e-9, 1e-9));
    vec4 viewPos = matrix_view * posW;
    vArcDepth = length(viewPos.xyz);
    vec4 clip = matrix_projection * viewPos;
    vec2 nd = normalize((matrix_projection * vec4(nW, 0.0)).xy + vec2(1e-7));
    clip.xy += nd * arcOutlineWidth * arcOutlineNdc * max(clip.w, 0.0);
    gl_Position = clip;
}
`,
    FS: `
precision highp float;
uniform vec3 arcInkColor;
uniform vec3 arcFogColor;
uniform float arcFogDensity;
varying float vArcDepth;
void main(void) {
    float f = exp(-vArcDepth * vArcDepth * arcFogDensity * arcFogDensity);
    gl_FragColor = vec4(mix(arcFogColor, arcInkColor, clamp(f, 0.0, 1.0)), 1.0);
}
`
};

// --- Ink line shader --------------------------------------------------------------
const ArcInk = {
    VS: `
attribute vec3 vertex_position;
attribute vec3 aOther;
attribute float aSign;
uniform mat4 matrix_model;
uniform mat4 matrix_view;
uniform mat4 matrix_projection;
uniform float arcInkWidth;
varying float vArcDepth;
void main(void) {
    vec4 pV = matrix_view * matrix_model * vec4(vertex_position, 1.0);
    vec4 qV = matrix_view * matrix_model * vec4(aOther, 1.0);
    vec2 d = qV.xy - pV.xy;
    float dl = length(d);
    d = dl > 1e-9 ? d / dl : vec2(1.0, 0.0);
    vec2 perp = vec2(d.y, -d.x) * aSign * arcInkWidth * 0.5;
    pV.xy += perp;
    vArcDepth = length(pV.xyz);
    gl_Position = matrix_projection * pV;
}
`,
    FS: `
precision highp float;
uniform vec3 arcInkColor;
uniform vec3 arcFogColor;
uniform float arcFogDensity;
varying float vArcDepth;
void main(void) {
    float f = exp(-vArcDepth * vArcDepth * arcFogDensity * arcFogDensity);
    gl_FragColor = vec4(mix(arcFogColor, arcInkColor, clamp(f, 0.0, 1.0)), 1.0);
}
`
};

// One 3D view: its own entity subtree, camera, light and shadows on the shared app.
class View3D {
    // opts: { sky?, groundTint?, shadowColor?, fogDensity?, shadowRadius? } — constant overrides
    constructor(world, opts) {
        this.world = world;
        this.opts = opts;
        this.active = false;
        this.app = world.app;
        this.uid = (View3D._uid = (View3D._uid || 0) + 1);
        this.scene = this.app.scene;

        this.root = new pc.Entity('view' + this.uid);
        this.app.root.addChild(this.root);

        const c = World3D.cfg();

        // --- Camera: a bare entity with a camera component, driven by CameraController
        // through the facade below (map-space position and target, fov in radians).
        this.camEntity = new pc.Entity('cam');
        this.root.addChild(this.camEntity);
        this.camEntity.addComponent('camera', {
            fov: (typeof CAMERA_FOV_DEG !== 'undefined' ? CAMERA_FOV_DEG : 52),
            nearClip: 6,
            farClip: 9000,
            clearColor: World3D.hexColor3(opts.sky != null ? opts.sky : c.sky),
            clearColorBuffer: true,
            layers: [pc.LAYERID_WORLD, World3D.LAYER_ID.OVERLAY, World3D.LAYER_ID.ACTOR]
        });
        this.camComp = this.camEntity.camera;
        this.camEntity.setPosition(0, 600, 0);
        this.camera = new ArcCamera(this);

        // Engine-shaped shim for the old call sites (CameraController's aspect ratio,
        // tests' stubs): the real engine is World3D.app.
        this.engine = {
            getAspectRatio: () => {
                const dev = this.app.graphicsDevice;
                return Math.max(0.01, dev.width / Math.max(1, dev.height));
            },
            getRenderWidth: () => this.app.graphicsDevice.width,
            getRenderHeight: () => this.app.graphicsDevice.height,
            getFps: () => World3D.fps()
        };

        // --- Light: the sun. The hemispheric sky lives in the toon ambient chunk.
        this.sunEntity = new pc.Entity('sun');
        this.root.addChild(this.sunEntity);
        this.sunEntity.addComponent('light', { type: 'directional' });
        this.sun = this.sunEntity.light;
        this.sun.intensity = 1;
        this.sun.color = new pc.Color(1, 1, 1);
        this._shadowRadius = opts.shadowRadius || (IS_MOBILE ? Math.min(520, c.shadowRadius) : c.shadowRadius);
        this._mapSize = IS_MOBILE ? Math.max(512, c.shadowMap / 2) : c.shadowMap;

        this.applyLighting(c);
        this.updateLightFrustum(0, 0, 0);

        this._syncFns = [];   // functions called before every 3D frame
        this._miLayers = new Map();
        /** @type {Map<pc.MeshInstance, pc.MeshInstance>} */
        this._outlines = new Map();     // source instance -> outline hull instance
        /** @type {Map<pc.MeshInstance, any>} */
        this._inks = new Map();         // source instance -> ink ribbon record
        /** @type {Record<string, pc.ShaderMaterial>} */
        this._outlineMats = {};         // hull material per object kind
        /** @type {Set<ArcMaterial>} */
        this._toonMats = new Set();     // materials with the toon chunks
        /** @type {pc.Asset[]} */
        this._assets = [];              // container assets loaded for this view
        this.active = true;
        world.view = this;
    }

    // Light, sky, fog and shadows from the render constants (the view's opts override them).
    // The shadow color/strength travel to the toon chunks as uniforms; the sun component
    // only provides direction, intensity and the shadow map.
    applyLighting(c) {
        c = c || World3D.cfg();
        const o = this.opts || {};
        const scene = this.app.scene;
        const sky = World3D.hexColor3(o.sky != null ? o.sky : c.sky);
        this.camComp.clearColor = new pc.Color(sky.r, sky.g, sky.b, 1);
        scene.fog.type = c.fog > 0 ? pc.FOG_EXP2 : pc.FOG_NONE;
        scene.fogColor = new pc.Color(sky.r, sky.g, sky.b);
        scene.fogDensity = Math.max(0, o.fogDensity != null ? o.fogDensity : c.fog);

        // Sun direction (mirrored world) + intensity and color in one component.
        const dir = World3D.sunDirection(c);
        this.sunEntity.setPosition(0, 0, 0);
        this.sunEntity.lookAt(new pc.Vec3(dir.x, dir.y, dir.z).add(this.sunEntity.getPosition()), pc.Vec3.UP);
        const col = World3D.hexColor3(c.sunColor);
        this.sun.color = new pc.Color(col.r * Math.max(0, c.sunIntensity), col.g * Math.max(0, c.sunIntensity), col.b * Math.max(0, c.sunIntensity));

        const sg = this.sun;
        sg.castShadows = true;
        sg.shadowResolution = this._mapSize;
        sg.numCascades = 1;
        // Shadow edge: 0 — hard (one map sample), otherwise PCF 3/5 taps or PCSS;
        // on mobile — no higher than the cheap filter.
        let soft = Math.max(0, Math.min(3, Math.round(c.shadowSoft)));
        if (IS_MOBILE && soft > 1) soft = 1;
        sg.shadowType = soft === 0 ? pc.SHADOW_PCF1_32F : (soft === 1 ? pc.SHADOW_PCF1_32F : (soft === 2 ? pc.SHADOW_PCF3_32F : pc.SHADOW_PCF5_32F));
        // Bias: PlayCanvas wants a depth bias as a fraction of the shadow map depth range
        // and a normal offset in WORLD px — the constants keep their old meaning, scaled
        // to the engine's units (measured against the Babylon reference).
        sg.shadowBias = Math.max(0, Math.min(1, c.shadowBias * 50));
        const texel = 2 * this._shadowRadius / this._mapSize;   // world px per shadow map texel
        sg.normalOffsetBias = Math.max(0, c.shadowNormalBias) * texel;
        if (this._lightAt) this.updateLightFrustum(this._lightAt.x, this._lightAt.y, this._lightAt.h, this._lightAt.r);
        World3D.toon.push(this, c);
    }

    // Fog parameters for the custom shaders (outline, ink): color and density in use.
    fogState(c) {
        c = c || World3D.cfg();
        const o = this.opts || {};
        const sky = World3D.hexColor3(o.sky != null ? o.sky : c.sky);
        return { r: sky.r, g: sky.g, b: sky.b, density: Math.max(0, o.fogDensity != null ? o.fogDensity : c.fog) };
    }

    // The sun's shadow frustum follows the point of interest (usually the camera target):
    // shadows are crisp where the player is looking. PlayCanvas fits the ortho frustum to
    // the shadow casters in range by itself; the range is shadowDistance from the camera.
    updateLightFrustum(x, y2d, h, radius) {
        const R = radius || this._shadowRadius;
        this._lightAt = { x: x, y: y2d, h: h || 0, r: radius };
        this._fitMaxR = R;
        this._updateShadowDistance();
    }

    // Fitted like the old fitShadowFrustum: the area around the ground point at the frame
    // center, no wider than WORLD3D_SHADOW_RADIUS.
    fitShadowFrustum(x, y2d, h, maxR) {
        const R0 = Math.min(maxR || this._shadowRadius, this._shadowRadius);
        this._lightAt = { x: x, y: y2d, h: h || 0, r: maxR };
        this._fitMaxR = R0;
        this._updateShadowDistance();
    }

    _updateShadowDistance() {
        const at = this._lightAt || { x: 0, y: 0, h: 0 };
        const eye = this.camEntity.getPosition();
        const d = Math.hypot(eye.x + at.x, eye.y - at.h, eye.z - at.y);   // camera -> point of interest
        this.sun.shadowDistance = Math.min(this.camComp.farClip, d + (this._fitMaxR || this._shadowRadius) + 200);
    }

    addShadowCaster(entity, includeDescendants) {
        if (!entity) return;
        for (const mi of this.meshInstancesOf(entity)) mi.castShadow = true;
    }

    removeShadowCaster(entity) {
        if (!entity) return;
        for (const mi of this.meshInstancesOf(entity)) mi.castShadow = false;
    }

    // --- Instance bookkeeping -----------------------------------------------------

    // All mesh instances of an entity subtree (render components).
    meshInstancesOf(entity) {
        const out = [];
        if (!entity) return out;
        for (const rc of entity.findComponents('render')) out.push(...rc.meshInstances);
        return out;
    }

    allMeshInstances() {
        return this.meshInstancesOf(this.root);
    }

    // All StandardMaterials owned by this view's subtree (render constants, toon push).
    materials() {
        const seen = new Set();
        for (const mi of this.allMeshInstances()) if (mi.material) seen.add(mi.material);
        for (const m of (this._toonMats || [])) seen.add(m);
        for (const m of Object.values(this._outlineMats || {})) seen.add(m);
        return [...seen];
    }

    // Layer bookkeeping: a mesh instance lives in exactly one of the kit's layers
    // (WORLD by default; ink lines and outline hulls follow their source).
    putInLayer(mi, id) {
        const comp = this.app.scene.layers;
        const old = this._miLayers.get(mi);
        if (old != null && old !== id) comp.getLayerById(old).removeMeshInstances([mi]);
        if (old == null || old !== id) comp.getLayerById(id).addMeshInstances([mi], true);
        this._miLayers.set(mi, id);
    }

    dropFromLayers(mi) {
        const id = this._miLayers.get(mi);
        if (id == null) return;
        this.app.scene.layers.getLayerById(id).removeMeshInstances([mi]);
        this._miLayers.delete(mi);
    }

    // The pc.Layer id a mesh instance lives in (ink/outline follow their source).
    layerOf(mi) {
        return this._miLayers.has(mi) ? this._miLayers.get(mi) : pc.LAYERID_WORLD;
    }

    // Move a whole object into one of World3D.LAYER groups (overlay marks, late actors).
    setLayer(entity, group) {
        const id = group === World3D.LAYER.OVERLAY ? World3D.LAYER_ID.OVERLAY
            : group === World3D.LAYER.ACTOR ? World3D.LAYER_ID.ACTOR : pc.LAYERID_WORLD;
        for (const mi of this.meshInstancesOf(entity)) this.putInLayer(mi, id);
    }

    // Ink line material of the view (shared by all ink instances).
    inkMaterial(c) {
        if (!this._inkMat) {
            this._inkMat = new pc.ShaderMaterial({
                uniqueName: 'arcInk' + this.uid,
                attributes: {
                    vertex_position: pc.SEMANTIC_POSITION,
                    aOther: pc.SEMANTIC_ATTR6,
                    aSign: pc.SEMANTIC_ATTR7
                },
                vertexGLSL: ArcInk.VS,
                fragmentGLSL: ArcInk.FS
            });
            this._inkMat.cull = pc.CULLFACE_NONE;
            this._inkMat.depthWrite = false;
            this._inkMat.depthFunc = pc.FUNC_LESSEQUAL;
        }
        const fog = this.fogState(c);
        this._inkMat.setParameter('arcFogColor', [fog.r, fog.g, fog.b]);
        this._inkMat.setParameter('arcFogDensity', fog.density);
        return this._inkMat;
    }

    onBeforeFrame(fn) {
        this._syncFns.push(fn);
    }

    beforeRender() {
        for (const fn of this._syncFns) {
            try { fn(); } catch (e) { console.error('World3D sync:', e); }
        }
        // Outline width in NDC follows the drawing buffer size.
        const dev = this.world.app.graphicsDevice;
        for (const mat of Object.values(this._outlineMats || {})) {
            mat.setParameter('arcOutlineNdc', [2 / Math.max(1, dev.width), 2 / Math.max(1, dev.height)]);
        }
        this._updateShadowDistance();
    }

    // --- Screen <-> world ---------------------------------------------------

    // The camera was moved, the frame has not been drawn yet — sync the hierarchy so the
    // projections below read fresh matrices (zoom to cursor, "follow the pointer" pan).
    refreshMatrices() {
        this.camEntity.syncHierarchy();
    }

    _renderScale() {
        const cw = this.world.canvas.clientWidth || 1;
        return this.world.app.graphicsDevice.width / cw;
    }

    // Screen point (canvas CSS px) -> map point ({x, y}) under the cursor.
    // With terrain — the ray intersection with the TERRAIN, without it — the plane h.
    // null — the ray looks into the sky.
    pointerToGround(px, py, h, terrain) {
        const k = this._renderScale();
        const dev = this.world.app.graphicsDevice;
        const sx = px * k, sy = py * k;
        const near = this.camComp.nearClip;
        const cam = this.camComp.camera;
        const p0 = cam.screenToWorld(sx, sy, near, dev.width, dev.height);
        const p1 = cam.screenToWorld(sx, sy, near + 1, dev.width, dev.height);
        const d = new pc.Vec3().sub2(p1, p0);
        if (Math.abs(d.y) < 1e-6) return null;
        d.normalize();
        const o = p0;
        const planeT = (yy) => (yy - o.y) / d.y;
        if (terrain && terrain.hgrid && Number.isFinite(terrain.hMin)) {
            // March along the ray from a level above the terrain maximum to a level below
            // the minimum; the first step under the surface is refined by bisection.
            let t0 = planeT(terrain.hMax + 1), t1 = planeT(terrain.hMin - 1);
            if (t1 > 0) {
                if (t0 < 0) t0 = 0;
                if (t1 > t0) {
                    const steps = Math.min(200, Math.max(48, Math.ceil((t1 - t0) / 4)));
                    const dt = (t1 - t0) / steps;
                    const under = (t) => (o.y + d.y * t) < terrain.heightAt(-(o.x + d.x * t), o.z + d.z * t);
                    let ta = t0;
                    for (let i = 1; i <= steps; i++) {
                        const t = t0 + dt * i;
                        if (under(t)) {
                            let a = ta, b = t;
                            for (let j = 0; j < 10; j++) {
                                const m = (a + b) / 2;
                                if (under(m)) b = m; else a = m;
                            }
                            const tm = (a + b) / 2;
                            return { x: -(o.x + d.x * tm), y: o.z + d.z * tm };
                        }
                        ta = t;
                    }
                }
            }
        }
        const t = planeT(h || 0);
        if (t <= 0) return null;
        return { x: -(o.x + d.x * t), y: o.z + d.z * t };
    }

    // Map point (x, y and height) -> screen CSS pixels of the canvas.
    // visible — the point is inside the viewport and in front of the camera.
    projectToScreen(x, y2d, h) {
        const k = this._renderScale();
        const dev = this.world.app.graphicsDevice;
        this.refreshMatrices();
        const w = new pc.Vec3(-x, h || 0, y2d);
        const vp = new pc.Mat4().mul2(this.camComp.projectionMatrix, this.camComp.viewMatrix);
        const m = vp.data;
        const wc = w.x * m[3] + w.y * m[7] + w.z * m[11] + m[15];
        const s = this.camComp.camera.worldToScreen(w, dev.width, dev.height);
        const sx = s.x / k, sy = s.y / k;
        const behind = wc <= 0;
        return {
            x: sx, y: sy, behind: behind,
            visible: !behind && sx >= 0 && sy >= 0 && sx <= dev.width / k && sy <= dev.height / k
        };
    }

    // Everything created in the view dies with it — and leaves no dangling instances in
    // the shared custom layers (pc culls by layer lists; a stale entry crashes the cull).
    dispose() {
        this.active = false;
        if (this.world.view === this) this.world.view = null;
        this._syncFns = [];
        for (const mi of this.allMeshInstances()) this.dropFromLayers(mi);
        for (const rec of [...(this._inks || []).values()]) {
            for (const mi of [rec.mi]) this.dropFromLayers(mi);
        }
        for (const hull of [...(this._outlines || []).values()]) this.dropFromLayers(hull);
        for (const asset of (this._assets || [])) {
            try { asset.unload(); this.app.assets.remove(asset); } catch (e) { /* ok */ }
        }
        try { this.root.destroy(); } catch (e) { /* already disposed */ }
        this.root = null;
        this.scene = null;
    }
}
View3D._uid = 0;

// Distance from the camera target to the sun (kept for API compatibility; PlayCanvas
// places the shadow camera by itself).
View3D.LIGHT_DIST = 2200;
// Minimum half-size of the shadow area: one object with its shadow.
View3D.SHADOW_MIN_RADIUS = 140;

// --- Camera facade ------------------------------------------------------------------
// CameraController talks to a Babylon-shaped camera: fov in RADIANS, a position vector in
// map space (x, height, y) with .set(), setTarget(vec). The facade mirrors everything into
// the PlayCanvas entity.
class ArcCamera {
    constructor(view) {
        this.view = view;
        this._fov = ((typeof CAMERA_FOV_DEG !== 'undefined') ? CAMERA_FOV_DEG : 52) * Math.PI / 180;
        this.position = new ArcVec3(0, 600, 0, (v) => this._apply(v, this._target));
        this._target = new ArcVec3(1, 0, 1, (v) => this._apply(this.position, v));
    }

    get fov() { return this._fov; }
    set fov(rad) {
        this._fov = rad;
        this.view.camComp.fov = Math.max(1, rad * 180 / Math.PI);
    }

    getTarget() { return this._target; }

    setTarget(v) {
        this._target.set(v.x, v.y, v.z);
    }

    _apply(pos, target) {
        const e = this.view.camEntity;
        e.setPosition(-pos.x, pos.y, pos.z);
        e.lookAt(new pc.Vec3(-target.x, target.y, target.z), pc.Vec3.UP);
    }
}

// A Babylon-shaped vector: mutable fields and set(), with a callback on change.
class ArcVec3 {
    constructor(x, y, z, onChange) {
        this.x = x; this.y = y; this.z = z;
        this._onChange = onChange;
    }
    set(x, y, z) {
        this.x = x; this.y = y; this.z = z;
        if (this._onChange) this._onChange(this);
        return this;
    }
    copy(o) { return this.set(o.x, o.y, o.z); }
}
