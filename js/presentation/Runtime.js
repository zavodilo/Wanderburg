// Runtime.js — PlayArcRuntime: ONE runtime, MANY presentation configurations.
//
//     PlayArcRuntime.start({ project: 'robot-quest', variant: 'robot-2d' })
//     PlayArcRuntime.start({ project: 'robot-quest', variant: 'robot-full3d' })
//
// Both calls boot the SAME Master Project: one Game Model, one world, one entity model, one
// asset registry, one save schema. Only the presentation differs, and it comes from
// presentation/variants/<id>.json (generated into js/presentation/Variants.js).
//
// Five browser tabs may run five variants of one project side by side — no copies of the
// project, no file replacement, no branches:
//
//     /?project=robot-quest&variant=robot-2d
//     /?project=robot-quest&variant=robot-full3d
//
// The runtime context ({ project, variant, profile, instance, contractHash, gameplayHash,
// saveSchemaHash }) is what an agent, the editor and the CLI read to know what a given instance
// presents. `contractHash` and `saveSchemaHash` are identical in every instance of a project —
// that is the machine-checkable proof that the variants share one game. `gameplayHash` covers the
// LIVE model state (positions, logic, progression): it is a migration's preservation proof inside
// one session, and it legitimately differs between two tabs that have been playing.

/** @satisfies {Record<string, any>} */
const PlayArcRuntime = {
    /** @type {any | null} the RuntimeContext of this instance */
    _context: null,
    /** @type {any | null} the report of the last start() */
    lastReport: null,
    started: false,

    /**
     * Boot (or re-boot) the project with a variant.
     * opts — { project?, variant?, profile?, spec?, query?, apply?, backend?, instance? }
     * @returns {{ ok: boolean, context: any, model: any, report: any }}
     */
    start(opts) {
        const o = opts || {};
        const t0 = PlayArcRuntime._now();
        const spec = o.spec || (typeof GAME_SPEC !== 'undefined' ? GAME_SPEC : null);
        if (!spec) throw new Error('PlayArcRuntime.start: no GAME_SPEC (js/GameSpec.js) and no spec passed');

        // 1. the shared game model — identical for every variant
        GameModel.boot(spec);
        if (typeof AssetRegistry !== 'undefined') AssetRegistry.fromSpec(spec.assets || []);

        // 2. the variant registry (project.json + presentation/variants/*.json)
        const data = o.variants || (typeof PROJECT_VARIANTS !== 'undefined' ? PROJECT_VARIANTS : null);
        Variant.boot(data);

        // 3. semantic input and audio contracts
        if (spec.input && typeof Input !== 'undefined') Input.define(spec.input);
        if (typeof GameAudio !== 'undefined') GameAudio.fromSpec(spec.audio || {});

        // 4. which variant does THIS instance present?
        const q = PlayArcRuntime.fromQuery(o.query !== undefined ? o.query : PlayArcRuntime.query());
        const wanted = o.variant || q.variant || o.profile || PlayArcRuntime.defaultVariant(q.project);
        const variantId = PlayArcRuntime._resolveVariant(wanted, o.profile || q.profile);
        const project = (Variant.project && Variant.project.id) || spec.id;
        if (q.project && q.project !== project) {
            console.warn('PlayArcRuntime: the URL asks for project ' + JSON.stringify(q.project) + ', this project is ' + JSON.stringify(project) + ' — using ' + project);
        }

        // 5. present it (camera, lighting, world, visuals, UI, input planes, audio)
        let report = null;
        if (o.apply === false) report = Variant.activate(variantId, { apply: false });
        else {
            try { report = Variant.activate(variantId); }
            catch (e) {
                // a presentation failure must not take the game down: fall back to the profile
                // defaults and say so loudly in the report.
                console.error('PlayArcRuntime: variant ' + variantId + ' failed to present — ' + ((e && e.message) || e));
                report = { ok: false, error: (e && e.message) || String(e), fallback: true };
                try { report = Variant.activate(variantId, { apply: false }); } catch (e2) { /* nothing left to try */ }
            }
        }

        PlayArcRuntime._context = {
            project: project,
            variant: variantId,
            profile: Variant.profileOf(variantId),
            url: PlayArcRuntime.urlFor(project, variantId),
            instance: o.instance || PlayArcRuntime.instanceId(),
            startedAt: new Date().toISOString(),
            gameplayHash: GameModel.gameplayHash(),
            // The cross-instance invariant (see GameModel.contractDigest): gameplayHash covers
            // LIVE model state, so two tabs of one project diverge as soon as the game plays.
            contractHash: GameModel.contractHash ? GameModel.contractHash() : null,
            saveSchemaHash: Save.schemaHash(),
            headless: typeof RenderProfile !== 'undefined' ? RenderProfile.isHeadless() : true
        };
        PlayArcRuntime.started = true;
        const out = {
            ok: !(report && report.ok === false),
            context: PlayArcRuntime.context(),
            model: GameModel.inspect(),
            variants: Variant.list().map(v => ({ id: v.id, profile: v.profile, enabled: v.enabled })),
            report: report,
            ms: Math.round((PlayArcRuntime._now() - t0) * 100) / 100
        };
        PlayArcRuntime.lastReport = out;
        return out;
    },

    /** The RuntimeContext of this instance. */
    context() { return PlayArcRuntime._context ? JSON.parse(JSON.stringify(PlayArcRuntime._context)) : null; },

    /** Switch the presentation of THIS instance (same project, same game model). */
    setVariant(variantId, opts) {
        const report = Variant.activate(variantId, opts || {});
        if (PlayArcRuntime._context) {
            PlayArcRuntime._context.variant = variantId;
            PlayArcRuntime._context.profile = Variant.profileOf(variantId);
            PlayArcRuntime._context.url = PlayArcRuntime.urlFor(PlayArcRuntime._context.project, variantId);
            PlayArcRuntime._context.gameplayHash = GameModel.gameplayHash();
            if (GameModel.contractHash) PlayArcRuntime._context.contractHash = GameModel.contractHash();
        }
        return { ok: !(report && report.ok === false), context: PlayArcRuntime.context(), report: report };
    },

    /** Re-run start() with the current (or a new) variant — the editor's live preview. */
    restart(opts) {
        const o = Object.assign({ variant: PlayArcRuntime._context ? PlayArcRuntime._context.variant : null }, opts || {});
        return PlayArcRuntime.start(o);
    },

    stop() {
        PlayArcRuntime.started = false;
        if (typeof VisualEntity !== 'undefined') VisualEntity.clear();
        if (typeof RenderProfile !== 'undefined') RenderProfile.attachBackend(null);
        PlayArcRuntime._context = null;
        return true;
    },

    /** An explicit variant id, a profile id (its variant is created on demand) or the default. */
    _resolveVariant(wanted, profileHint) {
        if (wanted && Variant.has(wanted)) return wanted;
        const pid = profileHint || (wanted && RenderProfile.isKnown(wanted) ? wanted : null);
        if (pid) {
            const have = Variant.forProfile(pid);
            if (have) return have.id;
            return Variant.createFromProfile(pid, { by: 'runtime' }).id;
        }
        if (wanted) {
            // an unknown id that looks like "<project>-<profile>" still resolves
            const m = String(wanted).match(/(2\.5d|isometric3d|lowpoly3d|full3d|2d)$/);
            if (m) return Variant.createFromProfile(m[1], { id: String(wanted), by: 'runtime' }).id;
            throw new Error('PlayArcRuntime: unknown variant ' + JSON.stringify(wanted) + ' (variants: ' + Variant.ids().join(', ') + ')');
        }
        const def = Variant.defaultId();
        if (!def) throw new Error('PlayArcRuntime: the project has no variants (Variant.createAll() creates one per profile)');
        return def;
    },

    defaultVariant(projectId) {
        if (projectId && Variant.project && Variant.project.id && projectId !== Variant.project.id) return null;
        return (Variant.project && Variant.project.defaultVariant) || Variant.defaultId();
    },

    // --- launch plumbing -------------------------------------------------------------------------

    /** The query string of this page ('' headlessly). */
    query() {
        return (typeof window !== 'undefined' && window.location && window.location.search) ? window.location.search : '';
    },

    /** '?project=x&variant=y' -> { project, variant, profile } (all optional). */
    fromQuery(search) {
        const out = { project: null, variant: null, profile: null };
        const s = String(search || '');
        if (!s) return out;
        const params = s.replace(/^\?/, '').split('&');
        for (const p of params) {
            const i = p.indexOf('=');
            if (i < 0) continue;
            const k = decodeURIComponent(p.slice(0, i)).toLowerCase();
            const v = decodeURIComponent(p.slice(i + 1));
            if (k === 'project') out.project = v;
            else if (k === 'variant') out.variant = v;
            else if (k === 'profile') out.profile = v;
        }
        return out;
    },

    /** The URL that launches one variant of one project. */
    urlFor(project, variantId) {
        return '/?project=' + encodeURIComponent(project || '') + '&variant=' + encodeURIComponent(variantId || '');
    },

    /** A per-tab instance id: five variants of one project run side by side, tellable apart. */
    instanceId() {
        if (PlayArcRuntime._instance) return PlayArcRuntime._instance;
        let id = null;
        try {
            if (typeof sessionStorage !== 'undefined') {
                id = sessionStorage.getItem('arc.runtime.instance');
                if (!id) {
                    id = 'i' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
                    sessionStorage.setItem('arc.runtime.instance', id);
                }
            }
        } catch (e) { /* a sandbox iframe refuses session storage: fall through */ }
        if (!id) id = 'headless-' + (PlayArcRuntime._seq = (PlayArcRuntime._seq || 0) + 1);
        PlayArcRuntime._instance = id;
        return id;
    },

    _seq: 0,
    _instance: null,

    isHeadless() { return typeof RenderProfile === 'undefined' || RenderProfile.isHeadless(); },

    _now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); },

    /** Machine-readable summary (the CLI, the editor, an agent). */
    inspect() {
        return {
            started: PlayArcRuntime.started,
            context: PlayArcRuntime.context(),
            project: Variant.project ? { id: Variant.project.id, name: Variant.project.name, defaultVariant: Variant.project.defaultVariant || null } : null,
            variants: Variant.list().map(v => ({ id: v.id, name: v.name, profile: v.profile, enabled: v.enabled })),
            profile: typeof RenderProfile !== 'undefined' ? RenderProfile.id() : null,
            headless: PlayArcRuntime.isHeadless(),
            shared: {
                gameplayHash: GameModel.booted() ? GameModel.gameplayHash() : null,
                contractHash: (GameModel.booted() && GameModel.contractHash) ? GameModel.contractHash() : null,
                saveSchemaHash: GameModel.booted() ? Save.schemaHash() : null,
                entityIds: GameModel.booted() ? GameModel.entities.map(e => e.id) : []
            }
        };
    }
};
