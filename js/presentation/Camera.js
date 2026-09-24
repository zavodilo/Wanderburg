// Camera.js — the semantic camera (presentation layer).
//
// Game code says WHAT to look at, never how the engine does it:
//
//     Camera.mode('isometric')
//     Camera.follow('player')
//     Camera.zoom(1.4)
//     Camera.lookAt(120, 0, -40)
//
// No setPosition/lookAt on an engine camera, no projection math, no `if (profile === …)`:
// the profile/variant supplies the parameters (manifest cameraModes + variant overrides),
// this file keeps them, and js/engine/Camera3D.js applies them to PlayCanvas.
//
// Modes: topdown, side, platformer, isometric, thirdPerson, firstPerson, free, orbit.
// A mode is allowed only if the active profile declares it (manifest
// profiles[*].camera.modes) — Camera.mode() refuses the others with a readable error.

/** @satisfies {Record<string, any>} */
const Camera = {
    MODES: ['topdown', 'side', 'platformer', 'isometric', 'thirdPerson', 'firstPerson', 'free', 'orbit'],

    /** @type {any | null} the engine binding (js/engine/Camera3D.js via Visual3D) */
    _backend: null,
    /** @type {any} the effective parameters of the active presentation */
    _params: null,
    /** @type {string | null} */
    _mode: null,
    /** @type {string | null} entity id the camera follows */
    _follow: null,
    /** Runtime offsets a game may add without fighting the profile: pan, zoom, orbit. */
    _runtime: { zoom: null, azimuthDeg: null, elevationDeg: null, pan: { x: 0, y: 0, z: 0 } },

    // --- configuration -----------------------------------------------------------------

    /** Apply a camera config block (from RenderProfile.config().camera). */
    applyConfig(cfg, opts) {
        const c = cfg || {};
        const o = opts || {};
        const mode = Camera._allowedMode(c.mode || c.defaultMode || 'topdown');
        Camera._mode = mode;
        Camera._params = {
            mode: mode,
            projection: c.projection || (Camera._profile() || {}).projection || 'perspective',
            azimuthDeg: Camera._num(c.azimuthDeg, Camera.modeDefaults(mode).azimuthDeg),
            elevationDeg: Camera._num(c.elevationDeg, Camera.modeDefaults(mode).elevationDeg),
            orthoHeightPx: Camera._num(c.orthoHeightPx, 540),
            fovDeg: Camera._num(c.fovDeg, 52),
            distance: Camera._num(c.distance, null),
            // null — nobody authored a zoom (profile, preset, variant): the controller keeps the
            // zoom the game/constants gave it, and Camera3D.apply leaves it alone. Defaulting to
            // 1 here silently re-zoomed every game whose CAMERA_ZOOM is not 1 (a phone build, a
            // game that zooms per state) the moment a variant was applied.
            zoom: Camera._num(c.zoom, null),
            zoomMin: Camera._num(c.zoomMin, 0.4),
            zoomMax: Camera._num(c.zoomMax, 4),
            follow: c.follow === undefined ? null : (c.follow || null),
            orbit: c.orbit !== false,
            tiltDeg: Camera._num(c.tiltDeg, 0),
            deadZone: c.deadZone || null
        };
        if (Camera._runtime.zoom != null) Camera._params.zoom = Camera._runtime.zoom;
        if (Camera._runtime.azimuthDeg != null) Camera._params.azimuthDeg = Camera._runtime.azimuthDeg;
        if (Camera._runtime.elevationDeg != null) Camera._params.elevationDeg = Camera._runtime.elevationDeg;
        if (Camera._params.follow) Camera._follow = Camera._params.follow;
        return Camera.push(o);
    },

    /** Push the current parameters to the engine (no backend — headless: nothing to do). */
    push(opts) {
        const o = opts || {};
        const p = Camera.params();
        if (!Camera._backend || typeof Camera._backend.camera !== 'function') return { applied: false, headless: true, params: p };
        const target = Camera._follow ? Camera._targetOf(Camera._follow) : null;
        const r = Camera._backend.camera(p, { target: target, immediate: !!o.immediate }) || {};
        return Object.assign({ applied: true, headless: false, params: p }, r);
    },

    _num(v, fallback) { return (typeof v === 'number' && Number.isFinite(v)) ? v : fallback; },

    _profile() { return (typeof RenderProfile !== 'undefined' && GameModel.booted()) ? RenderProfile.profile() : null; },

    /** A mode the active profile allows (falls back to the profile's default mode). */
    _allowedMode(mode) {
        const p = Camera._profile();
        const allowed = (p && p.camera && p.camera.modes) || Camera.MODES;
        if (allowed.includes(mode)) return mode;
        const def = (p && p.camera && p.camera.defaultMode) || 'topdown';
        if (!Camera.MODES.includes(String(mode))) throw new Error('Camera: unknown mode ' + JSON.stringify(mode) + ' (modes: ' + Camera.MODES.join(', ') + ')');
        // A profile that cannot do the requested mode keeps its own default and says so.
        Camera._lastModeWarning = 'mode ' + mode + ' is not allowed by the ' + (p ? p.id : '?') + ' profile — using ' + def;
        return def;
    },

    _lastModeWarning: null,

    /** The manifest defaults of a mode (azimuth/elevation/projection). */
    modeDefaults(mode) {
        const m = (typeof RENDER_PROFILES !== 'undefined' && RENDER_PROFILES.cameraModes[String(mode)]) || null;
        return m || { projection: 'perspective', azimuthDeg: -90, elevationDeg: 45 };
    },

    // --- game facing API ------------------------------------------------------------------

    /** Camera.mode('isometric') — read with no argument. */
    mode(name) {
        if (name === undefined) return Camera._mode;
        const p = Camera.params();
        return Camera.applyConfig(Object.assign({}, p, { mode: String(name) }));
    },

    getMode() { return Camera._mode; },

    /** Which modes the active profile allows. */
    modes() { const p = Camera._profile(); return ((p && p.camera && p.camera.modes) || Camera.MODES).slice(); },

    /** Camera.follow('player') — an entity id, an entity, or null for a static camera. */
    follow(target) {
        if (target == null) { Camera._follow = null; return Camera.push(); }
        const id = typeof target === 'string' ? target : (target && target.id) || null;
        if (!id) throw new Error('Camera.follow: pass an entity id');
        if (typeof GameModel !== 'undefined' && GameModel.booted() && !GameModel.entity(id)) {
            throw new Error('Camera.follow: no entity ' + JSON.stringify(id));
        }
        Camera._follow = id;
        if (Camera._params) Camera._params.follow = id;
        return Camera.push();
    },

    followed() { return Camera._follow; },

    /** Camera.zoom(1.4) — read with no argument. Clamped to the profile/variant range. */
    zoom(z) {
        // A reader always gets a number: null (nobody authored a zoom) reads as 1 — "as authored
        // in Constants.js", which is exactly the zoom the controller is holding.
        if (z === undefined) return (Camera._params && Camera._params.zoom != null) ? Camera._params.zoom : 1;
        const p = Camera.params();
        const clamped = Math.max(p.zoomMin, Math.min(p.zoomMax, Number(z) || (p.zoom != null ? p.zoom : 1)));
        Camera._runtime.zoom = clamped;
        if (Camera._params) Camera._params.zoom = clamped;
        return Camera.push();
    },

    getZoom() { return Camera.zoom(); },

    /** Look at a canonical point { x, y, z } (or x, y, z numbers). */
    lookAt(x, y, z) {
        const v = (typeof x === 'object' && x) ? Coords.from(x) : Coords.vec(x, y, z);
        Camera.follow(null);
        Camera._runtime.pan = v;
        return Camera.push({ target: v });
    },

    /** Orbit the camera (azimuth/elevation in degrees) — allowed when the profile orbits. */
    orbit(azimuthDeg, elevationDeg) {
        const p = Camera.params();
        if (!p.orbit) return { applied: false, reason: 'the active profile does not orbit' };
        if (azimuthDeg != null) Camera._runtime.azimuthDeg = ((Number(azimuthDeg) + 180) % 360 + 360) % 360 - 180;
        if (elevationDeg != null) Camera._runtime.elevationDeg = Math.max(-89, Math.min(89, Number(elevationDeg)));
        return Camera.applyConfig(Object.assign({}, p, { azimuthDeg: Camera._runtime.azimuthDeg, elevationDeg: Camera._runtime.elevationDeg }));
    },

    /** Pan the look-at point by a canonical delta (a game's map scrolling). */
    pan(dx, dy, dz) {
        Camera._runtime.pan = Coords.add(Camera._runtime.pan, Coords.vec(dx, dy, dz));
        return Camera.push();
    },

    shake(ms, intensity) {
        if (Camera._backend && typeof Camera._backend.shake === 'function') return Camera._backend.shake(ms, intensity);
        return { applied: false, headless: true };
    },

    /** Reset the runtime offsets and re-apply the profile/variant parameters. */
    home() {
        Camera._runtime = { zoom: null, azimuthDeg: null, elevationDeg: null, pan: { x: 0, y: 0, z: 0 } };
        if (Camera._params) {
            const p = Camera._profile() || {};
            return Camera.applyConfig(Object.assign({}, p.camera, { mode: Camera._params.mode, follow: Camera._params.follow }));
        }
        return Camera.push();
    },

    // --- projections ----------------------------------------------------------------------

    /** Screen px -> a canonical world point (null when the ray does not hit the world). */
    screenToWorld(px, py) {
        if (!Camera._backend || typeof Camera._backend.screenToWorld !== 'function') return null;
        const p = Camera._backend.screenToWorld(px, py);
        return p ? Coords.from(p) : null;
    },

    /** A canonical world point -> screen px { x, y, visible }. */
    worldToScreen(v) {
        if (!Camera._backend || typeof Camera._backend.worldToScreen !== 'function') return null;
        return Camera._backend.worldToScreen(Coords.from(v));
    },

    /** The canonical point the camera looks at. */
    target() {
        if (Camera._follow) return Camera._targetOf(Camera._follow);
        if (Camera._backend && typeof Camera._backend.target === 'function') {
            const t = Camera._backend.target();
            if (t) return Coords.from(t);
        }
        return Coords.clone(Camera._runtime.pan);
    },

    _targetOf(id) {
        const e = typeof GameModel !== 'undefined' && GameModel.booted() ? GameModel.entity(id) : null;
        return e ? Coords.clone(e.position) : null;
    },

    // --- state -------------------------------------------------------------------------------

    /** The effective parameters (what the engine gets, what an agent reads). */
    params() {
        if (!Camera._params) {
            const p = Camera._profile();
            Camera._params = {
                mode: (p && p.camera && p.camera.defaultMode) || 'topdown',
                projection: (p && p.projection) || 'orthographic',
                azimuthDeg: (p && p.camera ? p.camera.azimuthDeg : -90),
                elevationDeg: (p && p.camera ? p.camera.elevationDeg : 90),
                orthoHeightPx: (p && p.camera ? p.camera.orthoHeightPx : 540),
                fovDeg: (p && p.camera ? p.camera.fovDeg : 52),
                distance: null, zoom: 1, zoomMin: 0.4, zoomMax: 4,
                follow: Camera._follow, orbit: true, tiltDeg: 0, deadZone: null
            };
        }
        return JSON.parse(JSON.stringify(Camera._params));
    },

    /** Patch parameters directly (an editor slider, a cinematic). */
    setParams(patch) {
        return Camera.applyConfig(Object.assign({}, Camera.params(), patch || {}));
    },

    attachBackend(backend) {
        Camera._backend = backend && typeof backend.camera === 'function' ? backend : (backend || null);
        if (Camera._backend && Camera._params) Camera.push();
        return !!Camera._backend;
    },

    backend() { return Camera._backend; },

    /** Called by the frame loop after the game update: following and smoothing. */
    update(dt) {
        if (!Camera._backend || typeof Camera._backend.update !== 'function') return false;
        const t = Camera._follow ? Camera._targetOf(Camera._follow) : null;
        Camera._backend.update(dt, { follow: Camera._follow, target: t, params: Camera.params() });
        return true;
    },

    inspect() {
        return {
            mode: Camera._mode,
            modes: Camera.modes(),
            follow: Camera._follow,
            params: Camera.params(),
            target: Camera.target(),
            projection: Camera._params ? Camera._params.projection : null,
            backend: !!Camera._backend,
            headless: !Camera._backend,
            warning: Camera._lastModeWarning
        };
    }
};
