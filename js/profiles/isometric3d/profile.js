// js/profiles/isometric3d/profile.js — the Isometric 3D adapter (behaviour only).
//
// A real 3D world through a fixed ORTHOGRAPHIC camera: 3D geometry, 3D lighting and shadows,
// grid-oriented gameplay (Diablo / Monument Valley / tactics).
//
//   • the camera is PARAMETERIZED — azimuth, elevation, orthoHeight, target — never
//     hardcoded here; the manifest gives the defaults, a variant may override them;
//   • entities are models; a role that only has a sprite becomes a billboard, a role with
//     nothing becomes a primitive;
//   • the ground is a height field with 3D tiles for the logical WorldMap;
//   • lighting is 'isometric': stylized 3D with crisp directional shadows;
//   • gameplay still says `movement = { x: 0, z: -1 }` for "north": the camera decides how
//     north looks on screen. Nothing in the game knows the view is isometric.

ArcProfiles.define({
    id: 'isometric3d',

    /** Grid gameplay: the axes stay x/z whatever the camera angle is. */
    inputPlanes() { return { move: 'xz', look: 'xz', aim: 'xz' }; },

    /** The isometric camera pose, so an agent can read it without the manifest. */
    cameraParams(cfg) {
        const c = (cfg && cfg.camera) || {};
        return {
            projection: 'orthographic',
            mode: c.mode || 'isometric',
            azimuthDeg: c.azimuthDeg != null ? c.azimuthDeg : -90,
            elevationDeg: c.elevationDeg != null ? c.elevationDeg : 55,
            orthoHeightPx: c.orthoHeightPx || 540,
            orbit: !!c.orbit
        };
    },

    worldPresentation(cfg) {
        const w = (cfg && cfg.world) || {};
        return { ground: w.ground || '3d-tiles', flatten: false, heightfield: w.height === 'heightfield', tilePx: w.tilePx || 64 };
    },

    present(ctx) {
        const out = { profile: 'isometric3d', projection: 'orthographic', depth: 'z-buffer' };
        if (typeof Sprite2D !== 'undefined') {
            // Models are filtered; only projectiles and effects may still be billboards.
            Sprite2D.pixelArt = false;
            out.sprites = ctx && ctx.backend ? Sprite2D.count(ctx.backend.view && ctx.backend.view()) : 0;
        }
        const stats = (ctx && ctx.backend && ctx.backend.stats) ? (ctx.backend.stats() || {}) : null;
        if (stats) {
            out.projectionNow = stats.projection;
            out.orthoHeight = stats.orthoHeight;
            out.drawCalls = stats.drawCalls;
        }
        out.notes = 'fixed ortho camera over real 3D geometry: azimuth/elevation/orthoHeight are variant data';
        return out;
    }
});
