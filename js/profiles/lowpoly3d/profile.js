// js/profiles/lowpoly3d/profile.js — the Low-poly 3D adapter (behaviour only).
//
// A full 3D game with a simplified look: PERSPECTIVE camera, low-poly meshes, simple flat
// materials, one directional light, controlled shadows, mobile-friendly defaults.
//
//   • the difference from isometric3d is the lens: perspective instead of orthographic;
//   • models are the primary representation; a missing one becomes a primitive;
//   • the ground is a low-poly terrain (the same logical height field, coarser shading);
//   • lighting is 'lowpoly': banded toon light, no ink edges, cheap shadows;
//   • the budget is tighter than full3d on purpose (maxTextureResolution 1024, fewer draw
//     calls): a variant may only TIGHTEN it, never loosen it.

ArcProfiles.define({
    id: 'lowpoly3d',

    inputPlanes() { return { move: 'xz', look: 'xy', aim: 'xz' }; },

    cameraParams(cfg) {
        const c = (cfg && cfg.camera) || {};
        return {
            projection: 'perspective',
            mode: c.mode || 'thirdPerson',
            azimuthDeg: c.azimuthDeg != null ? c.azimuthDeg : -90,
            elevationDeg: c.elevationDeg != null ? c.elevationDeg : 18,
            fovDeg: c.fovDeg || 52,
            distance: c.distance != null ? c.distance : null,
            orbit: c.orbit !== false
        };
    },

    worldPresentation(cfg) {
        const w = (cfg && cfg.world) || {};
        return { ground: w.ground || 'low-poly-terrain', flatten: false, heightfield: true, tilePx: w.tilePx || 64, coarse: true };
    },

    present(ctx) {
        const out = { profile: 'lowpoly3d', projection: 'perspective', shading: 'stylized', mobile: true };
        if (typeof Sprite2D !== 'undefined') {
            Sprite2D.pixelArt = false;
            out.sprites = ctx && ctx.backend ? Sprite2D.count(ctx.backend.view && ctx.backend.view()) : 0;
        }
        if (ctx && ctx.backend && ctx.backend.stats) {
            const s = ctx.backend.stats() || {};
            out.projectionNow = s.projection;
            out.drawCalls = s.drawCalls;
        }
        out.notes = 'perspective camera, low-poly meshes, one directional light, tight budget';
        return out;
    }
});
