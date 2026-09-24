// js/profiles/2.5d/profile.js — the 2.5D adapter (behaviour only).
//
// The hybrid profile: 2D characters (billboard sprites) in a 3D environment, or sprites on a
// 3D plane with real depth. Declarative data comes from manifest/render-profiles.json.
//
//   • orthographic by default, a slightly tilted perspective is allowed (camera.tiltDeg);
//   • actors are billboards (the same sprite assets as 2D), props and structures are models;
//   • the ground is a real plane/height field, so depth exists and occludes;
//   • lighting is 'stylized': toon bands and one shadow, but no ink-heavy 3D look;
//   • sprites keep depthTest ON here: a 3D wall in front of a billboard hides it.
//
// This is the profile that proves the model: nothing about the game changes between 2D and
// 2.5D — the actor keeps its sprite, the world gains a third axis it already had logically.

ArcProfiles.define({
    id: '2.5d',

    inputPlanes(cfg) {
        const side = cfg && cfg.camera && (cfg.camera.mode === 'side' || cfg.camera.mode === 'platformer');
        return { move: side ? 'xy' : 'xz', look: 'xy', aim: side ? 'xy' : 'xz' };
    },

    worldPresentation(cfg) {
        const w = (cfg && cfg.world) || {};
        // 'stepped' height: the logical height field is presented, but tiles may snap to
        // whole steps so a sprite never sinks into a slope it cannot be drawn on.
        return { ground: w.ground || 'plane+sprites', flatten: w.height === 'flat', stepped: w.height === 'stepped', tilePx: w.tilePx || 64 };
    },

    present(ctx) {
        const out = { profile: '2.5d', hybrid: true, depth: 'z-buffer + declarative sprite order' };
        if (typeof Sprite2D !== 'undefined') {
            // Characters keep their pixel art; the 3D props around them are filtered normally.
            Sprite2D.pixelArt = true;
            out.sprites = ctx && ctx.backend ? Sprite2D.count(ctx.backend.view && ctx.backend.view()) : 0;
        }
        out.notes = 'billboard actors + 3D props/ground: the same sprite assets as 2d, a real depth buffer';
        return out;
    }
});
