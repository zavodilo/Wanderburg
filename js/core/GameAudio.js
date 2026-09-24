// GameAudio.js — the semantic audio API of the core.
//
// The name is GameAudio, not Audio: `Audio` is a DOM constructor (HTMLAudioElement) and a
// top-level lexical binding with that name would shadow it for the whole page.
//
// Gameplay plays CUES by id and never names a file, a channel or a profile:
//
//     GameAudio.play('step');                       // a cue from GAME_SPEC.audio
//     GameAudio.play('hit', { at: enemy.position });  // spatial when the profile supports it
//     GameAudio.music('main-theme');
//     GameAudio.volume('sfx', 0.5);
//
// The cue -> file mapping lives in the spec (and in the asset registry for
// audio.<name> roles), so a migration can swap a mono SFX for a 3D-positioned one without
// touching a single gameplay line. Whether a cue is spatial follows the ACTIVE PROFILE's
// capabilities (manifest/render-profiles.json -> profiles[*].audio.spatial): 2D pans by x,
// the 3D profiles place the sound in the world. The engine binding is js/engine/Sound3D.js.

/** @satisfies {Record<string, any>} */
const GameAudio = {
    /** @type {Map<string, any>} cue id -> { id, asset, loop, volume, spatial, channel } */
    _cues: new Map(),
    /** @type {Record<string, number>} */
    _volumes: { master: 1, music: 1, sfx: 1 },
    _muted: false,
    /** Recent calls, kept for headless verification (a migration must not change them). */
    log: [],
    LOG_MAX: 200,
    /** @type {Function | null} installed by the engine backend: (src, opts) => handle */
    _backend: null,
    /** @type {Function | null} */
    _backendStop: null,
    /** @type {Function | null} */
    _backendVolume: null,
    /** @type {Function | null} */
    _backendMute: null,

    // --- spec -------------------------------------------------------------------------

    /** Load cues from GAME_SPEC.audio (called by GameModel.boot's owner — main.js). */
    fromSpec(spec) {
        const s = spec || {};
        GameAudio._cues.clear();
        for (const c of s.cues || []) GameAudio.cue(c.id, c);
        for (const ch of s.channels || []) if (!(ch in GameAudio._volumes)) GameAudio._volumes[ch] = 1;
        return GameAudio.cues();
    },

    /** Define or read a cue. */
    cue(id, def) {
        if (!id) throw new Error('GameAudio.cue: id is required');
        if (def !== undefined) {
            const rec = Object.assign({ id: String(id), asset: null, loop: false, volume: 1, spatial: null, channel: 'sfx' }, def || {});
            rec.id = String(id);
            GameAudio._cues.set(rec.id, rec);
            return JSON.parse(JSON.stringify(rec));
        }
        const have = GameAudio._cues.get(String(id));
        return have ? JSON.parse(JSON.stringify(have)) : null;
    },

    cues() {
        const out = {};
        for (const [id, c] of GameAudio._cues) out[id] = JSON.parse(JSON.stringify(c));
        return out;
    },

    /** The asset of a cue, resolved through the registry when the cue names a role. */
    assetOf(id) {
        const c = GameAudio._cues.get(String(id));
        if (!c) return null;
        if (c.asset && /^assets\//.test(c.asset)) return c.asset;
        // A role (audio.step) or a bare name: ask the registry, which knows the fallbacks.
        if (typeof AssetRegistry !== 'undefined') {
            const role = /^audio\./.test(c.asset || '') ? c.asset : 'audio.' + (c.asset || c.id);
            const res = AssetRegistry.resolve(role, GameModel.renderProfile());
            if (res && res.asset) return res.asset;
        }
        return c.asset || null;
    },

    /** Is this cue positioned in the world under the active profile? */
    isSpatial(id) {
        const c = GameAudio._cues.get(String(id));
        if (c && c.spatial != null) return !!c.spatial;
        const prof = (typeof RENDER_PROFILES !== 'undefined') ? RENDER_PROFILES.profiles[GameModel.renderProfile()] : null;
        return !!(prof && prof.audio && prof.audio.spatial);
    },

    // --- playback ------------------------------------------------------------------------

    /**
     * Play a cue. opts — { at?: {x,y,z} | entity, volume?, loop?, channel?, rate? }.
     * Returns the engine handle when the engine is bound, otherwise a stub with stop().
     */
    play(id, opts) {
        const o = opts || {};
        const c = GameAudio._cues.get(String(id)) || { id: String(id), asset: null, volume: 1, channel: 'sfx' };
        const asset = GameAudio.assetOf(c.id);
        const at = GameAudio._posOf(o.at);
        const spatial = at != null && GameAudio.isSpatial(c.id);
        const entry = {
            cue: c.id, asset: asset, at: at, spatial: spatial,
            volume: o.volume != null ? Number(o.volume) : Number(c.volume != null ? c.volume : 1),
            loop: o.loop != null ? !!o.loop : !!c.loop,
            channel: o.channel || c.channel || 'sfx',
            muted: GameAudio._muted
        };
        GameAudio.log.push(entry);
        if (GameAudio.log.length > GameAudio.LOG_MAX) GameAudio.log.shift();
        if (GameAudio._muted || !asset) return GameAudio._silent(entry);
        if (typeof GameAudio._backend !== 'function') return GameAudio._silent(entry);
        const map = at ? Coords.toMap(at) : null;
        return GameAudio._backend(asset, {
            x: map ? map.x : undefined,
            y: map ? map.y : undefined,
            volume: entry.volume * (GameAudio._volumes[entry.channel] != null ? GameAudio._volumes[entry.channel] : 1),
            loop: entry.loop,
            channel: entry.channel
        }) || GameAudio._silent(entry);
    },

    /** The one looped background track. */
    music(id, opts) {
        const o = Object.assign({}, opts || {}, { loop: true, channel: 'music' });
        return GameAudio.play(id, o);
    },

    /** A sound that stands at a world position (canonical { x, y, z }). */
    at(id, position, opts) { return GameAudio.play(id, Object.assign({}, opts || {}, { at: position })); },

    /** Stop a channel or everything. */
    stop(channel) {
        if (typeof GameAudio._backendStop === 'function') return GameAudio._backendStop(channel || null);
        return false;
    },

    /** Channel volume: 'master' | 'music' | 'sfx' | a spec channel. */
    volume(channel, v) {
        if (v === undefined) return GameAudio._volumes[channel] != null ? GameAudio._volumes[channel] : 1;
        GameAudio._volumes[channel] = Math.max(0, Math.min(1, Number(v) || 0));
        if (typeof GameAudio._backendVolume === 'function') GameAudio._backendVolume(channel, GameAudio._volumes[channel]);
        return GameAudio._volumes[channel];
    },

    mute(on) {
        GameAudio._muted = on !== false;
        if (typeof GameAudio._backendMute === 'function') GameAudio._backendMute(GameAudio._muted);
        return GameAudio._muted;
    },

    muted() { return GameAudio._muted; },

    /** The engine backend: { play, stop, volume, mute } — installed by main.js. */
    setBackend(b) {
        const be = b || {};
        GameAudio._backend = typeof be.play === 'function' ? be.play : null;
        GameAudio._backendStop = typeof be.stop === 'function' ? be.stop : null;
        GameAudio._backendVolume = typeof be.volume === 'function' ? be.volume : null;
        GameAudio._backendMute = typeof be.mute === 'function' ? be.mute : null;
        return !!GameAudio._backend;
    },

    /** What the last frames played (headless verification: a migration changes nothing here). */
    recent(n) { return GameAudio.log.slice(-Math.max(1, n || 20)).map(e => JSON.parse(JSON.stringify(e))); },

    clearLog() { GameAudio.log.length = 0; },

    // --- internals -----------------------------------------------------------------------

    /** opts.at may be a canonical vector, an entity or an entity id. */
    _posOf(at) {
        if (at == null) return null;
        if (typeof at === 'string') { const e = GameModel.entity(at); return e ? Coords.clone(e.position) : null; }
        if (at.position) return Coords.from(at.position);
        if (typeof at.x === 'number' || typeof at.z === 'number') return Coords.from(at);
        return null;
    },

    _silent(entry) { return { cue: entry.cue, silent: true, stop() { return false; }, setVolume() { return false; } }; },

    /** Digest for the gameplay proof of a migration. */
    digest() {
        return {
            cues: [...GameAudio._cues.keys()].sort(),
            channels: Object.keys(GameAudio._volumes).sort()
        };
    }
};
