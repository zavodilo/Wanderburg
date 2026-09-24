// js/profiles/full3d/profile.js — the Full 3D adapter (behaviour only).
//
// The richest presentation of the same semantic model: perspective camera, PBR materials, GLB
// models with skeletal animation, dynamic lighting, shadows, particles, post effects, terrain
// with height, 3D audio.
//
//   • models are the primary representation; the fallback chain is
//     full3d -> lowpoly3d -> isometric3d -> primitive capsule/box -> generated placeholder;
//   • lighting is 'realistic': smooth shading (toon off), soft shadows, fog, rim;
//   • animation is skeletal: the semantic states (idle/walk/run/attack/hurt/death/jump)
//     map to clip names through the asset registry (variant.clips), so gameplay keeps
//     calling GameAnimation.play('run');
//   • world-space UI is allowed here (ui.worldSpace) — the UI DEFINITION stays shared;
//   • audio is spatial: a cue with a position is heard from where the camera is.
//
// GLB is the recommended model format (the kit parses FBX too); a missing file never breaks
// the scene — Location3D falls back to Procedural3D geometry and reports it.

ArcProfiles.define({
    id: 'full3d',

    inputPlanes() { return { move: 'xz', look: 'xy', aim: 'xz' }; },

    cameraParams(cfg) {
        const c = (cfg && cfg.camera) || {};
        return {
            projection: 'perspective',
            mode: c.mode || 'thirdPerson',
            azimuthDeg: c.azimuthDeg != null ? c.azimuthDeg : -90,
            elevationDeg: c.elevationDeg != null ? c.elevationDeg : 15,
            fovDeg: c.fovDeg || 52,
            distance: c.distance != null ? c.distance : null,
            orbit: c.orbit !== false
        };
    },

    worldPresentation(cfg) {
        const w = (cfg && cfg.world) || {};
        return { ground: w.ground || 'terrain', flatten: false, heightfield: true, tilePx: w.tilePx || 64, detailed: true };
    },

    present(ctx) {
        const out = { profile: 'full3d', projection: 'perspective', shading: 'pbr', skeletal: true };
        if (typeof Sprite2D !== 'undefined') {
            Sprite2D.pixelArt = false;
            out.sprites = ctx && ctx.backend ? Sprite2D.count(ctx.backend.view && ctx.backend.view()) : 0;
        }
        if (ctx && ctx.backend && ctx.backend.stats) {
            const s = ctx.backend.stats() || {};
            out.projectionNow = s.projection;
            out.drawCalls = s.drawCalls;
            out.triangles = s.triangles;
        }
        out.worldSpaceUi = true;
        out.spatialAudio = true;
        out.notes = 'full stack: PBR, skeletal clips, soft shadows, fog, particles, terrain';
        return out;
    }
});
