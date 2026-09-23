// Terrain3D.js — the location's ground: a height field from noise, one grid over the rectangle
// [0..W]×[0..H] and a coarse ground ring beyond the edge (otherwise, at a low camera angle,
// the sky would gape beyond the edge).
//
// Height — TERRAIN_BASE + noise (SimplexNoise(TERRAIN_NOISE_SEED), two octaves,
// amplitude TERRAIN_NOISE_AMP, hill size TERRAIN_NOISE_SCALE). heightAt()
// reads THE SAME triangles the mesh draws: objects stand exactly on the
// surface. Do not replace it with bilinear interpolation — on slopes objects
// would start to sink or float.
//
// Material — a texture tile (setGroundImage), repeated every GROUND_TILE_SIZE px. The grid and
// the ring share the same UVs — (x/W, y/H), so the tile continues beyond the edge without
// a seam. The ring is tinted by WORLD3D_OUTER_TINT (less than 1 — the location boundary is visible).
//
// GEOMETRY lives in the PlayCanvas world, mirrored on X versus the map (skill world3d,
// §Coordinates): a node (x, h, y) of the field is written as (-x, h, y). Winding is chosen so
// the faces look at the sky (the guard after the normal pass flips the order if the engine's
// front-face rule disagrees). Normals — by the triangles, in the same space.
//
// THE TERRAIN IS A PICTURE. Game logic does not ask 3D for height: the grid cell depends
// on the device (mobile — larger), and the computation would diverge between them.

class Terrain3D {
    // cfg: { worldW, worldH, groundImage?, cell?, noise?: { amp, scale, seed, base } }
    constructor(view, cfg) {
        const U = 'undefined';
        this.view = view;
        this.app = view.app;
        this.worldW = Math.max(64, cfg.worldW);
        this.worldH = Math.max(64, cfg.worldH);
        this.cell = Math.max(4, cfg.cell || (typeof TERRAIN_CELL !== U ? TERRAIN_CELL : 8));
        if (IS_MOBILE) this.cell = Math.max(this.cell, 12);
        const nz = cfg.noise || {};
        this.noiseAmp = nz.amp != null ? nz.amp : (typeof TERRAIN_NOISE_AMP !== U ? TERRAIN_NOISE_AMP : 28);
        this.noiseScale = Math.max(40, nz.scale != null ? nz.scale : (typeof TERRAIN_NOISE_SCALE !== U ? TERRAIN_NOISE_SCALE : 800));
        this.noiseBase = nz.base != null ? nz.base : (typeof TERRAIN_BASE !== U ? TERRAIN_BASE : 0);
        this.noiseSeed = nz.seed != null ? nz.seed : (typeof TERRAIN_NOISE_SEED !== U ? TERRAIN_NOISE_SEED : 5);
        this._noise = (typeof SimplexNoise !== U) ? new SimplexNoise(String(this.noiseSeed)) : null;
        // The camera pitch limit reads the ring width: the ring edge must not get into the frame.
        this.outerRing = Terrain3D.OUTER_RING;
        this.meshes = [];
        this.entities = [];
        this.texture = null;
        this._buildMaterials();
        this._buildField();
        this._buildGeometry();
        this._buildOuterRing();
        if (cfg.groundImage) this.setGroundImage(cfg.groundImage);
    }

    // --- Material ------------------------------------------------------------------

    // Two materials on one texture: the location grid and the ring beyond the edge (the ring
    // has its own brightness). Until there is a texture — flat green.
    _buildMaterials() {
        const mk = (name) => {
            const mat = /** @type {ArcMaterial} */ (new pc.StandardMaterial());
            mat.name = name;
            mat.arc = { group: 'ground' };
            mat.diffuse = new pc.Color(0.25, 0.4, 0.18);
            World3D.toon.attach(this.view, mat);
            World3D.applyMaterialConstants(mat);
            return mat;
        };
        this.material = mk('terrainMat');
        this.outerMaterial = mk('terrainOuterMat');
    }

    // Ground texture tile (Image or Canvas). The upload keeps the image rows as they are:
    // V goes down the map, like y (the old DynamicTexture with invertY = false).
    setGroundImage(img) {
        if (!img || !(img.width > 0)) return;
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        const tex = new pc.Texture(this.app.graphicsDevice, {
            width: img.width,
            height: img.height,
            mipmaps: true,
            minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
            magFilter: pc.FILTER_LINEAR,
            addressU: pc.ADDRESS_REPEAT,
            addressV: pc.ADDRESS_REPEAT
        });
        tex.name = 'groundTile';
        tex.anisotropy = IS_MOBILE ? 2 : 8;
        tex.setSource(c);
        const old = this.texture;
        this.texture = tex;
        this.applyTileSize();
        // With a texture the material color is a multiplier: white for the grid, for the ring —
        // brightness WORLD3D_OUTER_TINT (mat.arc.outer is read by applyMaterialConstants).
        this.material.diffuseMap = tex;
        this.material.diffuse = new pc.Color(1, 1, 1);
        this.outerMaterial.diffuseMap = tex;
        this.outerMaterial.diffuse = new pc.Color(1, 1, 1);
        /** @type {ArcMaterial} */ (this.outerMaterial).arc.outer = true;
        World3D.applyMaterialConstants(this.outerMaterial);
        this.material.update();
        this.outerMaterial.update();
        if (old) { try { old.destroy(); } catch (e) { /* ok */ } }
    }

    // Tile repeat — via the material's map tiling: u' = (x/W)·(W/tile) = x/tile.
    // GROUND_TILE_SIZE changed (editor) — only this.
    applyTileSize() {
        if (!this.texture) return;
        const tile = Math.max(16, (typeof GROUND_TILE_SIZE !== 'undefined') ? GROUND_TILE_SIZE : 512);
        this.material.diffuseMapTiling = new pc.Vec2(this.worldW / tile, this.worldH / tile);
        this.outerMaterial.diffuseMapTiling = new pc.Vec2(this.worldW / tile, this.worldH / tile);
    }

    // --- Height field ----------------------------------------------------------------

    terrainNoise(x, y) {
        if (!this._noise || !(this.noiseAmp > 0)) return this.noiseBase;
        const s = this.noiseScale;
        const n = this._noise.noise2D(x / s, y / s) * 0.72 +
                  this._noise.noise2D(x / s * 2.3 + 17.1, y / s * 2.3 - 9.7) * 0.28;
        return this.noiseBase + n * this.noiseAmp;
    }

    // Heights at the nodes of the grid [0..W]×[0..H] with step cell. The last cell may
    // extend beyond the edge (UV there > 1 — the tile simply continues).
    _buildField() {
        const cs = this.cell;
        this.nx = Math.ceil(this.worldW / cs) + 1;
        this.ny = Math.ceil(this.worldH / cs) + 1;
        const nx = this.nx, ny = this.ny;
        const H = new Float32Array(nx * ny);
        let lo = Infinity, hi = -Infinity;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const h = this.terrainNoise(i * cs, j * cs);
                H[j * nx + i] = h;
                if (h < lo) lo = h;
                if (h > hi) hi = h;
            }
        }
        this.hgrid = H;
        // Height range — for the pointer ray (View3D.pointerToGround) and the camera limit.
        this.hMin = lo;
        this.hMax = hi;
    }

    // Surface height under a point — exactly the one that is drawn: the cell is split by
    // the diagonal (i,j)-(i+1,j+1) into triangles (00,10,11) and (00,11,01), as in the
    // mesh. Beyond the grid edge — noise, as for the ring.
    heightAt(x, y) {
        const cs = this.cell, n = this.nx;
        const fx = x / cs, fy = y / cs;
        if (fx < 0 || fy < 0 || fx > n - 1 || fy > this.ny - 1) return this.terrainNoise(x, y);
        const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(this.ny - 2, Math.floor(fy));
        const tx = fx - i, ty = fy - j;
        const g = this.hgrid;
        const h00 = g[j * n + i], h10 = g[j * n + i + 1];
        const h01 = g[(j + 1) * n + i], h11 = g[(j + 1) * n + i + 1];
        if (tx >= ty) return h00 + (h10 - h00) * tx + (h11 - h10) * ty;
        return h00 + (h01 - h00) * ty + (h11 - h01) * tx;
    }

    // Surface tilt along the heading (rad): longitudinal and lateral slope from the
    // four points of the object's base — for the body's pitch and roll.
    tiltAt(x, y, headingRad, halfLen, halfWid) {
        const cx = Math.cos(headingRad), sy = Math.sin(headingRad);
        const hf = this.heightAt(x + cx * halfLen, y + sy * halfLen);
        const hb = this.heightAt(x - cx * halfLen, y - sy * halfLen);
        const hl = this.heightAt(x - sy * halfWid, y + cx * halfWid);
        const hr = this.heightAt(x + sy * halfWid, y - cx * halfWid);
        return {
            pitch: Math.atan2(hf - hb, halfLen * 2),   // nose higher than stern -> positive
            roll: Math.atan2(hl - hr, halfWid * 2)     // left side higher -> positive
        };
    }

    // --- Grids --------------------------------------------------------------------

    // Indices of a regular nx×ny grid in MAP order: triangles (a,b,d)(a,d,c) along the
    // diagonal a-d; swap — reversed winding. The mesh writer mirrors them into the
    // PlayCanvas world (X negated flips the screen winding, so the order is reversed
    // again on the way out).
    static gridIndices(nx, ny, swap) {
        const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
        let p = 0;
        for (let j = 0; j < ny - 1; j++) {
            for (let i = 0; i < nx - 1; i++) {
                const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
                if (swap) { idx[p++] = a; idx[p++] = d; idx[p++] = b; idx[p++] = a; idx[p++] = c; idx[p++] = d; }
                else { idx[p++] = a; idx[p++] = b; idx[p++] = d; idx[p++] = a; idx[p++] = d; idx[p++] = c; }
            }
        }
        return idx;
    }

    // Vertex normals by triangle area in PC space; returns { normals, up } where up is the
    // mean Y of the face normals — the winding guard reads it.
    static computeNormals(pos, idx) {
        const n = new Float32Array(pos.length);
        let upSum = 0;
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
            const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
            const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            upSum += ny;
            n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
            n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
            n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
        }
        for (let i = 0; i < n.length; i += 3) {
            const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
            n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
        }
        return { normals: n, up: upSum };
    }

    // Location grid. ORIENTATION: the ground needs a +Y normal and a front face that looks
    // at the sky. Positions go into the engine mirrored (x -> -x); the winding is the map
    // order REVERSED (the mirror flips it once more), and a safeguard after the normal pass
    // flips it again if the faces came out downward-facing. Do not "fix" the order by hand:
    // the handedness of the world already cost an iteration.
    _buildGeometry() {
        const nx = this.nx, ny = this.ny, cs = this.cell, NV = nx * ny, H = this.hgrid;
        const W = this.worldW, HH = this.worldH;
        const pos = new Float32Array(NV * 3), uvs = new Float32Array(NV * 2);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const k = j * nx + i, x = i * cs, y = j * cs;
                pos[k * 3] = -x; pos[k * 3 + 1] = H[k]; pos[k * 3 + 2] = y;
                uvs[k * 2] = x / W; uvs[k * 2 + 1] = y / HH;
            }
        }
        let idx = Terrain3D.gridIndices(nx, ny, false);
        let nr = Terrain3D.computeNormals(pos, idx);
        if (nr.up < 0) {
            idx = Terrain3D._reverseWinding(idx);
            nr = Terrain3D.computeNormals(pos, idx);
        }
        this._swap = nr.up < 0;   // the ring reuses the verdict
        this.mesh = this._makeMesh('terrain', pos, nr.normals, uvs, idx, this.material);
        this.triangles = idx.length / 3;
        this.meshes.push(this.mesh);
    }

    // Ground ring around the location: pure noise, cell RING_CELL. The hole in it is the location
    // grid; the ring cells at its edge stay and lie 1 px LOWER (under the grid, no further than one
    // and a half cells) — the T-junction of the coarse and fine grids doesn't let the sky show.
    _buildOuterRing() {
        const extent = this.outerRing, cell = Terrain3D.RING_CELL;
        const W = this.worldW, H = this.worldH;
        const x0 = -extent, y0 = -extent;
        const nx = Math.ceil((W + 2 * extent) / cell) + 1, ny = Math.ceil((H + 2 * extent) / cell) + 1;
        const positions = new Float32Array(nx * ny * 3), uvs = new Float32Array(nx * ny * 2);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const k = j * nx + i, x = x0 + i * cell, y = y0 + j * cell;
                positions[k * 3] = -x; positions[k * 3 + 1] = this.terrainNoise(x, y) - 1; positions[k * 3 + 2] = y;
                uvs[k * 2] = x / W; uvs[k * 2 + 1] = y / H;
            }
        }
        // Cells — only outside the location grid (with a one-cell margin at its edge).
        const X1 = (this.nx - 1) * this.cell, Y1 = (this.ny - 1) * this.cell;
        const inside = (x, y) => x > 0 && x < X1 && y > 0 && y < Y1;
        const indices = [];
        for (let j = 0; j < ny - 1; j++) {
            for (let i = 0; i < nx - 1; i++) {
                const cx = x0 + (i + 0.5) * cell, cy = y0 + (j + 0.5) * cell;
                if (inside(cx, cy) && inside(cx - cell, cy - cell) && inside(cx + cell, cy + cell)) continue;
                const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
                indices.push(a, b, d, a, d, c);   // map order; reversed below with the rest
            }
        }
        let idx = new Uint32Array(indices);
        let nr = Terrain3D.computeNormals(positions, idx);
        if (nr.up < 0) { idx = Terrain3D._reverseWinding(idx); nr = Terrain3D.computeNormals(positions, idx); }
        this.outer = this._makeMesh('terrainOuter', positions, nr.normals, uvs, idx, this.outerMaterial);
        this.meshes.push(this.outer);
    }

    // Triangle order (a,b,c) -> (a,c,b): the mirror into the PlayCanvas world flips the
    // screen winding once, so what the map order meant in the right-handed scene is
    // restored by reversing it here.
    static _reverseWinding(idx) {
        const out = new Uint32Array(idx.length);
        for (let t = 0; t < idx.length; t += 3) { out[t] = idx[t]; out[t + 1] = idx[t + 2]; out[t + 2] = idx[t + 1]; }
        return out;
    }

    // pc.Mesh + entity + mesh instance in the world layer, static, receives shadows.
    _makeMesh(name, pos, normals, uvs, idx, material) {
        const mesh = new pc.Mesh(this.app.graphicsDevice);
        mesh.setPositions(pos);
        mesh.setNormals(normals);
        mesh.setUvs(0, uvs);
        mesh.setIndices(idx);
        mesh.update(pc.PRIMITIVE_TRIANGLES);
        const node = new pc.Entity(name);
        this.view.root.addChild(node);
        this.entities.push(node);
        const mi = new pc.MeshInstance(mesh, material, node);
        mi.receiveShadow = true;
        mi.castShadow = false;
        node.addComponent('render', { layers: [pc.LAYERID_WORLD] });
        node.render.meshInstances = [mi];   // the layer registration comes with the component
        return mesh;
    }

    dispose() {
        for (const node of this.entities) { try { node.destroy(); } catch (e) { /* ok */ } }
        this.entities = [];
        for (const m of this.meshes) { try { m.destroy(); } catch (e) { /* ok */ } }
        this.meshes = [];
        this.mesh = null;
        this.outer = null;
        for (const mat of [this.material, this.outerMaterial]) {
            if (mat) { try { mat.destroy(); } catch (e) { /* ok */ } }
        }
        if (this.texture) { try { this.texture.destroy(); } catch (e) { /* ok */ } this.texture = null; }
    }
}

// Width of the ground ring beyond the location edge (px) and its cell.
Terrain3D.OUTER_RING = 2400;
Terrain3D.RING_CELL = 64;
