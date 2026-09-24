// WanderMesh.js — the game's geometry: every mesh in Wanderburg is built procedurally here, in
// the kit's conventions, with no external model files at all.
//
// Why procedural: the look of the game is "minimalist medieval-steampunk", which is boxes,
// cylinders, cones and prisms under toon bands with ink edges. Building it in code keeps the
// archive tiny, lets a castle grow with its tier without a re-export, and lets a biome repaint
// the whole valley with one palette swap.
//
// CONVENTIONS (skill world3d §Coordinates, skill render-conventions):
//   * positions are authored in WORLD (pc) space: map x -> −x, map y -> +z, height -> +y.
//     A part that must point where the castle drives therefore extends toward −x
//     (gun barrels, the ram, the knight's lance);
//   * normals are computed per vertex by Mesh3D.normals and the winding is fixed against them,
//     so nothing here can come out inside-out;
//   * hand-built convex meshes are registered with { outline: false } — the inverted hull wins
//     the depth tie on them and would paint the object black (skill world3d §Pitfalls). Ink
//     edges and toon bands stay, and they carry the whole look;
//   * materials and meshes are CACHED per (geometry key, color): a part is built once and
//     reused by every castle, village and tree in the valley.
//
// Builders return a RECIPE: a list of { key, hex, geo, opts?, spin?, barrier? }. The view
// (js/WanderView.js) turns a recipe into an entity tree — one child entity per entry, so a
// `spin` part (a wheel) can rotate on its own axis.
//
// This is a VIEW file: it may use pc.*, unlike js/Game.js (tests/apigate.test.mjs gates that).

/** @satisfies {Record<string, any>} */
const WanderMesh = {
    /** @type {Map<string, pc.StandardMaterial>} */
    _mats: new Map(),
    /** @type {Map<string, pc.Mesh>} */
    _meshes: new Map(),

    // --- materials and meshes -------------------------------------------------------------
    /**
     * A shared toon material of one color.
     * @param {any} device pc.GraphicsDevice
     * @param {number} hex 0xRRGGBB
     * @param {{ glow?: number, glowColor?: number, alpha?: number }} [opts] glow 0..1 — emissive
     *        (arcane, fire); alpha < 1 — transparent (blob shadows)
     */
    material(device, hex, opts) {
        const o = opts || {};
        const key = hex + '|' + (o.glow || 0) + '|' + (o.glowColor || 0);
        const hit = this._mats.get(key);
        if (hit) return hit;
        const mat = /** @type {ArcMaterial} */ (new pc.StandardMaterial());
        mat.name = 'wb-' + key;
        const c = World3D.hexColor3(hex);
        mat.diffuse = new pc.Color(c.r, c.g, c.b);
        if (o.glow) {
            const g = World3D.hexColor3(o.glowColor || hex);
            mat.emissive = new pc.Color(g.r * o.glow, g.g * o.glow, g.b * o.glow);
        }
        if (o.alpha != null && o.alpha < 1) {
            // A blob shadow: a flat disc that reads as the toon shadow of the hull above it.
            mat.blendType = pc.BLEND_NORMAL;
            mat.opacity = o.alpha;
            mat.depthWrite = false;
        }
        mat.update();
        this._mats.set(key, mat);
        return mat;
    },

    /**
     * A mesh from a positions array (normals and winding fixed by Mesh3D.normals).
     * NOT cached on purpose: PlayCanvas releases a mesh's GPU buffers when a mesh instance
     * referencing it is destroyed, and Wanderburg reuses recipes across many entities — a
     * shared mesh meant one eaten village could pull the GPU buffers out from under every
     * other house built from the same recipe (measured: forward pass dies on
     * `indexBuffer.impl` of a released buffer). One mesh per instance costs a little memory
     * and buys an unbreakable scene.
     */
    mesh(device, key, positions) {
        const m = new pc.Mesh(device);
        /** @type {any} */ (m).name = key;
        const n = positions.length / 3;
        const idx = new Uint32Array(n);
        for (let i = 0; i < n; i++) idx[i] = i;
        m.setPositions(positions);
        m.setNormals(Mesh3D.normals(positions, idx));
        m.setIndices(idx);
        m.update(pc.PRIMITIVE_TRIANGLES);
        return m;
    },

    // --- primitives (WORLD space) -----------------------------------------------------------
    /** An axis box w(x) · h(y) · d(z) centered at (cx, cy, cz). Flat-shaded: 36 own vertices. */
    box(w, h, d, cx, cy, cz) {
        const x = w / 2, y = h / 2, z = d / 2, X = cx || 0, Y = cy || 0, Z = cz || 0;
        const v = [
            [X - x, Y - y, Z - z], [X + x, Y - y, Z - z], [X + x, Y + y, Z - z], [X - x, Y + y, Z - z],
            [X - x, Y - y, Z + z], [X + x, Y - y, Z + z], [X + x, Y + y, Z + z], [X - x, Y + y, Z + z]
        ];
        const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [1, 2, 6, 5], [4, 7, 3, 0], [3, 7, 6, 2], [0, 1, 5, 4]];
        const out = [];
        for (const f of faces) {
            out.push(...v[f[0]], ...v[f[2]], ...v[f[1]]);
            out.push(...v[f[0]], ...v[f[3]], ...v[f[2]]);
        }
        return out;
    },

    /** A prism of `seg` sides: bottom radius rb at height by, top radius rt at ty, axis = y. */
    cylinder(rb, rt, seg, by, ty, cx, cz) {
        const out = [], X = cx || 0, Z = cz || 0, n = Math.max(3, seg | 0);
        const ring = (r, y) => {
            const p = [];
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2;
                p.push([X + Math.cos(a) * r, y, Z + Math.sin(a) * r]);
            }
            return p;
        };
        const b = ring(rb, by), t = ring(rt, ty);
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            out.push(...b[i], ...b[j], ...t[j]);
            out.push(...b[i], ...t[j], ...t[i]);
        }
        if (rt > 0.001) for (let i = 1; i < n - 1; i++) out.push(...t[0], ...t[i], ...t[i + 1]);
        if (rb > 0.001) for (let i = 1; i < n - 1; i++) out.push(...b[0], ...b[i + 1], ...b[i]);
        return out;
    },

    cone(r, h, seg, by, cx, cz) { return this.cylinder(r, 0, seg, by, by + h, cx, cz); },

    /** A low sphere of `seg` × `rings` quads, centered at (cx, cy, cz). */
    sphere(r, seg, rings, cy, cx, cz) {
        const out = [], X = cx || 0, Y = cy || 0, Z = cz || 0;
        const n = Math.max(3, seg | 0), m = Math.max(2, rings | 0);
        const ring = (j) => {
            const phi = (j / m) * Math.PI;
            const rr = Math.sin(phi) * r, yy = Y + Math.cos(phi) * r;
            const p = [];
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2;
                p.push([X + Math.cos(a) * rr, yy, Z + Math.sin(a) * rr]);
            }
            return p;
        };
        for (let j = 0; j < m; j++) {
            const a = ring(j), b = ring(j + 1);
            for (let i = 0; i < n; i++) {
                const k = (i + 1) % n;
                out.push(...a[i], ...a[k], ...b[k]);
                out.push(...a[i], ...b[k], ...b[i]);
            }
        }
        return out;
    },

    /** A pyramid roof over a w × d footprint, base at height by, apex h above it. */
    roof(w, d, h, by, cx, cz, over) {
        const o = over == null ? 1.14 : over, X = cx || 0, Z = cz || 0;
        const x = w * o / 2, z = d * o / 2;
        const c = [[X - x, by, Z - z], [X + x, by, Z - z], [X + x, by, Z + z], [X - x, by, Z + z]];
        const apex = [X, by + h, Z];
        const out = this.box(w * o, h * 0.14, d * o, X, by + h * 0.07, Z);
        for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            out.push(...c[i], ...c[j], ...apex);
        }
        return out;
    },

    /** Merlons along a wall of length len at height by, centered on (cx, cz), running along x. */
    merlons(len, n, mw, mh, by, cx, cz) {
        const out = [];
        for (let i = 0; i < n; i++) {
            const x = (cx || 0) - len / 2 + (n === 1 ? 0 : (i / (n - 1)) * len);
            out.push(...this.box(mw, mh, mw, x, by + mh / 2, cz || 0));
        }
        return out;
    },

    /**
     * A wheel whose axle runs along z (the hull's lateral axis), built AROUND ITS OWN CENTER so
     * the view can hang it on a child entity and spin that entity about z — a wheel baked at a
     * distance from its axle would wobble instead of rolling.
     */
    wheel(r, t, seg) {
        const n = Math.max(6, seg | 0), out = [];
        const ring = (z) => {
            const p = [];
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2;
                p.push([Math.cos(a) * r, Math.sin(a) * r, z]);
            }
            return p;
        };
        const a = ring(-t / 2), b = ring(t / 2);
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            out.push(...a[i], ...a[j], ...b[j]);
            out.push(...a[i], ...b[j], ...b[i]);
        }
        for (let i = 1; i < n - 1; i++) { out.push(...a[0], ...a[i + 1], ...a[i]); out.push(...b[0], ...b[i], ...b[i + 1]); }
        // Four spokes, each rotated into place about the axle (z): that is what makes the spin
        // readable at a glance.
        for (let s = 0; s < 4; s++) {
            const ang = (s / 4) * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
            const spoke = this.box(r * 0.15, r * 1.78, t * 0.5, 0, 0, 0);
            for (let k = 0; k < spoke.length; k += 3) {
                const y = spoke[k + 1], z = spoke[k + 2];
                spoke[k + 1] = y * ca - z * sa;
                spoke[k + 2] = y * sa + z * ca;
            }
            out.push(...spoke);
        }
        return out;
    },

    /** A hub cap across both faces of a wheel of radius r and thickness t. */
    hub(r, t) {
        return this.merge([
            this.box(r * 0.5, r * 0.5, t * 1.5, 0, 0, 0),
            this.rotate(this.box(r * 0.5, r * 0.5, t * 1.5, 0, 0, 0), 0, 0, Math.PI / 4)
        ]);
    },

    /**
     * Rotate a geometry list about the origin: ax — world x, ay — world y (height), az — world z.
     * Used to lay a vertical primitive on its side (a log, a barrel on a wagon).
     */
    rotate(geo, ax, ay, az) {
        const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
        const cz = Math.cos(az), sz = Math.sin(az);
        const out = new Array(geo.length);
        for (let i = 0; i < geo.length; i += 3) {
            let x = geo[i], y = geo[i + 1], z = geo[i + 2];
            // about y
            let x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
            // about z
            let x2 = x1 * cz - y * sz, y2 = x1 * sz + y * cz;
            // about x
            out[i] = x2;
            out[i + 1] = y2 * cx - z1 * sx;
            out[i + 2] = y2 * sx + z1 * cx;
        }
        return out;
    },

    /** Translate a geometry list by (dx, dy, dz) in WORLD space (a house placed inside a village). */
    // Uniform scale, a yaw (rad) about the base, then an offset: baked pack geometry (js/WanderPackGeo.js)
    // into recipe space. The arrays are positions only (triangles), so a plain affine pass is enough.
    xform(geo, o) {
        const s = (o && o.s != null) ? o.s : 1;
        const yaw = (o && o.yaw) || 0;
        const c = Math.cos(yaw), sn = Math.sin(yaw);
        const dx = (o && o.dx) || 0, dy = (o && o.dy) || 0, dz = (o && o.dz) || 0;
        const out = new Array(geo.length);
        for (let i = 0; i < geo.length; i += 3) {
            const x = geo[i] * s, z = geo[i + 2] * s;
            out[i] = x * c - z * sn + dx;
            out[i + 1] = geo[i + 1] * s + dy;
            out[i + 2] = x * sn + z * c + dz;
        }
        return out;
    },

    translate(geo, dx, dy, dz) {
        const out = new Array(geo.length);
        for (let i = 0; i < geo.length; i += 3) { out[i] = geo[i] + dx; out[i + 1] = geo[i + 1] + dy; out[i + 2] = geo[i + 2] + dz; }
        return out;
    },

    merge(list) {
        const out = [];
        for (const g of list) if (g) for (let i = 0; i < g.length; i++) out.push(g[i]);
        return out;
    },

    /** Deterministic jitter 0..1 from a seed — variety without Math.random. */
    rnd(seed) {
        let s = (seed >>> 0) || 1;
        return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    },

    // --- the walking castle -----------------------------------------------------------------
    /**
     * A castle recipe. `o`: { tier, faction, kind, seed }.
     * Returns { parts, r, deckY, hullL, hullW, wallH, wheelR, wheelZ, wheelXs } — the view needs
     * the wheel layout to hang the wheels on their own spinning child entities.
     */
    castleParts(o) {
        const tier = WB.M.clamp(o.tier | 0, 1, 5);
        const r = WB.tierRadius(tier);
        const P = WB.PAL;
        const player = o.faction === 'player';
        const boss = o.kind === 'warden' || o.kind === 'crown';
        const crown = o.kind === 'crown';
        const wall = player ? P.stone : boss ? P.ironDark : P.enemyIron;
        const wallDark = player ? P.stoneDark : P.black;
        const trim = player ? P.brass : boss ? P.gold : P.copper;
        const banner = player ? P.banner : P.enemy;
        const wood = player ? P.wood : P.woodDark;
        const parts = [];
        const add = (key, hex, geo, opts) => { parts.push({ key, hex, geo, opts }); };

        const hullW = r * 1.9, hullL = r * 2.1, deckY = r * 0.5;
        const wheelR = r * 0.46, wheelT = r * 0.22, wheelZ = hullW / 2 + wheelT * 0.2;
        const wheelXs = [];
        const wheels = Math.max(2, Math.round(tier * 0.8) + 1);
        for (let i = 0; i < wheels; i++) wheelXs.push(-hullL * 0.36 + (i / Math.max(1, wheels - 1)) * hullL * 0.72);

        // --- the rolling platform
        add('skirt', wood, this.merge([
            this.box(hullL, deckY * 0.6, hullW, 0, deckY * 0.44, 0),
            this.box(hullL * 1.02, deckY * 0.26, hullW * 0.34, 0, deckY * 0.12, -hullW * 0.4),
            this.box(hullL * 1.02, deckY * 0.26, hullW * 0.34, 0, deckY * 0.12, hullW * 0.4)
        ]));
        add('strakes', player ? P.iron : P.ironDark, this.merge([
            this.box(hullL * 0.94, deckY * 0.22, 4.5, 0, deckY * 0.66, -hullW / 2),
            this.box(hullL * 0.94, deckY * 0.22, 4.5, 0, deckY * 0.66, hullW / 2),
            this.box(hullL * 0.5, deckY * 0.2, 4.5, -hullL * 0.2, deckY * 0.3, -hullW / 2),
            this.box(hullL * 0.5, deckY * 0.2, 4.5, hullL * 0.2, deckY * 0.3, hullW / 2)
        ]));

        // --- the walls
        const wallH = r * (boss ? 0.78 : 0.62), wallT = r * 0.2, wy = deckY + wallH / 2;
        add('walls', wall, this.merge([
            this.box(hullL * 0.92, wallH, wallT, 0, wy, -hullW * 0.42),
            this.box(hullL * 0.92, wallH, wallT, 0, wy, hullW * 0.42),
            this.box(wallT, wallH, hullW * 0.88, -hullL * 0.45, wy, 0),
            this.box(wallT, wallH, hullW * 0.88, hullL * 0.45, wy, 0)
        ]));
        add('wallTrim', wallDark, this.merge([
            this.box(hullL * 0.94, wallH * 0.14, wallT * 1.25, 0, deckY + wallH * 0.93, -hullW * 0.42),
            this.box(hullL * 0.94, wallH * 0.14, wallT * 1.25, 0, deckY + wallH * 0.93, hullW * 0.42)
        ]));
        add('merlons', wallDark, this.merge([
            this.merlons(hullL * 0.84, 5 + tier, r * 0.15, r * 0.19, deckY + wallH, 0, -hullW * 0.42),
            this.merlons(hullL * 0.84, 5 + tier, r * 0.15, r * 0.19, deckY + wallH, 0, hullW * 0.42)
        ]));

        // --- the keep
        const keepH = r * (boss ? 1.6 : 1.2), keepW = r * 0.6, ky = deckY + wallH * 0.35;
        add('keep', wall, this.merge([
            this.box(keepW, keepH, keepW, 0, ky + keepH / 2, 0),
            this.box(keepW * 1.18, keepH * 0.09, keepW * 1.18, 0, ky + keepH * 0.97, 0)
        ]));
        add('keepRoof', player ? P.roof : P.roofDark, this.roof(keepW, keepW, keepH * (boss ? 0.6 : 0.5), ky + keepH, 0, 0));
        add('pole', wood, this.box(3.4, r * 0.7, 3.4, 0, ky + keepH * 1.3, 0));
        add('banner', banner, this.box(r * 0.46, r * 0.32, 2.6, -r * 0.25, ky + keepH * 1.44, 0));

        // --- corner turrets from tier 3 up
        if (tier >= 3) {
            const tg = [], tr = [];
            const tw = r * 0.28, th = r * (boss ? 1 : 0.74);
            for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
                const x = sx * hullL * 0.4, z = sz * hullW * 0.4;
                tg.push(...this.cylinder(tw, tw * 0.94, 8, deckY, deckY + th, x, z));
                tr.push(...this.cone(tw * 1.35, th * 0.58, 8, deckY + th, x, z));
            }
            add('turrets', wall, tg);
            add('turretRoofs', player ? P.roof : P.roofDark, tr);
        }

        // --- the funnels
        const stacks = boss ? 3 : Math.max(1, Math.round(tier / 2));
        const sg = [], sc = [];
        for (let i = 0; i < stacks; i++) {
            const x = hullL * 0.3 + i * r * 0.2;
            const z = (i - (stacks - 1) / 2) * r * 0.36;
            const hh = r * (boss ? 1 : 0.72) * (1 - i * 0.07);
            sg.push(...this.cylinder(r * 0.13, r * 0.15, 8, deckY, deckY + hh, x, z));
            sc.push(...this.cylinder(r * 0.175, r * 0.175, 8, deckY + hh, deckY + hh + r * 0.07, x, z));
        }
        add('stacks', P.ironDark, sg);
        add('stackCaps', trim, sc);

        // --- the ram and the boiler at the nose
        add('ram', trim, this.merge([
            this.box(r * 0.52, r * 0.26, r * 0.52, -hullL * 0.5 - r * 0.16, deckY + r * 0.16, 0),
            this.box(r * 0.3, r * 0.16, r * 0.3, -hullL * 0.5 - r * 0.42, deckY + r * 0.16, 0)
        ]));
        add('boiler', P.copper, this.cylinder(r * 0.26, r * 0.26, 10, deckY, deckY + r * 0.52, -hullL * 0.3, 0));

        // --- a boss wears a crown of spikes; the Iron Crown wears a real one
        if (boss) {
            const sp = [], n = crown ? 14 : 10;
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2;
                sp.push(...this.cone(r * 0.12, r * (crown ? 0.8 : 0.6), 5, deckY + wallH * 0.92,
                    Math.cos(a) * hullL * 0.34, Math.sin(a) * hullW * 0.34));
            }
            add('crown', P.gold, sp, { glow: crown ? 0.3 : 0.14, glowColor: P.gold });
        }
        return { parts, r, deckY, hullL, hullW, wallH, wheelR, wheelT, wheelZ, wheelXs, boss, crown, player };
    },

    /** The wheel parts of a castle: one recipe entry per wheel, each on its own spinning node. */
    castleWheels(layout, faction) {
        const P = WB.PAL;
        const out = [];
        for (const side of [-1, 1]) {
            for (const x of layout.wheelXs) {
                out.push({
                    key: 'wheel', hex: faction === 'player' ? P.woodDark : P.ironDark,
                    geo: this.wheel(layout.wheelR, layout.wheelT, 10),
                    at: [-x, layout.wheelR * 0.96, side * layout.wheelZ], spin: 'wheel'
                });
                out.push({
                    key: 'hub', hex: faction === 'player' ? P.brass : P.copper,
                    geo: this.hub(layout.wheelR, layout.wheelT),
                    at: [-x, layout.wheelR * 0.96, side * layout.wheelZ], spin: 'wheel'
                });
            }
        }
        return out;
    },

    // --- module mounts ------------------------------------------------------------------------
    /** A module recipe. The mount is a child entity the view yaws to the module's aim. */
    moduleParts(id, level, faction) {
        const P = WB.PAL;
        const player = faction === 'player';
        const metal = player ? P.brass : P.copper;
        const dark = player ? P.iron : P.ironDark;
        const parts = [];
        const add = (key, hex, geo, opts) => { parts.push({ key, hex, geo, opts }); };
        const s = 1 + (WB.M.clamp(level | 0, 1, 3) - 1) * 0.13;
        switch (id) {
            case 'bombard':
                add('base', dark, this.cylinder(15 * s, 17 * s, 8, 0, 11 * s, 0, 0));
                add('barrel', metal, this.barrel(7 * s, 9 * s, 36 * s, 16 * s));
                add('mouth', P.ironLight, this.ring(9.2 * s, 5 * s, -34 * s, 16 * s));
                break;
            case 'culverin':
                add('base', dark, this.cylinder(15 * s, 18 * s, 8, 0, 13 * s, 0, 0));
                add('barrel', metal, this.barrel(5.4 * s, 7.4 * s, 64 * s, 18 * s));
                add('bands', P.ironLight, this.merge([this.ring(7.8 * s, 3 * s, -24 * s, 18 * s), this.ring(6.4 * s, 3 * s, -52 * s, 18 * s)]));
                break;
            case 'gatling':
                add('base', dark, this.cylinder(14 * s, 16 * s, 8, 0, 10 * s, 0, 0));
                add('drum', metal, this.cylinder(11 * s, 11 * s, 10, 11 * s, 25 * s, 0, 0));
                add('barrels', P.ironLight, this.gatling(6, 2.6 * s, 30 * s, 18 * s, -16 * s));
                break;
            case 'ballista':
                add('frame', P.wood, this.merge([this.box(30 * s, 4, 6, -6 * s, 11 * s, 0), this.box(6, 13 * s, 4, 5 * s, 15 * s, 0)]));
                add('arms', metal, this.box(4, 3, 36 * s, -13 * s, 19 * s, 0));
                add('bolt', P.steel, this.box(30 * s, 2.4, 2.4, -15 * s, 19 * s, 0));
                break;
            case 'spire':
                add('base', dark, this.cylinder(15 * s, 18 * s, 8, 0, 9 * s, 0, 0));
                add('tower', player ? P.stoneDark : P.enemyIron, this.cylinder(9 * s, 12 * s, 8, 9 * s, 42 * s, 0, 0));
                add('orb', P.arcane, this.sphere(8.5 * s, 8, 5, 48 * s), { glow: 0.85, glowColor: P.arcane });
                add('spikes', metal, this.merge([this.cone(3 * s, 15 * s, 4, 42 * s, 9 * s, 0), this.cone(3 * s, 15 * s, 4, 42 * s, -9 * s, 0)]));
                break;
            case 'mortar':
                add('base', dark, this.cylinder(18 * s, 20 * s, 8, 0, 9 * s, 0, 0));
                add('tube', metal, this.cylinder(12 * s, 14.5 * s, 10, 9 * s, 32 * s, -5 * s, 0));
                add('mouth', P.ironLight, this.ring(15 * s, 5 * s, -5 * s, 33 * s));
                break;
            case 'flame':
                add('tank', P.copper, this.cylinder(12 * s, 12 * s, 10, 2 * s, 27 * s, 7 * s, 0));
                add('nozzle', dark, this.barrel(4.6 * s, 6.4 * s, 28 * s, 13 * s));
                add('pilot', P.flame, this.sphere(3.6 * s, 6, 4, 13 * s, -28 * s, 0), { glow: 0.95, glowColor: P.flame });
                break;
            case 'tesla':
                add('base', dark, this.cylinder(16 * s, 19 * s, 8, 0, 8 * s, 0, 0));
                add('coil', metal, this.merge([this.cylinder(4 * s, 9 * s, 8, 8 * s, 36 * s, 0, 0), this.ring(10 * s, 2.4 * s, 0, 38 * s)]));
                add('arc', P.arcane, this.sphere(6.4 * s, 8, 5, 45 * s), { glow: 1, glowColor: P.arcane });
                break;
            case 'hive':
                add('box', P.wood, this.box(23 * s, 21 * s, 23 * s, 0, 12 * s, 0));
                add('roof', P.thatch, this.roof(23 * s, 23 * s, 11 * s, 22 * s, 0, 0));
                add('holes', P.black, this.merge([this.box(4, 4, 2.4, -12 * s, 10 * s, 0), this.box(4, 4, 2.4, 12 * s, 15 * s, 0)]));
                break;
            case 'workshop':
                add('shed', P.wood, this.box(27 * s, 17 * s, 23 * s, 0, 9 * s, 0));
                add('roof', P.roofDark, this.roof(27 * s, 23 * s, 12 * s, 17 * s, 0, 0));
                add('anvil', P.ironLight, this.merge([this.box(10 * s, 6 * s, 6 * s, -15 * s, 4 * s, 0), this.box(5 * s, 5 * s, 5 * s, -15 * s, 9 * s, 0)]));
                break;
            case 'boiler':
                add('tank', P.copper, this.cylinder(14 * s, 14 * s, 12, 0, 31 * s, 0, 0));
                add('pipes', P.brass, this.merge([this.cylinder(3 * s, 3 * s, 6, 31 * s, 42 * s, 7 * s, 0), this.cylinder(3 * s, 3 * s, 6, 31 * s, 42 * s, -7 * s, 0)]));
                add('gauge', P.steel, this.cylinder(5 * s, 5 * s, 8, 17 * s, 21 * s, -14 * s, 0));
                break;
            case 'plate':
                add('plates', P.ironLight, this.merge([
                    this.box(31 * s, 17 * s, 4, 0, 9 * s, -13 * s), this.box(31 * s, 17 * s, 4, 0, 9 * s, 13 * s),
                    this.box(4, 17 * s, 27 * s, -15 * s, 9 * s, 0)
                ]));
                add('rivets', P.brass, this.merge([this.sphere(2.2, 5, 3, 17 * s, -6 * s, -13 * s), this.sphere(2.2, 5, 3, 17 * s, 6 * s, 13 * s)]));
                break;
            case 'masonry':
                add('wall', player ? P.stoneLight : P.stoneDark, this.box(31 * s, 23 * s, 27 * s, 0, 12 * s, 0));
                add('course', P.stoneDark, this.box(32 * s, 3.4, 28 * s, 0, 23 * s, 0));
                break;
            case 'keg':
                add('barrel', P.woodDark, this.cylinder(13 * s, 13 * s, 12, 0, 27 * s, 0, 0));
                add('bands', P.iron, this.merge([this.ring(13.6 * s, 3 * s, 0, 7 * s), this.ring(13.6 * s, 3 * s, 0, 21 * s)]));
                add('fuse', P.flame, this.box(2.4, 9, 2.4, 0, 31 * s, 0), { glow: 0.7, glowColor: P.flame });
                break;
            case 'ram':
                add('beam', P.woodDark, this.box(48 * s, 13 * s, 15 * s, -20 * s, 9 * s, 0));
                add('tip', P.ironLight, this.merge([this.box(10 * s, 10 * s, 10 * s, -48 * s, 9 * s, 0), this.box(6 * s, 6 * s, 6 * s, -56 * s, 9 * s, 0)]));
                break;
            case 'banner':
                add('pole', P.wood, this.box(3.4, 48 * s, 3.4, 0, 24 * s, 0));
                add('cloth', P.enemy, this.box(21 * s, 15 * s, 2.4, -11 * s, 40 * s, 0), { glow: 0.12, glowColor: P.enemy });
                break;
            case 'sail':
                add('mast', P.wood, this.box(3.6, 54 * s, 3.6, 0, 27 * s, 0));
                add('cloth', P.arcaneDeep, this.box(3, 32 * s, 30 * s, 0, 36 * s, 0), { glow: 0.3, glowColor: P.arcane });
                break;
            case 'nest':
                add('post', P.wood, this.box(4, 42 * s, 4, 0, 21 * s, 0));
                add('nest', P.woodDark, this.cylinder(13 * s, 9 * s, 8, 42 * s, 50 * s, 0, 0));
                add('bird', P.black, this.merge([this.sphere(4, 6, 4, 55 * s, 0, 0), this.box(13, 1.6, 3, 0, 55 * s, 0)]));
                break;
            case 'reliquary':
                add('case', P.gold, this.box(21 * s, 23 * s, 17 * s, 0, 12 * s, 0), { glow: 0.2, glowColor: P.gold });
                add('roof', P.roofDark, this.roof(21 * s, 17 * s, 13 * s, 23 * s, 0, 0));
                add('gem', P.arcane, this.sphere(5 * s, 6, 4, 14 * s, -11 * s, 0), { glow: 1, glowColor: P.arcane });
                break;
            case 'furnace':
                add('box', P.ironDark, this.box(27 * s, 23 * s, 23 * s, 0, 12 * s, 0));
                add('mouth', P.flame, this.box(15 * s, 11 * s, 2.4, -14 * s, 10 * s, 0), { glow: 1, glowColor: P.flame });
                add('pipe', P.iron, this.cylinder(5 * s, 5 * s, 8, 23 * s, 42 * s, 0, 0));
                break;
            default:
                add('crate', P.wood, this.box(21, 19, 21, 0, 9.5, 0));
        }
        return parts;
    },

    /** A gun barrel along −x (forward for a mount at aim 0), its axis at height y. */
    barrel(rMuzzle, rBreech, len, y) {
        const seg = 8, out = [];
        const ringAt = (x, r) => {
            const p = [];
            for (let i = 0; i < seg; i++) {
                const a = (i / seg) * Math.PI * 2;
                p.push([x, y + Math.cos(a) * r, Math.sin(a) * r]);
            }
            return p;
        };
        const a = ringAt(-len, rMuzzle), b = ringAt(0, rBreech);
        for (let i = 0; i < seg; i++) {
            const j = (i + 1) % seg;
            out.push(...a[i], ...a[j], ...b[j]);
            out.push(...a[i], ...b[j], ...b[i]);
        }
        for (let i = 1; i < seg - 1; i++) { out.push(...b[0], ...b[i], ...b[i + 1]); out.push(...a[0], ...a[i + 1], ...a[i]); }
        return out;
    },

    /** A band around a barrel whose axis runs along −x at height y. */
    ring(r, h, x, y) {
        const seg = 8, out = [];
        const ringAt = (xx) => {
            const p = [];
            for (let i = 0; i < seg; i++) {
                const a = (i / seg) * Math.PI * 2;
                p.push([xx, y + Math.cos(a) * r, Math.sin(a) * r]);
            }
            return p;
        };
        const a = ringAt(x - h / 2), b = ringAt(x + h / 2);
        for (let i = 0; i < seg; i++) {
            const j = (i + 1) % seg;
            out.push(...a[i], ...a[j], ...b[j]);
            out.push(...a[i], ...b[j], ...b[i]);
        }
        for (let i = 1; i < seg - 1; i++) { out.push(...a[0], ...a[i], ...a[i + 1]); out.push(...b[0], ...b[i + 1], ...b[i]); }
        return out;
    },

    /** A gatling bundle: n barrels around an axis at height y, starting at x0 and going −x. */
    gatling(n, r, len, y, x0) {
        const out = [];
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2;
            out.push(...this.box(len, r * 2, r * 2, x0 - len / 2, y + Math.cos(a) * r * 2.4, Math.sin(a) * r * 2.4));
        }
        return out;
    },

    // --- the valley's props -------------------------------------------------------------------
    house(seed, scale) {
        const P = WB.PAL, rnd = this.rnd(seed), s = scale || 1;
        const w = (26 + rnd() * 16) * s, d = (22 + rnd() * 14) * s, h = (18 + rnd() * 8) * s;
        const parts = [
            { key: 'walls', hex: rnd() < 0.5 ? P.peasant : P.stoneLight, geo: this.box(w, h, d, 0, h / 2, 0) },
            { key: 'beams', hex: P.woodDark, geo: this.merge([
                this.box(w * 1.02, h * 0.13, 2.6, 0, h * 0.54, -d / 2), this.box(w * 1.02, h * 0.13, 2.6, 0, h * 0.54, d / 2),
                this.box(2.6, h, 2.6, -w * 0.36, h / 2, -d / 2), this.box(2.6, h, 2.6, w * 0.36, h / 2, d / 2)
            ]) },
            { key: 'roof', hex: rnd() < 0.6 ? P.thatch : P.roof, geo: this.roof(w, d, h * 0.82, h, 0, 0) },
            { key: 'door', hex: P.woodDark, geo: this.box(w * 0.22, h * 0.52, 1.8, 0, h * 0.26, -d / 2 - 0.7) }
        ];
        if (rnd() < 0.55) parts.push({ key: 'chimney', hex: P.stoneDark, geo: this.box(5 * s, h * 0.62, 5 * s, w * 0.24, h + h * 0.3, d * 0.18) });
        return parts;
    },

    chapel(scale) {
        const P = WB.PAL, s = scale || 1;
        return [
            { key: 'nave', hex: P.stoneLight, geo: this.box(30 * s, 30 * s, 22 * s, 0, 15 * s, 0) },
            { key: 'roof', hex: P.roofDark, geo: this.roof(30 * s, 22 * s, 18 * s, 30 * s, 0, 0) },
            { key: 'tower', hex: P.stone, geo: this.box(14 * s, 46 * s, 14 * s, -18 * s, 23 * s, 0) },
            { key: 'spire', hex: P.roofDark, geo: this.cone(11 * s, 26 * s, 6, 46 * s, -18 * s, 0) },
            { key: 'cross', hex: P.gold, geo: this.merge([this.box(2.4 * s, 10 * s, 2.4 * s, -18 * s, 76 * s, 0), this.box(7 * s, 2.4 * s, 2.4 * s, -18 * s, 77 * s, 0)]) }
        ];
    },

    tree(seed, color, scale) {
        const P = WB.PAL, rnd = this.rnd(seed), s = scale || 1;
        const h = (66 + rnd() * 52) * s;
        const crown = [];
        const tiers = 2 + Math.round(rnd());
        for (let i = 0; i < tiers; i++) {
            crown.push(...this.cone((32 - i * 7) * s * (0.9 + rnd() * 0.22), (40 - i * 8) * s, 7,
                h * (0.38 + (i / tiers) * 0.44), (rnd() - 0.5) * 4 * s, (rnd() - 0.5) * 4 * s));
        }
        return [
            { key: 'trunk', hex: P.trunk, geo: this.cylinder(3.6 * s, 5.4 * s, 6, 0, h * 0.56, 0, 0) },
            { key: 'crown', hex: color == null ? P.leaf : color, geo: crown }
        ];
    },

    rock(seed, color, scale) {
        const P = WB.PAL, rnd = this.rnd(seed), s = scale || 1;
        const geo = [];
        const n = 2 + Math.round(rnd() * 2);
        for (let i = 0; i < n; i++) {
            const r = (11 + rnd() * 19) * s;
            const x = (rnd() - 0.5) * 26 * s, z = (rnd() - 0.5) * 26 * s;
            const j = () => r * (0.72 + rnd() * 0.55);
            const v = [[j(), 0, 0], [-j(), 0, 0], [0, j() * 0.9, 0], [0, -j() * 0.35, 0], [0, 0, j()], [0, 0, -j()]]
                .map(q => [q[0] + x, q[1] + r * 0.55, q[2] + z]);
            const f = [0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 0, 2, 0, 3, 5, 5, 3, 1, 1, 3, 4, 4, 3, 0];
            for (const k of f) geo.push(...v[k]);
        }
        return [{ key: 'rock', hex: color == null ? P.rock : color, geo }];
    },

    bush(seed, color, scale) {
        const P = WB.PAL, rnd = this.rnd(seed), s = scale || 1;
        const geo = [];
        for (let i = 0; i < 3; i++) geo.push(...this.sphere((8 + rnd() * 7) * s, 6, 4, (6 + rnd() * 4) * s, (rnd() - 0.5) * 8 * s, (rnd() - 0.5) * 8 * s));
        return [{ key: 'bush', hex: color == null ? P.leafDark : color, geo }];
    },

    /**
     * A mountain of the impassable ring: a LOW wide hill, not a spike. Spikes read as blades
     * from the game camera and eat the horizon; hills read as the rim of the valley (measured
     * in verify/play-*.png).
     */
    /**
     * A mountain of the impassable ring: tall rock cones with snow caps, so from the game
     * camera the rim reads as a ridge closing the horizon and not as grey puddles.
     * `capColor` — the snow (or sand/dust) on top; per biome.
     */
    peak(seed, color, scale, capColor) {
        const P = WB.PAL, rnd = this.rnd(seed), s = scale || 1;
        const rock = [], cap = [];
        const n = 1 + Math.round(rnd());
        for (let i = 0; i < n; i++) {
            const r = (22 + rnd() * 16) * s;
            const h = (150 + rnd() * 120) * s;
            const x = (rnd() - 0.5) * 34 * s, z = (rnd() - 0.5) * 34 * s;
            rock.push(...this.cone(r, h, 6, 0, x, z));
            cap.push(...this.cone(r * 0.5, h * 0.34, 6, h * 0.68, x, z));
        }
        return [
            { key: 'rock', hex: color == null ? P.rockDark : color, geo: rock },
            { key: 'cap', hex: capColor == null ? 0xeaf0f4 : capColor, geo: cap }
        ];
    },

    peasant(seed) {
        const P = WB.PAL, rnd = this.rnd(seed);
        return [
            { key: 'body', hex: rnd() < 0.5 ? P.peasantCloth : P.roof, geo: this.box(7, 11, 5, 0, 7.5, 0) },
            { key: 'head', hex: P.peasant, geo: this.box(5.4, 5.4, 5.4, 0, 15.6, 0) },
            { key: 'legs', hex: P.woodDark, geo: this.merge([this.box(2.4, 4, 2.4, -1.6, 2, 0), this.box(2.4, 4, 2.4, 1.6, 2, 0)]) }
        ];
    },

    sheep(seed) {
        const P = WB.PAL, rnd = this.rnd(seed);
        void rnd;
        return [
            { key: 'wool', hex: P.wool, geo: this.box(12, 8.5, 7.5, 0, 7.5, 0) },
            { key: 'head', hex: P.hide, geo: this.box(4.2, 4.6, 4.2, -7, 8, 0) },
            { key: 'legs', hex: P.hide, geo: this.merge([
                this.box(1.8, 5, 1.8, -3.6, 2.5, -2.4), this.box(1.8, 5, 1.8, -3.6, 2.5, 2.4),
                this.box(1.8, 5, 1.8, 3.6, 2.5, -2.4), this.box(1.8, 5, 1.8, 3.6, 2.5, 2.4)
            ]) }
        ];
    },

    /** A knight on a bicycle. Two wheels, a frame, a lance — deliberately absurd. */
    knight(seed) {
        const P = WB.PAL, rnd = this.rnd(seed);
        const wr = 9;
        return [
            { key: 'wheelA', hex: P.woodDark, geo: this.wheel(wr, 2.4, 9), at: [-11, wr, 0], spin: 'knight' },
            { key: 'wheelB', hex: P.woodDark, geo: this.wheel(wr, 2.4, 9), at: [11, wr, 0], spin: 'knight' },
            { key: 'frame', hex: P.iron, geo: this.merge([this.box(22, 2.2, 2.2, 0, wr + 2, 0), this.box(2.2, 13, 2.2, -3, wr + 7, 0), this.box(2.2, 9, 2.2, 6, wr + 4, 0)]) },
            { key: 'rider', hex: rnd() < 0.5 ? P.bannerDark : P.enemyDark, geo: this.merge([this.box(7, 14, 6.5, -3, wr + 17, 0), this.box(6, 6.5, 6, -3, wr + 26, 0)]) },
            { key: 'helm', hex: P.steel, geo: this.box(6.6, 3, 6.6, -3, wr + 30, 0) },
            { key: 'lance', hex: P.steel, geo: this.box(36, 2.2, 2.2, -18, wr + 19, 3.6) }
        ];
    },

    wagon() {
        const P = WB.PAL;
        return [
            { key: 'bed', hex: P.woodDark, geo: this.box(27, 4, 17, 0, 10, 0) },
            { key: 'barrel', hex: P.wood, geo: this.cylinder(9.5, 9.5, 10, 12, 28, 0, 0) },
            { key: 'bands', hex: P.iron, geo: this.merge([this.box(21, 2.2, 2.6, 0, 16, 0), this.box(21, 2.2, 2.6, 0, 24, 0)]) },
            { key: 'fuse', hex: P.flame, geo: this.box(2.2, 8, 2.2, 0, 32, 0), opts: { glow: 0.85, glowColor: P.flame } },
            { key: 'wheelA', hex: P.woodDark, geo: this.wheel(8, 3, 8), at: [-9, 8, -9], spin: 'wagon' },
            { key: 'wheelB', hex: P.woodDark, geo: this.wheel(8, 3, 8), at: [9, 8, 9], spin: 'wagon' }
        ];
    },

    node(kind, seed) {
        const P = WB.PAL, rnd = this.rnd(seed);
        if (kind === 'quarry') {
            const geo = [];
            for (let i = 0; i < 5; i++) {
                geo.push(...this.box(15 + rnd() * 17, 12 + rnd() * 21, 15 + rnd() * 15,
                    (rnd() - 0.5) * 46, 8 + rnd() * 9, (rnd() - 0.5) * 46));
            }
            return [
                { key: 'stone', hex: P.stoneDark, geo },
                { key: 'crane', hex: P.wood, geo: this.merge([this.box(4, 48, 4, 24, 24, 0), this.box(32, 3.6, 3.6, 10, 46, 0), this.box(2.4, 14, 2.4, -4, 40, 0)]) }
            ];
        }
        if (kind === 'mine') {
            return [
                { key: 'hill', hex: P.rockDark, geo: this.cone(36, 32, 7, 0, 0, 8) },
                { key: 'frame', hex: P.woodDark, geo: this.merge([this.box(4, 46, 4, -15, 23, -13), this.box(4, 46, 4, 15, 23, -13), this.box(36, 4, 4, 0, 46, -13)]) },
                { key: 'ore', hex: P.copper, geo: this.merge([this.sphere(6.5, 6, 4, 12, 20, -6), this.sphere(5, 6, 4, 20, 26, 4), this.sphere(4.4, 6, 3, 7, 14, 8)]), opts: { glow: 0.24, glowColor: P.copper } },
                { key: 'hut', hex: P.wood, geo: this.merge([this.box(21, 17, 19, -25, 8.5, 13), this.roof(21, 19, 10, 17, -25, 13)]) }
            ];
        }
        return [
            { key: 'hut', hex: P.wood, geo: this.merge([this.box(27, 19, 21, 0, 9.5, 0), this.roof(27, 21, 13, 19, 0, 0)]) },
            { key: 'logs', hex: P.woodLight, geo: this.merge([
                this.rotate(this.cylinder(5, 5, 8, 0, 30, 0, 0), 0, 0, Math.PI / 2).map((v, i) => i % 3 === 0 ? v + 22 : i % 3 === 1 ? v + 5 : v - 10),
                this.rotate(this.cylinder(5, 5, 8, 0, 30, 0, 0), 0, 0, Math.PI / 2).map((v, i) => i % 3 === 0 ? v + 22 : i % 3 === 1 ? v + 5 : v + 2),
                this.rotate(this.cylinder(5, 5, 7, 0, 26, 0, 0), 0, 0, Math.PI / 2).map((v, i) => i % 3 === 0 ? v + 26 : i % 3 === 1 ? v + 15 : v - 4)
            ]) },
            { key: 'saw', hex: P.steel, geo: this.merge([this.box(3, 24, 24, -23, 15, 7), this.box(8, 4, 4, -23, 4, 7)]) }
        ];
    },

    /** The warden gate: two towers, an arch, braziers and a barrier the view lifts when open. */
    gate() {
        const P = WB.PAL;
        return [
            { key: 'towers', hex: P.stoneDark, geo: this.merge([
                this.cylinder(20, 23, 8, 0, 94, 0, -54), this.cylinder(20, 23, 8, 0, 94, 0, 54),
                this.cone(27, 36, 8, 94, 0, -54), this.cone(27, 36, 8, 94, 0, 54)
            ]) },
            { key: 'arch', hex: P.stone, geo: this.merge([
                this.box(28, 22, 124, 0, 84, 0), this.box(22, 84, 17, 0, 42, -54), this.box(22, 84, 17, 0, 42, 54)
            ]) },
            { key: 'braziers', hex: P.brass, geo: this.merge([
                this.cylinder(7, 9.5, 8, 76, 88, 0, -31), this.cylinder(7, 9.5, 8, 76, 88, 0, 31)
            ]) },
            { key: 'fire', hex: P.flame, geo: this.merge([this.sphere(7, 6, 4, 92, 0, -31), this.sphere(7, 6, 4, 92, 0, 31)]), opts: { glow: 1, glowColor: P.flame } },
            { key: 'barrier', hex: P.enemy, geo: this.merge([
                this.box(9, 76, 100, 0, 38, 0), this.box(11, 8, 104, 0, 60, 0), this.box(11, 8, 104, 0, 22, 0)
            ]), barrier: 1 },
            { key: 'rune', hex: P.arcane, geo: this.sphere(10, 8, 5, 104, 0, 0), opts: { glow: 1, glowColor: P.arcane } }
        ];
    },

    // --- projectiles and effects ---------------------------------------------------------------
    shot(kind) {
        const P = WB.PAL;
        switch (kind) {
            case 'bullet': return { key: 'bullet', hex: P.steel, geo: this.sphere(3.4, 5, 3, 0) };
            case 'bolt': return { key: 'bolt', hex: P.steel, geo: this.box(24, 2.6, 2.6, 0, 0, 0) };
            case 'arcane': return { key: 'arcane', hex: P.arcane, geo: this.sphere(7.5, 7, 4, 0), opts: { glow: 1, glowColor: P.arcane } };
            case 'spark': return { key: 'spark', hex: P.steel, geo: this.sphere(5.4, 6, 4, 0), opts: { glow: 1, glowColor: P.arcane } };
            case 'shell': return { key: 'shell', hex: P.ironDark, geo: this.sphere(9.5, 7, 4, 0) };
            case 'flame': return { key: 'flame', hex: P.flame, geo: this.sphere(11, 6, 4, 0), opts: { glow: 1, glowColor: P.flame } };
            default: return { key: 'ball', hex: P.ironDark, geo: this.sphere(6.4, 6, 4, 0) };
        }
    },

    chunk() { return { key: 'chunk', hex: WB.PAL.wood, geo: this.box(7.5, 7.5, 7.5, 0, 0, 0) }; },

    puff() { return { key: 'puff', hex: WB.PAL.smoke, geo: this.box(10, 10, 10, 0, 0, 0) }; },

    /** A flat disc on the ground: the fake (blob) shadow of a castle. */
    blob(r) {
        return this.cylinder(r, r, 14, 0, 1.2, 0, 0);
    },

    /** A flat quad for the health bars and the boss charge telegraph (overlay layer). */
    quad(w, d) {
        const x = w / 2, z = d / 2;
        const v = [[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]];
        const out = [];
        out.push(...v[0], ...v[2], ...v[1]);
        out.push(...v[0], ...v[3], ...v[2]);
        return out;
    },

    wasp() {
        const P = WB.PAL;
        return [
            { key: 'body', hex: P.gold, geo: this.box(8, 4.4, 4.4, 0, 0, 0) },
            { key: 'wings', hex: P.white, geo: this.box(3.4, 1.2, 11, 0, 3, 0), opts: { glow: 0.25, glowColor: P.white } }
        ];
    }
};
