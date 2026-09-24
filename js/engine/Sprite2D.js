// Sprite2D.js — 2D sprites and billboards on the PlayCanvas backend.
//
// The 2D and 2.5D profiles present entities as textured quads. PlayCanvas is the single
// engine backend for every profile (no Phaser, no second runtime), and a sprite here is a
// camera-aligned quad with an unlit material in its own render layer:
//
//   • screen-aligned — the quad copies the camera rotation, so it looks like a 2D sprite
//     from any camera: lying flat under a top-down camera, standing in a side view, tilted
//     in an isometric one. One code path, no per-profile special case.
//   • declarative depth — renderLayer + drawOrder + zIndex (SORTMODE_CUSTOM), never a
//     distance computed by game code.
//   • automatic fallback — a texture that fails to load becomes a generated placeholder
//     (a colored card with the role name), so a missing asset never leaves a hole.
//   • frame animation — an atlas grid (cols × rows) or explicit frame indices per state.
//
// Only this file and Visual3D.js know that a sprite is a mesh instance: gameplay talks to
// GameAnimation.play('run') and VisualEntity, never here.

/** @satisfies {Record<string, any>} */
const Sprite2D = {
    /** @type {Map<string, any>} texture cache key -> pc.Texture */
    _textures: new Map(),
    /** @type {Map<any, any>} view uid -> { layer, mesh, sprites:Set, sync:Function } */
    _views: new Map(),

    get LAYER_ID() { return World3D.LAYER_ID.SPRITE; },
    get LAYER_NAME() { return 'sprite2d'; },

    // --- per-view plumbing ------------------------------------------------------------------

    /** The sprite layer + the shared unit quad of a view (created on first use). */
    ensure(view) {
        if (!view || !view.root) return null;
        let rec = Sprite2D._views.get(view.uid);
        if (rec) return rec;
        const app = view.app;
        const layer = new pc.Layer({
            name: Sprite2D.LAYER_NAME,
            id: Sprite2D.LAYER_ID,
            clearColorBuffer: false,
            clearDepthBuffer: false,
            opaqueSortMode: pc.SORTMODE_CUSTOM,
            transparentSortMode: pc.SORTMODE_CUSTOM
        });
        app.scene.layers.push(layer);
        const ids = (view.camComp.layers || []).slice();
        if (!ids.includes(Sprite2D.LAYER_ID)) { ids.push(Sprite2D.LAYER_ID); view.camComp.layers = ids; }
        rec = { view: view, layer: layer, mesh: Sprite2D._unitQuad(app.graphicsDevice), sprites: new Set(), frames: 0 };
        // Screen-align every sprite once per frame, just before the render.
        rec.sync = () => Sprite2D._syncView(rec);
        view.onBeforeFrame(rec.sync);
        Sprite2D._views.set(view.uid, rec);
        return rec;
    },

    /** A 1×1 quad in the XY plane, centered, +Z toward the viewer. Shared by every sprite. */
    _unitQuad(device) {
        const mesh = new pc.Mesh(device);
        mesh.setPositions(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]));
        mesh.setNormals(new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]));
        mesh.setUvs(0, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
        mesh.setIndices(new Uint16Array([0, 1, 2, 0, 2, 3]));
        mesh.update(pc.PRIMITIVE_TRIANGLES);
        // A shared mesh is never destroyed per sprite (the kit's refCount trap): it dies with
        // the view in dispose().
        return mesh;
    },

    // --- creation -------------------------------------------------------------------------------

    /**
     * Create a sprite.
     * opts — { name, texture (assets/… path | null), placeholder { color, label, size },
     *          w, h, drawOrder, depthTest, opacity, tint, frames { cols, rows, fps, states },
     *          flat (true — do not screen-align: a decal on the ground) }
     * @returns {any} handle { entity, mi, mat, w, h, mode, state, ... }
     */
    create(view, opts) {
        const o = opts || {};
        const rec = Sprite2D.ensure(view);
        if (!rec) return null;
        const w = Math.max(1, Number(o.w) || 64);
        const h = Math.max(1, Number(o.h) || 64);
        const entity = new pc.Entity(o.name || 'sprite');
        view.root.addChild(entity);
        entity.addComponent('render', { layers: [Sprite2D.LAYER_ID] });
        const mat = /** @type {ArcMaterial} */ (new pc.StandardMaterial());
        mat.name = (o.name || 'sprite') + '-sprite';
        mat.useLighting = false;                       // a 2D sprite is its own color
        mat.emissive = new pc.Color(1, 1, 1);
        mat.cull = pc.CULLFACE_NONE;                   // screen-aligned: never show a back
        mat.blendType = pc.BLEND_NORMAL;
        mat.depthWrite = false;
        mat.depthTest = o.depthTest !== false;
        mat.opacity = o.opacity != null ? Math.max(0, Math.min(1, Number(o.opacity))) : 1;
        if (o.tint) {
            const t = Sprite2D.colorOf(o.tint);
            mat.emissive = new pc.Color(t.r, t.g, t.b);
        }
        const mi = new pc.MeshInstance(rec.mesh, mat, entity);
        mi.drawOrder = Number(o.drawOrder) || 0;
        entity.render.meshInstances = [mi];
        rec.layer.addMeshInstances([mi], true);
        entity.setLocalScale(w, h, 1);

        /** @type {any} */
        const handle = {
            kind: 'sprite', entity: entity, mi: mi, mat: mat, view: view, layer: rec.layer,
            // base size (as authored); the entity scale is applied on top of it every place()
            // call, so place() must never accumulate it (that shrank/grew sprites per frame)
            baseW: w, baseH: h,
            w: w, h: h, flat: !!o.flat, depthTest: mat.depthTest,
            texture: null, textureKey: null, state: null, frames: o.frames || null,
            frame: 0, frameT: 0, fps: (o.frames && o.frames.fps) || 8,
            drawOrder: mi.drawOrder, disposed: false, placeholder: !!o.placeholder
        };
        rec.sprites.add(handle);
        if (o.texture) Sprite2D.setTexture(handle, o.texture, o.placeholder);
        else if (o.placeholder) Sprite2D.setPlaceholder(handle, o.placeholder);
        else Sprite2D.setPlaceholder(handle, { color: '#7f8c99', label: o.name || 'sprite' });
        return handle;
    },

    // --- textures --------------------------------------------------------------------------------

    /** Load (and cache) a texture; a failure falls back to a generated placeholder. */
    setTexture(handle, path, placeholder) {
        if (!handle || handle.disposed) return null;
        const key = 'file:' + path;
        const cached = Sprite2D._textures.get(key);
        if (cached) { Sprite2D._assign(handle, cached, key); return cached; }
        const view = handle.view;
        // The editor serves the game from /_utils/editor/, so a bare assets/… path is
        // resolved against the page: the location's assetBase prefixes it there.
        const url = /^(\/|https?:|data:)/.test(String(path)) ? String(path) : (Sprite2D.assetBase || '') + String(path);
        const asset = new pc.Asset(String(path).replace(/^.*\//, ''), 'texture', { url: url });
        asset.once('load', (a) => {
            if (handle.disposed) return;
            const tex = a.resource;
            tex.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
            tex.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
            // Pixel art stays crisp: no mipmaps, nearest sampling.
            if (Sprite2D.pixelArt) { tex.minFilter = pc.FILTER_NEAREST; tex.magFilter = pc.FILTER_NEAREST; tex.mipmaps = false; }
            Sprite2D._textures.set(key, tex);
            Sprite2D._assign(handle, tex, key);
        });
        asset.once('error', () => {
            console.warn('Sprite2D: не загрузилась текстура ' + path + ' — рисую заглушку.');
            handle.placeholder = true;
            Sprite2D.setPlaceholder(handle, placeholder || { color: '#c0563f', label: String(path).replace(/^.*\//, '').replace(/\.[a-z]+$/i, '') });
        });
        view._assets = view._assets || [];
        view._assets.push(asset);
        view.app.assets.add(asset);
        view.app.assets.load(asset);
        // Something is on screen immediately: the placeholder until the file arrives.
        Sprite2D.setPlaceholder(handle, placeholder || { color: '#7f8c99', label: String(path).replace(/^.*\//, '') });
        return null;
    },

    /** Nearest sampling for pixel-art profiles (set by the profile adapter). */
    pixelArt: false,
    /** '' in the game (paths from index.html), '/' in the editor (from the server root). */
    assetBase: '',

    /** A generated placeholder texture (a colored card with a label) — no file needed. */
    setPlaceholder(handle, ph) {
        if (!handle || handle.disposed) return null;
        const p = ph || {};
        const label = String(p.label || 'sprite');
        const color = String(p.color || '#7f8c99');
        const w = Math.max(16, Math.min(512, Number(p.width) || 128));
        const h = Math.max(16, Math.min(512, Number(p.height) || (handle.h > handle.w ? Math.round(w * handle.h / handle.w) : w)));
        const key = 'ph:' + label + '|' + color + '|' + w + 'x' + h;
        let tex = Sprite2D._textures.get(key);
        if (!tex) {
            tex = Sprite2D.placeholderTexture(handle.view, { label: label, color: color, width: w, height: h, kind: p.kind });
            if (!tex) return null;
            Sprite2D._textures.set(key, tex);
        }
        handle.placeholder = true;
        return Sprite2D._assign(handle, tex, key);
    },

    /** Draw a placeholder into a canvas and hand it to the engine as a texture. */
    placeholderTexture(view, o) {
        if (typeof document === 'undefined' || !view || !view.app) return null;
        const opt = o || {};
        const w = Math.max(8, Math.round(opt.width || 128));
        const h = Math.max(8, Math.round(opt.height || 128));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const g = cv.getContext('2d');
        if (!g) return null;
        g.clearRect(0, 0, w, h);
        const color = String(opt.color || '#7f8c99');
        // body
        g.fillStyle = color;
        g.globalAlpha = 0.92;
        const r = Math.max(2, Math.round(Math.min(w, h) * 0.12));
        Sprite2D._roundRect(g, 2, 2, w - 4, h - 4, r);
        g.fill();
        g.globalAlpha = 1;
        // a checker corner so a placeholder is unmistakable in a screenshot
        g.fillStyle = 'rgba(0,0,0,0.28)';
        const c = Math.max(4, Math.round(Math.min(w, h) / 8));
        for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) if ((x + y) % 2 === 0) g.fillRect(2 + x * c, 2 + y * c, c, c);
        // outline
        g.strokeStyle = 'rgba(0,0,0,0.55)';
        g.lineWidth = Math.max(1, Math.round(Math.min(w, h) / 32));
        Sprite2D._roundRect(g, 2, 2, w - 4, h - 4, r);
        g.stroke();
        // label
        const label = String(opt.label || '').slice(0, 24);
        if (label) {
            g.fillStyle = '#ffffff';
            g.font = 'bold ' + Math.max(8, Math.round(Math.min(w, h) / 8)) + 'px system-ui, sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.shadowColor = 'rgba(0,0,0,0.8)';
            g.shadowBlur = 3;
            g.fillText(label, w / 2, h * 0.62, w - 12);
        }
        const tex = new pc.Texture(view.app.graphicsDevice, { width: w, height: h, format: pc.PIXELFORMAT_RGBA8 });
        tex.setSource(cv);
        tex.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
        tex.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
        tex.minFilter = pc.FILTER_NEAREST;
        tex.magFilter = pc.FILTER_NEAREST;
        tex.mipmaps = false;
        return tex;
    },

    _roundRect(g, x, y, w, h, r) {
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath();
    },

    _assign(handle, tex, key) {
        if (!handle || handle.disposed || !tex) return null;
        handle.mat.emissiveMap = tex;
        handle.mat.opacityMap = tex;
        handle.mat.opacityMapChannel = 'a';
        handle.mat.useAlphaTest = true;
        handle.mat.alphaTest = 0.02;
        handle.mat.update();
        handle.texture = tex;
        handle.textureKey = key;
        return tex;
    },

    colorOf(c) {
        if (c && typeof c === 'object' && c.r != null) return c;
        const n = typeof c === 'number' ? c : parseInt(String(c).replace('#', ''), 16);
        const v = Number.isFinite(n) ? n : 0xffffff;
        return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
    },

    // --- placement and look ------------------------------------------------------------------------

    /**
     * Place a sprite at a canonical position. ground — the height of the ground under it
     * (the terrain or 0 for a flat profile); anchor — 'bottom' (stands on the ground, the
     * default for characters) or 'center'.
     */
    place(handle, pos, opts) {
        if (!handle || handle.disposed) return null;
        const o = opts || {};
        const p = pos || { x: 0, y: 0, z: 0 };
        const ground = Number(o.ground) || 0;
        const w = (handle.baseW || handle.w) * (o.scaleX != null ? o.scaleX : 1);
        const h = (handle.baseH || handle.h) * (o.scaleY != null ? o.scaleY : 1);
        if (w !== handle.w || h !== handle.h) { handle.entity.setLocalScale(w, h, 1); handle.w = w; handle.h = h; }
        const lift = o.anchor === 'center' ? 0 : h / 2;
        // map -> mirrored engine world: (-x, height, z)
        handle.entity.setPosition(-p.x, ground + (p.y || 0) + lift + (o.bias || 0), p.z);
        if (handle.flat) handle.entity.setEulerAngles(90, o.heading || 0, 0);
        else if (o.heading != null) handle._yaw = o.heading;
        return handle.entity.getPosition();
    },

    setDrawOrder(handle, order) {
        if (!handle || handle.disposed) return null;
        handle.drawOrder = Number(order) || 0;
        handle.mi.drawOrder = handle.drawOrder;
        return handle.drawOrder;
    },

    setOpacity(handle, v) {
        if (!handle || handle.disposed) return null;
        handle.mat.opacity = Math.max(0, Math.min(1, Number(v)));
        handle.mat.update();
        return handle.mat.opacity;
    },

    setSize(handle, w, h) {
        if (!handle || handle.disposed) return null;
        handle.baseW = Math.max(1, Number(w) || handle.baseW || handle.w);
        handle.baseH = Math.max(1, Number(h) || handle.baseH || handle.h);
        handle.w = handle.baseW;
        handle.h = handle.baseH;
        handle.entity.setLocalScale(handle.w, handle.h, 1);
        return { w: handle.w, h: handle.h };
    },

    setVisible(handle, on) {
        if (!handle || handle.disposed) return false;
        handle.entity.enabled = on !== false;
        return handle.entity.enabled;
    },

    // --- frame animation -----------------------------------------------------------------------------

    /**
     * Play a sprite state. frames — { cols, rows, fps, states: { run: [0,1,2] } } from the
     * asset registry; the frames are UV windows of the atlas, so one texture serves a whole
     * animation. An unknown state falls back to 'idle', then to frame 0.
     */
    play(handle, state, opts) {
        if (!handle || handle.disposed) return null;
        const o = opts || {};
        handle.state = String(state || 'idle');
        const f = handle.frames || null;
        handle.fps = Number(o.fps || (f && f.fps) || handle.fps || 8);
        handle.frameT = 0;
        if (!f || !f.cols || !f.rows) { handle.frame = 0; Sprite2D._frame(handle, 0); return { state: handle.state, frame: 0, frames: 1 }; }
        const states = f.states || {};
        const list = states[handle.state] || states.idle || null;
        handle._list = list;
        const total = f.cols * f.rows;
        handle.frame = list && list.length ? list[0] % total : 0;
        Sprite2D._frame(handle, handle.frame);
        return { state: handle.state, frame: handle.frame, frames: list ? list.length : total };
    },

    /** Set the UV window of a frame index (atlas grid, row-major). */
    _frame(handle, index) {
        const f = handle.frames;
        if (!f || !f.cols || !f.rows) {
            if (handle.mat.emissiveMapTiling) { handle.mat.emissiveMapTiling.set(1, 1); handle.mat.emissiveMapOffset.set(0, 0); handle.mat.update(); }
            return index;
        }
        const cols = f.cols, rows = f.rows;
        const i = Math.max(0, Math.min(cols * rows - 1, index | 0));
        const cx = i % cols, cy = Math.floor(i / cols);
        const tw = 1 / cols, th = 1 / rows;
        handle.mat.emissiveMapTiling.set(tw, th);
        // V grows upward in the engine, rows grow downward in an atlas
        handle.mat.emissiveMapOffset.set(cx * tw, 1 - (cy + 1) * th);
        if (handle.mat.opacityMap === handle.mat.emissiveMap) {
            handle.mat.opacityMapTiling.set(tw, th);
            handle.mat.opacityMapOffset.set(cx * tw, 1 - (cy + 1) * th);
        }
        handle.mat.update();
        return i;
    },

    /** Advance every sprite's animation and screen alignment (called before the render). */
    _syncView(rec) {
        const view = rec.view;
        if (!view || !view.root || !view.camEntity) return;
        const camRot = view.camEntity.getRotation();
        const camPos = view.camEntity.getPosition();
        const dt = Math.min(0.1, (World3D._lastDt || 0.016));
        for (const handle of rec.sprites) {
            if (handle.disposed || !handle.entity) continue;
            // screen alignment: the quad takes the camera's orientation (works for a
            // top-down, a side and a tilted camera alike — no per-profile branch)
            if (!handle.flat) handle.entity.setRotation(camRot);
            // frame animation
            const f = handle.frames;
            if (f && f.cols && f.rows) {
                handle.frameT += dt;
                const per = 1 / Math.max(0.5, handle.fps || 8);
                while (handle.frameT >= per) {
                    handle.frameT -= per;
                    const list = handle._list;
                    const total = f.cols * f.rows;
                    if (list && list.length) handle.frame = list[(list.indexOf(handle.frame) + 1) % list.length];
                    else handle.frame = (handle.frame + 1) % total;
                    Sprite2D._frame(handle, handle.frame);
                }
            }
            handle._camPos = camPos;
        }
        rec.frames++;
    },

    /** The number of sprites in a view (budget checks, reports). */
    count(view) { const rec = view && Sprite2D._views.get(view.uid); return rec ? rec.sprites.size : 0; },

    /** Destroy one sprite: out of the layer first, then the entity (the kit's dangling-MI trap). */
    destroy(handle) {
        if (!handle || handle.disposed) return false;
        handle.disposed = true;
        const rec = handle.view ? Sprite2D._views.get(handle.view.uid) : null;
        try {
            if (rec && rec.layer && handle.mi) rec.layer.removeMeshInstances([handle.mi]);
            if (handle.view) handle.view.dropFromLayers(handle.mi);
        } catch (e) { /* the layer may already be gone (view disposed) */ }
        if (rec) rec.sprites.delete(handle);
        try { if (handle.entity) handle.entity.destroy(); } catch (e) { /* already destroyed */ }
        handle.entity = null;
        handle.mi = null;
        return true;
    },

    /** Everything a view owns: sprites, the shared quad, the layer. */
    dispose(view) {
        const rec = view && Sprite2D._views.get(view.uid);
        if (!rec) return false;
        for (const h of [...rec.sprites]) Sprite2D.destroy(h);
        try { view.app.scene.layers.remove(rec.layer); } catch (e) { /* already removed */ }
        const ids = (view.camComp && view.camComp.layers ? view.camComp.layers : []).filter(id => id !== Sprite2D.LAYER_ID);
        if (view.camComp) view.camComp.layers = ids;
        try { if (rec.mesh) rec.mesh.destroy(); } catch (e) { /* shared mesh, engine may own it */ }
        Sprite2D._views.delete(view.uid);
        return true;
    },

    /** Drop the texture cache (a profile switch may re-sample pixel art differently). */
    clearCache() { Sprite2D._textures.clear(); return true; },

    inspect(view) {
        const rec = view && Sprite2D._views.get(view.uid);
        return {
            layer: Sprite2D.LAYER_NAME,
            layerId: Sprite2D.LAYER_ID,
            sprites: rec ? rec.sprites.size : 0,
            textures: Sprite2D._textures.size,
            placeholders: rec ? [...rec.sprites].filter(h => h.placeholder).length : 0,
            pixelArt: !!Sprite2D.pixelArt,
            frames: rec ? rec.frames : 0
        };
    }
};
