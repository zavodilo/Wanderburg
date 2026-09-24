// Lighting.js — the semantic lighting API (presentation layer).
//
//     Lighting.setProfile('flat')        // 2D: textures as authored, no shading model
//     Lighting.setProfile('stylized')    // 2.5D: banded toon light, ink edges
//     Lighting.setProfile('isometric')   // stylized 3D with crisp directional shadows
//     Lighting.setProfile('lowpoly')     // one directional light, flat-ish colors
//     Lighting.setProfile('realistic')   // full stack: PBR, soft shadows, fog, rim
//
// A profile declares its default lighting preset (manifest profiles[*].lighting.profile),
// a variant may override it (variant.lighting.preset / .overrides). Gameplay never calls
// this file: lighting is presentation. The engine binding is js/engine/Lighting3D.js,
// which turns a preset into World3D.cfg() overrides — no constant is rewritten, so the
// editor's Global Settings and a variant preset compose instead of fighting.

/** @satisfies {Record<string, any>} */
const Lighting = {
    /** @type {any | null} */
    _backend: null,
    /** @type {string | null} the active preset id (manifest lightingProfiles) */
    _preset: null,
    /** @type {any} preset + variant overrides, merged */
    _cfg: null,
    /** Friendly aliases: the spec's names -> the manifest's preset ids. */
    ALIASES: {
        'flat': 'flat', 'none': 'flat', '2d': 'flat',
        'stylized': 'stylized', '2.5d': 'stylized', 'toon': 'stylized',
        'isometric': 'isometric', 'isometric3d': 'isometric', 'stylized3d': 'isometric',
        'lowpoly': 'lowpoly', 'lowpoly3d': 'lowpoly', 'simple': 'lowpoly',
        'realistic': 'realistic', 'full3d': 'realistic', 'advanced': 'realistic', 'cinematic': 'realistic', 'pbr': 'realistic'
    },

    /** The canonical presets (manifest/render-profiles.json -> lightingProfiles). */
    presets() {
        const m = (typeof RENDER_PROFILES !== 'undefined' && RENDER_PROFILES.lightingProfiles) || {};
        return JSON.parse(JSON.stringify(m));
    },

    presetIds() { return Object.keys(Lighting.presets()); },

    /** Resolve an alias/variant preset name to a manifest preset id. */
    presetId(name) {
        const n = String(name || '');
        if (Lighting.presetIds().includes(n)) return n;
        if (Lighting.ALIASES[n]) return Lighting.ALIASES[n];
        // a variant preset (presentation/presets/<name>.json) may name its own lighting
        if (typeof Variant !== 'undefined') {
            const p = Variant.preset(n);
            if (p && p.lighting && p.lighting.preset && Lighting.presetIds().includes(p.lighting.preset)) return p.lighting.preset;
        }
        return null;
    },

    /** The active preset id ('flat' before anything is applied). */
    getProfile() { return Lighting._preset || 'flat'; },

    /** Semantic alias of getProfile (the spec's Lighting.setProfile/getProfile wording). */
    setProfile(name, opts) {
        const id = Lighting.presetId(name);
        if (!id) throw new Error('Lighting.setProfile: unknown preset ' + JSON.stringify(name) + ' (known: ' + Lighting.presetIds().join(', ') + ')');
        Lighting._preset = id;
        Lighting._cfg = Object.assign({}, Lighting.presets()[id], (opts && opts.overrides) || {});
        return Lighting.push(opts);
    },

    /** The effective lighting state (preset + overrides) — what the engine receives. */
    get() {
        if (!Lighting._cfg) Lighting._cfg = Object.assign({}, Lighting.presets()[Lighting.getProfile()]);
        return JSON.parse(JSON.stringify(Object.assign({ preset: Lighting._preset || 'flat' }, Lighting._cfg)));
    },

    /** Apply a lighting config block (RenderProfile.config().lighting). */
    applyConfig(cfg, opts) {
        const c = cfg || {};
        const id = Lighting.presetId(c.preset || c.profile) || Lighting.getProfile();
        Lighting._preset = id;
        Lighting._cfg = Object.assign({}, Lighting.presets()[id]);
        // named variant overrides
        for (const k of ['sunAzimuthDeg', 'sunElevationDeg', 'sunIntensity', 'sunColor', 'skyColor', 'shadows', 'toon', 'ink', 'outline', 'fog']) {
            if (c[k] !== undefined && c[k] !== null) Lighting._cfg[Lighting.FIELD_MAP[k] || k] = c[k];
        }
        // raw World3D.cfg() keys — the last word, used sparingly by a variant
        Object.assign(Lighting._cfg, c.overrides || {});
        return Lighting.push(opts);
    },

    /** Semantic name -> the World3D.cfg() key it drives. */
    FIELD_MAP: {
        sunAzimuthDeg: 'sunAzimuth', sunElevationDeg: 'sunElevation', sunIntensity: 'sunIntensity',
        sunColor: 'sunColor', skyColor: 'sky', shadows: 'shadows', toon: 'toon', ink: 'ink',
        outline: 'outline', fog: 'fog'
    },

    // --- individual knobs (all presentation, all optional) -----------------------------------

    /** Sun direction and strength: Lighting.setSun({ azimuthDeg, elevationDeg, intensity, color }). */
    setSun(sun) {
        const s = sun || {};
        if (!Lighting._cfg) Lighting._cfg = Object.assign({}, Lighting.presets()[Lighting.getProfile()]);
        if (s.azimuthDeg != null) Lighting._cfg.sunAzimuth = Number(s.azimuthDeg);
        if (s.elevationDeg != null) Lighting._cfg.sunElevation = Number(s.elevationDeg);
        if (s.intensity != null) Lighting._cfg.sunIntensity = Math.max(0, Number(s.intensity));
        if (s.color != null) Lighting._cfg.sunColor = Lighting.color(s.color);
        return Lighting.push();
    },

    /** Sky/ambient: Lighting.setAmbient({ intensity, skyColor, groundColor }). */
    setAmbient(a) {
        const s = a || {};
        if (!Lighting._cfg) Lighting._cfg = Object.assign({}, Lighting.presets()[Lighting.getProfile()]);
        if (s.intensity != null) Lighting._cfg.skyIntensity = Math.max(0, Number(s.intensity));
        if (s.skyColor != null) Lighting._cfg.skyLight = Lighting.color(s.skyColor);
        if (s.groundColor != null) Lighting._cfg.groundLight = Lighting.color(s.groundColor);
        if (s.sky != null) Lighting._cfg.sky = Lighting.color(s.sky);
        return Lighting.push();
    },

    /** Shadows on/off (a 2D profile has none: its budget says maxShadowLights 0). */
    setShadows(on) {
        if (!Lighting._cfg) Lighting._cfg = Object.assign({}, Lighting.presets()[Lighting.getProfile()]);
        Lighting._cfg.shadows = on ? 1 : 0;
        return Lighting.push();
    },

    /** Toon banding on/off (0 — smooth/PBR, 1 — banded stylized). */
    setToon(on) {
        if (!Lighting._cfg) Lighting._cfg = Object.assign({}, Lighting.presets()[Lighting.getProfile()]);
        Lighting._cfg.toon = on ? 1 : 0;
        return Lighting.push();
    },

    setFog(density) {
        if (!Lighting._cfg) Lighting._cfg = Object.assign({}, Lighting.presets()[Lighting.getProfile()]);
        Lighting._cfg.fog = Math.max(0, Number(density) || 0);
        return Lighting.push();
    },

    /** '#rrggbb' or 0xrrggbb -> 0xrrggbb (the engine's color form). */
    color(c) {
        if (typeof c === 'number') return c;
        const s = String(c || '').replace('#', '');
        const n = parseInt(s, 16);
        return Number.isFinite(n) ? n : 0xffffff;
    },

    /** Send the state to the engine (headless: recorded only). */
    push(opts) {
        const state = Lighting.get();
        if (!Lighting._backend || typeof Lighting._backend.lighting !== 'function') return { applied: false, headless: true, state: state };
        const r = Lighting._backend.lighting(state, opts || {}) || {};
        return Object.assign({ applied: true, headless: false, state: state }, r);
    },

    /** Re-apply (the editor changed a constant, a variant was activated). */
    refresh() { return Lighting.push(); },

    attachBackend(backend) {
        Lighting._backend = backend && typeof backend.lighting === 'function' ? backend : (backend || null);
        if (Lighting._backend && Lighting._cfg) Lighting.push();
        return !!Lighting._backend;
    },

    backend() { return Lighting._backend; },

    /** The World3D.cfg() overrides this state means (engine-side merge, no constant rewrite). */
    overrides() {
        const s = Lighting.get();
        const out = {};
        if (s.sunAzimuth != null) out.sunAz = Number(s.sunAzimuth);
        if (s.sunElevation != null) out.sunEl = Number(s.sunElevation);
        if (s.sunIntensity != null) out.sunIntensity = Number(s.sunIntensity);
        if (s.sunColor != null) out.sunColor = Lighting.color(s.sunColor);
        if (s.sky != null) out.sky = Lighting.color(s.sky);
        if (s.skyIntensity != null) out.skyIntensity = Number(s.skyIntensity);
        if (s.skyLight != null) out.skyLight = Lighting.color(s.skyLight);
        if (s.groundLight != null) out.groundLight = Lighting.color(s.groundLight);
        if (s.fog != null) out.fog = Number(s.fog);
        if (s.toon != null) out.toon = Number(s.toon);
        if (s.ink != null) out.ink = Number(s.ink);
        if (s.outline != null) out.outline = Number(s.outline);
        if (s.shadowStrength != null) out.shadowStrength = Number(s.shadowStrength);
        if (s.shadowSoft != null) out.shadowSoft = Number(s.shadowSoft);
        if (s.shadows === 0) { out.shadowStrength = 0; out.toon = out.toon || 0; }
        return out;
    },

    inspect() {
        return {
            preset: Lighting._preset,
            presets: Lighting.presetIds(),
            state: Lighting.get(),
            overrides: Lighting.overrides(),
            shadows: Lighting.get().shadows ? 1 : 0,
            backend: !!Lighting._backend,
            headless: !Lighting._backend
        };
    }
};
