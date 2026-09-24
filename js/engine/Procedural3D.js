// Procedural3D.js — procedural toon-friendly meshes with the kit's conventions baked in.
//
// Why this file exists (field feedback): authors and agents who build meshes by hand keep
// stepping on the mirror-world convention — normal hints computed in MAP space against
// cross products in WORLD space silently break the winding of vertical faces, and the
// outline hull then draws black shells over the object. Every builder here computes its
// normals IN WORLD (pc) SPACE and fixes the winding against them, so the result passes
// Debug3D.lint and the hull by construction. Use these builders (or Mesh3D.build with
// auto normals) instead of hand-rolled index arrays.
//
//   Procedural3D.spawn(view, 'tree', { x, y, kind: 'prop' })   -> entity (registered)
//   Procedural3D.fallbackKindFor(def)                          -> 'tree' | 'rock' | …
//   Mesh3D.build(view, name, { positions, indices?, normals? }) -> entity with render
//
// Kinds: 'box', 'crate', 'tree' (trunk + two cone tiers), 'rock' (seeded jittered
// octahedron), 'pole' (a post with a cap). All single-material, single-mesh, cheap in
// headless renders — they double as the visual LOW level for weak GPUs (Debug3D.softwareGL).

/** @satisfies {Record<string, any>} */
const Mesh3D = {
    // positions — flat [x, y, z, …] in WORLD (pc) space; indices optional (default: every
    // three vertices a triangle). normals optional: absent — computed per vertex from the
    // triangles; the winding is then FIXED against them (against ≈ 0, the lint convention).
    build(view, name, geo) {
        const positions = geo.positions;
        let indices = geo.indices;
        if (!indices) {
            indices = new Uint32Array(positions.length / 3);
            for (let i = 0; i < indices.length; i++) indices[i] = i;
        } else {
            indices = Uint32Array.from(indices);
        }
        let normals = geo.normals ? Float32Array.from(geo.normals) : Mesh3D.normals(positions, indices);
        // Outward safety for closed shapes (the feedback bug class: inward normals read as
        // consistent winding, light the mesh from inside and give the hull a black shell):
        // normals must point away from the centroid on average.
        if (Mesh3D._inward(positions, normals)) {
            for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
            for (let t = 0; t < indices.length; t += 3) {
                const tmp = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = tmp;
            }
        }
        // winding guard: the triangle normal cross(b-a, c-a) must point ALONG the vertex
        // normals (the kit convention in the mirrored world); otherwise reverse the order.
        const w = Debug3D.windingAgainstNormals(positions, normals, indices, 20000);
        if (w.total && w.against > 0.5) {
            for (let t = 0; t < indices.length; t += 3) {
                const tmp = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = tmp;
            }
            const again = Debug3D.windingAgainstNormals(positions, normals, indices, 20000);
            if (again.total && again.against > 0.5) {
                // the normals themselves were inverted — flip them, keep the winding
                for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
            }
        }
        const mesh = new pc.Mesh(view.world.app.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setNormals(normals);
        const uvs = geo.uvs;
        if (uvs) mesh.setUvs(0, uvs);
        mesh.setIndices(indices);
        mesh.update(pc.PRIMITIVE_TRIANGLES);

        const node = new pc.Entity(name);
        view.root.addChild(node);
        node.addComponent('render', { layers: [pc.LAYERID_WORLD] });
        const mat = /** @type {ArcMaterial} */ (new pc.StandardMaterial());
        mat.name = name + '-mat';
        mat.diffuse = new pc.Color(...(geo.color || [0.6, 0.6, 0.6]));
        node.render.meshInstances = [new pc.MeshInstance(mesh, mat, node)];
        return node;
    },

    // True when the normals point INTO the shape on average (closed-mesh heuristic).
    _inward(positions, normals) {
        let cx = 0, cy = 0, cz = 0;
        const n = positions.length / 3;
        for (let i = 0; i < positions.length; i += 3) { cx += positions[i]; cy += positions[i + 1]; cz += positions[i + 2]; }
        cx /= n; cy /= n; cz /= n;
        let dot = 0;
        for (let i = 0; i < positions.length; i += 3) {
            dot += normals[i] * (positions[i] - cx) + normals[i + 1] * (positions[i + 1] - cy) + normals[i + 2] * (positions[i + 2] - cz);
        }
        return dot < 0;
    },

    // Area-weighted vertex normals in the space of the positions (world for kit meshes).
    normals(positions, indices) {
        const n = new Float32Array(positions.length);
        for (let t = 0; t < indices.length; t += 3) {
            const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
            const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
            const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
            n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
            n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
        }
        for (let i = 0; i < n.length; i += 3) {
            const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
            n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
        }
        return n;
    }
};

/** @satisfies {Record<string, any>} */
const Procedural3D = {
    KINDS: ['box', 'crate', 'tree', 'rock', 'pole', 'capsule'],

    // A deterministic shape per kind+seed: the same numbers on every run and in headless.
    geometry(kind, seed) {
        const rnd = Procedural3D._rnd(seed == null ? 1 : seed);
        if (kind === 'box' || kind === 'crate') {
            const s = kind === 'crate' ? 48 : 64;
            return { positions: Procedural3D._box(s, s, s), color: kind === 'crate' ? [0.55, 0.38, 0.22] : [0.62, 0.62, 0.66] };
        }
        if (kind === 'tree') {
            const trunk = Procedural3D._box(14, 70, 14, 0, 35, 0);
            const c1 = Procedural3D._cone(46, 70, 8, 0, 100, 0, rnd);
            const c2 = Procedural3D._cone(34, 56, 8, 0, 148, 0, rnd);
            const geo = Procedural3D._merge([
                { positions: trunk, color: [0.42, 0.3, 0.18] },
                { positions: c1, color: [0.2, 0.45, 0.22] },
                { positions: c2, color: [0.24, 0.5, 0.26] }
            ]);
            return geo;
        }
        if (kind === 'rock') {
            return { positions: Procedural3D._rock(40, rnd), color: [0.5, 0.5, 0.52] };
        }
        if (kind === 'capsule') {
            // The stand-in for a missing character model: a body prism with two cone domes,
            // ~174 px tall (a human-sized placeholder that reads well under the toon bands).
            const body = Procedural3D._cylinder(30, 110, 10, 0, 32, 0);
            const top = Procedural3D._cone(30, 34, 10, 0, 142, 0, rnd);
            const bottom = Procedural3D._coneDown(30, 32, 10, 0, 32, 0, rnd);
            return Procedural3D._merge([
                { positions: body, color: [0.72, 0.3, 0.34] },
                { positions: top, color: [0.78, 0.34, 0.38] },
                { positions: bottom, color: [0.66, 0.27, 0.31] }
            ]);
        }
        // pole
        const post = Procedural3D._box(8, 120, 8, 0, 60, 0);
        const cap = Procedural3D._box(26, 10, 26, 0, 124, 0);
        return Procedural3D._merge([
            { positions: post, color: [0.35, 0.3, 0.26] },
            { positions: cap, color: [0.8, 0.75, 0.5] }
        ]);
    },

    // Spawn a procedural object and register it like any world object (group, shadows,
    // ink, outline). opts — the same as World3D.addObject's plus x/y/h/heading/scale.
    spawn(view, kind, opts) {
        const o = opts || {};
        const geo = Procedural3D.geometry(kind, o.seed);
        const node = Mesh3D.build(view, o.name || ('proc_' + kind), geo);
        node.setPosition(-(o.x || 0), (o.h || 0), o.y || 0);     // map -> mirrored world
        if (o.heading) node.setLocalEulerAngles(0, o.heading, 0);
        const s = o.scale == null ? 1 : o.scale;
        node.setLocalScale(s, s, s);
        World3D.addObject(view, node, o.kind || 'prop', o);
        return node;
    },

    // Which procedural stand-in suits a failed model: trees and plants -> tree,
    // rocks and ores -> rock, everything else -> crate (a readable placeholder).
    fallbackKindFor(def) {
        const m = String((def && def.model) || '').toLowerCase();
        if (/tree|pine|spruce|bush|plant|wood/.test(m)) return 'tree';
        if (/rock|stone|ore|gold|boulder/.test(m)) return 'rock';
        if (/pole|lamp|post|light/.test(m)) return 'pole';
        return 'crate';
    },

    // A stable seed per name: the same stand-in shape on every run.
    hashName(name) {
        let h = 2166136261;
        for (const ch of String(name)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
        return h >>> 0;
    },

    _rnd(seed) {
        let s = (seed >>> 0) || 1;
        return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x80000000 - 1; };
    },

    // Axis box w×h×d centered at (cx, cy, cz): 8 verts, 12 triangles, outward normals
    // come from Mesh3D's guard.
    _box(w, h, d, cx, cy, cz) {
        const x = w / 2, y = h / 2, z = d / 2;
        const c = [cx || 0, cy || 0, cz || 0];
        const v = [
            [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
            [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]
        ].map(p => [p[0] + c[0], p[1] + c[1], p[2] + c[2]]);
        const q = [0, 2, 1, 0, 3, 2, 5, 7, 4, 5, 6, 7, 1, 6, 5, 1, 2, 6, 4, 3, 0, 4, 7, 3];
        const out = [];
        for (const i of q) out.push(...v[i]);
        return out;
    },

    // A cone of radius r and height h in `seg` sides, base at (cx, cy, cz): sides + a fan
    // cap. Jitter ±10% on the rim vertices so the silhouette is not a perfect polygon.
    _cone(r, h, seg, cx, cy, cz, rnd) {
        const out = [];
        const apex = [cx, cy + h, cz];
        const ring = [];
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            const rr = r * (1 + (rnd ? rnd() * 0.1 : 0));
            ring.push([cx + Math.cos(a) * rr, cy, cz + Math.sin(a) * rr]);
        }
        for (let i = 0; i < seg; i++) {
            const a = ring[i], b = ring[(i + 1) % seg];
            out.push(...a, ...b, ...apex);
        }
        for (let i = 1; i < seg - 1; i++) out.push(...ring[0], ...ring[i + 1], ...ring[i]);
        return out;
    },

    // An n-sided prism of radius r and height h, base at (cx, cy, cz): side quads + two fans.
    _cylinder(r, h, seg, cx, cy, cz) {
        const out = [];
        const ring = (y) => {
            const pts = [];
            for (let i = 0; i < seg; i++) {
                const a = (i / seg) * Math.PI * 2;
                pts.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
            }
            return pts;
        };
        const lo = ring(cy), hi = ring(cy + h);
        for (let i = 0; i < seg; i++) {
            const j = (i + 1) % seg;
            out.push(...lo[i], ...lo[j], ...hi[j], ...lo[i], ...hi[j], ...hi[i]);
        }
        for (let i = 1; i < seg - 1; i++) out.push(...lo[0], ...lo[i + 1], ...lo[i]);
        for (let i = 1; i < seg - 1; i++) out.push(...hi[0], ...hi[i], ...hi[i + 1]);
        return out;
    },

    // A cone pointing DOWN (the lower dome of a capsule): apex at (cx, cy - h), rim at cy.
    _coneDown(r, h, seg, cx, cy, cz, rnd) {
        const out = [];
        const apex = [cx, cy - h, cz];
        const ring = [];
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            const rr = r * (1 + (rnd ? rnd() * 0.05 : 0));
            ring.push([cx + Math.cos(a) * rr, cy, cz + Math.sin(a) * rr]);
        }
        for (let i = 0; i < seg; i++) {
            const a = ring[i], b = ring[(i + 1) % seg];
            out.push(...a, ...apex, ...b);
        }
        for (let i = 1; i < seg - 1; i++) out.push(...ring[0], ...ring[i], ...ring[i + 1]);
        return out;
    },

    // A jittered octahedron: six apexes pushed in/out by the seed — reads as a boulder
    // under the toon bands.
    _rock(r, rnd) {
        const j = () => r * (0.75 + Math.abs(rnd()) * 0.5);
        const v = [
            [j(), 0, 0], [-j(), 0, 0], [0, j() * 0.8, 0], [0, -j() * 0.5, 0], [0, 0, j()], [0, 0, -j()]
        ];
        const f = [0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 0, 2, 0, 3, 5, 5, 3, 1, 1, 3, 4, 4, 3, 0];
        const out = [];
        for (const i of f) out.push(...v[i]);
        return out;
    },

    // Concatenate single-material geoms into one: colors collapse to the first (the toon
    // bands carry the shape), positions stay in world space.
    _merge(parts) {
        const positions = [];
        for (const p of parts) positions.push(...p.positions);
        return { positions, color: parts[0].color };
    }
};
