// WanderAudio.js — the game's sound: what plays on which simulation event, the looped steam
// and rumble of the walking castle, the biome music, and the player's own volume settings.
//
// It is a VIEW file like WanderView.js: it reads events and talks to Sound3D, and it never
// writes to the simulation. Every path is a quoted LITERAL from assets/sounds/ — the builder's
// asset scanner (tools/asset-scan.mjs) archives only what it can see that way. The files
// themselves are synthesized by `node tools/make-wander-sounds.mjs` (no recordings, no licence
// questions, ~200 KB in total).

/** @satisfies {Record<string, any>} */
const WanderAudio = {
    // --- the bank -------------------------------------------------------------------------
    // Paths are literals on purpose (see the header).
    SRC: {
        shotSmall: 'assets/sounds/shot_small.wav',
        shotBig: 'assets/sounds/shot_big.wav',
        shotRapid: 'assets/sounds/shot_rapid.wav',
        shotArcane: 'assets/sounds/shot_arcane.wav',
        shotMortar: 'assets/sounds/shot_mortar.wav',
        shotFlame: 'assets/sounds/shot_flame.wav',
        shotTesla: 'assets/sounds/shot_tesla.wav',
        impact: 'assets/sounds/impact.wav',
        boomSmall: 'assets/sounds/boom_small.wav',
        boomBig: 'assets/sounds/boom_big.wav',
        ram: 'assets/sounds/ram.wav',
        gulp: 'assets/sounds/gulp.wav',
        chew: 'assets/sounds/chew.wav',
        crumble: 'assets/sounds/crumble.wav',
        scream: 'assets/sounds/scream.wav',
        knight: 'assets/sounds/knight.wav',
        hurt: 'assets/sounds/hurt.wav',
        repair: 'assets/sounds/repair.wav',
        steam: 'assets/sounds/steam.wav',
        rumble: 'assets/sounds/rumble.wav',
        tierUp: 'assets/sounds/tier_up.wav',
        draft: 'assets/sounds/draft.wav',
        take: 'assets/sounds/take.wav',
        deny: 'assets/sounds/deny.wav',
        horn: 'assets/sounds/horn.wav',
        clear: 'assets/sounds/clear.wav',
        victory: 'assets/sounds/victory.wav',
        death: 'assets/sounds/death.wav',
        click: 'assets/sounds/ui_click.wav',
        buy: 'assets/sounds/ui_buy.wav',
        err: 'assets/sounds/ui_error.wav',
        musicMenu: 'assets/sounds/music_menu.wav',
        musicMarch: 'assets/sounds/music_march.wav',
        musicSteppe: 'assets/sounds/music_steppe.wav',
        musicFrost: 'assets/sounds/music_frost.wav',
        musicBoss: 'assets/sounds/music_boss.wav'
    },

    // One entry per shot kind of Content.js: which file, how loud, how far it carries.
    SHOTS: {
        ball: { src: 'shotSmall', v: 0.5, max: 1000 },
        bullet: { src: 'shotRapid', v: 0.26, max: 780 },
        bolt: { src: 'shotSmall', v: 0.44, max: 950 },
        arcane: { src: 'shotArcane', v: 0.46, max: 1050 },
        shell: { src: 'shotMortar', v: 0.6, max: 1250 },
        flame: { src: 'shotFlame', v: 0.3, max: 700 },
        spark: { src: 'shotTesla', v: 0.5, max: 1100 }
    },

    /** @type {Record<string, number>} key -> the last time it played (a cheap rate limiter) */
    _last: {},
    /** @type {Record<string, number>} how many of a key played this frame */
    _frameCount: {},
    _frame: 0,
    /** @type {SoundHandle | null} */
    _steam: null,
    /** @type {SoundHandle | null} */
    _rumble: null,
    _musicId: '',
    started: false,

    // --- plumbing ---------------------------------------------------------------------------
    /**
     * @param {string} key a name from SRC
     * @param {{ x?: number, y?: number, v?: number, min?: number, max?: number, loop?: boolean }} [o]
     * @param {number} [limit] ms: do not replay the same key sooner (0 — no limit)
     */
    play(key, o, limit) {
        const opt = o || {};
        const src = this.SRC[key];
        if (!src || typeof Sound3D === 'undefined') return null;
        const now = performance.now();
        if (limit && now - (this._last[key] || -1e9) < limit) return null;
        if ((this._frameCount[key] || 0) >= 3) return null;      // a salvo is three sounds, not thirty
        this._last[key] = now;
        this._frameCount[key] = (this._frameCount[key] || 0) + 1;
        return Sound3D.play(src, {
            x: opt.x, y: opt.y,
            volume: opt.v == null ? 0.6 : opt.v,
            loop: !!opt.loop,
            falloffMin: opt.min, falloffMax: opt.max
        });
    },

    /** Called once per frame before onEvents, so the per-frame limiter resets. */
    beginFrame() {
        this._frame++;
        this._frameCount = {};
    },

    /** The player's own mixer: the save's sfx/music sliders on top of the kit's constants. */
    applyVolumes() {
        if (typeof Sound3D === 'undefined' || !Sound3D.ctx) return;
        const meta = WB.Save.meta || WB.Save.load();
        const set = meta.settings || {};
        const sfx = WB.M.clamp(set.sfx == null ? 1 : Number(set.sfx), 0, 1);
        const music = WB.M.clamp(set.music == null ? 1 : Number(set.music), 0, 1);
        const base = typeof AUDIO_SFX_VOLUME !== 'undefined' ? AUDIO_SFX_VOLUME : 1;
        const baseM = typeof AUDIO_MUSIC_VOLUME !== 'undefined' ? AUDIO_MUSIC_VOLUME : 0.6;
        if (Sound3D.buses.sfx) Sound3D.buses.sfx.gain.value = base * sfx;
        if (Sound3D.buses.music) Sound3D.buses.music.gain.value = baseM * music;
        if (Sound3D.master) {
            Sound3D.master.gain.value = Sound3D.muted ? 0 : WB.M.clamp(typeof AUDIO_MASTER_VOLUME !== 'undefined' ? AUDIO_MASTER_VOLUME : 0.8, 0, 1);
        }
    },

    setMuted(on) {
        if (typeof Sound3D !== 'undefined') Sound3D.setMuted(!!on);
    },

    // --- music --------------------------------------------------------------------------------
    /** Start/replace the background track. `id` is any of SRC's music keys. */
    music(id) {
        if (this._musicId === id) return;
        this._musicId = id;
        if (typeof Sound3D === 'undefined') return;
        const src = id ? this.SRC[id] : null;
        Sound3D.music(src || null, { volume: 0.9 });
        this.applyVolumes();
    },

    /** The track of a region (a boss fight switches to the boss theme). */
    musicForRegion(biomeId, boss) {
        if (boss) return 'musicBoss';
        if (biomeId === 'steppe') return 'musicSteppe';
        if (biomeId === 'frost') return 'musicFrost';
        if (biomeId === 'crown') return 'musicBoss';
        return 'musicMarch';
    },

    // --- the castle's own noise -------------------------------------------------------------------
    /**
     * The looping steam and the wheels' rumble, mixed by speed and boost. Called every frame
     * with the player's castle; both loops are started on the first call (the browser unlocks
     * audio on the first press, Sound3D handles that).
     */
    updateEngine(castle, dt) {
        if (!castle || typeof Sound3D === 'undefined') return;
        const speed = castle.speed || 0;
        const k = WB.M.clamp(speed / Math.max(40, castle.stats ? castle.stats.speed : 200), 0, 1.4);
        if (!this._steam) this._steam = Sound3D.play(this.SRC.steam, { at: castle, loop: true, volume: 0, falloffMin: 200, falloffMax: 900 });
        if (!this._rumble) this._rumble = Sound3D.play(this.SRC.rumble, { at: castle, loop: true, volume: 0, falloffMin: 200, falloffMax: 1100 });
        const wantSteam = castle.boost ? 0.42 : 0.09 + k * 0.14;
        const wantRumble = 0.05 + k * 0.4;
        this._steam.setVolume(WB.M.damp(this._steam.volume || 0, wantSteam, 6, dt));
        this._rumble.setVolume(WB.M.damp(this._rumble.volume || 0, wantRumble, 7, dt));
    },

    // --- events -> sound ---------------------------------------------------------------------------
    /**
     * Play a frame's worth of simulation events.
     * @param {any[]} events WBRun.events of this frame
     * @param {any} player the player's castle (to tell our shots from theirs)
     */
    onEvents(events, player) {
        for (const ev of events) {
            switch (ev.type) {
                case 'shot': {
                    const s = this.SHOTS[ev.kind] || this.SHOTS.ball;
                    this.play(s.src, { x: ev.x, y: ev.y, v: s.v * (ev.faction === 'player' ? 1 : 0.8), max: s.max }, ev.faction === 'player' ? 40 : 90);
                    break;
                }
                case 'impact':
                    this.play('impact', { x: ev.x, y: ev.y, v: 0.24 * (0.6 + ev.power * 0.6), max: 700 }, 45);
                    break;
                case 'boom':
                    this.play(ev.r > 130 ? 'boomBig' : 'boomSmall', { x: ev.x, y: ev.y, v: WB.M.clamp(0.34 + ev.power * 0.3, 0.2, 0.85), max: 1500 }, 55);
                    break;
                case 'zap':
                    this.play('shotTesla', { x: ev.x, y: ev.y, v: 0.4, max: 1000 }, 90);
                    break;
                case 'flame':
                    this.play('shotFlame', { x: ev.x, y: ev.y, v: 0.22, max: 620 }, 110);
                    break;
                case 'ram':
                    this.play('ram', { x: ev.x, y: ev.y, v: WB.M.clamp(0.4 + ev.power * 0.4, 0.3, 0.95), max: 1300 }, 90);
                    break;
                case 'melee':
                    this.play('knight', { x: ev.x, y: ev.y, v: 0.3, max: 700 }, 110);
                    break;
                case 'sting':
                    this.play('knight', { x: ev.x, y: ev.y, v: 0.18, max: 500 }, 130);
                    break;
                case 'gulp':
                    this.play('gulp', { x: ev.x, y: ev.y, v: 0.34, max: 620 }, 55);
                    break;
                case 'chew':
                    this.play('chew', { x: ev.x, y: ev.y, v: 0.2, max: 560 }, 130);
                    break;
                case 'chunkEaten':
                    this.play('gulp', { v: 0.16, max: 500 }, 90);
                    break;
                case 'devoured':
                    this.play('crumble', { x: ev.x, y: ev.y, v: 0.5, max: 1100 }, 90);
                    this.play('scream', { x: ev.x, y: ev.y, v: 0.3, max: 900 }, 220);
                    break;
                case 'knightDown':
                    this.play('knight', { x: ev.x, y: ev.y, v: 0.28, max: 700 }, 90);
                    break;
                case 'surrender':
                    this.play('scream', { x: ev.x, y: ev.y, v: 0.16, max: 620 }, 260);
                    break;
                case 'hurt':
                    this.play('hurt', { v: WB.M.clamp(0.24 + ev.dmg / 160, 0.2, 0.7), max: 400 }, 120);
                    break;
                case 'repair':
                    this.play('repair', { v: 0.14, max: 420 }, 900);
                    break;
                case 'bump':
                    this.play('impact', { x: ev.x, y: ev.y, v: 0.2 * ev.power, max: 600 }, 140);
                    break;
                case 'tierUp':
                    this.play('tierUp', { v: 0.75 }, 0);
                    break;
                case 'draft':
                    this.play('draft', { v: 0.5 }, 0);
                    break;
                case 'take':
                    this.play('take', { v: 0.55 }, 0);
                    break;
                case 'deny':
                    this.play('deny', { v: 0.5 }, 0);
                    break;
                case 'reroll':
                    this.play('draft', { v: 0.42 }, 0);
                    break;
                case 'gateOpen':
                    this.play('horn', { x: ev.x, y: ev.y, v: 0.6, max: 2400 }, 0);
                    break;
                case 'bossSpawn':
                    this.play('horn', { x: ev.x, y: ev.y, v: 0.85, max: 3000 }, 0);
                    break;
                case 'chargeTelegraph':
                    this.play('steam', { x: ev.x, y: ev.y, v: 0.4, max: 1200 }, 200);
                    break;
                case 'bossDown':
                    this.play(ev.crown ? 'victory' : 'clear', { v: 0.85 }, 0);
                    break;
                case 'regionClear':
                    this.play('clear', { v: 0.8 }, 0);
                    break;
                case 'castleDown':
                    if (!ev.player) this.play('crumble', { x: ev.x, y: ev.y, v: 0.62, max: 1600 }, 0);
                    break;
                case 'playerDown':
                    this.play('death', { v: 0.9 }, 0);
                    break;
                case 'secondWind':
                    this.play('tierUp', { v: 0.7 }, 0);
                    break;
                case 'region':
                    this.music(this.musicForRegion(ev.biome, false));
                    break;
                default: break;
            }
        }
        void player;
    },

    // --- UI clicks -------------------------------------------------------------------------------
    click() { this.play('click', { v: 0.4 }, 30); },
    buy() { this.play('buy', { v: 0.55 }, 30); },
    error() { this.play('err', { v: 0.45 }, 60); },

    /** Stop the loops (a run ended / back to the menu). */
    stopLoops() {
        if (this._steam) { this._steam.stop(); this._steam = null; }
        if (this._rumble) { this._rumble.stop(); this._rumble = null; }
    },

    /** Preload the bank so the first shot is not silent (the files are tiny). */
    preload() {
        if (typeof Sound3D === 'undefined') return;
        for (const k of Object.keys(this.SRC)) Sound3D.load(this.SRC[k]);
    }
};
