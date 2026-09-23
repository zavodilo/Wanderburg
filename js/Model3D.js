// Model3D.js — models: binary FBX (7.x: Blender, Maya, Unity) -> PlayCanvas meshes.
// Location objects (Objects.js) are placed by Location3D: load(url, view) -> build() ->
// World3D.addObject. Models live in assets/models/. A .glb / .gltf (skeleton, animation
// clips, textures) goes through the same three calls into Gltf3D.js; clips(root) — its clips.
//
// FBX, this file's own parser.
// Taken: Model nodes with geometry — transform (Lcl Translation/Rotation/Scaling,
// Pre/PostRotation, pivots, Geometric*, parents), polygons fanned into
// triangles, normals, material color (DiffuseColor), node center and axes (Location3D
// spins a part by them — def.anim). Not taken: textures, UVs, vertex
// colors, bones, animation, ASCII FBX.
//
// UNITS: centimeters (the file's UnitScaleFactor is applied) = world px: a model from Blender
// 2 m tall — 200 px at scale 1. The model's origin is the file's origin.
// AXES: FBX is right-handed with Y up by default — like the kit's map space; other file
// axes (GlobalSettings: UpAxis, FrontAxis, CoordAxis) are converted to these.
// SPACE: parse() OUTPUT IS THE PLAYCANVAS WORLD, mirrored on X versus the map (skill
// world3d, §Coordinates): positions and normals come out with x negated, pivots and axes
// with them, bounds accordingly. The winding is the file's own fan order: the mirror into
// the left-handed world flips it once, and PlayCanvas' front face (counter-clockwise, like
// glTF) is restored. A mirrored node transform (negative determinant) flips the winding in
// the file — that case keeps its own reversal.
// COLOR: DiffuseColor in the file is linear (that is how Blender writes it); PlayCanvas
// material colors are sRGB — without the gamma conversion the colors are darker than in Blender.
// MATRICES here are row-vector (v' = v·M), A.multiply(B) — first A, then B, like the old code.

/** @satisfies {Record<string, any>} */
const Model3D = {
    _cache: new Map(),   // url -> parse Promise: the file is downloaded and parsed once per page

    // url -> Promise<model> (see parse). A .glb / .gltf goes to Gltf3D (skeleton, clips,
    // textures) and needs the view: its meshes are created by the PlayCanvas container loader.
    load(url, view) {
        if (Gltf3D.is(url)) return Gltf3D.load(url, view);
        let p = this._cache.get(url);
        if (!p) {
            p = fetch(url)
                .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
                .then((buf) => this.parse(buf));
            this._cache.set(url, p);
            p.catch(() => this._cache.delete(url));   // errors are not cached: the file may be added later
        }
        return p;
    },

    // Model -> root entity without geometry, parts are its children; each call gets its own
    // meshes and materials. opts: { name }. A part is a pair of entities: the spin root at the
    // node origin (Location3D.spinPart turns IT) and the mesh node offset back by the origin,
    // so the baked world-space vertices stay where the file put them.
    build(model, view, opts) {
        if (model.gltf) return Gltf3D.build(model, view, opts);
        const o = opts || {};
        const root = new pc.Entity(o.name || 'model');
        view.root.addChild(root);
        const mats = [];
        const material = (i) => {
            if (!mats[i]) {
                const m = model.materials[i];
                const mat = new pc.StandardMaterial();
                mat.name = root.name + '/' + m.name;
                const g = Model3D._gamma(m.color);
                mat.diffuse = new pc.Color(g[0], g[1], g[2]);
                if (m.texture) Model3D._attachTexture(mat, m.texture, view);
                mats[i] = mat;
            }
            return mats[i];
        };
        for (const part of model.parts) {
            const partRoot = /** @type {ArcNode} */ (new pc.Entity(root.name + '/' + part.name));
            partRoot.meta = { part: part.name, pivot: part.pivot, axes: part.axes };
            partRoot.setPosition(part.pivot[0], part.pivot[1], part.pivot[2]);
            root.addChild(partRoot);
            const meshNode = new pc.Entity(partRoot.name + '/mesh');
            meshNode.setPosition(-part.pivot[0], -part.pivot[1], -part.pivot[2]);
            partRoot.addChild(meshNode);
            meshNode.addComponent('render', { layers: [pc.LAYERID_WORLD] });
            const mis = [];
            for (const g of part.groups) {
                const mesh = new pc.Mesh(view.app.graphicsDevice);
                const gp = part.positions.subarray(g.start * 3, (g.start + g.count) * 3);
                mesh.setPositions(gp);
                if (part.normals) {
                    mesh.setNormals(part.normals.subarray(g.start * 3, (g.start + g.count) * 3));
                } else {
                    // No normals in the file: smooth them over the group's own triangles —
                    // a mesh without a NORMAL stream breaks normal-dependent shaders (the
                    // outline hull pushes along normalize(0) = NaN).
                    const seq = new Uint32Array(g.count);
                    for (let i = 0; i < g.count; i++) seq[i] = i;
                    mesh.setNormals(Model3D._smoothNormals(gp, seq));
                }
                const seq = new Uint32Array(g.count);
                for (let i = 0; i < g.count; i++) seq[i] = i;
                mesh.setIndices(seq);
                mesh.update(pc.PRIMITIVE_TRIANGLES);
                const mi = new pc.MeshInstance(mesh, material(g.material), meshNode);
                mi.receiveShadow = true;
                mis.push(mi);
            }
            meshNode.render.meshInstances = mis;
        }
        return root;
    },

    // Area-weighted vertex normals of an indexed triangle soup.
    _smoothNormals(pos, idx) {
        const n = new Float32Array(pos.length);
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
            const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
            const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
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
    },

    // A RelativeFilename like "..\\textures\\bark.jpg" or "tex/bark.jpg" -> a path under the
    // game root when it lives inside assets/; null when it points outside (embedded only).
    _normRel(rel) {
        if (!rel) return null;
        const clean = String(rel).replace(/\\+/g, '/');
        const m = /(?:^|\/)(assets\/.+)$/i.exec(clean);
        if (m) return m[1];
        return /^(?!\.\.\/)/.test(clean) ? 'assets/models/' + clean.split('/').pop() : null;
    },

    // Diffuse texture: embedded bytes win; otherwise the file next to the model under
    // assets/. Loaded in the background: the mesh renders with its flat color first and
    // gets the map when the image arrives (a missing file warns and keeps the color).
    _attachTexture(mat, tex, view) {
        const done = (blob) => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                const t = new pc.Texture(view.world.app.graphicsDevice, {
                    width: img.width, height: img.height,
                    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR, magFilter: pc.FILTER_LINEAR,
                    addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT
                });
                t.name = mat.name + '-diffuse';
                t.setSource(img);
                mat.diffuseMap = t;
                mat.diffuse = new pc.Color(1, 1, 1);
                mat.update();
                URL.revokeObjectURL(url);
            };
            img.onerror = () => { console.warn('Model3D: текстура не читается: ' + (tex.path || 'embedded')); URL.revokeObjectURL(url); };
            img.src = url;
        };
        if (tex.bytes) { done(new Blob([tex.bytes], { type: 'image/jpeg' })); return; }
        if (tex.path) {
            fetch(tex.path).then(r => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)))).then(done)
                .catch(e => console.warn('Model3D: нет файла текстуры ' + tex.path + ' (' + e.message + ')'));
        }
    },

    // Linear -> sRGB, like Babylon's toGammaSpace on the file's linear colors.
    _gamma(c) {
        const f = (v) => Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2);
        return [f(c[0]), f(c[1]), f(c[2])];
    },

    // Animation clips of a built model: Clips3D (play('run'), names()) for a glTF with
    // animations, null for FBX.
    clips(root) {
        return Gltf3D.clips(root);
    },

    // Remove a built model from the scene together with its materials
    // (World3D.removeObject leaves materials to the owner).
    dispose(view, root) {
        const mats = new Set();
        for (const rc of root.findComponents('render')) {
            for (const mi of rc.meshInstances) if (mi.material) mats.add(mi.material);
        }
        World3D.removeObject(view, root);
        for (const mat of mats) mat.destroy();
    },

    // ArrayBuffer -> { materials: [{ name, color: [r, g, b] }], parts: [{ name,
    // positions, normals | null, groups: [{ material, start, count }], pivot: [x, y, z],
    // axes: { x, y, z } }], min, max }. Coordinates — the file's world in SCENE (PlayCanvas,
    // mirrored) axes; a part's vertices go in groups by material; pivot and axes — the origin
    // and unit local axes of the node (the object's origin and axes in Blender), mirrored too.
    async parse(buffer) {
        const tree = await this._readTree(buffer);
        const objects = new Map(), parents = new Map(), children = new Map();
        for (const n of (this._child(tree, 'Objects') || { nodes: [] }).nodes) objects.set(n.props[0], n);
        // "object -> parent" links in file order: the model's materials are numbered by it.
        for (const c of (this._child(tree, 'Connections') || { nodes: [] }).nodes) {
            if (c.name !== 'C' || c.props[0] !== 'OO') continue;
            const from = c.props[1], to = c.props[2];
            if (!parents.has(from)) parents.set(from, []);
            if (!children.has(to)) children.set(to, []);
            parents.get(from).push(to);
            children.get(to).push(from);
        }
        const kind = (id) => (objects.has(id) ? objects.get(id).name : '');
        const nameOf = (n) => String(n.props[1]).split('\0')[0];   // "house\0\x01Model" -> "house"

        // Textures (feedback: bare FBX colors made pines/rocks look worse than procedural
        // toon trees). FBX 7.x: a Video node carries RelativeFilename and, when embedded,
        // the Content blob; a Texture node wraps a Video; an OP connection binds a Texture
        // to a material property (DiffuseColor/Diffuse). Embedded bytes win over the path.
        const videos = new Map();
        for (const [id, n] of objects) {
            if (n.name !== 'Video') continue;
            const p = this._props70(n);
            const one = (k) => { const v = p[k]; return Array.isArray(v) ? v[0] : v; };  // _props70 gives value arrays
            const rel = String(one('RelativeFilename') || one('RelativePath') || '').replace(/\\/g, '/');
            const content = one('Content');
            videos.set(id, { rel, bytes: content && content.length ? content : null });
        }
        const texToVideo = new Map();
        const matTex = new Map();      // material object id -> { rel, bytes, prop }
        for (const c of (this._child(tree, 'Connections') || { nodes: [] }).nodes) {
            if (c.name !== 'C') continue;
            if (c.props[0] === 'OO' && videos.has(c.props[1])) texToVideo.set(c.props[2], c.props[1]);
            if (c.props[0] === 'OP' && (String(c.props[3]) === 'DiffuseColor' || String(c.props[3]) === 'Diffuse')) {
                const vid = texToVideo.get(c.props[1]);
                if (vid) matTex.set(c.props[2], videos.get(vid));
            }
        }

        const worlds = new Map();
        const worldOf = (id) => {
            let m = worlds.get(id);
            if (!m) {
                m = this._localMatrix(this._props70(objects.get(id)));
                const parent = (parents.get(id) || []).find((p) => kind(p) === 'Model');
                if (parent) m = m.multiply(worldOf(parent));
                worlds.set(id, m);
            }
            return m;
        };

        // File axes -> scene axes, file units -> cm (UnitScaleFactor — centimeters per unit).
        const gs = this._props70(this._child(tree, 'GlobalSettings'));
        const unit = gs.UnitScaleFactor && gs.UnitScaleFactor[0] > 0 ? gs.UnitScaleFactor[0] : 1;
        const axes = this._axisMatrix(gs).multiply(M4.scaling(unit, unit, unit));
        const model = { materials: [], parts: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        const matIndex = new Map();
        const materialIndex = (id) => {
            if (!matIndex.has(id)) {
                const n = objects.get(id), p = n ? this._props70(n) : {};
                const c = p.DiffuseColor || p.Diffuse || [0.8, 0.8, 0.8];
                matIndex.set(id, model.materials.length);
                const tex = matTex.get(id);
                model.materials.push({
                    name: n ? nameOf(n) : 'default', color: [c[0], c[1], c[2],],
                    texture: tex ? { path: Model3D._normRel(tex.rel), bytes: tex.bytes || null } : null
                });
            }
            return matIndex.get(id);
        };
        for (const [id, node] of objects) {
            if (node.name !== 'Model') continue;
            const links = children.get(id) || [];
            const geo = links.map((l) => objects.get(l)).find((n) => n && n.name === 'Geometry' && n.props[2] === 'Mesh');
            if (!geo) continue;
            const mats = links.filter((l) => kind(l) === 'Material').map(materialIndex);
            if (!mats.length) mats.push(materialIndex('default'));
            const world = this._geometricMatrix(this._props70(node)).multiply(worldOf(id)).multiply(axes);
            const part = this._triangulate(geo, world, mats, model);
            if (part) {
                part.name = nameOf(node);
                // Node without Geometric*: they shift only the geometry, the object's center stays.
                const frame = worldOf(id).multiply(axes);
                part.pivot = M4.point(frame, [0, 0, 0]);
                part.axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
                for (const k in part.axes) part.axes[k] = M4.normal(frame, part.axes[k]);
                // Into the PlayCanvas world: mirror on X (positions and normals were
                // mirrored in _triangulate; the pivot and the axes — here).
                part.pivot[0] = -part.pivot[0];
                for (const k in part.axes) part.axes[k][0] = -part.axes[k][0];
                model.parts.push(part);
            }
        }
        if (!model.parts.length) throw new Error('no meshes in FBX');
        // Bounds in the mirrored world: the x ends swap places.
        const lo = model.min, hi = model.max;
        if (Number.isFinite(lo[0])) { const x = lo[0]; lo[0] = -hi[0]; hi[0] = -x; }
        return model;
    },

    // Geometry polygons -> triangles in the scene world, grouped by material; bounds — into model.
    _triangulate(geo, world, mats, model) {
        const V = this._value(geo, 'Vertices'), P = this._value(geo, 'PolygonVertexIndex');
        if (!V || !P) return null;
        const N = this._layer(this._child(geo, 'LayerElementNormal'), 'Normals', 'NormalsIndex');
        const ml = this._child(geo, 'LayerElementMaterial');
        const matIds = this._value(ml, 'Materials');
        const byPoly = matIds && this._value(ml, 'MappingInformationType') === 'ByPolygon';
        const normalMatrix = world.clone().invert().transpose();
        const mirror = world.determinant() < 0;   // a mirror transform flips the winding itself
        const groups = new Map();                  // material -> { pos: [], nrm: [] }
        const lo = model.min, hi = model.max;

        // Polygon corner: pv — number in PolygonVertexIndex (the last corner is stored as ~index).
        // The output goes out MIRRORED on X (the header of this file explains why).
        const corner = (g, pv, poly) => {
            const v = P[pv] < 0 ? ~P[pv] : P[pv];
            const p = M4.point(world, [V[3 * v], V[3 * v + 1], V[3 * v + 2]]);
            p[0] = -p[0];
            g.pos.push(p[0], p[1], p[2]);
            if (p[0] < lo[0]) lo[0] = p[0]; if (p[0] > hi[0]) hi[0] = p[0];
            if (p[1] < lo[1]) lo[1] = p[1]; if (p[1] > hi[1]) hi[1] = p[1];
            if (p[2] < lo[2]) lo[2] = p[2]; if (p[2] > hi[2]) hi[2] = p[2];
            if (!N) return;
            const i = 3 * N.at(pv, v, poly);
            const n = M4.normal(normalMatrix, [N.data[i], N.data[i + 1], N.data[i + 2]]);
            n[0] = -n[0];
            const l = Math.hypot(n[0], n[1], n[2]) || 1;
            g.nrm.push(n[0] / l, n[1] / l, n[2] / l);
        };

        for (let start = 0, poly = 0, i = 0; i < P.length; i++) {
            if (P[i] >= 0) continue;
            const mi = matIds ? matIds[byPoly ? poly : 0] : 0;
            const key = mi < mats.length ? mats[mi] : mats[0];
            let g = groups.get(key);
            if (!g) groups.set(key, (g = { pos: [], nrm: [] }));
            for (let k = start + 1; k < i; k++) {
                // Fan (start, k, k+1) in the FILE order — the scene world is mirrored versus
                // the file's handedness, and the mirror is the winding reversal (file header).
                corner(g, start, poly);
                corner(g, mirror ? k + 1 : k, poly);
                corner(g, mirror ? k : k + 1, poly);
            }
            poly++;
            start = i + 1;
        }

        let total = 0;
        for (const g of groups.values()) total += g.pos.length;
        if (!total) return null;
        const positions = new Float32Array(total), normals = N ? new Float32Array(total) : null, list = [];
        let at = 0;
        for (const [material, g] of groups) {
            positions.set(g.pos, at);
            if (normals) normals.set(g.nrm, at);
            list.push({ material, start: at / 3, count: g.pos.length / 3 });
            at += g.pos.length;
        }
        return { positions, normals, groups: list };
    },

    // Geometry layer (normals): the data and the data index for a polygon corner —
    // pv: corner number in PolygonVertexIndex, v: vertex, poly: polygon.
    _layer(el, dataName, indexName) {
        const data = this._value(el, dataName);
        if (!data) return null;
        const mapping = this._value(el, 'MappingInformationType');
        const index = this._value(el, 'ReferenceInformationType') === 'Direct' ? null : this._value(el, indexName);
        return {
            data,
            at: (pv, v, poly) => {
                const i = mapping === 'ByPolygonVertex' ? pv : mapping === 'ByPolygon' ? poly : mapping === 'AllSame' ? 0 : v;
                return index ? index[i] : i;
            }
        };
    },

    // Local transform of a node. In FBX (column vector):
    //   T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹
    // in row-vector matrices — the same sequence right to left.
    _localMatrix(p) {
        const Z = [0, 0, 0];
        const T = (t, k) => M4.translation(t[0] * k, t[1] * k, t[2] * k);
        const order = ['XYZ', 'XZY', 'YZX', 'YXZ', 'ZXY', 'ZYX'][(p.RotationOrder || [0])[0]] || 'XYZ';
        const s = p['Lcl Scaling'] || [1, 1, 1], rp = p.RotationPivot || Z, sp = p.ScalingPivot || Z;
        return T(sp, -1)
            .multiply(M4.scaling(s[0], s[1], s[2]))
            .multiply(T(sp, 1))
            .multiply(T(p.ScalingOffset || Z, 1))
            .multiply(T(rp, -1))
            .multiply(this._euler(p.PostRotation || Z, 'XYZ').transpose())   // the inverse of a rotation is its transpose
            .multiply(this._euler(p['Lcl Rotation'] || Z, order))
            .multiply(this._euler(p.PreRotation || Z, 'XYZ'))
            .multiply(T(rp, 1))
            .multiply(T(p.RotationOffset || Z, 1))
            .multiply(T(p['Lcl Translation'] || Z, 1));
    },

    // Geometry offset relative to its own node (not inherited by children): Gt · Gr · Gs.
    _geometricMatrix(p) {
        const s = p.GeometricScaling || [1, 1, 1], t = p.GeometricTranslation || [0, 0, 0];
        return M4.scaling(s[0], s[1], s[2])
            .multiply(this._euler(p.GeometricRotation || [0, 0, 0], 'XYZ'))
            .multiply(M4.translation(t[0], t[1], t[2]));
    },

    // Angles in degrees -> rotation; order — axes in order of application (XYZ: X first).
    _euler(deg, order) {
        const r = Math.PI / 180;
        let m = M4.identity();
        for (const ax of order) {
            m = m.multiply(ax === 'X' ? M4.rotationX(deg[0] * r) : ax === 'Y' ? M4.rotationY(deg[1] * r) : M4.rotationZ(deg[2] * r));
        }
        return m;
    },

    // File axes -> scene axes: CoordAxis -> X, UpAxis -> Y, FrontAxis -> Z, with signs.
    _axisMatrix(gs) {
        const get = (name, def) => (gs[name] ? gs[name][0] : def);
        const c = get('CoordAxis', 0), u = get('UpAxis', 1), f = get('FrontAxis', 2);
        if (new Set([c, u, f]).size !== 3 || Math.min(c, u, f) < 0 || Math.max(c, u, f) > 2) return M4.identity();
        const m = new Array(16).fill(0);
        m[c * 4] = get('CoordAxisSign', 1);
        m[u * 4 + 1] = get('UpAxisSign', 1);
        m[f * 4 + 2] = get('FrontAxisSign', 1);
        m[15] = 1;
        return new M4(m);
    },

    // Node's Properties70 -> { name: [values] } (P record: name, type, two flags, values).
    _props70(node) {
        const out = {}, p70 = this._child(node, 'Properties70');
        if (p70) for (const p of p70.nodes) out[p.props[0]] = p.props.slice(4);
        return out;
    },

    _child(node, name) {
        return node ? node.nodes.find((n) => n.name === name) : undefined;
    },

    _value(node, name) {
        const n = this._child(node, name);
        return n ? n.props[0] : undefined;
    },

    // Binary FBX -> node tree { name, props, nodes }. int64 — as a string (these are
    // object ids), arrays — typed: compressed ones (zlib) are unpacked by
    // DecompressionStream, all at once after the traversal.
    async _readTree(buffer) {
        const bytes = new Uint8Array(buffer), dv = new DataView(buffer), text = new TextDecoder();
        const str = (at, n) => text.decode(bytes.subarray(at, at + n));
        if (bytes.length < 27 || str(0, 18) !== 'Kaydara FBX Binary') throw new Error('not a binary FBX (ASCII FBX is not supported)');
        const W = dv.getUint32(23, true) >= 7500 ? 8 : 4;   // since v7.5 record fields are 64-bit
        const num = (at) => (W === 8 ? Number(dv.getBigUint64(at, true)) : dv.getUint32(at, true));
        const ARRAYS = { f: Float32Array, d: Float64Array, i: Int32Array, l: BigInt64Array, b: Uint8Array };
        const pending = [];

        const readNode = (at) => {
            const end = num(at), count = num(at + W), nameLen = bytes[at + 3 * W];
            if (end === 0) return null;   // null record — end of list
            const node = { name: str(at + 3 * W + 1, nameLen), props: [], nodes: [], end };
            let p = at + 3 * W + 1 + nameLen;
            for (let i = 0; i < count; i++) {
                const t = String.fromCharCode(bytes[p++]);
                switch (t) {
                    case 'Y': node.props.push(dv.getInt16(p, true)); p += 2; break;
                    case 'C': node.props.push(bytes[p] !== 0); p += 1; break;
                    case 'I': node.props.push(dv.getInt32(p, true)); p += 4; break;
                    case 'F': node.props.push(dv.getFloat32(p, true)); p += 4; break;
                    case 'D': node.props.push(dv.getFloat64(p, true)); p += 8; break;
                    case 'L': node.props.push(dv.getBigInt64(p, true).toString()); p += 8; break;
                    case 'S': case 'R': {
                        const n = dv.getUint32(p, true);
                        node.props.push(t === 'S' ? str(p + 4, n) : bytes.subarray(p + 4, p + 4 + n));
                        p += 4 + n;
                        break;
                    }
                    default: {
                        if (!ARRAYS[t]) throw new Error('FBX: unknown property type ' + t);
                        const n = dv.getUint32(p, true), zip = dv.getUint32(p + 4, true) === 1, len = dv.getUint32(p + 8, true);
                        pending.push({ props: node.props, at: node.props.length, T: ARRAYS[t], n, zip, data: bytes.subarray(p + 12, p + 12 + len) });
                        node.props.push(null);
                        p += 12 + len;
                    }
                }
            }
            while (p < end) {
                const child = readNode(p);
                if (!child) break;
                node.nodes.push(child);
                p = child.end;
            }
            return node;
        };

        const tree = { name: '', props: [], nodes: [] };
        for (let at = 27; at + 3 * W + 1 <= bytes.length;) {
            const node = readNode(at);
            if (!node) break;
            tree.nodes.push(node);
            at = node.end;
        }
        await Promise.all(pending.map(async (a) => {
            // Own copy of the bytes: a typed array needs buffer alignment.
            const raw = a.zip
                ? new Uint8Array(await new Response(new Blob([a.data]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())
                : a.data.slice();
            a.props[a.at] = new a.T(raw.buffer, 0, a.n);
        }));
        return tree;
    },
};

// --- Row-vector 4x4 matrices (v' = v·M), the FBX transform chain --------------------
// Row-major storage: m[row * 4 + col]; A.multiply(B) applies A first, then B.
class M4 {
    constructor(m) {
        this.m = m || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    }
    static identity() { return new M4(); }
    static translation(x, y, z) { return new M4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]); }
    static scaling(x, y, z) { return new M4([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]); }
    static rotationX(a) { const c = Math.cos(a), s = Math.sin(a); return new M4([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); }
    static rotationY(a) { const c = Math.cos(a), s = Math.sin(a); return new M4([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); }
    static rotationZ(a) { const c = Math.cos(a), s = Math.sin(a); return new M4([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
    clone() { return new M4(this.m.slice()); }
    transpose() {
        const m = this.m, o = new Array(16);
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[r * 4 + c] = m[c * 4 + r];
        return new M4(o);
    }
    multiply(b) {
        const a = this.m, n = b.m, o = new Array(16);
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                o[r * 4 + c] = a[r * 4] * n[c] + a[r * 4 + 1] * n[4 + c] + a[r * 4 + 2] * n[8 + c] + a[r * 4 + 3] * n[12 + c];
            }
        }
        return new M4(o);
    }
    determinant() {
        const m = this.m;
        const a = (i, j) => m[i * 4 + j];
        const det3 = (r0, r1, r2, c0, c1, c2) =>
            a(r0, c0) * (a(r1, c1) * a(r2, c2) - a(r1, c2) * a(r2, c1)) -
            a(r0, c1) * (a(r1, c0) * a(r2, c2) - a(r1, c2) * a(r2, c0)) +
            a(r0, c2) * (a(r1, c0) * a(r2, c1) - a(r1, c1) * a(r2, c0));
        return a(0, 0) * det3(1, 2, 3, 1, 2, 3) - a(0, 1) * det3(1, 2, 3, 0, 2, 3) +
               a(0, 2) * det3(1, 2, 3, 0, 1, 3) - a(0, 3) * det3(1, 2, 3, 0, 1, 2);
    }
    invert() {
        const m = this.m, inv = new Array(16);
        const a = (i, j) => m[i * 4 + j];
        inv[0] = a(1, 1) * a(2, 2) * a(3, 3) - a(1, 1) * a(2, 3) * a(3, 2) - a(2, 1) * a(1, 2) * a(3, 3) + a(2, 1) * a(1, 3) * a(3, 2) + a(3, 1) * a(1, 2) * a(2, 3) - a(3, 1) * a(1, 3) * a(2, 2);
        inv[4] = -a(1, 0) * a(2, 2) * a(3, 3) + a(1, 0) * a(2, 3) * a(3, 2) + a(2, 0) * a(1, 2) * a(3, 3) - a(2, 0) * a(1, 3) * a(3, 2) - a(3, 0) * a(1, 2) * a(2, 3) + a(3, 0) * a(1, 3) * a(2, 2);
        inv[8] = a(1, 0) * a(2, 1) * a(3, 3) - a(1, 0) * a(2, 3) * a(3, 1) - a(2, 0) * a(1, 1) * a(3, 3) + a(2, 0) * a(1, 3) * a(3, 1) + a(3, 0) * a(1, 1) * a(2, 3) - a(3, 0) * a(1, 3) * a(2, 1);
        inv[12] = -a(1, 0) * a(2, 1) * a(3, 2) + a(1, 0) * a(2, 2) * a(3, 1) + a(2, 0) * a(1, 1) * a(3, 2) - a(2, 0) * a(1, 2) * a(3, 1) - a(3, 0) * a(1, 1) * a(2, 2) + a(3, 0) * a(1, 2) * a(2, 1);
        inv[1] = -a(0, 1) * a(2, 2) * a(3, 3) + a(0, 1) * a(2, 3) * a(3, 2) + a(2, 1) * a(0, 2) * a(3, 3) - a(2, 1) * a(0, 3) * a(3, 2) - a(3, 1) * a(0, 2) * a(2, 3) + a(3, 1) * a(0, 3) * a(2, 2);
        inv[5] = a(0, 0) * a(2, 2) * a(3, 3) - a(0, 0) * a(2, 3) * a(3, 2) - a(2, 0) * a(0, 2) * a(3, 3) + a(2, 0) * a(0, 3) * a(3, 2) + a(3, 0) * a(0, 2) * a(2, 3) - a(3, 0) * a(0, 3) * a(2, 2);
        inv[9] = -a(0, 0) * a(2, 1) * a(3, 3) + a(0, 0) * a(2, 3) * a(3, 1) + a(2, 0) * a(0, 1) * a(3, 3) - a(2, 0) * a(0, 3) * a(3, 1) - a(3, 0) * a(0, 1) * a(2, 3) + a(3, 0) * a(0, 3) * a(2, 1);
        inv[13] = a(0, 0) * a(2, 1) * a(3, 2) - a(0, 0) * a(2, 2) * a(3, 1) - a(2, 0) * a(0, 1) * a(3, 2) + a(2, 0) * a(0, 2) * a(3, 1) + a(3, 0) * a(0, 1) * a(2, 2) - a(3, 0) * a(0, 2) * a(2, 1);
        inv[2] = a(0, 1) * a(1, 2) * a(3, 3) - a(0, 1) * a(1, 3) * a(3, 2) - a(1, 1) * a(0, 2) * a(3, 3) + a(1, 1) * a(0, 3) * a(3, 2) + a(3, 1) * a(0, 2) * a(1, 3) - a(3, 1) * a(0, 3) * a(1, 2);
        inv[6] = -a(0, 0) * a(1, 2) * a(3, 3) + a(0, 0) * a(1, 3) * a(3, 2) + a(1, 0) * a(0, 2) * a(3, 3) - a(1, 0) * a(0, 3) * a(3, 2) - a(3, 0) * a(0, 2) * a(1, 3) + a(3, 0) * a(0, 3) * a(1, 2);
        inv[10] = a(0, 0) * a(1, 1) * a(3, 3) - a(0, 0) * a(1, 3) * a(3, 1) - a(1, 0) * a(0, 1) * a(3, 3) + a(1, 0) * a(0, 3) * a(3, 1) + a(3, 0) * a(0, 1) * a(1, 3) - a(3, 0) * a(0, 3) * a(1, 1);
        inv[14] = -a(0, 0) * a(1, 1) * a(3, 2) + a(0, 0) * a(1, 2) * a(3, 1) + a(1, 0) * a(0, 1) * a(3, 2) - a(1, 0) * a(0, 2) * a(3, 1) - a(3, 0) * a(0, 1) * a(1, 2) + a(3, 0) * a(0, 2) * a(1, 1);
        inv[3] = -a(0, 1) * a(1, 2) * a(2, 3) + a(0, 1) * a(1, 3) * a(2, 2) + a(1, 1) * a(0, 2) * a(2, 3) - a(1, 1) * a(0, 3) * a(2, 2) - a(2, 1) * a(0, 2) * a(1, 3) + a(2, 1) * a(0, 3) * a(1, 2);
        inv[7] = a(0, 0) * a(1, 2) * a(2, 3) - a(0, 0) * a(1, 3) * a(2, 2) - a(1, 0) * a(0, 2) * a(2, 3) + a(1, 0) * a(0, 3) * a(2, 2) + a(2, 0) * a(0, 2) * a(1, 3) - a(2, 0) * a(0, 3) * a(1, 2);
        inv[11] = -a(0, 0) * a(1, 1) * a(2, 3) + a(0, 0) * a(1, 3) * a(2, 1) + a(1, 0) * a(0, 1) * a(2, 3) - a(1, 0) * a(0, 3) * a(2, 1) - a(2, 0) * a(0, 1) * a(1, 3) + a(2, 0) * a(0, 3) * a(1, 1);
        inv[15] = a(0, 0) * a(1, 1) * a(2, 2) - a(0, 0) * a(1, 2) * a(2, 1) - a(1, 0) * a(0, 1) * a(2, 2) + a(1, 0) * a(0, 2) * a(2, 1) + a(2, 0) * a(0, 1) * a(1, 2) - a(2, 0) * a(0, 2) * a(1, 1);
        const d = this.determinant() || 1;
        return new M4(inv.map(v => v / d));
    }
    static point(m, p) {
        const a = m.m;
        return [
            p[0] * a[0] + p[1] * a[4] + p[2] * a[8] + a[12],
            p[0] * a[1] + p[1] * a[5] + p[2] * a[9] + a[13],
            p[0] * a[2] + p[1] * a[6] + p[2] * a[10] + a[14]
        ];
    }
    static normal(m, p) {
        const a = m.m;
        return [
            p[0] * a[0] + p[1] * a[4] + p[2] * a[8],
            p[0] * a[1] + p[1] * a[5] + p[2] * a[9],
            p[0] * a[2] + p[1] * a[6] + p[2] * a[10]
        ];
    }
}
