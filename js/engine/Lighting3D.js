// Lighting3D.js — the engine half of the semantic lighting API (js/presentation/Lighting.js).
//
// A lighting preset becomes a set of World3D.cfg() OVERRIDES, never a rewrite of
// Constants.js: the editor's Global Settings and a variant's preset compose, and switching
// back to 'flat' restores exactly what the constants say.
//
//     flat       2D — no shading model, no shadows (sprites are unlit anyway)
//     stylized   2.5D — banded toon light, ink edges, one shadow
//     isometric  stylized 3D with crisp directional shadows
//     lowpoly    one directional light, flat-ish colors, cheap shadows
//     realistic  full stack: smooth shading, soft shadows, fog, rim
//
// Gameplay never calls this file.

/** @satisfies {Record<string, any>} */
const Lighting3D = {
    /** @type {any | null} the overrides currently in force */
    current: null,
    /** @type {string | null} */
    currentPreset: null,

    /** Semantic state -> World3D.cfg() keys. */
    overridesFor(state) {
        const s = state || {};
        const o = {};
        const num = (k, v) => { if (typeof v === 'number' && Number.isFinite(v)) o[k] = v; };
        num('sunAz', s.sunAzimuth != null ? s.sunAzimuth : s.sunAz);
        num('sunEl', s.sunElevation != null ? s.sunElevation : s.sunEl);
        num('sunIntensity', s.sunIntensity);
        num('skyIntensity', s.skyIntensity);
        num('fog', s.fog);
        num('toonBands', s.toonBands);
        num('toonSoft', s.toonSoft);
        num('toonLow', s.toonLow);
        num('toonSpec', s.toonSpec);
        num('toonRim', s.toonRim);
        num('shadowStrength', s.shadowStrength);
        num('shadowSoft', s.shadowSoft);
        const col = (k, v) => { if (v != null) o[k] = Lighting3D.hex(v); };
        col('sunColor', s.sunColor);
        col('sky', s.sky != null ? s.sky : s.skyColor);
        col('skyLight', s.skyLight);
        col('groundLight', s.groundLight);
        col('shadowColor', s.shadowColor);
        col('inkColor', s.inkColor);
        // level switches
        if (s.toon != null) o.toon = s.toon ? 1 : 0;
        if (s.ink != null) o.ink = Math.max(0, Math.min(2, Number(s.ink) || 0));
        if (s.outline != null) o.outline = Math.max(0, Math.min(2, Number(s.outline) || 0));
        // `shadows` is the shadow MAP switch — apply() turns view.sun.castShadows off for 0. It
        // must NOT zero `shadowStrength`: that is the toon shadow TINT (World3D.cfg().shadowColor
        // /shadowStrength), which a game keeps while casting no shadow map at all — a stylized 3D
        // game with blob shadows, or one whose shadow map is off on mobile. Zeroing it here
        // flattened the shading of every project that declared shadows: 0 (found porting
        // Wanderburg: no shadow map, shadowStrength 0.5). The flat preset still wants both off
        // and says so explicitly below.
        if (s.preset === 'flat') { o.toon = 0; o.ink = 0; o.outline = 0; o.shadowStrength = 0; o.fog = 0; }
        return o;
    },

    /** '#rrggbb' | 0xrrggbb -> 0xrrggbb (the engine's color form). */
    hex(c) {
        if (typeof c === 'number') return c;
        const n = parseInt(String(c).replace('#', ''), 16);
        return Number.isFinite(n) ? n : 0xffffff;
    },

    /**
     * Apply a semantic lighting state to a view. Returns what changed (for reports and the
     * editor's profile panel).
     */
    apply(view, state, opts) {
        const o = opts || {};
        const s = state || {};
        const ov = Lighting3D.overridesFor(s);
        const changed = JSON.stringify(ov) !== JSON.stringify(Lighting3D.current || {});
        Lighting3D.current = ov;
        Lighting3D.currentPreset = s.preset || null;
        World3D.setLightOverrides(ov);
        if (view && view.root && !o.skipRender) World3D.applyRenderConstants(view);
        // The shadow map itself: off means no caster pass at all (a 2D budget says 0 lights).
        if (view && view.sun) {
            const want = !(s.shadows === 0 || s.shadows === false || s.preset === 'flat');
            if (view.sun.castShadows !== want) view.sun.castShadows = want;
        }
        return {
            applied: true, preset: s.preset || null, overrides: ov, changed: changed,
            shadows: (view && view.sun) ? !!view.sun.castShadows : false,
            toon: World3D.cfg().toon, ink: World3D.cfg().ink, outline: World3D.cfg().outline
        };
    },

    /** Drop the overrides: the constants alone decide again. */
    reset(view) {
        Lighting3D.current = null;
        Lighting3D.currentPreset = null;
        World3D.setLightOverrides(null);
        if (view && view.root) World3D.applyRenderConstants(view);
        return { applied: true, preset: null, overrides: {} };
    },

    inspect(view) {
        const c = World3D.cfg();
        return {
            preset: Lighting3D.currentPreset,
            overrides: JSON.parse(JSON.stringify(Lighting3D.current || {})),
            effective: {
                sunAz: c.sunAz, sunEl: c.sunEl, sunIntensity: c.sunIntensity, skyIntensity: c.skyIntensity,
                toon: c.toon, ink: c.ink, outline: c.outline, fog: c.fog, shadowStrength: c.shadowStrength
            },
            shadows: view && view.sun ? !!view.sun.castShadows : false
        };
    }
};
