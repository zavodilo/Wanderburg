// Game.js — Wanderburg's orchestrator: the state machine, the input, the camera and the frame.
//
// This file is AGENT-FACING, so tests/apigate.test.mjs holds it to the kit's contract: it drives
// the world through the kit's own objects (window.app.location, the camera, UI.get, Sound3D) and
// through the game's modules — js/Logic.js (the simulation), js/WanderView.js (the picture),
// js/Hud.js (the screens), js/WanderAudio.js (the sound) — and never writes `pc.*` itself. All
// geometry, materials and entity bookkeeping live in the view module, which is where they belong.
//
// The loop is the kit's: main.js calls update(dt) BEFORE the render, then location.update,
// camera.update and World3D.renderFrame. Everything here is "read the simulation, hand it to the
// view, feed the HUD".

class Game {
    /** @param {{ location: Location3D, camera: CameraController, runtime: any }} app */
    constructor(app) {
        this.app = app;
        this.location = app.location;
        this.camera = app.camera;
        /** @type {'menu'|'play'|'draft'|'pause'|'help'|'settings'|'end'} */
        this.state = 'menu';
        /** @type {any} WBRun */
        this.run = null;
        this.view = new WanderView(app);
        this.view.installRenderLoop();
        this.input = { throttle: 0, steer: 0, boost: false };
        this._keys = new Set();
        this._hudHidden = false;
        this._fpsT = 0;
        this._pendingRegion = false;
        this._attract = null;
        this._started = false;

        // The castle is steered with WASD, so the camera must not fly with those keys; the RMB
        // orbit, the wheel zoom and R (re-center on the followed object) stay with the camera.
        this.camera.flightKeys = false;

        WB.Save.load();
        WanderAudio.applyVolumes();
        Hud.bind(this);
        this.bindInput();
        this.applyMobileUi();

        // Boot: an attract run rolls around the first valley behind the title screen, so the
        // menu is not a picture — it is the game already happening (and the release gate sees a
        // live frame with the HUD on it).
        this.startAttract();

        // ?run=1 (or ?autoboot=1) skips the menus: the headless gate and a quick "just play"
        // link land straight in the valley.
        if (Game.wantsAutoStart()) {
            setTimeout(() => { if (this.state === 'menu') this.startRun(false); }, 60);
        }
    }

    static wantsAutoStart() {
        try {
            const q = new URLSearchParams(window.location.search);
            return q.get('run') === '1' || q.get('autoboot') === '1' || q.get('autorun') === '1';
        } catch (e) { return false; }
    }

    /** ?seed=N — a fixed run seed: reproducible runs for tests, A/B shots and bug reports. */
    static querySeed() {
        try {
            const v = new URLSearchParams(window.location.search).get('seed');
            const n = v == null ? NaN : Number(v);
            return Number.isFinite(n) ? (n | 0) : null;
        } catch (e) { return null; }
    }

    /** ?nopack=1 — the valley without the baked CC0 pack (procedural geometry only): the A/B
     *  half of verify/packdiff.mjs and an escape hatch if a pack bake ever looks wrong. */
    static queryNoPack() {
        try { return new URLSearchParams(window.location.search).get('nopack') === '1'; } catch (e) { return false; }
    }

    // --- input ------------------------------------------------------------------------------------
    bindInput() {
        const KEYMAP = {
            KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back',
            KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
            Space: 'boost', ShiftLeft: 'boost', ShiftRight: 'boost'
        };
        window.addEventListener('keydown', (e) => {
            const t = /** @type {HTMLElement | null} */ (e.target);
            if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (KEYMAP[e.code]) {
                this._keys.add(KEYMAP[e.code]);
                e.preventDefault();          // Space and the arrows must not scroll the page
                return;
            }
            this.onKey(e.code, e);
        });
        window.addEventListener('keyup', (e) => {
            if (KEYMAP[e.code]) this._keys.delete(KEYMAP[e.code]);
        });
        window.addEventListener('blur', () => this._keys.clear());
        // Embedded play (an iframe preview, a portal, a kiosk tab): the frame only owns the
        // keyboard once the player has touched it — until then the arrows land in the parent
        // page and the castle "does not obey the arrows". Take focus on the first gesture.
        window.addEventListener('pointerdown', () => { try { window.focus(); } catch (e) { /* a sandboxed frame may refuse */ } }, { passive: true });
        this.touch = this.bindTouch();
    }

    /** Keys that are not movement. `e` is the raw event (repeat handling). */
    onKey(code, e) {
        if (e && e.repeat) return;
        switch (code) {
            case 'Escape':
                if (this.state === 'draft') this.skipDraft();
                else if (this.state === 'play') this.pause();
                else if (this.state === 'pause') this.resume();
                else if (this.state === 'help') Hud.openTitle(), this.state = 'menu';
                else if (this.state === 'settings') { const from = Hud.settingsFrom(); Hud.closeSettings(); this.state = from === 'pause' ? 'pause' : 'menu'; }
                else if (this.state === 'menu' && Hud.screen === 'legacy') Hud.openTitle();
                else if (this.state === 'menu' && Hud.screen === 'loadout') Hud.openTitle();
                else if (this.state === 'menu' && Hud.screen === 'help') Hud.openTitle();
                break;
            case 'KeyP':
                if (this.state === 'play') this.pause();
                else if (this.state === 'pause') this.resume();
                break;
            case 'KeyM': {
                const set = WB.Save.meta.settings;
                set.sfx = set.sfx === 0 ? 1 : 0;
                set.music = set.music === 0 ? 1 : 0;
                WB.Save.persist();
                WanderAudio.applyVolumes();
                Hud.toast(set.sfx ? 'Звук включён' : 'Звук выключен', 2);
                break;
            }
            case 'KeyH':
                if (this.state === 'play' || this.state === 'pause') { this._helpFrom = this.state; this.state = 'help'; Hud.openHelp(); }
                else if (this.state === 'help') this.closeHelp();
                else if (this.state === 'menu') { this._helpFrom = 'menu'; Hud.openHelp(); }
                break;
            case 'Tab':
                this.toggleHud();
                break;
            case 'KeyF':
                if (this.run) this.camera.lookAt(this.run.player.x, this.run.player.y);
                break;
            case 'Enter':
                if (this.state === 'menu' && Hud.screen === 'legacy') Hud.buySelected();
                else if (this.state === 'menu' && Hud.screen === 'title') this.startRun(false);
                else if (this.state === 'menu' && Hud.screen === 'loadout') this.startRun(true);
                else if (this.state === 'end') this.startRun(false);
                break;
            default: break;
        }
        // The legacy screen is keyboard-driven (there is no scrolling in the kit's UI).
        if (this.state === 'menu' && Hud.screen === 'legacy') {
            if (code === 'ArrowDown' || code === 'KeyS') Hud.moveCursor(1);
            else if (code === 'ArrowUp' || code === 'KeyW') Hud.moveCursor(-1);
            else if (code === 'PageDown') { Hud.page++; Hud.renderLegacy(); }
            else if (code === 'PageUp') { Hud.page--; Hud.renderLegacy(); }
        }
        if (this.state === 'settings' || (this.state === 'menu' && Hud.screen === 'settings')) {
            if (code === 'ArrowLeft' || code === 'KeyA') Hud.bumpSetting(-1);
            else if (code === 'ArrowRight' || code === 'KeyD') Hud.bumpSetting(1);
            else if (code === 'ArrowDown' || code === 'KeyS') { Hud.setRow = (Hud.setRow + 1) % Hud.SETTINGS.length; Hud.renderSettings(); }
            else if (code === 'ArrowUp' || code === 'KeyW') { Hud.setRow = (Hud.setRow + Hud.SETTINGS.length - 1) % Hud.SETTINGS.length; Hud.renderSettings(); }
        }
        if (this.state === 'draft') {
            if (code === 'Digit1') this.takeDraft(0);
            else if (code === 'Digit2') this.takeDraft(1);
            else if (code === 'Digit3') this.takeDraft(2);
            else if (code === 'Digit4') this.takeDraft(3);
            else if (code === 'Numpad1') this.takeDraft(0);
            else if (code === 'Numpad2') this.takeDraft(1);
            else if (code === 'Numpad3') this.takeDraft(2);
            else if (code === 'Numpad4') this.takeDraft(3);
            else if (code === 'KeyR') this.rerollDraft();
        }
    }

    closeHelp() {
        if (this._helpFrom === 'pause') { this.state = 'pause'; Hud.show('pause'); }
        else if (this._helpFrom === 'play') { this.state = 'play'; Hud.show('play'); }
        else { this.state = 'menu'; Hud.openTitle(); }
        this._helpFrom = null;
    }

    toggleHud() {
        this._hudHidden = !this._hudHidden;
        if (UI.root) UI.root.style.display = this._hudHidden ? 'none' : '';
    }

    /** The touch controls: a stick in the left corner and a steam button in the right one. */
    bindTouch() {
        const state = { active: false, id: -1, cx: 0, cy: 0, dx: 0, dy: 0, boost: false };
        const base = Hud.el('joyBase');
        const boost = Hud.el('btnBoost');
        if (base && base.el) {
            const el = base.el;
            el.style.pointerEvents = 'auto';
            el.style.touchAction = 'none';
            el.addEventListener('pointerdown', (ev) => {
                state.active = true; state.id = ev.pointerId;
                const r = el.getBoundingClientRect();
                state.cx = r.left + r.width / 2; state.cy = r.top + r.height / 2;
                state.dx = 0; state.dy = 0;
                try { el.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
                ev.preventDefault(); ev.stopPropagation();
            });
            el.addEventListener('pointermove', (ev) => {
                if (!state.active || ev.pointerId !== state.id) return;
                const r = el.getBoundingClientRect();
                const rad = Math.max(20, r.width / 2);
                let dx = ev.clientX - state.cx, dy = ev.clientY - state.cy;
                const d = Math.hypot(dx, dy);
                if (d > rad) { dx *= rad / d; dy *= rad / d; }
                state.dx = dx / rad; state.dy = dy / rad;
                ev.preventDefault();
            });
            const end = (ev) => {
                if (ev && ev.pointerId !== state.id) return;
                state.active = false; state.id = -1; state.dx = 0; state.dy = 0;
            };
            el.addEventListener('pointerup', end);
            el.addEventListener('pointercancel', end);
        }
        if (boost && boost.el) {
            const el = boost.el;
            el.addEventListener('pointerdown', (ev) => { state.boost = true; ev.stopPropagation(); });
            el.addEventListener('pointerup', () => { state.boost = false; });
            el.addEventListener('pointercancel', () => { state.boost = false; });
            // A click also lands after pointerup on some browsers: swallow it, the pointer
            // handlers above are the truth (a click-toggle would flip the steam back on).
            boost.onClick(() => {});
        }
        return state;
    }

    applyMobileUi() {
        if (typeof IS_MOBILE === 'undefined' || !IS_MOBILE) return;
        const base = Hud.el('joyBase');
        if (base) { base.def.alpha = 0.34; base.apply(); }
        const boost = Hud.el('btnBoost');
        if (boost) { boost.def.alpha = 0.5; boost.apply(); }
    }

    /** Read the keyboard and the stick into this.input. */
    readInput() {
        const k = this._keys;
        let throttle = 0, steer = 0;
        if (k.has('fwd')) throttle += 1;
        if (k.has('back')) throttle -= 1;
        if (k.has('left')) steer -= 1;
        if (k.has('right')) steer += 1;
        let boost = k.has('boost');
        const t = this.touch;
        if (t && t.active) {
            // The stick: up is forward, sideways is the rudder, full deflection adds steam.
            throttle = WB.M.clamp(-t.dy * 1.6, -1, 1);
            steer = WB.M.clamp(t.dx * 1.6, -1, 1);
            if (Math.hypot(t.dx, t.dy) > 0.92) boost = true;
        }
        if (t && t.boost) boost = true;
        this.input.throttle = throttle;
        this.input.steer = steer;
        this.input.boost = boost;
        return this.input;
    }

    // --- state transitions -------------------------------------------------------------------------
    /** The attract run behind the title screen: a real run driven by a simple autopilot. */
    startAttract() {
        this.state = 'menu';
        const attractSeed = Game.querySeed();
        this.run = new WB.Run({ seed: attractSeed != null ? attractSeed ^ 0x51eed : (Date.now() % 99991) | 0, region: 0 });
        this.run.paused = true;                       // the menu does not simulate
        this.view.setRun(this.run);
        this.camera.follow(this.run.player);
        this._attract = this.run.player;
        Hud.openTitle();
        Hud.setHint(typeof IS_MOBILE !== 'undefined' && IS_MOBILE
            ? 'Коснитесь «В ПОХОД» · круг слева — ход и поворот'
            : 'W A S D — ход · Shift — пар · мышь — камера · H — правила');
    }

    /**
     * Start a run.
     * @param {boolean} useLoadout true — take the chassis/captain/seed picked in the loadout screen
     */
    startRun(useLoadout) {
        const forced = Game.querySeed();
        const seed = forced != null ? forced : (useLoadout && Hud.seed ? Hud.seed : ((Date.now() % 99991) | 0) ^ 0x5f3a);
        const chassis = useLoadout ? Hud.chassis : (WB.chassisUnlocked(Hud.chassis || WB.CHASSIS[0], WB.Save.meta) ? (Hud.chassis || WB.CHASSIS[0]) : WB.CHASSIS[0]);
        const captain = useLoadout ? Hud.captain : (WB.captainUnlocked(Hud.captain || WB.CAPTAINS[0], WB.Save.meta) ? (Hud.captain || WB.CAPTAINS[0]) : WB.CAPTAINS[0]);
        this.run = new WB.Run({
            seed, region: 0,
            chassis: chassis || WB.CHASSIS[0],
            captain: captain || WB.CAPTAINS[0],
            legacy: WB.Save.meta.legacy,
            meta: WB.Save.meta
        });
        this._pendingRegion = false;
        this._started = true;
        this.view.setRun(this.run);
        this.camera.follow(this.run.player);
        this.state = 'play';
        Hud.show('play');
        Hud._lastRegion = -1;
        WanderAudio.stopLoops();
        const b = this.run.region.biome;
        Hud.toast(b.name + ' — ' + b.subtitle, 5);
        Hud.setHint('W A S D — ход · Shift/Пробел — пар · Esc — пауза · H — правила');
        return this.run;
    }

    pause() {
        if (this.state !== 'play') return;
        this.state = 'pause';
        this.run.paused = true;
        Hud.show('pause');
    }

    resume() {
        if (this.state !== 'pause' && this.state !== 'settings') return;
        this.state = 'play';
        this.run.paused = false;
        Hud.show('play');
    }

    toMenu() {
        this.state = 'menu';
        if (this.run) this.run.paused = true;
        WanderAudio.stopLoops();
        this.startAttract();
    }

    /** The run ended (the hull is down or the Iron Crown is): book the result and show it. */
    endRun() {
        const run = this.run;
        const summary = run.summary();
        const scrap = run.runScrap();
        const st = WB.Save.meta.stats;
        st.runs++;
        st.massTotal += summary.mass;
        st.kills += summary.kills;
        st.devoured += summary.devoured;
        st.playTime += summary.time;
        st.bestRegion = Math.max(st.bestRegion, summary.regionIndex);
        st.bestTime = Math.max(st.bestTime || 0, summary.time);
        if (summary.won) st.wins++;
        WB.Save.addScrap(scrap);
        this.state = 'end';
        WanderAudio.stopLoops();
        WanderAudio.music('musicMenu');
        Hud.showEnd(summary, scrap);
    }

    /** After a win: keep going into the endless regions. */
    continueEndless() {
        const run = this.run;
        run.over = false;
        run.won = false;
        run.regionCleared = true;
        this.enterNextRegion();
        this.state = 'play';
        Hud.show('play');
    }

    /** Leave the cleared region for the next one. */
    enterNextRegion() {
        const run = this.run;
        run.nextRegion();
        this._pendingRegion = false;
        this.view.setRun(run);
        this.camera.follow(run.player);
        WanderAudio.stopLoops();
        const b = run.region.biome;
        Hud.toast((run.regionIndex + 1) + '-й рубеж: ' + b.name + ' — ' + b.subtitle, 5);
    }

    // --- the draft -----------------------------------------------------------------------------------
    takeDraft(index) {
        if (this.state !== 'draft' || !this.run.draftPending) return;
        const cards = this.run.draftPending.cards;
        if (index < 0 || index >= cards.length) { WanderAudio.error(); return; }
        const taken = this.run.takeDraft(index);
        if (!taken) { WanderAudio.error(); return; }
        this.closeDraft();
    }

    rerollDraft() {
        if (this.state !== 'draft') return;
        const cards = this.run.takeDraft('reroll');
        if (!cards) { WanderAudio.error(); return; }
        Hud.showDraft(this.run, this.run.rerollsLeft);
    }

    skipDraft() {
        if (this.state !== 'draft') return;
        this.run.skipDraft();
        this.closeDraft();
    }

    closeDraft() {
        this.state = 'play';
        this.run.paused = false;
        Hud.show('play');
        // A region may have been cleared while the draft was open.
        if (this._pendingRegion) this.enterNextRegion();
    }

    // --- the frame ------------------------------------------------------------------------------------
    /** @param {number} dt seconds, already clamped by main.js */
    update(dt) {
        const run = this.run;
        if (!run) return;

        // The semantic model (js/GameSpec.js -> js/core/GameModel.js) follows the simulation.
        this.mirrorModel();

        if (this.state === 'menu') {
            // The attract run: roll the valley slowly behind the title so the menu is alive.
            this.stepAttract(dt);
            this.view.update(dt, []);
            return;
        }

        const playing = this.state === 'play';
        const input = playing ? this.readInput() : { throttle: 0, steer: 0, boost: false };
        const events = run.update(dt, input);      // the simulation ignores a paused/drafting run
        WanderAudio.beginFrame();
        if (events && events.length) WanderAudio.onEvents(events, run.player);
        this.handleEvents(events || []);
        if (playing) WanderAudio.updateEngine(run.player, dt);

        this.view.update(dt, events || []);
        if (this.state === 'play' || this.state === 'draft' || this.state === 'pause') {
            Hud.updateHud(run, dt);
        }

        if (run.over && this.state !== 'end') this.endRun();
    }

    // --- the semantic model ---------------------------------------------------------------------
    // js/GameSpec.js declares this project's renderer-independent contract and js/core/GameModel.js
    // boots it: stable entity ids, one save schema, one gameplay hash in every visual variant.
    // js/Logic.js stays the OWNER of the simulation truth — the mirror below only copies the two
    // actors that outlive a frame (the player's castle and the region's warden gate), the run's
    // progression and the active scene into the model, so Save.*, Scene.inspect(), the editor's
    // Profile tab and a profile migration all speak about real state instead of an empty shell.
    //
    // Coordinates go through Coords: the simulation's map space (x, y — depth, height separate) is
    // the kit's mirror of the canonical (x — horizontal, y — height, z — depth). Both entities are
    // SELF-PRESENTED (visual.representation 'none'): js/WanderView.js draws them, the pipeline
    // binds no second copy.

    /** The logical scene the screen shows right now (GAME_SPEC.scenes). */
    syncScene() {
        if (typeof GameModel === 'undefined' || !GameModel.booted()) return null;
        let id = 'gameplay';
        if (this.state === 'menu') {
            const s = (typeof Hud !== 'undefined' && Hud.screen) || 'title';
            id = (s === 'loadout' || s === 'legacy') ? s : 'main-menu';
        } else if (this.state === 'draft') id = 'draft';
        else if (this.state === 'pause') id = 'pause';
        else if (this.state === 'help') id = 'help';
        else if (this.state === 'settings') id = 'settings';
        else if (this.state === 'end') id = 'run-over';
        else if (this.run && this.run.bossActive) id = 'boss';
        if (GameModel.activeScene !== id) GameModel.activeScene = id;
        return id;
    }

    /** Simulation truth -> the semantic model. One call per frame; no per-frame allocation. */
    mirrorModel() {
        if (typeof GameModel === 'undefined' || !GameModel.booted()) return false;
        this.syncScene();
        const run = this.run;
        if (!run || !run.player || !run.region) return false;
        const p = run.player, region = run.region;

        const castle = GameModel.entity(Game.CASTLE_ID);
        if (castle) {
            castle.setPosition(Coords.fromMap({ x: p.x, y: p.y, h: region.heightAt(p.x, p.y) }));
            castle.setHeading(p.heading * 180 / Math.PI);
            castle.set('hull', Math.round(p.hp));
            castle.set('maxHull', Math.round(p.maxHp));
            castle.set('mass', Math.round(p.mass));
            castle.set('tier', p.tier);
            castle.set('steam', Math.round(p.steam));
            castle.set('speed', Math.round(p.speed || 0));
            castle.set('slots', p.slots);
            castle.set('modules', p.modules.length);
            castle.set('region', run.regionIndex);
            const hull = castle.component('Hull');
            if (hull) { hull.current = Math.round(p.hp); hull.max = Math.round(p.maxHp); hull.tier = p.tier; }
            const steam = castle.component('Steam');
            if (steam) steam.current = Math.round(p.steam);
            const mass = castle.component('Mass');
            if (mass) mass.current = Math.round(p.mass);
        }

        const g = region.gate;
        const gate = GameModel.entity(Game.GATE_ID);
        if (gate && g) {
            gate.setPosition(Coords.fromMap({ x: g.x, y: g.y, h: region.heightAt(g.x, g.y) }));
            gate.setHeading((g.heading || 0) * 180 / Math.PI);
            gate.set('open', !!g.open);
            gate.set('region', run.regionIndex);
        }

        // Progression: the hull tier is the in-run level, the devoured mass is its experience,
        // scrap is the meta-currency the legacy shop spends between runs.
        const pr = GameModel.progression;
        if (pr) {
            pr.level = p.tier;
            pr.xp = Math.round(p.mass);
            pr.currencies = pr.currencies || {};
            pr.currencies.scrap = Math.round((run.totals && run.totals.scrap) || 0);
            pr.currencies.mass = Math.round((run.totals && run.totals.mass) || 0);
        }
        // Run context an agent or a save reads without touching the simulation.
        if (typeof Kit !== 'undefined') {
            Kit.state('region', run.regionIndex);
            Kit.state('biome', region.biome.id);
            Kit.state('seed', run.seed);
            Kit.state('runTime', Math.round(run.time));
            Kit.state('screenState', this.state);
            Kit.state('fortressesLeft', run.fortressesLeft);
        }
        return true;
    }

    /** The attract autopilot: seek the nearest village, avoid the rim, no fighting. */
    stepAttract(dt) {
        const run = this.run;
        if (!run) return;
        this._attractT = (this._attractT || 0) + dt;
        // Unpause for the step, then pause again: the menu must not progress the world forever.
        run.paused = false;
        const p = run.player, r = run.region;
        let target = null, best = -1;
        for (const e of r.entities) {
            if (e.dead || (e.type !== 'village' && e.type !== 'node' && e.type !== 'herd')) continue;
            const d = WB.M.dist(p.x, p.y, e.x, e.y);
            if (best < 0 || d < best) { best = d; target = e; }
        }
        const dC = Math.hypot(p.x - r.cx, p.y - r.cy);
        let want;
        if (dC > r.regionR - 200) want = Math.atan2(r.cy - p.y, r.cx - p.x);
        else if (target) want = Math.atan2(target.y - p.y, target.x - p.x);
        else want = this._attractT * 0.2;
        const d = WB.M.angleDelta(p.heading, want);
        run.update(Math.min(dt, 1 / 30), {
            throttle: 0.7,
            steer: WB.M.clamp(d * 1.6, -1, 1),
            boost: false
        });
        run.paused = true;
        if (run.draftPending) run.takeDraft(0);
        // A slow camera orbit makes the valley readable from the menu.
        this.camera.zoomTarget = WB.M.clamp(0.5 + Math.sin(this._attractT * 0.08) * 0.08, 0.42, 0.7);
        if (run.over) this.startAttract();
    }

    /** React to the simulation's events: toasts, the draft, the boss, the region end. */
    handleEvents(events) {
        for (const ev of events) {
            switch (ev.type) {
                case 'region':
                    WanderAudio.music(WanderAudio.musicForRegion(ev.biome, false));
                    break;
                case 'objective':
                    Hud.setHint('W A S D — ход · Shift — пар');
                    break;
                case 'tierUp':
                    Hud.toast('СТУПЕНЬ ' + ev.tier + ' — корпус вырос, слотов ' + ev.slots, 3.5);
                    break;
                case 'draft':
                    this.state = 'draft';
                    this.run.paused = true;
                    Hud.showDraft(this.run, this.run.rerollsLeft);
                    break;
                case 'gateOpen':
                    Hud.toast('ВРАТА ВАРДЕНА ОТКРЫТЫ — он ждёт у центра долины', 6);
                    break;
                case 'bossSpawn':
                    Hud.toast(ev.name + ' ВЫХОДИТ НА ОХОТУ', 5);
                    WanderAudio.music('musicBoss');
                    this.camera.shake(420, 14);
                    break;
                case 'bossDown':
                    if (ev.crown) Hud.toast('ЖЕЛЕЗНЫЙ ВЕНЕЦ ПОВЕРЖЕН', 6);
                    else Hud.toast(ev.name + ' разрушен — рубеж ваш', 5);
                    break;
                case 'chargeTelegraph':
                    Hud.toast('ВАРДЕН ИДЁТ НА ТАРАН!', 1.6);
                    break;
                case 'fortressDown':
                    Hud.toast('Крепость съедена · осталось ' + ev.left, 3);
                    break;
                case 'secondWind':
                    Hud.toast('ВТОРОЕ ДЫХАНИЕ — корпус восстановлен', 4);
                    break;
                case 'regionClear':
                    // The next valley waits until any open draft is closed.
                    if (this.state === 'draft') this._pendingRegion = true;
                    else if (this.state === 'play') this.enterNextRegion();
                    break;
                case 'playerDown':
                    break;
                default: break;
            }
        }
    }
}

// The tag of the location object the kit's sample game used to drive; Wanderburg builds its own
// world in code, so Objects.js stays empty and this is kept for the kit's contract only.
Game.HERO_TAG = 'player';

// The stable logical identities of GAME_SPEC.entities (js/GameSpec.js). A visual migration,
// a save and the editor all address the actors by these ids — never by a mesh or a scene node.
Game.CASTLE_ID = 'castle';
Game.GATE_ID = 'warden-gate';
