// Debug3D.js — the kit's dev tools: scene lint, a held debug view, a synchronous benchmark
// and debug render modes. Inert until called: nothing here runs in a normal frame, so the
// script may stay in a release build.
//
//   await Debug3D.lint()                          findings of the active view (World3D.view)
//   Debug3D.hold({ eye: [x, y, h], target: [x, y, h] })   look from here, whatever the camera
//   Debug3D.release()                             controller does; release() hands it back
//   Debug3D.bench()                               ms per frame, GPU-synchronised
//   Debug3D.benchToggle(mesh)                     what one thing costs (A/B/A/B)
//   Debug3D.setMode('backfaces' | 'normals' | 'wireframe' | 'off')
//
// WHY LINT. Every check below is a defect that once reached the screen unnoticed by the
// author and was found by eye: a mesh with the opposite winding draws its inside (the
// silhouette is the same, so it looks plausible — but the light comes from the wrong side and
// textures are mirrored); a mirrored node scale flips the faces silently; two shadow-casting
// suns fight over the one colored shadow of the toon shader.
//
// WINDING RULE (PlayCanvas: front face is COUNTER-CLOCKWISE, like glTF). Take the triangle
// normal as cross(b - a, c - a): it points ALONG the vertex normals on a correct mesh of
// this world, and AGAINST them on an inside-out one. A mirrored world matrix (negative
// determinant — a negative scale on the entity) flips the verdict. A mesh that disagrees
// needs its indices reversed (or culling off for cards).

/** @satisfies {Record<string, any>} */
const Debug3D = {
    /** @type {{ heightAt(x: number, y: number): number } | null} */
    terrain: null,          // for hold(): keeps the eye above the ground; defaults to window.app's
    /** @type {{ view: View3D, fn: any, pose: any } | null} */
    _hold: null,
    _mode: 'off',
    /** @type {Map<any, any>} */
    _saved: new Map(),      // mesh instance -> its material (debug modes swap them)
    /** @type {Map<any, any>} */
    _savedMesh: new Map(),  // mesh instance -> its mesh (wireframe swaps meshes)
    /** @type {pc.ShaderMaterial | null} */
    _modeMaterial: null,
    /** @type {Map<any, pc.Mesh>} */
    _wireCache: new Map(),
    /** @type {View3D | null} */
    _modeView: null,

    LIMITS: { meshTriangles: 300000, sampleTriangles: 20000 },

    // True on software rasterizers (SwiftShader/llvmpipe/Software): headless sandboxes and
    // ancient GPUs. Games use it for VISUAL LEVELS (feedback: heavy GLB do not run in
    // headless): lower shadow map, skip hulls/ink, procedural stand-ins instead of GLB.
    softwareGL() {
        const W = /** @type {any} */ (window).World3D;
        const gl = W && W.app && W.app.graphicsDevice && /** @type {any} */ (W.app.graphicsDevice).gl;
        if (!gl || !gl.getExtension) return false;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
        return /swiftshader|llvmpipe|softpipe|software|angle \(google, vulkan.*swiftshader/i.test(renderer);
    },

    // --- Lint: pure parts (tests/debug3d.test.mjs) ----------------------------------------

    // Share of triangles whose winding normal points against the vertex normals (0..1), over at
    // most maxTris evenly spaced triangles. total = 0 — nothing to judge by.
    windingAgainstNormals(positions, normals, indices, maxTris) {
        const P = positions, N = normals, I = indices;
        const count = Math.floor(I.length / 3), step = Math.max(1, Math.ceil(count / (maxTris || count || 1)));
        let against = 0, total = 0;
        for (let t = 0; t < count; t += step) {
            const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
            const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
            const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
            const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
            const d = gx * (N[a] + N[b] + N[c]) + gy * (N[a + 1] + N[b + 1] + N[c + 1]) + gz * (N[a + 2] + N[b + 2] + N[c + 2]);
            if (Math.abs(d) < 1e-12) continue;      // degenerate triangle or zero normals
            total++;
            if (d < 0) against++;
        }
        return { against: total ? against / total : 0, total };
    },

    // against — from windingAgainstNormals; mirrored — negative world determinant (a negative
    // scale on the entity). PlayCanvas' front face is counter-clockwise: a correct unmirrored
    // mesh has the winding normal ALONG the vertex normals (against ~ 0). Returns the share of
    // triangles facing the wrong way and the verdict: 'ok', 'mixed' (double-sided cards are
    // fine, a half-flipped hull is not) or 'inverted'.
    sideVerdict(against, mirrored) {
        const wrong = mirrored ? 1 - against : against;
        return { wrong, verdict: wrong >= 0.9 ? 'inverted' : wrong >= 0.25 ? 'mixed' : 'ok' };
    },

    // A normal map's convention cannot be read from its pixels, only from its name: Poly Haven
    // and glTF maps are OpenGL (Y up), DirectX maps are Y down. PlayCanvas reads OpenGL maps
    // as they are (glTF-native); a DirectX map needs its green channel flipped by hand
    // (bumpiness < 0 inverts the whole map — close enough for a flat-ish surface, and the
    // lint names the file so the author can re-export). Returns 'ok', 'wrong' or 'unknown'.
    normalMapVerdict(url, inverted) {
        const name = String(url || '').toLowerCase();
        const gl = /(_nor_gl|_normal_gl|[_-]gl)\.[a-z]+$|_nor_gl_|normalgl|opengl/.test(name) || /\.(glb|gltf)/.test(name);
        const dx = /(_nor_dx|_normal_dx|[_-]dx)\.[a-z]+$|_nor_dx_|normaldx|directx/.test(name);
        if (gl === dx) return 'unknown';
        return (gl ? !inverted : inverted) ? 'ok' : 'wrong';
    },

    // Map pose -> map-space vectors. pose: { eye: [x, y, h], target: [x, y, h] } or
    // { eye, yaw, pitch } (yaw — heading in map radians, pitch — up is positive). The eye is
    // lifted to clearance px above the ground when a terrain is known.
    poseFrom(pose, terrain, clearance) {
        const e = pose.eye, eye = { x: e[0], y: e[1], h: e[2] };
        let clamped = false;
        if (terrain) {
            const floor = terrain.heightAt(eye.x, eye.y) + (clearance == null ? 4 : clearance);
            if (eye.h < floor) { eye.h = floor; clamped = true; }
        }
        let target;
        if (pose.target) target = { x: pose.target[0], y: pose.target[1], h: pose.target[2] };
        else {
            const yaw = pose.yaw || 0, pitch = pose.pitch || 0, cp = Math.cos(pitch);
            target = { x: eye.x + Math.cos(yaw) * cp * 100, y: eye.y + Math.sin(yaw) * cp * 100, h: eye.h + Math.sin(pitch) * 100 };
        }
        return { eye, target, clamped };
    },

    // --- Lint --------------------------------------------------------------------------------

    // Findings of a view: [{ level: 'error' | 'warn' | 'info', code, target, message }], worst
    // first, plus scene totals. opts.silent — no console output; opts.frame = false — skip the
    // blank-frame probe (it renders one frame).
    async lint(view, opts) {
        view = view || World3D.view;
        const o = opts || {};
        /** @type {{ level: string, code: string, target: string, message: string }[]} */
        const out = [];
        if (!view || !view.root) return { findings: out, stats: null };
        const add = (level, code, target, message) => out.push({ level, code, target, message });
        const list = view.allMeshInstances().filter(mi => mi !== this._modeMaterial);
        const stats = { meshes: list.length, triangles: 0, materials: view.materials().length, lights: 1 };

        this._lintLights(view, add);
        for (const mi of list) {
            const mesh = mi.mesh;
            if (!mesh || !mesh.vertexBuffer || !mesh.vertexBuffer.numVertices) continue;
            if (this._saved.has(mi)) continue;   // a debug mode is on
            const tris = (mesh.primitive[0] ? mesh.primitive[0].count : 0) / 3;
            stats.triangles += tris;
            if (tris > this.LIMITS.meshTriangles) {
                add('warn', 'heavy-mesh', mi.node ? mi.node.name : '?', Math.round(tris / 1000) + 'K triangles in one mesh: decimate or add a LOD');
            }
            this._lintWinding(mi, add);
            this._lintMaterial(mi.material, mi, add);
        }
        if (o.frame !== false) await this._lintFrame(view, add);

        /** @type {Record<string, number>} */
        const rank = { error: 0, warn: 1, info: 2 };
        out.sort((a, b) => rank[a.level] - rank[b.level]);
        if (!o.silent) {
            const n = (l) => out.filter(f => f.level === l).length;
            console.log('Debug3D.lint: ' + n('error') + ' error(s), ' + n('warn') + ' warning(s), ' + n('info') + ' note(s); ' +
                stats.meshes + ' meshes, ' + Math.round(stats.triangles / 1000) + 'K triangles, ' + stats.lights + ' light(s)');
            if (out.length) console.table(out);
        }
        return { findings: out, stats };
    },

    _lintWinding(mi, add) {
        const mesh = mi.mesh;
        const vb = mesh.vertexBuffer;
        const fmt = vb.format;
        const iP = fmt.elements.find(el => el.name === pc.SEMANTIC_POSITION);
        const iN = fmt.elements.find(el => el.name === pc.SEMANTIC_NORMAL);
        if (!iP || !iN) return;
        const locked = new Float32Array(/** @type {ArrayBuffer} */ (vb.lock()));
        const stride = fmt.size / 4;
        const P = [], N = [];
        for (let v = 0; v < vb.numVertices; v++) {
            const o = v * stride;
            P.push(locked[o + iP.offset / 4], locked[o + iP.offset / 4 + 1], locked[o + iP.offset / 4 + 2]);
            N.push(locked[o + iN.offset / 4], locked[o + iN.offset / 4 + 1], locked[o + iN.offset / 4 + 2]);
        }
        vb.unlock();
        const ib = mesh.indexBuffer && mesh.indexBuffer[0];
        if (!ib) return;
        const I = Array.from(ib.lock());
        ib.unlock();
        const w = this.windingAgainstNormals(P, N, I, this.LIMITS.sampleTriangles);
        if (!w.total) return;
        const mirrored = mi.node ? mi.node.getWorldTransform().scaleSign < 0 : false;
        const v = this.sideVerdict(w.against, mirrored);
        if (v.verdict === 'ok') return;
        const culled = !mi.material || mi.material.cull !== pc.CULLFACE_NONE;
        const share = Math.round(v.wrong * 100) + '% of triangles face inward';
        if (v.verdict === 'inverted') {
            add(culled ? 'error' : 'warn', 'inverted-winding', (mi.node && mi.node.name) || '?', share + (culled
                ? ': the mesh draws its INSIDE (far wall, mirrored texture, light from the wrong side)'
                : ': back-face lighting is wrong') + ' — reverse the index order of the mesh');
        } else if (culled) {
            add('warn', 'mixed-winding', (mi.node && mi.node.name) || '?', share + ' while back-face culling is on: holes from one side — fix the index order of those parts or turn culling off for cards');
        }
    },

    _lintLights(view, add) {
        const suns = view.root.findComponents('light').filter(l => l.castShadows && l.type === 'directional');
        if (suns.length > 1) {
            add('warn', 'sun-count', suns.length + ' lights', 'the toon shader colors ONE sun shadow (the last directional light in the loop wins): keep a single shadow-casting directional light');
        }
    },

    _lintMaterial(mat, mi, add) {
        if (!mat || !(mat instanceof pc.StandardMaterial) || !mat.normalMap) return;
        const url = mat.normalMap.name || '';
        const verdict = this.normalMapVerdict(url, mat.bumpiness < 0);
        if (verdict === 'wrong') {
            add('error', 'normal-map-y', mat.name, 'normal map "' + url + '" looks like a DirectX map (Y down): PlayCanvas reads OpenGL/green-up maps natively — re-export it or negate bumpiness');
        } else if (verdict === 'unknown' && mat.bumpiness < 0) {
            add('info', 'normal-map-y', mat.name, 'normal map "' + url + '" with inverted bumpiness: right only for a DirectX map. OpenGL maps (Poly Haven, glTF) need it as is');
        }
    },

    // A NaN in a shader (normalize of a zero vector, pow of a negative) spreads and whites out
    // the WHOLE frame; a shader writing zeros blacks it out.
    async _lintFrame(view, add) {
        const gl = /** @type {any} */ (view.world.app.graphicsDevice).gl;
        if (!gl || !gl.readPixels) return;
        try {
            World3D.renderFrame();
            const dev = view.world.app.graphicsDevice;
            const w = dev.width, h = dev.height;
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            let white = 0, black = 0, n = 0, any = 0;
            for (let i = 0; i + 3 < px.length; i += 4 * 61) {
                n++;
                if (px[i] || px[i + 1] || px[i + 2]) any++;
                if (px[i] >= 250 && px[i + 1] >= 250 && px[i + 2] >= 250) white++;
                else if (px[i] <= 4 && px[i + 1] <= 4 && px[i + 2] <= 4) black++;
            }
            if (!n || !any) return;   // the backbuffer was already swapped — probe unavailable
            if (white / n > 0.98) add('warn', 'blank-frame', 'frame', 'the frame is fully white: a NaN in a shader spreads — look for normalize() of a zero vector or pow() of a negative in custom chunks');
            if (black / n > 0.98) add('warn', 'blank-frame', 'frame', 'the frame is fully black: no light reaches the scene, exposure is zero or a shader writes zeros');
        } catch (e) { /* readPixels is unavailable — skip the probe */ }
    },

    // --- Held view -----------------------------------------------------------------------------

    // Holds the camera at a pose whatever the CameraController does: the pose is applied
    // right before every render, after the controller's own update. Returns the pose in use
    // ({ eye, target, clamped }); clamped — the eye was under the ground and has been lifted.
    hold(pose, view) {
        view = view || World3D.view;
        this.release();
        const app = /** @type {any} */ (window).app;
        const terrain = this.terrain || (app && app.location && app.location.terrain) || null;
        const p = this.poseFrom(pose, terrain, pose.clearance);
        const cam = view.camera;
        const apply = () => {
            cam.position.set(p.eye.x, p.eye.h, p.eye.y);
            cam.setTarget({ x: p.target.x, y: p.target.h, z: p.target.y });
        };
        view.onBeforeFrame(apply);
        this._hold = { view, fn: apply, pose: p };
        apply();
        return p;
    },

    // Hands the camera back to its controller (its next update() restores its own pose).
    release() {
        const h = this._hold;
        if (!h) return;
        const i = h.view._syncFns.indexOf(h.fn);
        if (i >= 0) h.view._syncFns.splice(i, 1);
        this._hold = null;
    },

    // n frames right now, without waiting for requestAnimationFrame (a hidden or background
    // tab gets a few frames per second at best): for "move, then look" in one script.
    frames(n) {
        for (let i = 0; i < (n || 1); i++) World3D.renderFrame();
    },

    // --- Benchmark -----------------------------------------------------------------------------

    // Milliseconds per frame with the GPU drained (gl.finish) before and after: the FPS counter
    // of a throttled tab says nothing. Same view, same size, nothing else rendering nearby —
    // a second 3D tab halves the GPU.
    bench(opts) {
        const o = opts || {}, gl = World3D.app && /** @type {any} */ (World3D.app.graphicsDevice).gl;
        const finish = () => { if (gl && gl.finish) gl.finish(); };
        this.frames(o.warmup == null ? 10 : o.warmup);
        finish();
        const n = o.frames || 60, t0 = performance.now();
        this.frames(n);
        finish();
        const ms = (performance.now() - t0) / n;
        const dev = World3D.app.graphicsDevice;
        return { ms: Math.round(ms * 100) / 100, fps: Math.round(1000 / ms), width: dev.width, height: dev.height };
    },

    // Cost of one thing: target — an entity (enabled on/off) or { on(), off() }. Alternates A/B
    // rounds times and compares the best runs — one-off spikes (shader compiles) drop out.
    benchToggle(target, opts) {
        const o = opts || {}, rounds = o.rounds || 3;
        const t = target && target.setEnabled ? { on: () => target.setEnabled(true), off: () => target.setEnabled(false) } : target;
        const on = [], off = [];
        for (let i = 0; i < rounds; i++) {
            t.on(); on.push(this.bench(o).ms);
            t.off(); off.push(this.bench(o).ms);
        }
        t.on();
        const best = (a) => Math.min(...a);
        return { on: best(on), off: best(off), delta: Math.round((best(on) - best(off)) * 100) / 100, runs: { on, off } };
    },

    // --- Machine-readable assertions for the AI loop (review: visual verification) -----
    // Every assert returns { ok, code, details } instead of throwing: the agent reads the
    // outcome and fixes the scene; the headless gate aggregates them into its JSON report.

    _rec(name) {
        const app = /** @type {any} */ (window).app;
        const loc = app && app.location;
        return loc ? loc.objects.find(r => r.def.name === name) : null;
    },

    // The object exists, its model has loaded, and it sits at/above the ground it stands on.
    assertVisible(name) {
        const rec = this._rec(name);
        if (!rec) return { ok: false, code: 'no-object', details: { name } };
        if (!rec.mesh) return { ok: false, code: 'not-loaded', details: { name, error: rec.error } };
        const view = /** @type {any} */ (window).World3D.view;
        const t = /** @type {any} */ (window).app.location.terrain;
        const d = rec.def;
        const ground = t ? t.heightAt(d.x, d.y) : 0;
        if (d.h < -1) return { ok: false, code: 'under-ground', details: { name, h: d.h, ground } };
        const frame = this.assertInFrame(name);
        if (!frame.ok) return frame;
        return { ok: true, code: 'visible', details: { name, view: view ? true : false } };
    },

    // The object's anchor projects inside the current frame (view.projectToScreen).
    assertInFrame(name) {
        const rec = this._rec(name);
        if (!rec) return { ok: false, code: 'no-object', details: { name } };
        const view = /** @type {any} */ (window).World3D.view;
        if (!view) return { ok: false, code: 'no-view', details: { name } };
        view.refreshMatrices();
        const d = rec.def;
        const p = view.projectToScreen(d.x, d.y, (d.h || 0) + 1);
        return p.visible
            ? { ok: true, code: 'in-frame', details: { name, screen: [Math.round(p.x), Math.round(p.y)] } }
            : { ok: false, code: p.behind ? 'behind-camera' : 'out-of-frame', details: { name, screen: [Math.round(p.x), Math.round(p.y)] } };
    },

    // The record sits where the agent meant to put it (map px, tolerance inclusive).
    assertPosition(name, x, y, tol) {
        const rec = this._rec(name);
        if (!rec) return { ok: false, code: 'no-object', details: { name } };
        const t = tol == null ? 1 : tol, d = rec.def;
        const dx = d.x - x, dy = d.y - y;
        return Math.abs(dx) <= t && Math.abs(dy) <= t
            ? { ok: true, code: 'position', details: { name, x: d.x, y: d.y } }
            : { ok: false, code: 'position-mismatch', details: { name, want: [x, y], got: [d.x, d.y], dx, dy } };
    },

    // Render now and hand back the frame: the agent LOOKS at the result of its edit.
    capture() {
        const W = /** @type {any} */ (window).World3D;
        if (!W || !W.canvas) return { ok: false, code: 'no-canvas' };
        W.renderFrame();
        const c = W.canvas;
        return { ok: true, width: c.width, height: c.height, dataUrl: c.toDataURL('image/png') };
    },

    // --- Debug render modes ----------------------------------------------------------------------

    // 'backfaces' — faces the engine treats as back are RED (an inside-out mesh turns red from
    // the outside), 'normals' — world normals as color, 'wireframe' — every edge as a line,
    // 'off'. Materials (or meshes) are swapped for the time of the mode and restored by 'off';
    // instances added meanwhile keep their own.
    setMode(mode, view) {
        view = view || this._modeView || World3D.view;
        if (!view) return this._mode;
        for (const [mi, mat] of this._saved) mi.material = mat;
        this._saved.clear();
        for (const [mi, mesh] of this._savedMesh) mi.mesh = mesh;
        this._savedMesh.clear();
        this._mode = mode === 'backfaces' || mode === 'normals' || mode === 'wireframe' ? mode : 'off';
        this._modeView = this._mode === 'off' ? null : view;
        if (this._mode === 'off') return this._mode;
        if (this._mode === 'wireframe') {
            const wire = this._wireMaterial();
            for (const mi of view.allMeshInstances()) {
                if (!mi.mesh || !mi.mesh.vertexBuffer || !mi.mesh.vertexBuffer.numVertices) continue;
                this._savedMesh.set(mi, mi.mesh);
                this._saved.set(mi, mi.material);
                mi.mesh = this._wireMesh(view, mi.mesh);
                mi.material = wire;
            }
            return this._mode;
        }
        const mat = this._facesMaterial(view);
        mat.setParameter('mode', this._mode === 'normals' ? 1 : 0);
        for (const mi of view.allMeshInstances()) {
            if (!mi.mesh || !mi.mesh.vertexBuffer || !mi.mesh.vertexBuffer.numVertices) continue;
            this._saved.set(mi, mi.material);
            mi.material = mat;
        }
        return this._mode;
    },

    _facesMaterial(view) {
        if (this._modeMaterial) return this._modeMaterial;
        const mat = new pc.ShaderMaterial({
            uniqueName: 'debug3dFaces',
            attributes: { vertex_position: pc.SEMANTIC_POSITION, vertex_normal: pc.SEMANTIC_NORMAL },
            vertexGLSL: [
                '#include "transformCoreVS"',
                '#include "normalCoreVS"',
                'varying vec3 vN;',
                'void main(void) {',
                '    vN = mat3(getModelMatrix()) * getLocalNormal(vertex_normal);',
                '    gl_Position = getPosition();',
                '}'].join('\n'),
            fragmentGLSL: [
                'precision highp float;',
                'varying vec3 vN;',
                'uniform float mode;',
                'void main(void) {',
                '    vec3 n = normalize(vN + vec3(0.0, 1e-5, 0.0));',
                '    if (mode > 0.5) { gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); return; }',
                '    float l = 0.3 + 0.7 * abs(dot(n, normalize(vec3(0.4, 0.8, 0.45))));',
                '    gl_FragColor = gl_FrontFacing ? vec4(vec3(l) * 0.75, 1.0) : vec4(l, 0.07, 0.05, 1.0);',
                '}'].join('\n')
        });
        mat.cull = pc.CULLFACE_NONE;
        this._modeMaterial = mat;
        return mat;
    },

    _wireMaterial() {
        if (this._wireMat) return this._wireMat;
        const mat = new pc.ShaderMaterial({
            uniqueName: 'debug3dWire',
            attributes: { vertex_position: pc.SEMANTIC_POSITION },
            vertexGLSL: '#include "transformCoreVS"\nvoid main(void) { gl_Position = getPosition(); }',
            fragmentGLSL: 'precision highp float;\nvoid main(void) { gl_FragColor = vec4(0.1, 0.75, 0.5, 1.0); }'
        });
        mat.cull = pc.CULLFACE_NONE;
        this._wireMat = mat;
        return mat;
    },

    // Every triangle edge of a mesh as a line mesh (cached per source mesh).
    _wireMesh(view, mesh) {
        if (this._wireCache.has(mesh)) return this._wireCache.get(mesh);
        const vb = mesh.vertexBuffer;
        const fmt = vb.format;
        const iP = fmt.elements.find(el => el.name === pc.SEMANTIC_POSITION);
        const locked = new Float32Array(/** @type {ArrayBuffer} */ (vb.lock()));
        const stride = fmt.size / 4;
        const P = new Float32Array(vb.numVertices * 3);
        for (let v = 0; v < vb.numVertices; v++) {
            const o = v * stride + iP.offset / 4;
            P[v * 3] = locked[o]; P[v * 3 + 1] = locked[o + 1]; P[v * 3 + 2] = locked[o + 2];
        }
        vb.unlock();
        const ib = mesh.indexBuffer && mesh.indexBuffer[0];
        const I = ib ? ib.lock() : null;
        if (ib) ib.unlock();
        const nTri = I ? I.length / 3 : vb.numVertices / 3;
        const idx = [];
        for (let t = 0; t < nTri; t++) {
            const a = I ? I[t * 3] : t * 3, b = I ? I[t * 3 + 1] : t * 3 + 1, c = I ? I[t * 3 + 2] : t * 3 + 2;
            idx.push(a, b, b, c, c, a);
        }
        const out = new pc.Mesh(view.world.app.graphicsDevice);
        out.setPositions(P);
        out.setIndices(idx);
        out.update(pc.PRIMITIVE_LINES);
        this._wireCache.set(mesh, out);
        return out;
    }
};
