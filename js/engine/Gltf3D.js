// Gltf3D.js — glTF/GLB models: skeleton, animation clips, textures. Called through Model3D
// (load / build / dispose pick the loader by the file extension); the clips of a built model —
// Model3D.clips(root). The container loader of the engine does the parsing (no separate
// loader script in libs/ anymore); a missing file fails the model load, the scene doesn't crash.
//
// UNITS: glTF is meters, the kit's world is px = centimeters — the model is scaled by 100.
// AXES: the glTF front is +Z, the kit's model nose is +X — in the mirrored PlayCanvas world
// (skill world3d, §Coordinates) that is a −90° turn about Y (the old +90° in the
// right-handed scene).
// MATERIALS: glTF gives PBR; the toon shader lives on StandardMaterial in the
// diffuse-specular workflow — every build converts the container's materials: base color
// (already sRGB in PlayCanvas), base color texture, normal map, alpha, culling (glTF
// double-sided stays double-sided, losing it turns the model inside out).
// CLIPS: glTF animations by name — Clips3D: play('run') cross-fades from the current clip
// (the AnimComponent's layer transition).

/** @satisfies {Record<string, any>} */
const Gltf3D = {
    UNITS: 100,              // glTF meters -> world px (1 cm = 1 px, like FBX)
    _cache: new Map(),       // view uid + url -> Promise<model>: the file is loaded once per view
    _clips: new WeakMap(),   // model root -> Clips3D

    is(url) {
        return /\.(glb|gltf)(\?|$)/i.test(String(url));
    },

    // url -> Promise<{ gltf: true, container, clips: [names] }>. The container asset stays
    // in the registry; build() instantiates it. It dies with the view.
    load(url, view) {
        const key = view.uid + '|' + url;
        let p = this._cache.get(key);
        if (!p) {
            p = new Promise((resolve, reject) => {
                const app = view.world.app;
                const asset = new pc.Asset(url, 'container', { url: url });
                (view._assets || (view._assets = [])).push(asset);
                asset.once('load', () => {
                    const res = /** @type {any} */ (asset.resource);
                    resolve({
                        gltf: true,
                        container: res,
                        asset: asset,
                        clips: (res.animations || []).map(a => (a.resource && a.resource.name) || a.name)
                    });
                });
                asset.once('error', (err) => reject(new Error((err && err.message) || ('load failed: ' + url))));
                app.assets.add(asset);
                app.assets.load(asset);
            });
            this._cache.set(key, p);
            p.catch(() => this._cache.delete(key));   // errors are not cached: the file may be added later
        }
        return p;
    },

    // Model -> root entity without geometry; each call gets its own entities, skeleton, clips
    // and materials. opts: { name }.
    build(model, view, opts) {
        const name = (opts && opts.name) || 'model';
        const root = new pc.Entity(name);
        view.root.addChild(root);
        const fit = new pc.Entity(name + '/gltf');
        fit.setLocalScale(Gltf3D.UNITS, Gltf3D.UNITS, Gltf3D.UNITS);
        fit.setLocalEulerAngles(0, -90, 0);   // glTF +Z nose -> map +x in the mirrored world
        root.addChild(fit);
        const inst = model.container.instantiateRenderEntity();
        fit.addChild(inst);

        // PBR -> the kit's diffuse-specular StandardMaterial with the toon chunks.
        const mats = new Map();
        for (const rc of inst.findComponents('render')) {
            for (const mi of rc.meshInstances) {
                const src = mi.material;
                if (!src || !(src instanceof pc.StandardMaterial)) continue;
                if (!mats.has(src)) mats.set(src, this._standard(src, name));
                mi.material = mats.get(src);
                World3D.toon.attach(view, mi.material);
            }
        }

        // Animation: one AnimComponent on the instantiated root; every clip of the file
        // becomes a state of its base layer.
        const clips = new Clips3D(inst, model.clips);
        clips.setTracks(model.container.animations || []);
        this._clips.set(root, clips);
        return root;
    },

    clips(root) {
        return (root && this._clips.get(root)) || null;
    },

    // glTF material (PBR) -> StandardMaterial for the toon shader.
    _standard(src, name) {
        const m = new pc.StandardMaterial();
        m.name = name + '/' + src.name;
        m.diffuse = src.diffuse.clone();
        if (src.diffuseMap) {
            m.diffuseMap = src.diffuseMap;
            m.opacityMap = src.opacityMap || null;
        }
        if (src.normalMap) {
            m.normalMap = src.normalMap;
            m.bumpiness = src.bumpiness;
        }
        m.opacity = src.opacity;
        m.alphaTest = src.alphaTest;
        m.blendType = src.blendType;
        m.cull = src.cull;
        m.useMetalness = false;
        return m;
    }
};

// Animation clips of one built model. play(name) starts the clip and cross-fades to it from
// whatever is playing (the layer transition of the AnimComponent); non-looped clips chain
// through opts.then when they reach their end (watched in the view's before-frame hook).
class Clips3D {
    // entity — the instantiated glTF root (the AnimComponent lives on it), names — the clip
    // names in the file, in the order of container.animations.
    constructor(entity, names) {
        this.entity = entity;
        entity.addComponent('anim');
        this.anim = entity.anim;
        /** @type {Map<string, { track: any, loop: boolean }>} */
        this.tracks = new Map();
        const anims = [];
        // The component binds tracks by the node paths of THIS hierarchy: collect them from
        // the container through the entity's render meshes is not possible — the tracks
        // arrive via Model3D.load's resource list; here they are assigned by the caller's
        // names through _addTracks below.
        this.current = '';
        this.blend = Clips3D.blendSec();
        this._then = '';
        this._view = null;
        this._onFrame = null;
        this._names = names || [];
    }

    static blendSec() {
        return typeof MODEL_CLIP_BLEND_SEC !== 'undefined' ? MODEL_CLIP_BLEND_SEC : 0.2;
    }

    // The animation tracks of the container, in file order (Gltf3D.build calls this right
    // after the component is on the entity).
    setTracks(trackAssets) {
        const layer = this._layer();
        const layerName = layer ? layer.name : 'Base';
        for (let i = 0; i < trackAssets.length; i++) {
            const track = trackAssets[i].resource || trackAssets[i];
            const name = this._names[i] || track.name || ('clip' + i);
            this.anim.assignAnimation(name, track, layerName, 1, true);
            this.tracks.set(name, { track: track, loop: true });
        }
        this.anim.playing = false;   // rest pose until the game or the location asks
        return this;
    }

    names() {
        return [...this.tracks.keys()];
    }

    has(name) {
        return this.tracks.has(name);
    }

    // The layer the clips live on: the component's default one (the engine names it
    // 'Base'); fall back to whatever exists so a renamed default cannot break playback.
    _layer() {
        return this.anim.findAnimationLayer('Base') || this.anim.findAnimationLayer('base') ||
            (this.anim._layers && this.anim._layers[0]) || null;
    }

    // opts: { loop = true, speed = 1, blend = MODEL_CLIP_BLEND_SEC, then — the clip to play after a
    // non-looped one ends }. false — the model has no such clip.
    play(name, opts) {
        const t = this.tracks.get(name), o = opts || {};
        if (!t) return false;
        const loop = o.loop !== false, speed = o.speed > 0 ? o.speed : 1;
        this.blend = o.blend >= 0 ? o.blend : Clips3D.blendSec();
        this._then = loop ? '' : String(o.then || '');
        const layer = this._layer();
        if (this.current !== name || !this.anim.playing) {
            const first = !this.anim.playing || !this.current;
            // Re-assign to apply loop/speed of this request.
            this.anim.assignAnimation(name, t.track, this._layer() ? this._layer().name : 'Base', speed, loop);
            if (first) {
                layer.play(name);
            } else {
                layer.transition(name, this.blend);
            }
            this.anim.playing = true;
            this._watchEnd(name, loop);
        } else {
            this.anim.speed = speed;
        }
        this.current = name;
        return true;
    }

    // Stop everything: the model returns to its rest pose.
    stop() {
        this.current = '';
        this._then = '';
        this.anim.playing = false;
        const layer = this._layer();
        if (layer) layer.reset();
        this.anim.playing = false;
        this._unwatch();
    }

    // A non-looped clip chains: the view's before-frame hook compares the layer clock with
    // the track duration and starts opts.then.
    _watchEnd(name, loop) {
        if (loop) { this._unwatch(); return; }
        this._unwatch();
        const track = this.tracks.get(name).track;
        this._onFrame = () => {
            if (this.current !== name) return;
            const layer = this._layer();
            const t = layer && layer.activeStateCurrentTime;
            if (t != null && track.duration > 0 && t >= track.duration - 1e-3) {
                if (this._then && this.tracks.has(this._then)) this.play(this._then);
                else { this.anim.playing = false; this.current = ''; }
            }
        };
        const view = World3D.view;
        if (view) { this._view = view; view.onBeforeFrame(this._onFrame); }
    }

    _unwatch() {
        if (this._onFrame && this._view) {
            const i = this._view._syncFns.indexOf(this._onFrame);
            if (i >= 0) this._view._syncFns.splice(i, 1);
        }
        this._onFrame = null;
    }

    dispose() {
        this._unwatch();
        this.tracks.clear();
        this.current = '';
    }
}
