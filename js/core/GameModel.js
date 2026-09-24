// GameModel.js — the canonical game model of the semantic core.
//
//     Game
//      ├── Rules        named parameters and predicates the systems read
//      ├── Systems      ordered update phases (input, logic, resolve, present)
//      ├── World        the logical map (js/core/World.js)
//      ├── Entities     stable logical identities + state (js/core/Entity.js)
//      ├── Scenes       logical scenes, each with an optional presentation preset
//      ├── Assets       semantic asset registry roles (js/presentation/AssetRegistry.js)
//      ├── UI           semantic UI definition (elements, ids, bindings)
//      ├── Audio        cues and channels (js/core/GameAudio.js)
//      ├── Progression  level / xp / unlocks / currencies
//      └── SaveState    the save schema (js/core/Save.js)
//
// The model is built from GAME_SPEC (js/GameSpec.js, shape: manifest/game-schema.json) and
// is renderer-independent: it never mentions a profile except to record WHICH ONE IS
// CURRENTLY PRESENTING it (spec.renderProfile) — and that field is presentation data, not
// gameplay. `gameplayHash()` is the proof a migration uses: it covers everything a visual
// conversion must preserve and nothing that may change.

/** @satisfies {Record<string, any>} */
const GameModel = {
    /** @type {any | null} the live spec (the canon the editor and migrations write) */
    spec: null,
    /** @type {WorldMap | null} */
    world: null,
    /** @type {ArcEntity[]} */
    entities: [],
    /** @type {Map<string, { id: string, phase: string, fn: Function | null, description: string | null, calls: number }>} */
    _systems: new Map(),
    /** @type {Map<string, any>} */
    _rules: new Map(),
    /** @type {string | null} */
    activeScene: null,
    /** @type {any} */
    progression: null,
    _t: 0,

    // --- boot -----------------------------------------------------------------------

    /**
     * Build the model from a spec (GAME_SPEC by default). Idempotent: booting again
     * replaces the model, which is what a migration rollback and a save restore use.
     * @param {any} [spec]
     */
    boot(spec) {
        const s = GameModel.validate(spec || (typeof GAME_SPEC !== 'undefined' ? GAME_SPEC : null));
        GameModel.spec = JSON.parse(JSON.stringify(s));
        GameModel.world = new WorldMap(s.world);
        GameModel.entities = Entity.fromSpec(s.entities || []);
        GameModel.progression = JSON.parse(JSON.stringify(s.progression || { level: 1, xp: 0, unlocks: [], currencies: {} }));
        GameModel._rules = new Map();
        for (const [id, r] of Object.entries(s.rules || {})) GameModel._rules.set(id, Object.assign({ id: id }, r));
        GameModel._systems = new Map();
        for (const sys of s.systems || []) GameModel.system(sys.id, null, sys.phase, sys.description);
        const scenes = GameModel.scenes();
        GameModel.activeScene = (scenes.find(x => x.kind === 'gameplay') || scenes[0] || { id: null }).id;
        GameModel._t = 0;
        return GameModel.inspect();
    },

    /** Drop the model (tests, a migration rollback). */
    reset() {
        GameModel.spec = null; GameModel.world = null; GameModel.entities = [];
        GameModel._systems = new Map(); GameModel._rules = new Map();
        GameModel.progression = null; GameModel.activeScene = null; GameModel._t = 0;
    },

    booted() { return !!GameModel.spec; },

    // --- entities -------------------------------------------------------------------

    /** @param {string} id @returns {ArcEntity | null} */
    entity(id) { return GameModel.entities.find(e => e.id === id) || null; },

    /** Strict variant for game code: throws when the id is unknown (typos must be loud). */
    need(id) {
        const e = GameModel.entity(id);
        if (!e) throw new Error('GameModel: no entity ' + JSON.stringify(id) + ' (GameModel.entities() lists them)');
        return e;
    },

    /**
     * filter — { type?, tag?, scene?, component?, where?: (e) => boolean } or a predicate.
     * @returns {ArcEntity[]}
     */
    find(filter) {
        let list = GameModel.entities;
        if (typeof filter === 'function') return list.filter(filter);
        if (filter) {
            list = list.filter(e =>
                (filter.type == null || e.type === filter.type) &&
                (filter.tag == null || e.hasTag(filter.tag)) &&
                (filter.scene == null || e.scene === filter.scene) &&
                (filter.component == null || e.hasComponent(filter.component)) &&
                (typeof filter.where !== 'function' || !!filter.where(e)));
        }
        return list.slice();
    },

    /** Plain JSON snapshots (what an agent reads). */
    list(filter) { return GameModel.find(filter).map(e => e.snapshot()); },

    /** @param {any} spec @returns {ArcEntity} */
    add(spec) {
        if (!GameModel.spec) throw new Error('GameModel.add: boot a spec first (GameModel.boot())');
        const e = Entity.create(spec);
        if (GameModel.entity(e.id)) throw new Error('GameModel.add: entity ' + JSON.stringify(e.id) + ' already exists');
        GameModel.entities.push(e);
        GameModel.spec.entities = GameModel.spec.entities || [];
        GameModel.spec.entities.push(e.snapshot());
        return e;
    },

    /** @returns {boolean} */
    remove(id) {
        const i = GameModel.entities.findIndex(e => e.id === id);
        if (i < 0) return false;
        GameModel.entities.splice(i, 1);
        if (GameModel.spec && GameModel.spec.entities) {
            const j = GameModel.spec.entities.findIndex(s => s.id === id);
            if (j >= 0) GameModel.spec.entities.splice(j, 1);
        }
        return true;
    },

    /** A logic component on an entity: GameModel.component('player', 'Health'). */
    component(id, name) { return GameModel.need(id).component(name); },

    // --- systems and rules -----------------------------------------------------------

    /**
     * Register (or replace) a system. `fn(dt, model)` runs every frame in phase order
     * (input -> logic -> resolve -> present). fn = null declares the system without an
     * implementation (the spec records it, js/Game.js implements it).
     */
    system(id, fn, phase, description) {
        if (!id) throw new Error('GameModel.system: id is required');
        const p = phase || 'logic';
        if (!GameModel.PHASES.includes(p)) throw new Error('GameModel.system: unknown phase ' + JSON.stringify(p));
        /** @type {{ id: string, phase: string, fn: Function | null, description: string | null, calls: number }} */
        const rec = GameModel._systems.get(id) || { id: String(id), phase: p, fn: null, description: description || null, calls: 0 };
        rec.phase = p;
        if (fn !== undefined) rec.fn = fn;
        if (description != null) rec.description = description;
        GameModel._systems.set(id, rec);
        if (GameModel.spec) {
            GameModel.spec.systems = GameModel.spec.systems || [];
            const s = GameModel.spec.systems.find(x => x.id === id);
            if (s) { s.phase = p; if (description != null) s.description = description; }
            else GameModel.spec.systems.push({ id: id, phase: p, description: description || null });
        }
        return rec;
    },

    offSystem(id) {
        const ok = GameModel._systems.delete(id);
        if (GameModel.spec && GameModel.spec.systems) {
            const i = GameModel.spec.systems.findIndex(x => x.id === id);
            if (i >= 0) GameModel.spec.systems.splice(i, 1);
        }
        return ok;
    },

    /** Declared systems in run order. */
    systems() {
        const order = GameModel.PHASES;
        return [...GameModel._systems.values()].sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase));
    },

    /** Run every implemented system of a phase (or all phases). Returns the count run. */
    run(dt, phase) {
        if (!GameModel.spec) return 0;
        GameModel._t += dt || 0;
        let n = 0;
        for (const s of GameModel.systems()) {
            if (phase && s.phase !== phase) continue;
            if (typeof s.fn !== 'function') continue;
            try { s.fn(dt || 0, GameModel); s.calls++; n++; }
            catch (e) { console.error('GameModel.system[' + s.id + ']:', e); }
        }
        return n;
    },

    /** A named rule: GameModel.rule('combat.damage') -> { id, description, params }. */
    rule(id, def) {
        if (def !== undefined) {
            GameModel._rules.set(id, Object.assign({ id: id }, def));
            if (GameModel.spec) {
                GameModel.spec.rules = GameModel.spec.rules || {};
                GameModel.spec.rules[id] = Object.assign({ id: id }, def);
            }
        }
        return GameModel._rules.get(id) || null;
    },

    rules() {
        const out = {};
        for (const [id, r] of GameModel._rules) out[id] = JSON.parse(JSON.stringify(r));
        return out;
    },

    /** Read a rule parameter with a default: GameModel.param('combat.damage', 'base', 10). */
    param(ruleId, key, fallback) {
        const r = GameModel._rules.get(ruleId);
        const v = r && r.params ? r.params[key] : undefined;
        return v === undefined ? fallback : v;
    },

    time() { return GameModel._t; },

    // --- scenes ----------------------------------------------------------------------

    scenes() { return JSON.parse(JSON.stringify((GameModel.spec && GameModel.spec.scenes) || [])); },

    /** @returns {any | null} */
    scene(id) { return GameModel.scenes().find(s => s.id === id) || null; },

    setActiveScene(id) {
        if (id != null && !GameModel.scene(id)) throw new Error('GameModel.setActiveScene: unknown scene ' + JSON.stringify(id));
        GameModel.activeScene = id || null;
        return GameModel.activeScene;
    },

    /** Entities of a scene (a scene without an entity list owns them all). */
    sceneEntities(id) {
        const s = GameModel.scene(id || GameModel.activeScene);
        if (!s || !s.entities || !s.entities.length) return GameModel.entities.slice();
        return GameModel.entities.filter(e => s.entities.includes(e.id));
    },

    /**
     * The presentation preset of a scene: its own renderProfile when it declares one,
     * otherwise the project profile. Read by RenderProfile.forScene(id).
     */
    sceneProfile(id) {
        const s = GameModel.scene(id || GameModel.activeScene);
        if (s && s.renderProfile) return s.renderProfile;
        return GameModel.renderProfile();
    },

    setSceneProfile(id, profileId) {
        const s = (GameModel.spec.scenes || []).find(x => x.id === id);
        if (!s) throw new Error('GameModel.setSceneProfile: unknown scene ' + JSON.stringify(id));
        if (profileId != null && !GameModel.profiles().includes(profileId)) throw new Error('GameModel.setSceneProfile: unknown profile ' + JSON.stringify(profileId));
        s.renderProfile = profileId || null;
        return s.renderProfile;
    },

    // --- profile (recorded here, owned by the presentation layer) ----------------------

    /** The project's current render profile id. */
    renderProfile() { return (GameModel.spec && GameModel.spec.renderProfile) || GameModel.profiles()[0]; },

    setRenderProfile(id, reason) {
        if (!GameModel.profiles().includes(id)) throw new Error('GameModel.setRenderProfile: unknown profile ' + JSON.stringify(id));
        if (!GameModel.spec) throw new Error('GameModel.setRenderProfile: boot a spec first');
        GameModel.spec.renderProfile = id;
        if (reason != null) GameModel.spec.renderProfileReason = String(reason);
        return id;
    },

    /** Why the current profile was chosen (the AI decision record). */
    renderProfileReason() { return (GameModel.spec && GameModel.spec.renderProfileReason) || null; },

    /** Profile ids in ladder order (canon: manifest/render-profiles.json). */
    profiles() { return typeof RENDER_PROFILES !== 'undefined' ? RENDER_PROFILES.order.slice() : ['2d', '2.5d', 'isometric3d', 'lowpoly3d', 'full3d']; },

    // --- validation and introspection -------------------------------------------------

    /** Validate a spec against the canonical shape; returns the normalized spec. */
    validate(spec) {
        const s = spec || null;
        if (!s || typeof s !== 'object') throw new Error('GameModel: a spec object is required (js/GameSpec.js declares GAME_SPEC)');
        if (typeof s.id !== 'string' || !s.id) throw new Error('GameModel: spec.id is required');
        if (typeof s.title !== 'string' || !s.title) throw new Error('GameModel: spec.title is required');
        const profiles = typeof RENDER_PROFILES !== 'undefined' ? RENDER_PROFILES.order : GameModel.profiles();
        if (!profiles.includes(s.renderProfile)) {
            throw new Error('GameModel: spec.renderProfile must be one of ' + profiles.join(', ') + ', got ' + JSON.stringify(s.renderProfile));
        }
        if (!s.world || typeof s.world !== 'object') throw new Error('GameModel: spec.world is required');
        World.validate(s.world);
        const ids = new Set();
        for (const e of s.entities || []) {
            Entity.validate(e);
            if (ids.has(e.id)) throw new Error('GameModel: duplicate entity id ' + JSON.stringify(e.id));
            ids.add(e.id);
        }
        const sceneIds = new Set();
        for (const sc of s.scenes || []) {
            if (!sc.id) throw new Error('GameModel: every scene needs an id');
            if (sceneIds.has(sc.id)) throw new Error('GameModel: duplicate scene id ' + JSON.stringify(sc.id));
            sceneIds.add(sc.id);
            if (sc.renderProfile != null && !profiles.includes(sc.renderProfile)) {
                throw new Error('GameModel: scene ' + sc.id + ' has an unknown renderProfile ' + JSON.stringify(sc.renderProfile));
            }
            for (const eid of sc.entities || []) {
                if (!ids.has(eid)) throw new Error('GameModel: scene ' + sc.id + ' references an unknown entity ' + JSON.stringify(eid));
            }
        }
        for (const e of s.entities || []) {
            if (e.scene && !sceneIds.has(e.scene)) throw new Error('GameModel: entity ' + e.id + ' references an unknown scene ' + JSON.stringify(e.scene));
        }
        for (const sys of s.systems || []) {
            if (!sys.id) throw new Error('GameModel: every system needs an id');
            if (sys.phase && !GameModel.PHASES.includes(sys.phase)) throw new Error('GameModel: system ' + sys.id + ' has an unknown phase ' + sys.phase);
        }
        if (s.saveState && s.saveState.schemaVersion != null && !(Number(s.saveState.schemaVersion) >= 1)) {
            throw new Error('GameModel: saveState.schemaVersion must be >= 1');
        }
        return s;
    },

    PHASES: ['input', 'logic', 'resolve', 'present'],

    /** The whole model as a spec (what the editor writes into js/GameSpec.js). */
    toSpec() {
        if (!GameModel.spec) return null;
        const s = JSON.parse(JSON.stringify(GameModel.spec));
        s.entities = GameModel.entities.map(e => e.snapshot());
        s.world = GameModel.world ? GameModel.world.toSpec() : s.world;
        s.progression = JSON.parse(JSON.stringify(GameModel.progression || {}));
        s.rules = GameModel.rules();
        s.systems = GameModel.systems().map(x => ({ id: x.id, phase: x.phase, description: x.description }));
        return s;
    },

    /**
     * Everything a visual migration must preserve, in one deterministic string:
     * rules, system ids/order, world (tiles, zones, triggers, spawns, props, height),
     * entity ids/types/tags/logic/components/transforms, scenes (ids, entities, ui),
     * progression, input actions, audio cues and the save schema.
     * Visual blocks, the profile id, camera/lighting and asset paths are NOT part of it.
     */
    gameplayDigest() {
        const s = GameModel.spec;
        if (!s) return null;
        const ents = GameModel.entities.map(e => ({
            id: e.id, type: e.type, tags: e.tags.slice().sort(), scene: e.scene,
            position: e.position, rotation: e.rotation,
            logic: e.logic, components: e.components
        })).sort((a, b) => (a.id < b.id ? -1 : 1));
        const scenes = (s.scenes || []).map(x => ({ id: x.id, kind: x.kind || 'gameplay', entities: (x.entities || []).slice(), ui: (x.ui || []).slice() }))
            .sort((a, b) => (a.id < b.id ? -1 : 1));
        const payload = {
            id: s.id,
            rules: GameModel.rules(),
            systems: GameModel.systems().map(x => x.id + ':' + x.phase),
            world: GameModel.world ? GameModel.world.toSpec() : null,
            entities: ents,
            scenes: scenes,
            progression: GameModel.progression,
            input: s.input || null,
            audio: (s.audio && s.audio.cues ? s.audio.cues.map(c => c.id).sort() : null),
            saveSchema: Save.schema()
        };
        return payload;
    },

    /** FNV-1a over the digest: one string to compare before/after a migration. */
    gameplayHash() {
        const d = GameModel.gameplayDigest();
        if (!d) return null;
        return GameModel.hash(JSON.stringify(d));
    },

    /**
     * The game CONTRACT digest: what makes this project THIS game — and nothing that changes
     * while it is played. gameplayDigest() deliberately includes live state (positions, logic,
     * progression): that is what a migration must preserve inside one session. It is therefore
     * the WRONG thing to compare across instances — a game that mirrors its simulation into the
     * model (the normal case: js/Game.js follows js/Logic.js) has a different live hash in every
     * tab and at every frame.
     *
     * contractHash() is the cross-instance invariant: five variants of one project, five tabs,
     * five minutes apart, one contract. It covers the spec as authored: rules, systems, the world
     * definition, entity identities (id/type/tags/scene/visual role — never their live state),
     * scenes, asset roles, input actions, audio cue ids and the save schema.
     */
    contractDigest() {
        const s = GameModel.spec;
        if (!s) return null;
        const ents = (s.entities || []).map(e => ({
            id: e.id, type: e.type, tags: (e.tags || []).slice().sort(), scene: e.scene || null,
            role: (e.visual && e.visual.role) || null,
            representation: (e.visual && e.visual.representation) || null
        })).sort((a, b) => (a.id < b.id ? -1 : 1));
        const scenes = (s.scenes || []).map(x => ({ id: x.id, kind: x.kind || 'gameplay', entities: (x.entities || []).slice(), ui: (x.ui || []).slice() }))
            .sort((a, b) => (a.id < b.id ? -1 : 1));
        const rules = Object.keys(s.rules || {}).sort()
            .map(id => [id, JSON.stringify((s.rules[id] && s.rules[id].params) || {})]);
        return {
            id: s.id,
            specVersion: s.specVersion || 1,
            rules: rules,
            systems: (s.systems || []).map(x => x.id + ':' + (x.phase || 'logic')),
            // the world AS AUTHORED: the live WorldMap may have tiles a system wrote mid-run
            world: s.world || null,
            entities: ents,
            scenes: scenes,
            roles: (s.assets || []).map(a => a.role).sort(),
            input: (s.input && s.input.actions) ? Object.keys(s.input.actions).sort() : null,
            audio: (s.audio && s.audio.cues) ? s.audio.cues.map(c => c.id).sort() : null,
            saveSchema: Save.schema()
        };
    },

    /** FNV-1a over the contract digest: stable across instances, variants and play. */
    contractHash() {
        const d = GameModel.contractDigest();
        if (!d) return null;
        return GameModel.hash(JSON.stringify(d));
    },

    /** Deterministic 32-bit FNV-1a of a string, as 8 hex digits. */
    hash(str) {
        let h = 0x811c9dc5;
        const s = String(str);
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ('0000000' + h.toString(16)).slice(-8);
    },

    /** Machine-readable summary for agents, the editor and the migration plan. */
    inspect() {
        const s = GameModel.spec;
        if (!s) return { booted: false };
        const byType = {};
        for (const e of GameModel.entities) byType[e.type] = (byType[e.type] || 0) + 1;
        return {
            booted: true,
            id: s.id,
            title: s.title,
            specVersion: s.specVersion || 1,
            renderProfile: GameModel.renderProfile(),
            renderProfileReason: GameModel.renderProfileReason(),
            entities: GameModel.entities.length,
            entitiesByType: byType,
            entityIds: GameModel.entities.map(e => e.id),
            rules: Object.keys(GameModel.rules()),
            systems: GameModel.systems().map(x => ({ id: x.id, phase: x.phase, implemented: typeof x.fn === 'function' })),
            scenes: GameModel.scenes().map(x => ({ id: x.id, kind: x.kind || 'gameplay', renderProfile: x.renderProfile || null })),
            activeScene: GameModel.activeScene,
            world: GameModel.world ? GameModel.world.inspect() : null,
            assets: (s.assets || []).length,
            ui: s.ui && s.ui.elements ? s.ui.elements.length : 0,
            audio: s.audio && s.audio.cues ? s.audio.cues.length : 0,
            progression: JSON.parse(JSON.stringify(GameModel.progression || {})),
            saveState: Save.schema(),
            gameplayHash: GameModel.gameplayHash(),
            migrations: (s.visualMigrationJournal || []).length
        };
    }
};
