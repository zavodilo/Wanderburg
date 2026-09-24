// Camera3D.js — the engine half of the semantic camera (js/presentation/Camera.js).
//
// It turns profile/variant camera parameters into the kit's CameraController state and
// switches the PlayCanvas projection:
//
//     2d / 2.5d / isometric3d -> orthographic (orthoHeight from zoom)
//     lowpoly3d / full3d      -> perspective  (fov)
//
// The controller keeps doing what it always did (input, follow, zoom, pan, shake, the shadow
// frustum); this file only sets projection, orientation and limits, so a profile switch is a
// camera change and nothing else. Gameplay never reaches this file — it talks to Camera.*.

/** @satisfies {Record<string, any>} */
const Camera3D = {
    D: Math.PI / 180,

    /** Modes that look horizontally (the height axis is a screen axis there). */
    SIDE_MODES: ['side', 'platformer'],

    /**
     * Apply semantic camera params to a controller.
     * params — { mode, projection, azimuthDeg, elevationDeg, orthoHeightPx, fovDeg, zoom,
     *            zoomMin, zoomMax, orbit, distance }
     * opts — { immediate?: true (snap instead of lerping), keepPose?: true }
     */
    apply(controller, params, opts) {
        if (!controller) return { applied: false, reason: 'no camera controller' };
        const p = params || {};
        const o = opts || {};
        const mode = p.mode || 'topdown';
        const before = {
            projection: controller.projection, azimuthDeg: controller.azimuth / Camera3D.D,
            elevationDeg: controller.pitch / Camera3D.D, zoom: controller.zoom
        };

        // --- projection
        controller.projection = p.projection === 'orthographic' ? 'orthographic' : 'perspective';
        if (p.orthoHeightPx > 0) controller.orthoHeightPx = p.orthoHeightPx;
        if (p.fovDeg > 0) {
            controller.cam.fov = Math.max(10, Math.min(120, p.fovDeg)) * Camera3D.D;
            if (controller.view && controller.view.camComp) controller.view.camComp.fov = Math.max(10, Math.min(120, p.fovDeg));
        }

        // --- limits and interaction
        const c = controller.c;
        if (p.zoomMin != null) c.zoomMin = Math.max(0.05, Number(p.zoomMin));
        if (p.zoomMax != null) c.zoomMax = Math.max(c.zoomMin, Number(p.zoomMax));
        c.orbit = p.orbit === false ? 0 : 1;
        // A side view needs a horizontal pitch, which the game-camera pitch limit forbids:
        // the presentation layer widens the range instead of switching the controller to free.
        const wantPitch = Camera3D.clamp(p.elevationDeg != null ? Number(p.elevationDeg) : before.elevationDeg, mode);
        c.pitchMin = Math.min(c.pitchMin == null ? 35 : c.pitchMin, Math.max(0, wantPitch));
        c.pitchMax = Math.max(c.pitchMax == null ? 88 : c.pitchMax, Math.min(89, wantPitch));
        if (typeof controller.setFree === 'function') controller.setFree(mode === 'free');
        // The flight keys belong to the game unless the profile is an editor/free camera.
        controller.flightKeys = mode === 'free' || mode === 'orbit';

        // --- orientation and zoom
        if (!o.keepPose) {
            if (p.azimuthDeg != null) controller.azimuth = Number(p.azimuthDeg) * Camera3D.D;
            controller.pitch = wantPitch * Camera3D.D;
            if (p.zoom != null) {
                controller.zoomTarget = controller._clampZoom(Number(p.zoom));
                if (o.immediate !== false) controller.zoom = controller.zoomTarget;
            }
        }
        controller._applyProjection();
        if (typeof controller._apply === 'function') controller._apply();
        return {
            applied: true,
            mode: mode,
            projection: controller.projection,
            azimuthDeg: Math.round(controller.azimuth / Camera3D.D * 10) / 10,
            elevationDeg: Math.round(controller.pitch / Camera3D.D * 10) / 10,
            zoom: controller.zoom,
            orthoHeight: controller.projection === 'orthographic' ? Math.round(controller.orthoHeight() * 10) / 10 : null,
            fovDeg: Math.round(controller.cam.fov / Camera3D.D * 10) / 10,
            changed: before.projection !== controller.projection ||
                Math.abs(before.azimuthDeg - controller.azimuth / Camera3D.D) > 0.01 ||
                Math.abs(before.elevationDeg - controller.pitch / Camera3D.D) > 0.01
        };
    },

    /** A side view cannot pitch below the horizon; a top-down one cannot pass the zenith. */
    clamp(elevationDeg, mode) {
        const e = Number(elevationDeg);
        if (Camera3D.SIDE_MODES.includes(mode)) return Math.max(0, Math.min(45, e));
        if (mode === 'topdown') return Math.max(60, Math.min(88, e));
        return Math.max(1, Math.min(88, e));
    },

    /**
     * Per frame: keep a side view at the height of what it follows (the controller's own
     * follow only tracks map x/y, and its flight floor would tilt a horizontal camera down).
     */
    update(controller, params, opts) {
        if (!controller) return false;
        const o = opts || {};
        const mode = (params && params.mode) || 'topdown';
        if (Camera3D.SIDE_MODES.includes(mode)) {
            const h = o.lift != null ? Number(o.lift) : Camera3D.SIDE_EYE_PX;
            controller.lift = h;
            controller.target.h = controller._groundH(controller.target.x, controller.target.y) + h;
        }
        controller._applyProjection();
        return true;
    },

    /** px above the ground a side-view camera keeps its look-at point (Constants.js). */
    get SIDE_EYE_PX() { return (typeof PROFILE_SIDE_EYE_PX !== 'undefined' && PROFILE_SIDE_EYE_PX > 0) ? PROFILE_SIDE_EYE_PX : 90; },

    /** The canonical point the camera looks at. */
    target(controller) {
        if (!controller || !controller.target) return null;
        return { x: controller.target.x, y: controller.target.h, z: controller.target.y };
    },

    /** Screen px -> a canonical world point (the ground/terrain hit, or the y = 0 plane). */
    screenToWorld(view, px, py, opts) {
        if (!view || typeof view.pointerToGround !== 'function') return null;
        const o = opts || {};
        const hit = view.pointerToGround(px, py, o.height || 0, o.terrain !== false ? view.world.terrain || o.terrain : null);
        if (!hit) return null;
        return { x: hit.x, y: o.height || 0, z: hit.y };
    },

    /** A canonical point -> screen px { x, y, visible, behind }. */
    worldToScreen(view, v) {
        if (!view || typeof view.projectToScreen !== 'function') return null;
        return view.projectToScreen(v.x, v.z, v.y);
    },

    /** Machine-readable camera state for reports and the editor. */
    inspect(controller) {
        if (!controller) return { attached: false };
        return {
            attached: true,
            projection: controller.projection,
            orthoHeight: controller.projection === 'orthographic' ? controller.orthoHeight() : null,
            fovDeg: controller.cam.fov / Camera3D.D,
            azimuthDeg: controller.azimuth / Camera3D.D,
            elevationDeg: controller.pitch / Camera3D.D,
            zoom: controller.zoom,
            target: Camera3D.target(controller),
            following: !!controller.followObj,
            free: !!controller.free
        };
    }
};
