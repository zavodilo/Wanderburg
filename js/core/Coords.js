// Coords.js — the canonical coordinate system of a PlayArc game (semantic core).
//
//     X = horizontal
//     Y = vertical / height (up)
//     Z = depth / forward
//
// Every logical position in the kit is a { x, y, z } in THIS space, in every render
// profile. A 2D game is the y = 0 case of the same space, not a separate space: the
// profile decides how the space is shown (top-down on x/z, side view on x/y, isometric,
// full 3D), never what the coordinates mean.
//
// The kit's older map record (Objects.js, Location3D, CameraController) is
// { x — right, y — down the map, h — height above the ground } and the PlayCanvas world
// is that map mirrored on X (pc = (-x, h, y)). Both conversions live HERE and only here:
// gameplay code never mirrors, never swaps axes and never asks the renderer.
//
//     Coords.toMap({ x: 10, y: 0, z: 20 })   -> { x: 10, y: 20, h: 0 }
//     Coords.fromMap({ x: 10, y: 20, h: 0 }) -> { x: 10, y: 0, z: 20 }

/** @typedef {{ x: number, y: number, z: number }} ArcVec3Like */

/** @satisfies {Record<string, any>} */
const Coords = {
    /** The canonical axes, for manifests and error messages. */
    AXES: { x: 'horizontal', y: 'vertical / height', z: 'depth / forward' },

    /** @returns {ArcVec3Like} */
    vec(x, y, z) { return { x: x || 0, y: y || 0, z: z || 0 }; },

    ZERO: Object.freeze({ x: 0, y: 0, z: 0 }),
    UP: Object.freeze({ x: 0, y: 1, z: 0 }),
    NORTH: Object.freeze({ x: 0, y: 0, z: -1 }),   // "move north" is always -z: the camera decides how it looks
    EAST: Object.freeze({ x: 1, y: 0, z: 0 }),

    // --- canonical space math ---------------------------------------------------

    /** @param {ArcVec3Like} v @returns {ArcVec3Like} */
    clone(v) { return { x: v.x, y: v.y, z: v.z }; },

    /** Any of { x, y, z } may be missing; a map-shaped { x, y, h } is NOT accepted here. */
    from(v) { return { x: Number(v && v.x) || 0, y: Number(v && v.y) || 0, z: Number(v && v.z) || 0 }; },

    add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; },
    sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; },
    scale(a, k) { return { x: a.x * k, y: a.y * k, z: a.z * k }; },
    neg(a) { return { x: -a.x, y: -a.y, z: -a.z }; },
    dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; },
    len(a) { return Math.hypot(a.x, a.y, a.z); },
    /** Horizontal length (x/z) — what a top-down game means by "distance". */
    lenXZ(a) { return Math.hypot(a.x, a.z); },
    dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); },
    distXZ(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); },

    normalize(a) {
        const l = Coords.len(a);
        return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
    },

    lerp(a, b, t) {
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    },

    equals(a, b, eps) {
        const e = eps == null ? 1e-6 : eps;
        return Math.abs(a.x - b.x) <= e && Math.abs(a.y - b.y) <= e && Math.abs(a.z - b.z) <= e;
    },

    /** Heading in degrees around Y (0 — along +x, 90 — toward +z), the kit's map convention. */
    headingOf(dir) { return Math.atan2(dir.z, dir.x) * 180 / Math.PI; },

    /** Unit direction on the x/z plane from a heading in degrees. */
    fromHeading(deg) {
        const r = (deg || 0) * Math.PI / 180;
        return { x: Math.cos(r), y: 0, z: Math.sin(r) };
    },

    // --- canonical <-> kit map record -------------------------------------------
    // map record: { x — right, y — down the map, h — height } (Objects.js / Location3D).

    /** @param {ArcVec3Like} v @returns {{ x: number, y: number, h: number }} */
    toMap(v) { return { x: v.x, y: v.z, h: v.y }; },

    /** @param {{ x: number, y: number, h?: number }} m @returns {ArcVec3Like} */
    fromMap(m) { return { x: m.x || 0, y: m.h || 0, z: m.y || 0 }; },

    /** canonical -> PlayCanvas world (the engine mirror lives here and in World3D.mirror). */
    toEngine(v) { return { x: -v.x, y: v.y, z: v.z }; },
    fromEngine(p) { return { x: -p.x, y: p.y, z: p.z }; },

    /** Rotation degrees [tiltX, heading, tiltZ] of a map record -> canonical { x, y, z } degrees. */
    rotFromMap(rot) {
        const r = Array.isArray(rot) ? rot : [0, rot || 0, 0];
        return { x: r[0] || 0, y: r[1] || 0, z: r[2] || 0 };
    },

    rotToMap(rot) { return [rot.x || 0, rot.y || 0, rot.z || 0]; }
};
