// GameAnimation.js — the semantic animation API (presentation layer).
//
// Gameplay names a STATE, never a clip, a frame index or an animation system:
//
//     GameAnimation.play('run')                  // the default subject (the followed entity)
//     GameAnimation.play('player', 'attack')     // an explicit entity
//     GameAnimation.state('player')              // 'attack'
//
// The same state list works everywhere (manifest animationStates): idle, walk, run, attack,
// hurt, death, jump, fall, land, use, carry, sleep. Under it, the ACTIVE PROFILE decides the
// representation — sprite frames in 2D, a billboard strip in 2.5D, skeletal clips in the 3D
// profiles — and js/engine/Visual3D.js drives the right system. A visual migration therefore
// never touches a gameplay line: `GameAnimation.play('run')` keeps working from 2D to Full 3D.

/** @satisfies {Record<string, any>} */
const GameAnimation = {
    /** @type {any | null} */
    _backend: null,
    /** @type {Map<string, { state: string, since: number, speed: number, loop: boolean, applied: boolean }>} */
    _states: new Map(),
    /** @type {string | null} the entity play() targets when it is not given one */
    _subject: null,
    _t: 0,

    /** The canonical state names (canon: manifest/render-profiles.json -> animationStates). */
    states() {
        return (typeof RENDER_PROFILES !== 'undefined' ? RENDER_PROFILES.animationStates : ['idle', 'walk', 'run', 'attack', 'hurt', 'death', 'jump']).slice();
    },

    isKnown(state) { return GameAnimation.states().includes(String(state)); },

    /** The states a profile animates (a 2D profile has no 'fall' if its spec says so). */
    statesFor(profileId) {
        const p = (typeof RENDER_PROFILES !== 'undefined' && RENDER_PROFILES.profiles[profileId || GameAnimation.system().profile]) || null;
        return p && p.animation && p.animation.states ? p.animation.states.slice() : GameAnimation.states();
    },

    /** Which animation system presents the active profile: sprite-frames | skeletal | hybrid. */
    system(profileId) {
        const pid = profileId || (typeof RenderProfile !== 'undefined' && GameModel.booted() ? RenderProfile.id() : '2d');
        const p = (typeof RENDER_PROFILES !== 'undefined' && RENDER_PROFILES.profiles[pid]) || null;
        return { profile: pid, system: (p && p.animation && p.animation.system) || 'sprite-frames', states: GameAnimation.statesFor(pid) };
    },

    // --- game facing API --------------------------------------------------------------------

    /** The entity play()/stop() act on when called without one. */
    subject(id) {
        if (id === undefined) return GameAnimation._subject || GameAnimation.defaultSubject();
        if (id !== null && typeof GameModel !== 'undefined' && GameModel.booted() && !GameModel.entity(id)) {
            throw new Error('GameAnimation.subject: no entity ' + JSON.stringify(id));
        }
        GameAnimation._subject = id || null;
        return GameAnimation._subject;
    },

    /** The followed entity, else the first character, else null. */
    defaultSubject() {
        if (!GameModel.booted()) return null;
        const followed = typeof Camera !== 'undefined' ? Camera.followed() : null;
        if (followed && GameModel.entity(followed)) return followed;
        const chars = GameModel.find({ type: 'character' });
        return chars.length ? chars[0].id : null;
    },

    /**
     * Play a state. Signatures:
     *   GameAnimation.play('run')                      — the default subject
     *   GameAnimation.play('player', 'run')            — an explicit entity
     *   GameAnimation.play('run', { entity: 'player', speed: 1.4, loop: true })
     */
    play(a, b, opts) {
        let id = null, state = null, o = opts || {};
        if (typeof a === 'string' && GameAnimation.isKnown(a)) { state = a; id = (b && typeof b === 'object' && b.entity) || (typeof b === 'string' && !GameAnimation.isKnown(b) ? b : null) || o.entity || GameAnimation.subject(); }
        else if (typeof a === 'string' && typeof b === 'string') { id = a; state = b; }
        else if (typeof a === 'string') { state = a; id = o.entity || GameAnimation.subject(); }
        if (!state) throw new Error('Animation.play: a state name is required (' + GameAnimation.states().join(', ') + ')');
        if (!GameAnimation.isKnown(state)) throw new Error('GameAnimation.play: unknown state ' + JSON.stringify(state) + ' (known: ' + GameAnimation.states().join(', ') + ')');
        if (!id) throw new Error('Animation.play: no target entity (GameAnimation.subject(id) sets the default)');
        const rec = GameAnimation._states.get(id) || { state: null, since: 0, speed: 1, loop: true, applied: false };
        const changed = rec.state !== state;
        rec.state = state;
        rec.speed = o.speed != null ? Number(o.speed) : rec.speed;
        rec.loop = o.loop !== undefined ? !!o.loop : rec.loop;
        if (changed) { rec.since = GameAnimation._t; rec.applied = false; }
        GameAnimation._states.set(id, rec);
        return GameAnimation._apply(id, rec, o);
    },

    /** Semantic alias of play() (GameAnimation.set('idle')). */
    set(a, b, opts) { return GameAnimation.play(a, b, opts); },

    _apply(id, rec, o) {
        const out = { entity: id, state: rec.state, applied: false, headless: true, representation: null };
        if (GameAnimation._backend && typeof GameAnimation._backend.animation === 'function') {
            const r = GameAnimation._backend.animation(id, rec.state, Object.assign({ speed: rec.speed, loop: rec.loop }, o || {})) || {};
            out.applied = r.applied !== false;
            out.headless = false;
            out.representation = r.representation || null;
            out.clip = r.clip || null;
            out.frame = r.frame != null ? r.frame : null;
        }
        rec.applied = out.applied;
        return out;
    },

    /** Stop the animation of an entity (it keeps its current pose/frame). */
    stop(id) {
        const target = id || GameAnimation.subject();
        const rec = GameAnimation._states.get(target);
        if (rec) rec.state = null;
        if (GameAnimation._backend && typeof GameAnimation._backend.animationStop === 'function') return GameAnimation._backend.animationStop(target);
        return { entity: target, applied: false, headless: !GameAnimation._backend };
    },

    /** The state an entity is in (null — nothing was played yet). */
    state(id) {
        const target = id || GameAnimation.subject();
        const rec = GameAnimation._states.get(target);
        return rec ? rec.state : null;
    },

    /** Everything known about an entity's animation. */
    of(id) {
        const target = id || GameAnimation.subject();
        const rec = GameAnimation._states.get(target) || null;
        return {
            entity: target,
            state: rec ? rec.state : null,
            since: rec ? rec.since : null,
            speed: rec ? rec.speed : 1,
            loop: rec ? rec.loop : true,
            applied: rec ? rec.applied : false,
            system: GameAnimation.system(),
            mapping: GameAnimation.mapping(target)
        };
    },

    /**
     * How a state is represented for an entity right now: the clip name of a model variant
     * or the frame indices of a sprite variant (null — the backend picks a default).
     */
    mapping(entityId) {
        const e = typeof GameModel !== 'undefined' && GameModel.booted() ? GameModel.entity(entityId) : null;
        if (!e || typeof AssetRegistry === 'undefined') return null;
        const role = e.role();
        if (!role) return null;
        const pid = typeof RenderProfile !== 'undefined' ? RenderProfile.id() : null;
        const r = AssetRegistry.resolve(role, pid, { entityType: e.type });
        return { role: role, profile: pid, type: r.type, clips: r.clips, frames: r.frames, asset: r.asset };
    },

    /** Reset every recorded state (a scene change, a migration rollback). */
    clear() { GameAnimation._states.clear(); return true; },

    /** Every entity with a state, for tests and reports. */
    inspect() {
        const out = [];
        for (const [id, rec] of GameAnimation._states) out.push({ entity: id, state: rec.state, speed: rec.speed, loop: rec.loop, applied: rec.applied, since: Math.round(rec.since * 1000) / 1000 });
        return {
            system: GameAnimation.system(),
            subject: GameAnimation.subject(),
            states: GameAnimation.states(),
            playing: out,
            backend: !!GameAnimation._backend,
            headless: !GameAnimation._backend
        };
    },

    attachBackend(backend) {
        GameAnimation._backend = backend && typeof backend.animation === 'function' ? backend : (backend || null);
        // re-apply what was already playing (a migration swapped the representation under us)
        if (GameAnimation._backend) for (const [id, rec] of GameAnimation._states) if (rec.state) GameAnimation._apply(id, rec, {});
        return !!GameAnimation._backend;
    },

    backend() { return GameAnimation._backend; },

    /** Called by the frame loop: bookkeeping only, the engine advances clips/frames itself. */
    update(dt) { GameAnimation._t += Math.max(0, Number(dt) || 0); return GameAnimation._t; }
};
