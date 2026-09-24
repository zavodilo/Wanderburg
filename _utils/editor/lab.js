// lab.js — the location view in the editor: the same world as at game startup
// (Location3D with the Objects.js objects + CameraController), the Objects tab
// (ObjectsPanel: selection, gizmo) and live application of the inspector constants
// (the constants-changed event from main.js).
//
// Cameras: "free" — editor navigation (LMB/RMB — orbit, middle button and
// Shift+LMB — pan, wheel — zoom to cursor, the game limits are lifted);
// "game" — exactly the game camera: the same limits and controls, start on R.
//
// The frame is drawn EVERY tick: the engine draws on demand (World3D.renderFrame), and a
// skipped frame would leave the previous picture stale anyway. In a background tab the
// browser stops requestAnimationFrame by itself.

/** @satisfies {Record<string, any>} */
const Lab = {
    /** @type {Location3D | null} */
    location: null,
    /** @type {CameraController | null} */
    camera: null,
    /** @type {HTMLCanvasElement | null} */
    canvas: null,
    mode: 'free',
    _terrainQueued: false,
    _lastT: 0,
    _infoT: 0,
    _fps: 60,

    init() {
        this.canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('view-canvas'));
        if (!World3D.init(this.canvas)) {
            Toast.show(I18N.t('toast.no3d'), true);
            return;
        }
        this.location = new Location3D({ assetBase: '/', objects: ObjectsPanel.initialObjects() });
        this.camera = new CameraController(this.location.view, {
            terrain: this.location.terrain,
            bounds: { w: this.location.width, h: this.location.height },
            free: true
        });
        this.camera.attach(this.canvas);
        new ResizeObserver(() => World3D.resize()).observe(this.canvas.parentElement);
        World3D.resize();

        // The presentation backend: the editor previews the project's visual variants live
        // (one shared game model, many presentations). The editor's own camera is left alone:
        // a variant switch re-presents ground, visuals and lighting, not the viewpoint.
        if (typeof Visual3D !== 'undefined' && typeof PlayArcRuntime !== 'undefined') {
            try {
                Visual3D.attach({ view: this.location.view, location: this.location, camera: this.camera, canvas: this.canvas });
                PlayArcRuntime.start({ apply: false });
                RenderProfile.apply({ skipCamera: true });
            } catch (e) {
                console.error('PlayArcRuntime:', e);
            }
        }

        this.bindUi();
        if (typeof ProfilePanel !== 'undefined') {
            ProfilePanel.init(this);
            // The gizmo edits the location records (the editor's canon); the shared game model
            // follows, so every variant of the project sees the same world.
            setInterval(() => { if (ProfilePanel.syncFromEditor() > 0) ProfilePanel.refresh(); }, 500);
        }
        ObjectsPanel.init(this);
        UIPanel.init(this.canvas);
        this.setCameraMode('free');
        this.camera.home();
        window.addEventListener('constants-changed', (e) => {
            const d = /** @type {CustomEvent} */ (e).detail;
            this.onConstant((d && d.name) || '');
        });
        window.addEventListener('lang-changed', () => { this.renderHint(); this.updateInfo(); });
        requestAnimationFrame(t => this.tick(t));
    },

    bindUi() {
        for (const btn of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#camera-modes button'))) {
            btn.addEventListener('click', () => this.setCameraMode(btn.dataset.camera));
        }
        document.getElementById('btn-home').addEventListener('click', () => this.camera.home());
        // The quick toon toggle — the same WORLD3D_TOON constant as in the inspector.
        document.getElementById('opt-toon').addEventListener('change', (e) => {
            Inspector.apply(Inspector.fieldByName.WORLD3D_TOON, /** @type {HTMLInputElement} */ (e.target).checked ? 1 : 0);
        });
        this.syncToonToggle();
        // Camera keys do not work while the focus is in an inspector field: a click on the view removes it.
        this.canvas.addEventListener('pointerdown', () => {
            const focused = /** @type {HTMLElement | null} */ (document.activeElement);
            if (focused && focused !== document.body) focused.blur();
        });
    },

    setCameraMode(mode) {
        this.mode = mode === 'game' ? 'game' : 'free';
        for (const btn of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#camera-modes button'))) {
            btn.classList.toggle('active', btn.dataset.camera === this.mode);
        }
        this.camera.setFree(this.mode === 'free');
        if (this.mode === 'game') this.camera.home();   // exactly the game's starting frame
        this.renderHint();
    },

    renderHint() {
        document.getElementById('view-hints').textContent = I18N.t(this.mode === 'game' ? 'cam.hintGame' : 'cam.hintFree');
    },

    syncToonToggle() {
        /** @type {HTMLInputElement} */ (document.getElementById('opt-toon')).checked = Number(/** @type {any} */ (window).WORLD3D_TOON) > 0;
    },

    onConstant(name) {
        if (!this.location) return;
        if (name.indexOf('WORLD3D_') === 0) {
            this.location.applyRenderConstants();
            if (name === 'WORLD3D_TOON') this.syncToonToggle();
            return;
        }
        if (name.indexOf('CAMERA_') === 0) {
            this.camera.applyConstants();
            // Orientation and the starting zoom live in home(): the game view shows them right away.
            if (this.mode === 'game' && /^CAMERA_(AZIMUTH_DEG|PITCH_DEG|ZOOM|ZOOM_MOBILE)$/.test(name)) this.camera.home();
            return;
        }
        if (name.indexOf('UI_') === 0) { UIPanel.refresh(); return; }
        if (name === 'LOCATION_GROUND') { this.location.loadGround(); return; }
        if (name === 'GROUND_TILE_SIZE') { if (this.location.terrain) this.location.terrain.applyTileSize(); return; }
        if (name.indexOf('TERRAIN_') === 0 || name.indexOf('LOCATION_') === 0) this.rebuildTerrainSoon();
    },

    // The slider sends an edit on every movement — the terrain is rebuilt at most once per frame.
    rebuildTerrainSoon() {
        if (this._terrainQueued) return;
        this._terrainQueued = true;
        requestAnimationFrame(() => {
            this._terrainQueued = false;
            const terrain = this.location.buildTerrain();   // location objects settle onto the new ground on their own
            this.camera.setTerrain(terrain, { w: this.location.width, h: this.location.height });
        });
    },

    tick(now) {
        const dt = Math.min(0.1, (now - (this._lastT || now)) / 1000);
        this._lastT = now;
        this.location.update(dt);   // model part spin (def.anim) — as in the game
        this.camera.update(dt);
        World3D.renderFrame();
        if (dt > 0) this._fps += (1 / dt - this._fps) * 0.05;
        if (now - this._infoT > 500) { this._infoT = now; this.updateInfo(); }
        requestAnimationFrame(t => this.tick(t));
    },

    updateInfo() {
        if (!this.camera) return;
        const c = this.camera, t = this.location.terrain, D = 180 / Math.PI;
        const txt = I18N.t('info', {
            fps: Math.round(this._fps), zoom: c.zoom.toFixed(2),
            az: Math.round(c.azimuth * D), pitch: Math.round(c.pitch * D),
            x: Math.round(c.target.x), y: Math.round(c.target.y)
        }) + (t ? I18N.t('info.terrain', { tris: Math.round(t.triangles / 1000), cell: t.cell }) : '');
        const el = document.getElementById('view-info');
        if (el.textContent !== txt) el.textContent = txt;
    },
};
