// Variant.js — the variant half of the presentation layer.
//
//     Profile != Variant.
//
//     PROFILE  (manifest/render-profiles.json) — a TYPE of presentation: capabilities,
//              camera defaults, representations, lighting, budget, fallback rules.
//     VARIANT  (presentation/variants/<id>.json) — one CONCRETE presentation of ONE game:
//              a profile + project-specific overrides (camera, lighting, visual mappings,
//              materials, environment, animation, UI presentation, effects, performance).
//
// One Master Project, one Game Model, many variants:
//
//     Variant.list()                       // every presentation of this game
//     Variant.current()                    // the one this runtime instance presents
//     Variant.activate('robot-full3d')     // switch presentation, gameplay untouched
//     Variant.createFromProfile('full3d')  // "Create All Visual Variants", one per profile
//     Variant.convert({ source, target })  // NON-DESTRUCTIVE: the source variant stays
//     Variant.compare('robot-2d', 'robot-full3d')
//     Variant.effective('robot-full3d')    // profile defaults <- variant overrides <- scene
//
// A variant is CONFIGURATION, never a copy: nothing here duplicates game/, entities,
// systems or the world. Converting 2D -> Full 3D creates a variant; the 2D one survives.

/** @typedef {any} ArcVariant */

/** @satisfies {Record<string, any>} */
const Variant = {
    /** @type {Map<string, ArcVariant>} variant id -> config */
    _variants: new Map(),
    /** @type {Map<string, any>} mapping set name -> { role: { profile: { type, asset } } } */
    _mappings: new Map(),
    /** @type {Map<string, any>} preset name -> { camera?, lighting?, environment? } */
    _presets: new Map(),
    /** @type {any | null} the master project descriptor (project.json) */
    project: null,
    /** @type {string | null} */
    _current: null,
    /** @type {Map<string, any>} variant-local runtime/editor state (never gameplay) */
    _state: new Map(),
    /** Every activation/creation/conversion, newest last. */
    journal: [],
    JOURNAL_MAX: 200,

    // --- boot ------------------------------------------------------------------------------

    /**
     * Load the project + variants. data — the generated js/presentation/Variants.js
     * ({ project, variants, mappings, presets }) or a plain object with those keys.
     */
    boot(data) {
        const d = data || (typeof PROJECT_VARIANTS !== 'undefined' ? PROJECT_VARIANTS : null) || {};
        Variant.project = d.project ? JSON.parse(JSON.stringify(d.project)) : Variant._projectFromSpec();
        Variant._variants.clear();
        Variant._mappings.clear();
        Variant._presets.clear();
        Variant._state.clear();
        for (const [name, set] of Object.entries(d.mappings || {})) Variant._mappings.set(name, JSON.parse(JSON.stringify(set)));
        for (const [name, preset] of Object.entries(d.presets || {})) Variant._presets.set(name, JSON.parse(JSON.stringify(preset)));
        for (const [id, v] of Object.entries(d.variants || {})) Variant._put(Variant.normalize(v, id));
        // The persisted VisualMigrationJournal (presentation/migration-journal.json, written
        // by tools/variants.mjs) seeds the spec, so a browser session sees the project's
        // conversion history without reading a file.
        if (Array.isArray(d.journal) && GameModel.booted()) {
            GameModel.spec.visualMigrationJournal = JSON.parse(JSON.stringify(d.journal)).slice(-100);
        }
        if (!Variant._variants.size && GameModel.booted()) Variant.createAll({ silent: true });
        return Variant.list().length;
    },

    /** A project descriptor derived from GAME_SPEC when project.json was not generated. */
    _projectFromSpec() {
        const s = GameModel.booted() ? GameModel.spec : (typeof GAME_SPEC !== 'undefined' ? GAME_SPEC : null);
        return {
            id: (s && s.id) || 'arcengine',
            name: (s && s.title) || 'ArcEngine project',
            kit: 'ArcEngine',
            schemaVersion: 1,
            defaultVariant: null,
            profiles: RenderProfile.ids(),
            variants: [],
            gameModel: 'js/GameSpec.js',
            assetRegistry: 'GAME_SPEC.assets + presentation/mappings/*.json'
        };
    },

    /** Validate + normalize a variant config (manifest/variant-schema.json#/definitions/variant). */
    normalize(v, id) {
        const rec = JSON.parse(JSON.stringify(v || {}));
        rec.id = String(rec.id || id || '');
        if (!Variant.ID.test(rec.id)) throw new Error('Variant: id must match ' + Variant.ID + ', got ' + JSON.stringify(rec.id));
        if (!RenderProfile.isKnown(rec.profile)) {
            throw new Error('Variant ' + rec.id + ': unknown profile ' + JSON.stringify(rec.profile) + ' (known: ' + RenderProfile.ids().join(', ') + ')');
        }
        rec.name = rec.name || Variant.defaultName(rec.id, rec.profile);
        rec.enabled = rec.enabled !== false;
        rec.createdBy = rec.createdBy || 'author';
        rec.createdFrom = rec.createdFrom || null;
        if (rec.camera && rec.camera.mode && !Variant.CAMERA_MODES.includes(rec.camera.mode)) {
            throw new Error('Variant ' + rec.id + ': unknown camera mode ' + JSON.stringify(rec.camera.mode));
        }
        if (rec.performance && typeof RenderProfile !== 'undefined') {
            const budget = RenderProfile.budget(rec.profile);
            for (const [k, val] of Object.entries(rec.performance)) {
                if (typeof budget[k] === 'number' && typeof val === 'number' && val > budget[k]) {
                    throw new Error('Variant ' + rec.id + ': performance.' + k + ' ' + val + ' loosens the ' + rec.profile + ' budget (' + budget[k] + ') — a variant may only tighten it');
                }
            }
        }
        return rec;
    },

    ID: /^[a-z0-9][a-z0-9.-]{1,47}$/,
    CAMERA_MODES: ['topdown', 'side', 'platformer', 'isometric', 'thirdPerson', 'firstPerson', 'free', 'orbit'],

    defaultName(id, profileId) {
        const title = (GameModel.booted() && GameModel.spec.title) || (Variant.project && Variant.project.name) || 'Game';
        const p = RenderProfile.isKnown(profileId) ? RenderProfile.info(profileId).name : profileId;
        return title + ' — ' + p;
    },

    _put(rec) { Variant._variants.set(rec.id, rec); return rec; },

    // --- queries ------------------------------------------------------------------------------

    /** Every variant as plain data, in creation order. */
    list() { return [...Variant._variants.values()].map(v => JSON.parse(JSON.stringify(v))); },

    ids() { return [...Variant._variants.keys()]; },

    has(id) { return Variant._variants.has(String(id)); },

    /** @returns {ArcVariant | null} */
    get(id) { const v = Variant._variants.get(String(id)); return v ? JSON.parse(JSON.stringify(v)) : null; },

    /** The first enabled variant of a profile (null when the project has none). */
    forProfile(profileId) {
        return Variant.list().find(v => v.profile === profileId && v.enabled) || null;
    },

    /** The variants of a profile (a project may keep several: Pixel and Neon, both 2D). */
    allForProfile(profileId) { return Variant.list().filter(v => v.profile === profileId); },

    current() { return Variant._current ? Variant.get(Variant._current) : null; },

    currentId() { return Variant._current; },

    defaultId() {
        const d = Variant.project && Variant.project.defaultVariant;
        if (d && Variant.has(d)) return d;
        const first = Variant.list().find(v => v.enabled);
        return first ? first.id : null;
    },

    /** The profile of a variant (or of the active one). */
    profileOf(id) { const v = Variant.get(id || Variant._current); return v ? v.profile : null; },

    // --- creation -----------------------------------------------------------------------------

    /**
     * Create a variant. def — { id, profile, name?, camera?, lighting?, visualMappings?,
     * overrides… }. Creating never touches another variant and never touches gameplay.
     */
    create(def, opts) {
        const o = opts || {};
        const rec = Variant.normalize(def, def && def.id);
        if (Variant.has(rec.id) && !o.replace) throw new Error('Variant.create: ' + rec.id + ' already exists (pass { replace: true } to update it)');
        if (o.mapping && typeof o.mapping === 'object') Variant._mappings.set(Variant.mappingName(rec.id), JSON.parse(JSON.stringify(o.mapping)));
        Variant._put(rec);
        if (Variant.project) {
            Variant.project.variants = Variant.ids();
            if (!Variant.project.defaultVariant) Variant.project.defaultVariant = rec.id;
        }
        Variant._record('create', { variant: rec.id, profile: rec.profile, by: rec.createdBy, from: rec.createdFrom });
        return Variant.get(rec.id);
    },

    /** Create (or reuse) the variant that presents the game with a profile. */
    createFromProfile(profileId, opts) {
        const o = opts || {};
        if (!RenderProfile.isKnown(profileId)) throw new Error('Variant.createFromProfile: unknown profile ' + JSON.stringify(profileId));
        const existing = o.reuse === false ? null : Variant.forProfile(profileId);
        if (existing && !o.id) return existing;
        const id = String(o.id || Variant.idFor(profileId));
        if (Variant.has(id)) return Variant.get(id);
        return Variant.create({
            id: id,
            profile: profileId,
            name: o.name || Variant.defaultName(id, profileId),
            description: o.reason || ('Created from the ' + profileId + ' profile defaults'),
            createdBy: o.by || 'agent',
            createdFrom: o.from || Variant.currentId()
        }, { mapping: o.mapping });
    },

    /** The canonical variant id of a profile: <project>-<profile>. */
    idFor(profileId) {
        const base = (Variant.project && Variant.project.id) || (GameModel.booted() ? GameModel.spec.id : 'game');
        return String(base + '-' + profileId).replace(/[^a-z0-9.-]+/g, '-').toLowerCase().slice(0, 48);
    },

    /**
     * "Create All Visual Variants": one variant per profile, all pointing at the same Game
     * Model. Idempotent — an existing variant is kept as it is.
     */
    createAll(opts) {
        const o = opts || {};
        const created = [];
        for (const pid of RenderProfile.ids()) {
            const have = Variant.forProfile(pid);
            if (have) { created.push({ id: have.id, profile: pid, existed: true }); continue; }
            const v = Variant.createFromProfile(pid, { by: o.by || 'agent', from: o.from || Variant.currentId() });
            created.push({ id: v.id, profile: pid, existed: false });
        }
        if (!o.silent) Variant._record('create-all', { variants: created.map(c => c.id), by: o.by || 'agent' });
        return created;
    },

    /**
     * Clone a variant CONFIGURATION (never the game): a new id/name, the same profile and
     * overrides, ready to diverge. `Game.variant.clone()` in the spec is this method.
     */
    clone(id, newId, opts) {
        const src = Variant.get(id);
        if (!src) throw new Error('Variant.clone: unknown variant ' + JSON.stringify(id));
        const o = opts || {};
        const rec = JSON.parse(JSON.stringify(src));
        rec.id = String(newId || (id + '-copy'));
        rec.name = o.name || (src.name + ' (copy)');
        rec.createdBy = 'clone';
        rec.createdFrom = id;
        rec.state = null;
        delete rec.state;
        const created = Variant.create(rec, { replace: !!o.replace });
        // the clone gets its own copy of the source's visual mappings
        const srcMap = Variant.mappingName(id);
        if (Variant._mappings.has(srcMap)) Variant._mappings.set(Variant.mappingName(created.id), JSON.parse(JSON.stringify(Variant._mappings.get(srcMap))));
        Variant._record('clone', { variant: created.id, from: id });
        return created;
    },

    /**
     * Remove a variant. This is the ONLY destructive variant operation and it is never part
     * of a conversion: convert() creates, it does not replace (spec: "Source Variant is
     * preserved after conversion").
     */
    remove(id) {
        const vid = String(id);
        if (!Variant._variants.has(vid)) return false;
        if (Variant._variants.size === 1) throw new Error('Variant.remove: ' + vid + ' is the last variant of the project — a project always presents its game somehow');
        Variant._variants.delete(vid);
        Variant._mappings.delete(Variant.mappingName(vid));
        Variant._state.delete(vid);
        if (Variant._current === vid) Variant._current = Variant.defaultId();
        if (Variant.project) Variant.project.variants = Variant.ids();
        Variant._record('remove', { variant: vid });
        return true;
    },

    /** Enable/disable a variant (disabled ones are skipped by run --all and validate --all). */
    setEnabled(id, on) {
        const rec = Variant._variants.get(String(id));
        if (!rec) throw new Error('Variant.setEnabled: unknown variant ' + JSON.stringify(id));
        rec.enabled = on !== false;
        Variant._record('enable', { variant: rec.id, enabled: rec.enabled });
        return rec.enabled;
    },

    /**
     * Convert a variant into another profile. NON-DESTRUCTIVE by default: the source
     * variant stays, the target is created from the same Game Model, and the migration
     * journal records it. `Game.variant.convert()` in the spec is this method.
     * opts — { source, target?, profile?, name?, dryRun?, preserveSource?, by? }.
     */
    convert(opts) {
        if (typeof Migration === 'undefined') throw new Error('Variant.convert: js/presentation/Migration.js is not loaded');
        return Migration.convert(opts);
    },

    /**
     * Compare two variants: what is SHARED (all of it — one Game Model) and how the
     * presentation differs. This is the answer to "what changes if I go 3D?".
     */
    compare(a, b) {
        const va = Variant.get(a), vb = Variant.get(b);
        if (!va) throw new Error('Variant.compare: unknown variant ' + JSON.stringify(a));
        if (!vb) throw new Error('Variant.compare: unknown variant ' + JSON.stringify(b));
        const FIELDS = ['camera', 'lighting', 'materials', 'environment', 'animation', 'ui', 'audio', 'effects', 'performance', 'visualMappings'];
        const diffs = [];
        if (va.profile !== vb.profile) diffs.push({ field: 'profile', a: va.profile, b: vb.profile });
        for (const f of FIELDS) {
            const x = JSON.stringify(va[f] == null ? null : va[f]);
            const y = JSON.stringify(vb[f] == null ? null : vb[f]);
            if (x !== y) diffs.push({ field: f, a: va[f] != null ? va[f] : RenderProfile.defaultsFor(va.profile)[f] || null, b: vb[f] != null ? vb[f] : RenderProfile.defaultsFor(vb.profile)[f] || null });
        }
        const missing = [];
        if (typeof AssetRegistry !== 'undefined') {
            for (const role of AssetRegistry.digest()) {
                const ra = AssetRegistry.resolve(role, va.profile);
                const rb = AssetRegistry.resolve(role, vb.profile);
                if (ra.missing || rb.missing) missing.push({ role: role, a: ra.resolvedBy, b: rb.resolvedBy });
            }
        }
        return {
            a: a, b: b,
            profiles: { a: va.profile, b: vb.profile },
            shared: ['gameplay', 'gameModel', 'world', 'entityIds', 'rules', 'systems', 'quests', 'combat', 'inventory', 'progression', 'saveSchema', 'assetRegistry', 'inputActions', 'audioCues', 'uiDefinition'],
            presentationDifferences: diffs,
            missing: missing,
            sameGameplay: true,
            sameEntityIds: true,
            sameSaveSchema: true,
            gameplayHash: GameModel.booted() ? GameModel.gameplayHash() : null,
            note: 'Both variants present ONE Game Model: nothing under game/ differs, only presentation configuration does.'
        };
    },

    // --- activation ----------------------------------------------------------------------------

    /**
     * Make a variant the presented one. Gameplay, entities and the world are untouched;
     * the presentation (camera, lighting, world look, visuals, UI, input planes) is
     * re-applied. opts — { apply: false } only switches the bookkeeping.
     */
    activate(id, opts) {
        const o = opts || {};
        const v = Variant.get(id);
        if (!v) throw new Error('Variant.activate: unknown variant ' + JSON.stringify(id) + ' (Variant.list() shows them)');
        if (v.enabled === false) throw new Error('Variant.activate: ' + id + ' is disabled');
        const prev = Variant._current;
        Variant._current = v.id;
        if (Variant.project) Variant.project.activeVariant = v.id;
        RenderProfile._activeVariant = v.id;
        Variant.applyMappings(v.id);
        if (GameModel.booted()) GameModel.setRenderProfile(v.profile, v.description || GameModel.renderProfileReason());
        Variant._record('activate', { variant: v.id, profile: v.profile, from: prev });
        if (o.apply === false) return { ok: true, deferred: true, variant: v.id, profile: v.profile };
        return RenderProfile.apply(Object.assign({ sceneId: o.sceneId }, o));
    },

    /** The variant-local overlay of the shared asset registry (visualMappings). */
    applyMappings(id) {
        const v = Variant.get(id);
        if (!v) return null;
        const name = typeof v.visualMappings === 'string' ? v.visualMappings.replace(/^.*\//, '').replace(/\.json$/, '') : Variant.mappingName(id);
        const map = (typeof v.visualMappings === 'object' && v.visualMappings) ? v.visualMappings : (Variant._mappings.get(name) || null);
        if (typeof AssetRegistry !== 'undefined') AssetRegistry.setOverlay(map, name);
        return map ? Object.keys(map).length : 0;
    },

    mappingName(id) { return String(id); },

    /** Register/replace a mapping set (the editor and tools/variants.mjs write it to disk). */
    setMappings(name, map) {
        Variant._mappings.set(String(name), JSON.parse(JSON.stringify(map || {})));
        if (Variant._current && (Variant.mappingName(Variant._current) === String(name))) Variant.applyMappings(Variant._current);
        return Variant._mappings.get(String(name));
    },

    mappings(name) {
        const n = name || (Variant._current ? Variant.mappingName(Variant._current) : null);
        const m = n ? Variant._mappings.get(String(n)) : null;
        return m ? JSON.parse(JSON.stringify(m)) : null;
    },

    mappingNames() { return [...Variant._mappings.keys()]; },

    preset(name) { const p = Variant._presets.get(String(name)); return p ? JSON.parse(JSON.stringify(p)) : null; },

    presets() { return [...Variant._presets.keys()]; },

    setPreset(name, def) { Variant._presets.set(String(name), JSON.parse(JSON.stringify(def || {}))); return Variant.preset(name); },

    // --- effective configuration -----------------------------------------------------------------

    /**
     * Profile defaults <- preset <- variant overrides <- scene preset: the ONE config the
     * presentation layer applies. Inheritance is exactly `Profile -> Variant -> Overrides`.
     */
    effective(id, sceneId) {
        const vid = id || Variant._current;
        const v = Variant.get(vid);
        if (!v) return RenderProfile.defaultsFor(RenderProfile.id(), sceneId);
        const cfg = RenderProfile.defaultsFor(v.profile);
        cfg.variant = v.id;
        cfg.variantName = v.name;
        const preset = Variant._resolvePreset(v);
        const merge = (dst, src) => { for (const [k, val] of Object.entries(src || {})) if (val !== undefined && val !== null) dst[k] = val; return dst; };
        merge(cfg.camera, preset.camera);
        merge(cfg.camera, v.camera);
        merge(cfg.lighting, preset.lighting);
        merge(cfg.lighting, v.lighting);
        merge(cfg.world, preset.environment);
        merge(cfg.world, v.environment);
        merge(cfg.materials, v.materials);
        merge(cfg.animation, v.animation);
        merge(cfg.ui, v.ui);
        merge(cfg.audio, v.audio);
        merge(cfg.effects, preset.effects);
        merge(cfg.effects, v.effects);
        // a variant may only TIGHTEN the budget
        for (const [k, val] of Object.entries(v.performance || {})) if (typeof val === 'number') cfg.performance[k] = Math.min(cfg.performance[k] == null ? val : cfg.performance[k], val);
        cfg.scenes = Object.assign({}, v.scenes || {});
        // a scene preset of this variant (MainMenu 2D inside a full3d variant, a map view…)
        const sid = sceneId || (GameModel.booted() ? GameModel.activeScene : null);
        if (sid && cfg.scenes[sid]) {
            const sc = cfg.scenes[sid];
            merge(cfg.camera, sc.camera);
            merge(cfg.lighting, sc.lighting);
            merge(cfg.ui, sc.ui);
            cfg.scene = sid;
        }
        if (!cfg.camera.follow && GameModel.booted()) {
            const players = GameModel.find({ type: 'character' });
            if (players.length) cfg.camera.follow = players[0].id;
        }
        return cfg;
    },

    _resolvePreset(v) {
        const out = { camera: null, lighting: null, environment: null, effects: null };
        const names = [];
        if (v.camera && v.camera.preset) names.push(v.camera.preset);
        if (v.lighting && v.lighting.preset && Variant._presets.has(v.lighting.preset)) names.push(v.lighting.preset);
        for (const n of names) {
            const p = Variant._presets.get(n);
            if (!p) continue;
            for (const k of Object.keys(out)) if (p[k]) out[k] = Object.assign({}, out[k], p[k]);
        }
        return out;
    },

    // --- variant-local state (§ never a copy of the Game Model) ----------------------------------

    /** Camera/selection/scroll state of one variant. Gameplay never lives here. */
    state(id, patch) {
        const vid = String(id || Variant._current || '');
        const cur = Variant._state.get(vid) || {};
        if (patch === undefined) return JSON.parse(JSON.stringify(cur));
        Object.assign(cur, JSON.parse(JSON.stringify(patch)));
        Variant._state.set(vid, cur);
        const rec = Variant._variants.get(vid);
        if (rec) rec.state = JSON.parse(JSON.stringify(cur));
        return JSON.parse(JSON.stringify(cur));
    },

    clearState(id) { return Variant._state.delete(String(id || Variant._current || '')); },

    // --- validation -------------------------------------------------------------------------------

    /**
     * Validate one variant: the profile exists, its adapter is loaded, the camera mode is
     * allowed by the profile, the budget is not loosened, every visual role resolves in this
     * profile (a placeholder counts as resolved, but is reported), and the shared model is
     * intact (entity ids, gameplay hash, save schema).
     */
    validate(id) {
        const v = Variant.get(id);
        const problems = [];
        const warnings = [];
        if (!v) return { ok: false, variant: id, problems: ['unknown variant'], warnings: [] };
        const p = RenderProfile.isKnown(v.profile) ? RenderProfile.info(v.profile) : null;
        if (!p) problems.push('profile ' + JSON.stringify(v.profile) + ' is not in manifest/render-profiles.json');
        else {
            if (v.camera && v.camera.mode && !(p.camera.modes || []).includes(v.camera.mode)) {
                problems.push('camera mode ' + v.camera.mode + ' is not allowed by the ' + v.profile + ' profile (' + (p.camera.modes || []).join(', ') + ')');
            }
            if (v.camera && v.camera.mode && RenderProfile.manifest().cameraModes[v.camera.mode] &&
                RenderProfile.manifest().cameraModes[v.camera.mode].projection !== p.projection) {
                problems.push('camera mode ' + v.camera.mode + ' is ' + RenderProfile.manifest().cameraModes[v.camera.mode].projection + ', the profile is ' + p.projection);
            }
        }
        if (!ArcProfiles.has(v.profile)) warnings.push('no adapter loaded for profile ' + v.profile + ' (js/profiles/' + v.profile + '/profile.js)');
        if (typeof AssetRegistry !== 'undefined') {
            const missing = AssetRegistry.missing(v.profile);
            for (const m of missing) warnings.push('asset ' + m.role + ': ' + m.resolvedBy + (m.asset ? ' (' + m.asset + ')' : ''));
        }
        if (GameModel.booted()) {
            const budget = RenderProfile.checkBudget(v.profile, Variant.effective(v.id));
            for (const w of budget.warnings) warnings.push('budget: ' + w);
        }
        return {
            ok: !problems.length, variant: v.id, profile: v.profile, name: v.name,
            problems: problems, warnings: warnings,
            shared: {
                entityIds: GameModel.booted() ? GameModel.entities.length : 0,
                gameplayHash: GameModel.booted() ? GameModel.gameplayHash() : null,
                saveSchemaHash: GameModel.booted() ? Save.schemaHash() : null
            }
        };
    },

    /** Validate every enabled variant; one result each (validate --project X --all). */
    validateAll(opts) {
        const o = opts || {};
        const out = [];
        for (const v of Variant.list()) {
            if (v.enabled === false && !o.includeDisabled) continue;
            out.push(Variant.validate(v.id));
        }
        return { ok: out.every(r => r.ok), variants: out, count: out.length };
    },

    // --- serialization -----------------------------------------------------------------------------

    /** The variant configs as they are written to presentation/variants/*.json. */
    toSpec() {
        const out = {};
        for (const [id, v] of Variant._variants) {
            const rec = JSON.parse(JSON.stringify(v));
            delete rec.state;
            out[id] = rec;
        }
        return out;
    },

    /** Everything the tooling writes: project.json + variants + mappings + presets. */
    exportAll() {
        return {
            project: Variant.project ? JSON.parse(JSON.stringify(Variant.project)) : null,
            variants: Variant.toSpec(),
            mappings: JSON.parse(JSON.stringify(Object.fromEntries(Variant._mappings))),
            presets: JSON.parse(JSON.stringify(Object.fromEntries(Variant._presets)))
        };
    },

    /** Machine-readable summary for agents and the editor. */
    inspect() {
        const cur = Variant.current();
        return {
            project: Variant.project ? { id: Variant.project.id, name: Variant.project.name, defaultVariant: Variant.project.defaultVariant || null } : null,
            variants: Variant.list().map(v => ({ id: v.id, name: v.name, profile: v.profile, enabled: v.enabled, createdBy: v.createdBy, createdFrom: v.createdFrom })),
            current: cur ? { id: cur.id, name: cur.name, profile: cur.profile } : null,
            mappings: Variant.mappingNames(),
            presets: Variant.presets(),
            profilesCovered: [...new Set(Variant.list().map(v => v.profile))],
            profilesMissing: RenderProfile.ids().filter(p => !Variant.forProfile(p)),
            gameplayHash: GameModel.booted() ? GameModel.gameplayHash() : null,
            saveSchemaHash: GameModel.booted() ? Save.schemaHash() : null,
            journal: Variant.journal.slice(-10)
        };
    },

    _record(kind, detail) {
        Variant.journal.push(Object.assign({ kind: kind, at: new Date().toISOString() }, detail || {}));
        if (Variant.journal.length > Variant.JOURNAL_MAX) Variant.journal.shift();
        return Variant.journal[Variant.journal.length - 1];
    },

    /** The migration/conversion journal (spec: VisualMigrationJournal). */
    migrationJournal() {
        return (GameModel.booted() && GameModel.spec.visualMigrationJournal) ? JSON.parse(JSON.stringify(GameModel.spec.visualMigrationJournal)) : [];
    }
};
