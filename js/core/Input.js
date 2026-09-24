// Input.js — the semantic input contract of the core (renderer-independent).
//
// Gameplay asks for ACTIONS and canonical DIRECTIONS, never for keys, pointers or screen
// axes:
//
//     Input.isDown('run')
//     Input.pressed('jump')
//     const move = Input.axis('move');      // { x: 0, y: 0, z: -1 } — "north"
//     hero.moveBy(Coords.scale(move, speed * dt));
//
// `axis()` returns a vector in the CANONICAL space (x horizontal, y height, z depth), so
// "move north" is { x: 0, z: -1 } in every render profile: the camera decides how north
// looks on screen (skill render-profile). A 2D side-scroller maps the same action to
// { x, y }; nothing in game code branches on the profile.
//
// Bindings come from GAME_SPEC.input (manifest/game-schema.json) and may be remapped at
// runtime; Input.simulate() drives the same contract headlessly (tests, agents, replays).

/** @satisfies {Record<string, any>} */
const Input = {
    /** action -> bindings (['KeyW', 'ArrowUp', 'mouse0', 'touch', 'gamepad0:axis1+']) */
    _map: new Map(),
    /** action -> is down now */
    _down: new Map(),
    /** action -> was down at the end of the previous frame */
    _prev: new Map(),
    /** action -> handlers registered with on() */
    _handlers: new Map(),
    /** Which axis an action drives: 'xz' (top-down / 3D), 'xy' (side view), 'none'. */
    _axisPlane: new Map(),
    _attached: null,
    /** @type {any | null} the listeners attach() installed (detach removes exactly these) */
    _bound: null,
    _worldProjector: null,
    /** @type {{ x: number, y: number, down: boolean, moved: boolean }} */
    pointer: { x: 0, y: 0, down: false, moved: false },
    /** Everything that happened this frame, for tests and replays. */
    events: [],

    AXES: ['move', 'look', 'aim'],

    // --- action map ------------------------------------------------------------------

    /**
     * Define actions. spec — { move: ['KeyW', 'ArrowUp', …], jump: ['Space'] } or the
     * GAME_SPEC.input block, optionally with { actions: {...}, planes: { move: 'xz' } }.
     */
    define(spec) {
        const s = spec || {};
        const actions = s.actions || s;
        const planes = s.planes || {};
        for (const [name, bindings] of Object.entries(actions || {})) {
            if (!Input.ACTION_NAME.test(String(name))) throw new Error('Input.define: bad action name ' + JSON.stringify(name));
            Input._map.set(String(name), (Array.isArray(bindings) ? bindings : [bindings]).map(String));
            if (planes[name]) Input._axisPlane.set(String(name), String(planes[name]));
            else if (!Input._axisPlane.has(String(name))) Input._axisPlane.set(String(name), Input.AXES.includes(name) ? 'xz' : 'none');
            if (!Input._down.has(name)) { Input._down.set(name, false); Input._prev.set(name, false); }
        }
        return Input.map();
    },

    /** The action map as plain data (agent-readable, saved with the spec). */
    map() {
        const out = {};
        for (const [name, b] of Input._map) out[name] = { bindings: b.slice(), plane: Input._axisPlane.get(name) || 'none' };
        return out;
    },

    actions() { return [...Input._map.keys()]; },

    has(action) { return Input._map.has(String(action)); },

    /** Which plane an axis action drives ('xz' | 'xy' | 'none'). */
    plane(action) { return Input._axisPlane.get(String(action)) || 'none'; },

    /** Rebind: Input.bind('jump', ['Space', 'mouse0']). */
    bind(action, bindings) {
        if (!Input.has(action)) throw new Error('Input.bind: unknown action ' + JSON.stringify(action));
        Input._map.set(String(action), (Array.isArray(bindings) ? bindings : [bindings]).map(String));
        return Input.map()[String(action)];
    },

    ACTION_NAME: /^[a-z][a-zA-Z0-9_.-]{0,47}$/,

    // --- state ------------------------------------------------------------------------

    /** Held down right now. */
    isDown(action) { return !!Input._down.get(String(action)); },

    /** Went down this frame (edge). */
    pressed(action) { return !!Input._down.get(String(action)) && !Input._prev.get(String(action)); },

    /** Went up this frame (edge). */
    released(action) { return !Input._down.get(String(action)) && !!Input._prev.get(String(action)); },

    /**
     * The canonical direction of an axis action:
     *   plane 'xz' — { x: right, y: 0, z: down-the-map } (top-down, isometric, 3D)
     *   plane 'xy' — { x: right, y: up, z: 0 }          (side view, platformer)
     * Bindings are read by their ROLE suffix: :up :down :left :right, or the well-known
     * WASD/arrow keys. The result is a unit-ish vector in canonical space.
     */
    axis(action) {
        const name = String(action);
        let dx = 0, dy = 0, dz = 0;
        for (const b of Input._map.get(name) || []) {
            if (!Input.isDown(b) && !Input._down.get(b)) continue;
            const role = Input.ROLE_OF[b] || null;
            if (!role) continue;
            if (role === 'left') dx -= 1;
            else if (role === 'right') dx += 1;
            else if (role === 'up') { if (Input.plane(name) === 'xy') dy += 1; else dz -= 1; }
            else if (role === 'down') { if (Input.plane(name) === 'xy') dy -= 1; else dz += 1; }
        }
        const v = { x: dx, y: dy, z: dz };
        const l = Coords.len(v);
        return l > 1 ? Coords.scale(v, 1 / l) : v;
    },

    /** Key/mouse bindings that mean a direction (extend at will: Input.ROLE_OF['KeyT'] = 'up'). */
    ROLE_OF: {
        KeyW: 'up', ArrowUp: 'up', Numpad8: 'up',
        KeyS: 'down', ArrowDown: 'down', Numpad2: 'down',
        KeyA: 'left', ArrowLeft: 'left', Numpad4: 'left',
        KeyD: 'right', ArrowRight: 'right', Numpad6: 'right'
    },

    /**
     * Press/release from code (tests, replays, an agent driving the game, touch buttons).
     * A direction binding ('KeyW', 'ArrowLeft'…) also feeds axis(); an action name feeds
     * isDown/pressed for that action.
     */
    simulate(action, down) {
        const name = String(action);
        Input._set(name, !!down);
        for (const [act, bindings] of Input._map) {
            if (!bindings.includes(name)) continue;
            Input._set(act, bindings.some(b => !!Input._down.get(b)));
        }
        return Input.isDown(name);
    },

    /** Which plane an axis action drives: 'xz' (top-down/3D) or 'xy' (side view). */
    setPlane(action, plane) {
        if (plane !== 'xz' && plane !== 'xy' && plane !== 'none') throw new Error('Input.setPlane: xz | xy | none');
        Input._axisPlane.set(String(action), plane);
        return Input.plane(action);
    },

    /** Release everything (scene change, focus loss). */
    clear() {
        for (const k of Input._down.keys()) Input._down.set(k, false);
        Input.pointer.down = false;
    },

    /** on('jump', () => …) — fired on the press edge inside update(). */
    on(action, fn) {
        if (typeof fn !== 'function') throw new Error('Input.on: fn must be a function');
        const list = Input._handlers.get(String(action)) || [];
        list.push(fn);
        Input._handlers.set(String(action), list);
        return () => Input.off(String(action), fn);
    },

    off(action, fn) {
        const list = Input._handlers.get(String(action));
        if (!list) return false;
        const i = fn ? list.indexOf(fn) : 0;
        if (i < 0) return false;
        list.splice(fn ? i : 0, fn ? 1 : list.length);
        return true;
    },

    _frame: 0,

    /** End of frame: edges settle, handlers fire. main.js calls it after the game update. */
    update() {
        Input._frame++;
        for (const [name, fn] of Input._handlers) {
            if (!Input.pressed(name)) continue;
            for (const h of fn.slice()) {
                try { h(name); } catch (e) { console.error('Input.on[' + name + ']:', e); }
            }
        }
        for (const k of Input._down.keys()) Input._prev.set(k, Input._down.get(k));
        if (Input.events.length > 500) Input.events.splice(0, Input.events.length - 500);
        Input.pointer.moved = false;
        return Input._frame;
    },

    // --- pointer ------------------------------------------------------------------------

    /**
     * The presentation layer installs the screen -> world projector (engine/Visual3D.js):
     * Input.pointerWorld() then returns a canonical { x, y, z } without game code knowing
     * the camera, the projection or the profile.
     */
    setWorldProjector(fn) { Input._worldProjector = typeof fn === 'function' ? fn : null; },

    /** The world point under the pointer (null when the projection is not available). */
    pointerWorld() {
        if (typeof Input._worldProjector !== 'function') return null;
        const p = Input._worldProjector(Input.pointer.x, Input.pointer.y);
        return p ? Coords.from(p) : null;
    },

    // --- DOM binding ----------------------------------------------------------------------

    /** Start listening (window by default). Safe headlessly: no DOM, no listeners. */
    attach(target) {
        if (Input._attached) Input.detach();
        const t = target || (typeof window !== 'undefined' ? window : null);
        if (!t || typeof t.addEventListener !== 'function') return false;
        const b = Input._bound = {
            down: (e) => Input._key(e, true),
            up: (e) => Input._key(e, false),
            blur: () => Input.clear(),
            pdown: (e) => Input._pointerEvent(e, true),
            pup: (e) => Input._pointerEvent(e, false),
            pmove: (e) => Input._pointerMove(e)
        };
        t.addEventListener('keydown', b.down);
        t.addEventListener('keyup', b.up);
        t.addEventListener('blur', b.blur);
        t.addEventListener('pointerdown', b.pdown);
        t.addEventListener('pointerup', b.pup);
        t.addEventListener('pointermove', b.pmove);
        Input._attached = t;
        return true;
    },

    detach() {
        const t = Input._attached, b = Input._bound;
        if (!t || !b) return false;
        t.removeEventListener('keydown', b.down);
        t.removeEventListener('keyup', b.up);
        t.removeEventListener('blur', b.blur);
        t.removeEventListener('pointerdown', b.pdown);
        t.removeEventListener('pointerup', b.pup);
        t.removeEventListener('pointermove', b.pmove);
        Input._attached = null;
        Input._bound = null;
        return true;
    },

    _key(e, down) {
        const code = e && e.code ? String(e.code) : null;
        if (!code) return;
        if (Input.ROLE_OF[code]) Input._set(code, down);
        let hit = false;
        // An action is down while ANY of its bindings is down (W and D held = move right-up).
        for (const [action, bindings] of Input._map) {
            if (!bindings.includes(code)) continue;
            hit = true;
            Input._set(action, bindings.some(b => !!Input._down.get(b)));
        }
        // A bound gameplay key must not scroll the page.
        if (hit && typeof e.preventDefault === 'function' && code !== 'F5' && code !== 'F12') e.preventDefault();
    },

    _pointerEvent(e, down) {
        const binding = 'mouse' + (e && e.button != null ? e.button : 0);
        for (const [action, bindings] of Input._map) if (bindings.includes(binding)) Input._set(action, down);
        if (e && e.pointerType === 'touch') {
            for (const [action, bindings] of Input._map) if (bindings.includes('touch')) Input._set(action, down);
        }
        Input.pointer.down = down;
        Input._pointerMove(e);
    },

    _pointerMove(e) {
        if (!e || typeof e.clientX !== 'number') return;
        Input.pointer.x = e.clientX;
        Input.pointer.y = e.clientY;
        Input.pointer.moved = true;
    },

    _set(action, down) {
        const was = !!Input._down.get(action);
        Input._down.set(action, !!down);
        if (was !== !!down) Input.events.push({ action: action, down: !!down, at: Input._frame });
    }
};
