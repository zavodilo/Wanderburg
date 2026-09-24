// RenderProfile.js — the profile half of the presentation layer.
//
//     PROFILE  = a TYPE of presentation: camera, projection, representations, lighting,
//                animation, depth, capabilities and a performance budget.
//                Canon: manifest/render-profiles.json (generated: RenderProfiles.js).
//     VARIANT  = one CONCRETE presentation of one game: a profile + project-specific
//                overrides (js/presentation/Variant.js).
//
//     Profile != Variant. Switching a profile never rewrites the game; it activates (or
//     creates) the variant that presents the shared Game Model that way.
//
// Game and agent facing API:
//
//     RenderProfile.get()                       // 'full3d' — the active variant's profile
//     RenderProfile.list()                      // the canonical ladder
//     RenderProfile.set('2d')                   // present the same game as 2D
//     RenderProfile.canConvert('2d', 'full3d')  // { ok, reason, warnings }
//     RenderProfile.plan('2d', 'full3d')        // dry run: the MigrationPlan
//     RenderProfile.convert('2d', 'full3d')     // NON-DESTRUCTIVE: creates the 3D variant
//     RenderProfile.inspect()                   // machine-readable state for an agent
//     RenderProfile.suggest('pixel-art top-down RPG')
//
// Nothing here touches pc.* — the engine binding is attached by main.js
// (RenderProfile.attachBackend) and lives in js/engine/Visual3D.js.

/** @typedef {{ id: string, projection: string, camera: any, lighting: any, world: any, materials: any, animation: any, ui: any, audio: any, effects: any, performance: any, scenes: any }} ArcPresentationConfig */

/** @satisfies {Record<string, any>} */
const ArcProfiles = {
    /** @type {Map<string, any>} profile id -> adapter (js/profiles/<id>/profile.js) */
    _adapters: new Map(),

    /**
     * Register a profile adapter. Only the BEHAVIOUR lives in the adapter; every
     * declarative field comes from the manifest, so a profile cannot drift from its canon.
     * def — { id, present(ctx), cameraParams(cfg), lightingPreset(cfg), worldPresentation(cfg),
     *         inputPlanes(cfg), uiPresentation(cfg), budgetOf(cfg) }
     */
    define(def) {
        if (!def || !def.id) throw new Error('ArcProfiles.define: id is required');
        const id = String(def.id);
        if (!ArcProfiles.ids().includes(id)) throw new Error('ArcProfiles.define: ' + id + ' is not in manifest/render-profiles.json');
        const manifest = ArcProfiles.manifestOf(id);
        const adapter = {
            id: id,
            manifest: manifest,
            present: typeof def.present === 'function' ? def.present : null,
            cameraParams: typeof def.cameraParams === 'function' ? def.cameraParams : null,
            lightingPreset: typeof def.lightingPreset === 'function' ? def.lightingPreset : null,
            worldPresentation: typeof def.worldPresentation === 'function' ? def.worldPresentation : null,
            inputPlanes: typeof def.inputPlanes === 'function' ? def.inputPlanes : null,
            uiPresentation: typeof def.uiPresentation === 'function' ? def.uiPresentation : null,
            notes: def.notes || null
        };
        ArcProfiles._adapters.set(id, adapter);
        return adapter;
    },

    /** @returns {any | null} */
    get(id) { return ArcProfiles._adapters.get(String(id)) || null; },

    has(id) { return ArcProfiles._adapters.has(String(id)); },

    ids() { return RenderProfile.ids(); },

    /** The manifest block of a profile. */
    manifestOf(id) {
        return (typeof RENDER_PROFILES !== 'undefined' && RENDER_PROFILES.profiles[String(id)]) || null;
    },

    /** Which profiles have an adapter (a missing one is a boot error, not a silent 2D). */
    missing() { return ArcProfiles.ids().filter(id => !ArcProfiles._adapters.has(id)); }
};

/** @satisfies {Record<string, any>} */
const RenderProfile = {
    /** @type {any | null} the engine binding (js/engine/Visual3D.js) */
    _backend: null,
    /** @type {string | null} the active variant id */
    _activeVariant: null,
    /** The last apply() report — what an agent reads after a switch. */
    lastReport: null,
    /** Every profile switch/conversion of this page, newest last. */
    history: [],
    HISTORY_MAX: 100,

    // --- canon -------------------------------------------------------------------------

    /** The machine-readable profile canon (manifest/render-profiles.json). */
    manifest() { return typeof RENDER_PROFILES !== 'undefined' ? RENDER_PROFILES : null; },

    /** Profile ids in ladder order: 2d -> 2.5d -> isometric3d -> lowpoly3d -> full3d. */
    ids() { return typeof RENDER_PROFILES !== 'undefined' ? RENDER_PROFILES.order.slice() : ['2d', '2.5d', 'isometric3d', 'lowpoly3d', 'full3d']; },

    /** Short list for UIs and agents: [{ id, name, projection, description }]. */
    list() {
        return RenderProfile.ids().map(id => {
            const p = ArcProfiles.manifestOf(id) || {};
            return {
                id: id, name: p.name || id, projection: p.projection || null,
                geometry: p.geometry || null, description: p.description || '',
                adapter: ArcProfiles.has(id), enabled: RenderProfile.variantEnabled(id)
            };
        });
    },

    isKnown(id) { return RenderProfile.ids().includes(String(id)); },

    /** The manifest block, validated. */
    info(id) {
        const pid = String(id || RenderProfile.id());
        const p = ArcProfiles.manifestOf(pid);
        if (!p) throw new Error('RenderProfile: unknown profile ' + JSON.stringify(id) + ' (known: ' + RenderProfile.ids().join(', ') + ')');
        return p;
    },

    /** Dimension of a profile: 2, 2.5 or 3. */
    dimension(id) {
        const m = RenderProfile.manifest();
        return m && m.dimension ? m.dimension[String(id || RenderProfile.id())] : 3;
    },

    capabilities(id) { return (RenderProfile.info(id).capabilities || []).slice(); },

    supports(cap, id) { return RenderProfile.capabilities(id).includes(String(cap)); },

    /** The machine-readable performance budget of a profile (manifest performanceBudget). */
    budget(id) { return JSON.parse(JSON.stringify(RenderProfile.info(id).performanceBudget || {})); },

    /** The canonical coordinate system (x horizontal, y height, z depth). */
    coordinates() { const m = RenderProfile.manifest(); return m ? JSON.parse(JSON.stringify(m.coordinateSystem)) : null; },

    // --- active profile -------------------------------------------------------------------

    /** The active profile id: the active variant's profile, else the project default. */
    id() {
        if (typeof Variant !== 'undefined' && Variant.current()) return Variant.current().profile;
        if (GameModel.booted()) return GameModel.renderProfile();
        return RenderProfile.ids()[0];
    },

    /** The active variant id (null before a variant is active). */
    variant() { return RenderProfile._activeVariant; },

    /** The active profile's manifest block. */
    profile() { return RenderProfile.info(RenderProfile.id()); },

    /**
     * The EFFECTIVE presentation config: profile defaults <- variant overrides <-
     * scene presets. This is the only thing the presentation code reads.
     * @returns {ArcPresentationConfig}
     */
    config(sceneId) {
        const id = RenderProfile.id();
        if (typeof Variant !== 'undefined' && Variant.current()) return Variant.effective(RenderProfile._activeVariant, sceneId);
        // No variant layer (a bare GameModel boot, tests): profile defaults only.
        return RenderProfile.defaultsFor(id, sceneId);
    },

    /** Profile defaults as an effective config (no variant). */
    defaultsFor(id, sceneId) {
        const p = RenderProfile.info(id);
        const cfg = {
            id: id,
            variant: null,
            projection: p.projection,
            camera: Object.assign({}, p.camera),
            // the profile's lighting block + the concrete fields of its preset
            lighting: Object.assign({ preset: p.lighting.profile },
                ((RenderProfile.manifest() || {}).lightingProfiles || {})[p.lighting.profile] || {}, p.lighting),
            world: Object.assign({}, p.worldRepresentation),
            materials: Object.assign({}, p.materials),
            animation: Object.assign({}, p.animation),
            ui: Object.assign({}, p.ui),
            audio: Object.assign({}, p.audio),
            effects: { particles: p.performanceBudget.maxParticles, postprocessing: id === 'full3d' ? 'cinematic' : 'none' },
            performance: Object.assign({}, p.performanceBudget),
            depth: Object.assign({}, p.depth),
            representations: Object.assign({}, p.entityRepresentations),
            scenes: {}
        };
        if (sceneId && GameModel.booted()) {
            const s = GameModel.scene(sceneId);
            if (s && s.renderProfile && s.renderProfile !== id) return RenderProfile.defaultsFor(s.renderProfile, null);
        }
        return cfg;
    },

    // --- switching ---------------------------------------------------------------------------

    /**
     * Present the game with a profile. NON-DESTRUCTIVE: the variant of the current profile
     * stays in the project, the target variant is activated (and created when missing).
     * opts — { variant?, reason?, apply?, by? }.
     * @returns {any} the apply report
     */
    set(profileIdOrVariant, opts) {
        const o = opts || {};
        let profileId = profileIdOrVariant;
        let variantId = o.variant || null;
        if (typeof Variant !== 'undefined' && Variant.has(profileIdOrVariant)) {
            variantId = String(profileIdOrVariant);
            profileId = Variant.get(variantId).profile;
        }
        if (!RenderProfile.isKnown(profileId)) {
            throw new Error('RenderProfile.set: unknown profile ' + JSON.stringify(profileIdOrVariant) +
                ' (known: ' + RenderProfile.ids().join(', ') + '; variants: ' + (typeof Variant !== 'undefined' ? Variant.ids().join(', ') : '-'));
        }
        if (!GameModel.booted()) throw new Error('RenderProfile.set: boot the game model first (GameModel.boot(GAME_SPEC))');
        if (typeof Variant !== 'undefined') {
            if (!variantId) {
                const existing = Variant.forProfile(profileId);
                variantId = existing ? existing.id : Variant.createFromProfile(profileId, { reason: o.reason, by: o.by || 'RenderProfile.set' }).id;
            }
            Variant.activate(variantId);
        }
        RenderProfile._activeVariant = variantId;
        GameModel.setRenderProfile(profileId, o.reason || GameModel.renderProfileReason());
        const report = o.apply === false ? { ok: true, deferred: true, profile: profileId, variant: variantId } : RenderProfile.apply(o);
        RenderProfile._record('set', profileId, variantId, report, o);
        return report;
    },

    /**
     * (Re)apply the active presentation: camera, lighting, world, visuals, UI, input and
     * audio. Called on boot, after a variant switch and after a conversion.
     */
    apply(opts) {
        const o = opts || {};
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const id = RenderProfile.id();
        const cfg = RenderProfile.config(o.sceneId || GameModel.activeScene);
        const adapter = ArcProfiles.get(id);
        if (!adapter) throw new Error('RenderProfile.apply: no adapter for profile ' + id + ' (js/profiles/' + id + '/profile.js)');
        const report = {
            ok: true, profile: id, variant: RenderProfile._activeVariant, scene: o.sceneId || GameModel.activeScene,
            headless: !RenderProfile._backend, camera: null, lighting: null, world: null, visuals: null,
            ui: null, input: null, audio: null, budget: null, warnings: [], steps: [], ms: 0
        };
        const step = (name, fn) => {
            try { const r = fn(); report.steps.push({ id: name, ok: true }); return r; }
            catch (e) {
                report.steps.push({ id: name, ok: false, error: (e && e.message) || String(e) });
                report.ok = false;
                report.warnings.push(name + ': ' + ((e && e.message) || e));
                if (!o.lenient) throw e;
                return null;
            }
        };

        // 1. camera (semantic: modes and parameters, never pc.Camera). The editor previews
        //    a variant without stealing its own camera: { skipCamera: true }.
        report.camera = step('camera', () => {
            if (o.skipCamera) return { deferred: true, reason: 'skipCamera' };
            if (typeof Camera === 'undefined') return null;
            Camera.applyConfig(cfg.camera, { backend: RenderProfile._backend });
            return Camera.params();
        });

        // 2. lighting preset
        report.lighting = step('lighting', () => {
            if (typeof Lighting === 'undefined') return null;
            Lighting.applyConfig(cfg.lighting, { backend: RenderProfile._backend });
            return Lighting.get();
        });

        // 3. world presentation (ground/tiles/terrain) — the LOGICAL world is untouched
        report.world = step('world', () => {
            if (typeof VisualEntity === 'undefined') return null;
            return VisualEntity.presentWorld(cfg, { backend: RenderProfile._backend });
        });

        // 4. entity visuals: rebind every entity to its representation in this profile
        report.visuals = step('visuals', () => {
            if (typeof VisualEntity === 'undefined') return null;
            return VisualEntity.sync(GameModel.entities, cfg, { backend: RenderProfile._backend, adapter: adapter });
        });

        // 5. UI presentation (the UI DEFINITION stays shared)
        report.ui = step('ui', () => {
            if (typeof UI === 'undefined' || !UI.root) return { deferred: true };
            const u = cfg.ui || {};
            if (typeof UI.setSpace === 'function') UI.setSpace(u.space || 'screen');
            if (u.scale != null && typeof UI.setScale === 'function') UI.setScale(Number(u.scale));
            return { space: u.space || 'screen', elements: (UI.layout || []).length };
        });

        // 6. input planes: a side view drives x/y, everything else x/z
        report.input = step('input', () => {
            if (typeof Input === 'undefined') return null;
            const planes = (adapter.inputPlanes && adapter.inputPlanes(cfg)) ||
                { move: /side|platformer/.test(String(cfg.camera && cfg.camera.mode)) ? 'xy' : 'xz' };
            for (const [action, plane] of Object.entries(planes)) if (Input.has(action)) Input.setPlane(action, plane);
            return planes;
        });

        // 7. audio spatialization follows the profile
        report.audio = step('audio', () => {
            if (typeof GameAudio === 'undefined') return null;
            return { spatial: !!(cfg.audio && cfg.audio.spatial), cues: Object.keys(GameAudio.cues()).length };
        });

        // 8. the adapter's own presentation work (engine-side, when a backend is attached)
        if (adapter.present) {
            report.adapter = step('adapter:' + id, () => adapter.present({
                profile: id, config: cfg, backend: RenderProfile._backend,
                view: RenderProfile._backend && RenderProfile._backend.view ? RenderProfile._backend.view() : null,
                model: GameModel, registry: typeof AssetRegistry !== 'undefined' ? AssetRegistry : null
            }));
        }

        // 9. budget check (machine-readable constraints, manifest performanceBudget)
        report.budget = step('budget', () => RenderProfile.checkBudget(id, cfg));
        for (const w of (report.budget && report.budget.warnings) || []) report.warnings.push(w);

        const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        report.ms = Math.round((t1 - t0) * 100) / 100;
        RenderProfile.lastReport = report;
        return report;
    },

    /** Refresh the presentation without switching (the editor's live preview). */
    refresh(opts) { return RenderProfile.apply(opts); },

    // --- scenes (§ per-scene presentation presets) --------------------------------------------

    /** The profile presenting a scene: its own preset when it declares one. */
    forScene(sceneId) {
        if (!GameModel.booted()) return RenderProfile.id();
        return GameModel.sceneProfile(sceneId);
    },

    /** Give one scene its own presentation preset (MainMenu 2D, Gameplay full3d, Map iso). */
    setSceneProfile(sceneId, profileId) {
        if (profileId != null && !RenderProfile.isKnown(profileId)) throw new Error('RenderProfile.setSceneProfile: unknown profile ' + JSON.stringify(profileId));
        const p = GameModel.setSceneProfile(sceneId, profileId);
        if (sceneId === GameModel.activeScene) RenderProfile.apply({ sceneId: sceneId });
        return p;
    },

    // --- conversion -----------------------------------------------------------------------------

    /**
     * Can a profile be converted into another? Always yes between known profiles — the
     * semantic model is shared and missing assets fall back — but the answer carries the
     * warnings an agent must show a human first.
     */
    canConvert(from, to) {
        const a = String(from || RenderProfile.id()), b = String(to);
        if (!RenderProfile.isKnown(a)) return { ok: false, from: a, to: b, reason: 'unknown source profile ' + a, warnings: [] };
        if (!RenderProfile.isKnown(b)) return { ok: false, from: a, to: b, reason: 'unknown target profile ' + b, warnings: [] };
        if (a === b) return { ok: true, from: a, to: b, noop: true, reason: 'already presenting ' + a, warnings: [] };
        const warnings = [];
        const target = RenderProfile.info(b);
        const missing = typeof AssetRegistry !== 'undefined' ? AssetRegistry.withoutVariant(b) : [];
        if (missing.length) warnings.push(missing.length + ' role(s) have no ' + b + ' variant yet: ' + missing.slice(0, 6).join(', ') + (missing.length > 6 ? '…' : ''));
        if (target.performanceBudget && typeof VisualEntity !== 'undefined') {
            const over = VisualEntity.overBudget(GameModel.entities, target.performanceBudget);
            for (const w of over) warnings.push('budget: ' + w);
        }
        const dropped = ((RenderProfile.info(a).capabilities || []).filter(c => !(target.capabilities || []).includes(c)));
        if (dropped.length) warnings.push('capabilities lost: ' + dropped.join(', '));
        return { ok: true, from: a, to: b, noop: false, reason: null, warnings: warnings };
    },

    /** The dry-run migration plan (Migration.plan). */
    plan(from, to, opts) {
        if (typeof Migration === 'undefined') throw new Error('RenderProfile.plan: js/presentation/Migration.js is not loaded');
        return Migration.plan(from || RenderProfile.id(), to, opts);
    },

    /**
     * Convert: NON-DESTRUCTIVE. Creates (or updates) the target variant from the same Game
     * Model; the source variant stays in the project. Destructive replacement needs an
     * explicit { preserveSource: false }.
     */
    convert(from, to, opts) {
        if (typeof Migration === 'undefined') throw new Error('RenderProfile.convert: js/presentation/Migration.js is not loaded');
        return Migration.convert(Object.assign({ source: from || RenderProfile.id(), target: to }, opts || {}));
    },

    /** Machine-readable state: what an agent asks before touching anything. */
    inspect() {
        const id = RenderProfile.id();
        const variants = typeof Variant !== 'undefined' ? Variant.list() : [];
        return {
            profile: id,
            variant: RenderProfile._activeVariant,
            variants: variants,
            defaultVariant: typeof Variant !== 'undefined' ? Variant.defaultId() : null,
            projection: RenderProfile.info(id).projection,
            cameraMode: (RenderProfile.config().camera || {}).mode || null,
            lighting: (RenderProfile.config().lighting || {}).preset || null,
            capabilities: RenderProfile.capabilities(id),
            budget: RenderProfile.budget(id),
            adapters: ArcProfiles.ids().filter(x => ArcProfiles.has(x)),
            missingAdapters: ArcProfiles.missing(),
            backend: !!RenderProfile._backend,
            headless: !RenderProfile._backend,
            entities: GameModel.booted() ? GameModel.entities.length : 0,
            assets: typeof AssetRegistry !== 'undefined' ? AssetRegistry.inspect(id) : null,
            scenes: GameModel.booted() ? GameModel.scenes().map(s => ({ id: s.id, profile: GameModel.sceneProfile(s.id) })) : [],
            gameplayHash: GameModel.booted() ? GameModel.gameplayHash() : null,
            saveSchemaHash: GameModel.booted() ? Save.schemaHash() : null,
            history: RenderProfile.history.slice(-10),
            lastReport: RenderProfile.lastReport ? { ok: RenderProfile.lastReport.ok, profile: RenderProfile.lastReport.profile, warnings: RenderProfile.lastReport.warnings, ms: RenderProfile.lastReport.ms } : null
        };
    },

    /** Is any variant of this profile enabled? (the editor dims profiles without one) */
    variantEnabled(profileId) {
        if (typeof Variant === 'undefined') return true;
        return Variant.list().some(v => v.profile === profileId && v.enabled !== false);
    },

    // --- budget -----------------------------------------------------------------------------

    /**
     * Check a model/config against the profile's machine-readable budget. Returns
     * { ok, budget, used, warnings } — the numbers an agent must respect when it generates
     * a variant (maxDrawCalls, maxTextureMemoryMB, maxShadowLights, maxTextureResolution,
     * maxParticles, maxPolycount, maxAnimatedEntities).
     */
    checkBudget(profileId, cfg) {
        const budget = RenderProfile.budget(profileId);
        const c = cfg || RenderProfile.config();
        const entities = GameModel.booted() ? GameModel.entities : [];
        const animated = entities.filter(e => e.visual && e.visual.animation).length;
        const used = {
            maxAnimatedEntities: animated,
            maxDrawCalls: entities.length + RenderProfile.presentedTiles(),
            maxShadowLights: (c.lighting && c.lighting.shadows != null ? Number(c.lighting.shadows) : 1),
            maxParticles: (c.effects && c.effects.particles) || 0,
            maxTextureMemoryMB: 0,
            maxPolycount: 0,
            maxTextureResolution: 0
        };
        const warnings = [];
        for (const k of Object.keys(budget)) {
            if (typeof used[k] !== 'number' || used[k] <= budget[k]) continue;
            warnings.push(k + ' ' + used[k] + ' > budget ' + budget[k]);
        }
        const tiles = RenderProfile.presentedTiles();
        if (tiles > budget.maxDrawCalls) warnings.push('world tiles ' + tiles + ' > maxDrawCalls ' + budget.maxDrawCalls + ' (batch or instance them)');
        return { ok: !warnings.length, budget: budget, used: used, warnings: warnings, tier: budget.tier || null };
    },

    /**
     * How many world tiles a presentation actually draws: floor tiles are the ground
     * texture's job once there are many of them (js/engine/Visual3D.js skips them), so they
     * only count while they are few.
     */
    presentedTiles() {
        if (!GameModel.booted() || !GameModel.world) return 0;
        const counts = GameModel.world.tileCounts();
        let n = 0;
        for (const [kind, c] of Object.entries(counts)) {
            if (kind === 'empty' || kind === 'trigger' || kind === 'spawn' || kind === 'enemySpawn') continue;
            if (kind === 'floor' && c > 256) continue;
            n += c;
        }
        return n;
    },

    // --- AI decision rules (§ profile selection) ------------------------------------------------

    /**
     * Pick a profile from a user intent string, using the manifest's aiDecisionRules
     * (never a hardcoded "genre = profile" table). Returns
     * { profile, reason, score, alternatives } — the decision an agent records in the
     * project spec (GameSpec.renderProfileReason).
     */
    suggest(intent, opts) {
        const text = String(intent || '').toLowerCase();
        const o = opts || {};
        const m = RenderProfile.manifest();
        const rules = (m && m.aiDecisionRules) || { examples: [], signals: [] };
        const scores = {};
        for (const id of RenderProfile.ids()) scores[id] = 0;

        // 1. an explicit profile id in the wording wins
        for (const id of RenderProfile.ids()) {
            const p = RenderProfile.info(id);
            const names = [id, String(p.name || '').toLowerCase(), id.replace('3d', ' 3d')];
            for (const n of names) if (n && text.includes(n)) scores[id] += 100;
        }
        // 2. manifest examples ("Diablo-like camera with a real 3D environment")
        for (const ex of rules.examples || []) {
            const words = String(ex.intent || '').toLowerCase().split(/[^a-z0-9.]+/).filter(w => w.length > 2);
            let hit = 0;
            for (const w of words) if (text.includes(w)) hit++;
            if (hit) scores[ex.profile] += 8 * hit / Math.max(1, words.length);
        }
        // 3. capability keywords
        const KEYWORDS = {
            '2d': ['pixel', 'sprite', 'top-down', 'topdown', 'side-scroller', 'platformer', 'tile', '2d', 'retro', 'arena'],
            '2.5d': ['2.5d', 'hybrid', 'billboard', '2d characters', '3d world', 'parallax'],
            'isometric3d': ['isometric', 'iso', 'diablo', 'monument', 'tactics', 'orthographic 3d'],
            'lowpoly3d': ['low-poly', 'lowpoly', 'low poly', 'stylized', 'mobile', 'casual', 'simple geometry'],
            'full3d': ['3d', 'cinematic', 'realistic', 'pbr', 'third-person', 'first-person', 'fps', 'aaa']
        };
        for (const [id, words] of Object.entries(KEYWORDS)) for (const w of words) if (text.includes(w)) scores[id] += 3;
        // 4. constraints from the caller: required capabilities and a performance target
        for (const cap of o.capabilities || []) {
            for (const id of RenderProfile.ids()) if (RenderProfile.supports(cap, id)) scores[id] += 4;
        }
        if (o.performanceTarget) {
            const want = String(o.performanceTarget).toLowerCase();
            for (const id of RenderProfile.ids()) {
                const tier = (RenderProfile.budget(id).tier || '').toLowerCase();
                if (tier === want || (want === 'mobile' && ['very-low', 'low', 'medium'].includes(tier))) scores[id] += 6;
                if (want === 'mobile' && tier === 'high') scores[id] -= 8;
            }
        }
        if (o.projection) for (const id of RenderProfile.ids()) if (RenderProfile.info(id).projection === o.projection) scores[id] += 5;

        const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || RenderProfile.ids().indexOf(a[0]) - RenderProfile.ids().indexOf(b[0]));
        const best = ranked[0][0];
        const reason = RenderProfile._reasonFor(best, text, o);
        return {
            profile: best,
            reason: reason,
            score: ranked[0][1],
            alternatives: ranked.slice(1).filter(r => r[1] > 0).map(r => ({ profile: r[0], score: r[1] })),
            intent: String(intent || ''),
            ambiguous: ranked.length > 1 && ranked[1][1] > 0 && ranked[0][1] - ranked[1][1] < 3
        };
    },

    _reasonFor(id, text, o) {
        const p = RenderProfile.info(id);
        const why = [];
        if (text.includes(id) || text.includes(String(p.name || '').toLowerCase())) why.push('the request names ' + p.name);
        if (p.camera && p.camera.defaultMode) why.push('camera ' + p.camera.defaultMode + ' (' + p.projection + ')');
        why.push('geometry ' + p.geometry);
        if (o && o.performanceTarget) why.push('performance target ' + o.performanceTarget + ' fits the ' + p.performanceBudget.tier + ' budget');
        return why.join('; ');
    },

    // --- backend -------------------------------------------------------------------------------

    /**
     * Install the engine binding (main.js does it with js/engine/Visual3D.js). Without a
     * backend every presentation step still runs on the model and reports headless: this is
     * how tools/migrate.mjs, tools/variants.mjs and the tests drive the whole pipeline.
     */
    attachBackend(backend) {
        RenderProfile._backend = backend && typeof backend === 'object' ? backend : null;
        if (typeof Camera !== 'undefined') Camera.attachBackend(RenderProfile._backend);
        if (typeof Lighting !== 'undefined') Lighting.attachBackend(RenderProfile._backend);
        if (typeof VisualEntity !== 'undefined') VisualEntity.attachBackend(RenderProfile._backend);
        if (typeof GameAnimation !== 'undefined') GameAnimation.attachBackend(RenderProfile._backend);
        return !!RenderProfile._backend;
    },

    backend() { return RenderProfile._backend; },

    isHeadless() { return !RenderProfile._backend; },

    _record(kind, profileId, variantId, report, opts) {
        RenderProfile.history.push({
            kind: kind, profile: profileId, variant: variantId || null,
            ok: !!(report && report.ok), warnings: (report && report.warnings || []).slice(0, 8),
            at: new Date().toISOString(), by: (opts && opts.by) || null,
            ms: report && report.ms ? report.ms : null
        });
        if (RenderProfile.history.length > RenderProfile.HISTORY_MAX) RenderProfile.history.shift();
        return RenderProfile.history[RenderProfile.history.length - 1];
    }
};
