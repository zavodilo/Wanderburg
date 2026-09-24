// js/profiles/2d/profile.js — the 2D adapter (behaviour only).
//
// Every declarative field of this profile comes from manifest/render-profiles.json
// (generated into RENDER_PROFILES): camera, representations, lighting, depth, budget.
// What lives here is the DOING:
//
//   • orthographic camera, top-down by default (a side view is one camera mode away);
//   • the ground is flat (no height field) and tiles are sprites;
//   • lighting is 'flat': no toon bands, no ink, no shadows, no fog — textures as authored;
//   • sprites sample nearest (pixel art stays crisp) and are drawn by declarative depth
//     (renderLayer/drawOrder/zIndex), never by a distance a system computed;
//   • the input plane follows the camera mode: top-down drives x/z, a side view x/y.
//
// Gameplay is identical to every other profile: the same entities, the same coordinates,
// the same systems. Nothing here may read or write GameModel logic.

ArcProfiles.define({
    id: '2d',

    /** A side-scroller drives the height axis; a top-down game drives depth. */
    inputPlanes(cfg) {
        const side = cfg && cfg.camera && (cfg.camera.mode === 'side' || cfg.camera.mode === 'platformer');
        return { move: side ? 'xy' : 'xz', look: 'xy', aim: side ? 'xy' : 'xz' };
    },

    worldPresentation(cfg) {
        // The logical WorldMap keeps its height field; the 2D presentation simply shows it
        // flat, so switching back to 3D needs no world data at all.
        return { ground: (cfg && cfg.world && cfg.world.ground) || 'tilemap', flatten: true, tilePx: (cfg && cfg.world && cfg.world.tilePx) || 64 };
    },

    present(ctx) {
        const out = { profile: '2d', pixelArt: true, flat: true, depth: 'declarative' };
        if (typeof Sprite2D !== 'undefined') {
            Sprite2D.pixelArt = true;
            out.sprites = ctx && ctx.backend ? Sprite2D.count(ctx.backend.view && ctx.backend.view()) : 0;
        }
        // Sprites in a flat world never z-fight: the sprite layer draws after the ground and
        // sorts by drawOrder (SORTMODE_CUSTOM), which is data on the entity.
        out.depthModel = 'renderLayer + drawOrder + zIndex';
        out.notes = 'orthographic, y is stored but presented as 0; a wall is a tile here and a mesh in 3D';
        return out;
    }
});
