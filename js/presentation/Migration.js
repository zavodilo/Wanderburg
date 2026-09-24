// Migration.js — presentation migration and variant conversion.
//
// Two names for one operation, because the kit keeps both contracts:
//
//   RenderProfile.convert('2d', 'full3d')   — "convert this game from 2D to 3D"
//   Variant.convert({ source, target })     — "create a Full 3D variant of my 2D game"
//
// Both end up here, and both are NON-DESTRUCTIVE: the source variant stays in the project,
// the target variant is created from the SAME Game Model. Nothing under the game's logic is
// rewritten — that is the whole point of the architecture:
//
//     preserve: gameplay, entity ids, scene ids, logical coordinates, rules, systems,
//               quests, inventory, combat, economy, progression, UI logic, save schema
//     change:   camera, rendering, visual assets, lighting, materials, animation
//               representation, world presentation, depth model, visual effects
//
// There is no converter per profile pair. Every conversion goes
//     semantic model -> source profile -> migration plan -> target profile
// so 2d -> full3d and full3d -> 2d are the same code path, and a game that went
// 2D -> 3D -> 2D is still the game it was (no backup, no re-authoring).
//
// The mechanism is the kit's transactional edit: snapshot -> validate -> apply -> verify ->
// commit, and rollback() on the first failure.

/** @typedef {any} MigrationPlan */

/** @satisfies {Record<string, any>} */
const Migration = {
    /** @type {any | null} the snapshot of the last conversion (rollback restores it) */
    _snapshot: null,
    /** @type {any | null} */
    lastReport: null,
    /** @type {any | null} the last journal entry written */
    _lastEntry: null,
    /** Where generated placeholders go (the tool writes them, the engine draws them). */
    VISUAL_DIR: 'assets/visual/',

    /** The canonical step list (canon: manifest/render-profiles.json -> migration.steps). */
    steps() {
        const m = (typeof RENDER_PROFILES !== 'undefined' && RENDER_PROFILES.migration) || null;
        return (m && m.steps) || ['validate-source', 'snapshot', 'commit'];
    },

    preserveList() {
        const m = (typeof RENDER_PROFILES !== 'undefined' && RENDER_PROFILES.migration) || null;
        return ((m && m.preserve) || ['gameplay', 'entity_ids', 'save_schema']).slice();
    },

    changeList() {
        const m = (typeof RENDER_PROFILES !== 'undefined' && RENDER_PROFILES.migration) || null;
        return ((m && m.change) || ['camera', 'visual_assets', 'lighting']).slice();
    },

    // --- resolution helpers -------------------------------------------------------------------

    /** A profile id from a variant id, a profile id or nothing (the active one). */
    profileOf(what) {
        if (!what) return typeof RenderProfile !== 'undefined' ? RenderProfile.id() : '2d';
        if (RenderProfile.isKnown(what)) return String(what);
        if (typeof Variant !== 'undefined' && Variant.has(what)) return Variant.get(what).profile;
        throw new Error('Migration: ' + JSON.stringify(what) + ' is neither a profile (' + RenderProfile.ids().join(', ') + ') nor a variant');
    },

    /** The variant to convert from: an explicit one, or the active one, or the profile's. */
    sourceVariant(what) {
        if (what && typeof Variant !== 'undefined' && Variant.has(what)) return Variant.get(what);
        const pid = Migration.profileOf(what);
        if (typeof Variant !== 'undefined') {
            const cur = Variant.current();
            if (cur && cur.profile === pid) return cur;
            const v = Variant.forProfile(pid);
            if (v) return v;
        }
        return null;
    },

    // --- the plan (§ dry run) ---------------------------------------------------------------------

    /**
     * Build the migration plan WITHOUT touching anything. This is what an agent shows a
     * human before a big conversion, and what `--dry-run` prints:
     *
     *   Entities: 124   Preserved: 124   Visual replacements: 93
     *   Missing 3D assets: 17   Fallback geometry: 17
     *   Camera changes: 1   Lighting changes: 1   Gameplay files changed: 0
     */
    plan(from, to, opts) {
        const o = opts || {};
        const srcProfile = Migration.profileOf(from);
        const dstProfile = Migration.profileOf(to);
        if (!GameModel.booted()) throw new Error('Migration.plan: boot the game model first (GameModel.boot(GAME_SPEC))');
        const src = RenderProfile.info(srcProfile);
        const dst = RenderProfile.info(dstProfile);
        const entities = GameModel.entities;
        const noop = srcProfile === dstProfile;

        const rows = [];
        const generated = [];
        const fallbacks = [];
        let replacements = 0, missing = 0, fallbackGeometry = 0;

        for (const e of entities) {
            const before = VisualEntity.desired(e, { id: srcProfile, depth: src.depth, world: src.worldRepresentation });
            const after = VisualEntity.desired(e, { id: dstProfile, depth: dst.depth, world: dst.worldRepresentation });
            const row = {
                id: e.id, type: e.type, role: e.role(),
                from: before ? { type: before.type, asset: before.asset, resolvedBy: before.resolvedBy } : { type: 'none', asset: null },
                to: after ? { type: after.type, asset: after.asset, resolvedBy: after.resolvedBy } : { type: 'none', asset: null },
                resolvedBy: after ? after.resolvedBy : 'none',
                generated: null, preserved: true
            };
            if (after) {
                if (!before || before.type !== after.type || before.asset !== after.asset) replacements++;
                if (after.resolvedBy === 'placeholder' || !after.asset) {
                    missing++;
                    const ph = Migration.placeholderFor(e, after, dstProfile);
                    row.generated = ph.path || ('primitive:' + (ph.kind || 'box'));
                    if (ph.path && !generated.includes(ph.path)) generated.push(ph.path);
                    if (!ph.path) fallbackGeometry++;
                    fallbacks.push(e.role() || e.id);
                } else if (after.resolvedBy === 'fallback') {
                    fallbacks.push((e.role() || e.id) + ' <- ' + after.fallbackFrom);
                }
            }
            rows.push(row);
        }

        const cameraChanges = (src.camera.projection !== dst.camera.projection || src.camera.defaultMode !== dst.camera.defaultMode) ? 1 : 0;
        const lightingChanges = (src.lighting.profile !== dst.lighting.profile) ? 1 : 0;
        const worldChanges = (src.worldRepresentation.ground !== dst.worldRepresentation.ground || src.worldRepresentation.height !== dst.worldRepresentation.height) ? 1 : 0;
        const uiChanges = (src.ui.space !== dst.ui.space || !!src.ui.worldSpace !== !!dst.ui.worldSpace) ? 1 : 0;

        const budget = RenderProfile.checkBudget(dstProfile, RenderProfile.defaultsFor(dstProfile));
        const warnings = [];
        if (missing) warnings.push(missing + ' role(s) have no ' + dstProfile + ' asset yet — they will be presented by generated placeholders/primitives');
        for (const w of budget.warnings) warnings.push('budget: ' + w);
        const lost = (src.capabilities || []).filter(c => !(dst.capabilities || []).includes(c));
        if (lost.length) warnings.push('capabilities not present in ' + dstProfile + ': ' + lost.join(', '));
        if (o.checkVariants && typeof Variant !== 'undefined') {
            const have = Variant.forProfile(dstProfile);
            if (have) warnings.push('variant ' + have.id + ' already presents ' + dstProfile + ' — the conversion updates it instead of creating a new one');
        }

        return {
            from: srcProfile, to: dstProfile, noop: noop,
            sourceVariant: (Migration.sourceVariant(from) || {}).id || null,
            targetVariant: o.target || (typeof Variant !== 'undefined' ? Variant.idFor(dstProfile) : null),
            preserve: Migration.preserveList(),
            change: Migration.changeList(),
            generated: generated,
            fallbacks: fallbacks,
            counts: {
                entities: entities.length,
                preserved: entities.length,
                visualReplacements: noop ? 0 : replacements,
                missingAssets: missing,
                fallbackGeometry: fallbackGeometry,
                cameraChanges: noop ? 0 : cameraChanges,
                lightingChanges: noop ? 0 : lightingChanges,
                worldChanges: noop ? 0 : worldChanges,
                uiChanges: noop ? 0 : uiChanges,
                gameplayFilesChanged: 0
            },
            entities: rows,
            camera: { from: { projection: src.camera.projection, mode: src.camera.defaultMode }, to: { projection: dst.camera.projection, mode: dst.camera.defaultMode, azimuthDeg: dst.camera.azimuthDeg, elevationDeg: dst.camera.elevationDeg } },
            lighting: { from: src.lighting.profile, to: dst.lighting.profile },
            world: { from: src.worldRepresentation.ground, to: dst.worldRepresentation.ground, tiles: GameModel.world ? (GameModel.world._tiles ? GameModel.world._tiles.size : 0) : 0 },
            budget: budget,
            warnings: warnings,
            steps: Migration.steps(),
            nonDestructive: true,
            gameplayHash: GameModel.gameplayHash(),
            saveSchemaHash: Save.schemaHash()
        };
    },

    /** The dry run: the plan plus the report envelope (`--dry-run`, the editor's Preview). */
    dryRun(opts) {
        const o = opts || {};
        const plan = Migration.plan(o.source || o.from, o.target || o.to, o);
        return {
            ok: true, dryRun: true, status: 'planned', from: plan.from, to: plan.to, plan: plan,
            counts: plan.counts, warnings: plan.warnings, preserved: null, steps: [],
            note: 'Nothing was changed. Migration.convert(opts) applies it, the source variant is preserved.'
        };
    },

    /**
     * The placeholder a missing asset becomes. Sprites get a generated image file (the
     * tooling writes a real PNG under assets/visual/<profile>/, the browser draws one on a
     * canvas); 3D gets primitive geometry and needs no file at all.
     */
    placeholderFor(entity, binding, profileId) {
        const role = (entity && typeof entity.role === 'function' && entity.role()) || (entity && entity.role) || (entity ? entity.id : 'asset');
        // A declared variant whose file is missing decides the name: the generator creates
        // exactly the file the registry points at, so no mapping has to be rewritten.
        const declared = (typeof AssetRegistry !== 'undefined') ? AssetRegistry.variant(role, profileId) : null;
        const name = (declared && declared.asset)
            ? String(declared.asset).replace(/^assets\//, '').replace(/\.[a-z0-9]+$/i, '')
            : String(role).replace(/[^a-z0-9.]+/gi, '-').replace(/\.visual$|\.sprite$/i, '');
        const ph = (binding && binding.placeholder) || (typeof AssetRegistry !== 'undefined' ? AssetRegistry.placeholder(null, profileId, entity ? entity.type : 'prop', role) : { kind: 'box' });
        const wantsFile = binding && (binding.type === 'sprite' || binding.type === 'billboard' || binding.type === 'tile');
        return {
            role: role,
            profile: profileId,
            type: binding ? binding.type : 'primitive',
            kind: ph.kind || 'box',
            primitive: ph.primitive || 'box',
            color: ph.color || '#888888',
            label: ph.label || name,
            size: ph.size || (binding ? binding.size : null),
            path: wantsFile ? (declared && declared.asset ? declared.asset : Migration.VISUAL_DIR + profileId + '/' + name + '.png') : null,
            generated: true
        };
    },

    /**
     * Every placeholder a PROFILE needs for the whole registry (entities AND world tiles):
     * what `tools/variants.mjs convert --write-placeholders` writes as real files.
     */
    placeholderAssets(profileId) {
        const out = [];
        if (typeof AssetRegistry === 'undefined') return out;
        const seen = new Set();
        for (const rec of AssetRegistry.roles()) {
            const res = AssetRegistry.resolve(rec.role, profileId, { entityType: rec.entityType });
            if (!res.missing && res.resolvedBy !== 'placeholder') continue;
            const type = res.type || AssetRegistry.defaultTypeFor(rec.entityType || 'prop', profileId);
            const ph = Migration.placeholderFor({ role: rec.role, id: rec.role, type: rec.entityType || 'prop' },
                { type: type, placeholder: rec.placeholder, size: null }, profileId);
            if (!ph.path || seen.has(ph.path)) continue;
            seen.add(ph.path);
            out.push(ph);
        }
        return out;
    },

    /** Every placeholder a plan needs (what tools/variants.mjs --write-placeholders creates). */
    placeholders(plan) {
        const out = [];
        for (const row of (plan && plan.entities) || []) {
            if (row.resolvedBy !== 'placeholder') continue;
            const e = GameModel.entity(row.id);
            if (!e) continue;
            const binding = VisualEntity.desired(e, { id: plan.to });
            out.push(Migration.placeholderFor(e, binding, plan.to));
        }
        return out;
    },

    // --- conversion --------------------------------------------------------------------------------

    /**
     * Convert. NON-DESTRUCTIVE: creates (or updates) the target variant, keeps the source,
     * and records the conversion in the journal.
     *
     * opts — { source?, target?, profile?, name?, dryRun?, activate?, preserveSource?,
     *          generatePlaceholders?, by?, lenient? }
     * @returns {any} the report (manifest/migration-schema.json#/definitions/report)
     */
    convert(opts) {
        const o = opts || {};
        const t0 = Migration._now();
        const srcRef = o.source || (typeof Variant !== 'undefined' && Variant.currentId()) || (GameModel.booted() ? GameModel.renderProfile() : '2d');
        const srcProfile = Migration.profileOf(srcRef);
        const dstProfile = Migration.profileOf(o.target && RenderProfile.isKnown(o.target) ? o.target : (o.profile || o.target || o.to));
        if (o.dryRun) return Migration.dryRun(Object.assign({}, o, { source: srcProfile, target: dstProfile }));

        const plan = Migration.plan(srcProfile, dstProfile, { target: o.target && !RenderProfile.isKnown(o.target) ? o.target : undefined, checkVariants: true });
        const report = {
            ok: true, from: srcProfile, to: dstProfile, dryRun: false, status: 'committed',
            sourceVariant: (Migration.sourceVariant(srcRef) || {}).id || null,
            targetVariant: null, plan: plan, steps: [], preserved: null,
            gameplayTests: 0, renderTests: 0, visualTests: 0, missingAssets: plan.counts.missingAssets,
            assetsGenerated: [], fallbacksUsed: plan.fallbacks.slice(), error: null, ms: 0,
            rollbackAvailable: false, by: o.by || 'agent'
        };
        const step = (id, fn) => {
            const s0 = Migration._now();
            try {
                const detail = fn();
                report.steps.push({ id: id, ok: true, ms: Math.round((Migration._now() - s0) * 100) / 100, detail: detail == null ? null : String(detail).slice(0, 200) });
                return detail;
            } catch (e) {
                report.steps.push({ id: id, ok: false, ms: Math.round((Migration._now() - s0) * 100) / 100, detail: (e && e.message) || String(e) });
                throw e;
            }
        };

        // 1-2. validate the source and snapshot everything the rollback may need
        step('validate-source', () => {
            GameModel.validate(GameModel.spec);
            if (typeof Variant !== 'undefined' && report.sourceVariant) {
                const v = Variant.validate(report.sourceVariant);
                if (!v.ok) throw new Error('source variant ' + report.sourceVariant + ' is invalid: ' + v.problems.join('; '));
            }
            return 'ok';
        });
        const snapshot = step('snapshot', () => Migration.snapshot());
        Migration._snapshot = snapshot;
        report.rollbackAvailable = true;

        try {
            // 3-8. the preservation steps: recorded as assertions, proved at the end
            step('preserve-gameplay', () => snapshot.gameplayHash);
            step('preserve-entity-ids', () => snapshot.entityIds.length + ' ids');
            step('preserve-scene-ids', () => snapshot.sceneIds.join(',') || '-');
            step('preserve-coordinates', () => 'canonical x/y/z unchanged');
            step('preserve-rules', () => Object.keys(snapshot.rules).length + ' rules');
            step('preserve-save-schema', () => snapshot.saveSchemaHash);

            // 9. replace the visual mappings: the target variant + its registry variants
            const created = step('replace-visual-mappings', () => {
                const v = Migration._targetVariant(o, dstProfile, plan);
                report.targetVariant = v.id;
                const n = Migration._writeMappings(v, plan, o);
                return v.id + ' (' + n + ' role(s))';
            });

            // 10-12. camera, lighting and world presentation follow from the variant
            step('replace-camera', () => {
                if (o.activate === false) return 'deferred (activate: false)';
                return 'mode ' + (plan.camera.to.mode || '-') + ' / ' + plan.camera.to.projection;
            });
            step('replace-lighting', () => (o.activate === false ? 'deferred' : 'preset ' + plan.lighting.to));
            step('replace-world-presentation', () => (o.activate === false ? 'deferred' : plan.world.to + ' (' + plan.world.tiles + ' tiles)'));

            // 13. generate the missing visuals (placeholders) — never fail the conversion
            step('generate-placeholders', () => {
                if (o.generatePlaceholders === false) return 'skipped';
                const list = Migration.placeholders(plan);
                for (const ph of list) {
                    if (ph.path) report.assetsGenerated.push(ph.path);
                    if (typeof AssetRegistry !== 'undefined') AssetRegistry.markGenerated(ph.role + '@' + ph.profile, ph);
                }
                return list.length + ' placeholder(s), ' + report.assetsGenerated.length + ' file(s) to write';
            });

            // 14. validate the result BEFORE it is shown
            step('validate', () => {
                const proof = Migration.verify(snapshot);
                report.preserved = proof;
                if (!proof.ok) throw new Error('preservation failed: ' + proof.failed.join('; '));
                if (typeof Variant !== 'undefined' && report.targetVariant) {
                    const v = Variant.validate(report.targetVariant);
                    if (!v.ok) throw new Error('target variant invalid: ' + v.problems.join('; '));
                    report.variantWarnings = v.warnings.slice(0, 12);
                }
                return 'gameplay hash ' + proof.gameplayHash;
            });

            // 15. a render check when an engine is attached (headless: the model check above)
            step('headless-render', () => {
                if (typeof RenderProfile === 'undefined' || RenderProfile.isHeadless()) return 'headless: no engine backend attached';
                const backend = RenderProfile.backend();
                if (backend && typeof backend.renderCheck === 'function') {
                    const r = backend.renderCheck({ profile: dstProfile, variant: report.targetVariant }) || {};
                    report.renderTests = r.renderTests || 0;
                    report.visualTests = r.visualTests || 0;
                    if (r.errors && r.errors.length) throw new Error('render check: ' + r.errors.slice(0, 3).join('; '));
                    return 'render ok';
                }
                return 'no render check available';
            });

            // 16. commit: activate the target variant (unless the caller only wanted it created)
            step('commit', () => {
                if (o.activate === false) return 'created without activating';
                const r = RenderProfile.set(report.targetVariant || dstProfile, { reason: 'converted from ' + srcProfile, by: report.by, lenient: !!o.lenient });
                report.gameplayTests = (r.steps || []).filter(s => s.ok).length;
                report.applyReport = { ok: r.ok, warnings: (r.warnings || []).slice(0, 8), ms: r.ms };
                return 'active variant ' + (Variant.currentId ? Variant.currentId() : report.targetVariant);
            });

            // a destructive replace is a separate, explicit act — never the default
            if (o.preserveSource === false && o.destroySource === true && typeof Variant !== 'undefined' && report.sourceVariant && report.sourceVariant !== report.targetVariant) {
                step('destroy-source', () => { Variant.remove(report.sourceVariant); return report.sourceVariant + ' removed (explicit destroySource)'; });
            }
        } catch (e) {
            report.ok = false;
            report.status = 'rolledback';
            report.error = (e && e.message) || String(e);
            Migration.rollback();
            report.ms = Math.round((Migration._now() - t0) * 100) / 100;
            Migration._journal(report, 'rolledback');
            Migration.lastReport = report;
            throw e;
        }

        report.ms = Math.round((Migration._now() - t0) * 100) / 100;
        report.status = plan.noop && report.sourceVariant === report.targetVariant ? 'noop' : 'committed';
        Migration._journal(report, report.status);
        Migration.lastReport = report;
        return report;
    },

    /** The in-place wording of the spec: RenderProfile.convert('2d', 'full3d'). */
    apply(from, to, opts) { return Migration.convert(Object.assign({ source: from, target: to }, opts || {})); },

    /** Create (or reuse) the target variant of a conversion. */
    _targetVariant(o, dstProfile, plan) {
        if (typeof Variant === 'undefined') return { id: null, profile: dstProfile };
        const explicit = o.target && !RenderProfile.isKnown(o.target) ? String(o.target) : null;
        const id = explicit || Variant.idFor(dstProfile);
        if (Variant.has(id)) {
            const v = Variant.get(id);
            if (v.profile !== dstProfile && explicit) throw new Error('Migration: variant ' + id + ' presents ' + v.profile + ', not ' + dstProfile);
            return v;
        }
        return Variant.create({
            id: id,
            profile: dstProfile,
            name: o.name || Variant.defaultName(id, dstProfile),
            description: 'Converted from ' + plan.from + ' (non-destructive: the source variant is preserved)',
            createdBy: 'conversion',
            createdFrom: plan.sourceVariant || Variant.currentId()
        });
    },

    /**
     * Give the target variant its visual mapping: for every role, the asset that dresses it
     * in the target profile — the declared variant when there is one, a generated
     * placeholder path when there is not. The SHARED registry keeps every profile's entry,
     * so switching back needs no re-authoring.
     */
    _writeMappings(variant, plan, o) {
        if (typeof AssetRegistry === 'undefined') return 0;
        const mapping = {};
        let n = 0;
        for (const rec of AssetRegistry.roles()) {
            const res = AssetRegistry.resolve(rec.role, plan.to, { entityType: rec.entityType });
            if (res.asset && !res.missing) {
                mapping[rec.role] = mapping[rec.role] || {};
                mapping[rec.role][plan.to] = { type: res.type, asset: res.asset };
                n++;
                continue;
            }
            if (o.generatePlaceholders === false) continue;
            // no asset for this profile: declare the placeholder as the variant's choice and
            // add it to the shared registry, so the fallback chain stays honest.
            const ph = Migration.placeholderFor({ id: rec.role, type: rec.entityType || 'prop', role: rec.role, visual: {} },
                { type: AssetRegistry.defaultTypeFor(rec.entityType || 'prop', plan.to), placeholder: rec.placeholder, size: null }, plan.to);
            mapping[rec.role] = mapping[rec.role] || {};
            if (ph.path) {
                mapping[rec.role][plan.to] = { type: ph.type, asset: ph.path, generated: true };
                // Only a NEW path has to be registered: a declared one is already in the
                // registry and its file is about to be generated at exactly that path.
                if (!AssetRegistry.variant(rec.role, plan.to)) {
                    AssetRegistry.setVariant(rec.role, plan.to, { type: ph.type, asset: ph.path, generated: true });
                }
            } else {
                mapping[rec.role][plan.to] = { type: 'primitive', kind: ph.primitive || ph.kind || 'box' };
                AssetRegistry.setVariant(rec.role, plan.to, { type: 'primitive', kind: ph.primitive || ph.kind || 'box', generated: true });
            }
            n++;
        }
        if (typeof Variant !== 'undefined' && variant && variant.id) {
            Variant.setMappings(Variant.mappingName(variant.id), mapping);
            const v = Variant.get(variant.id);
            if (v) { v.visualMappings = 'presentation/mappings/' + Variant.mappingName(variant.id) + '.json'; Variant.create(v, { replace: true }); }
        }
        return n;
    },

    // --- snapshot / rollback ----------------------------------------------------------------------

    /** Everything a rollback needs: the model, the registry, the variants, the presentation. */
    snapshot() {
        return {
            at: new Date().toISOString(),
            spec: GameModel.booted() ? GameModel.toSpec() : null,
            registry: typeof AssetRegistry !== 'undefined' ? AssetRegistry.toSpec() : null,
            overlay: typeof AssetRegistry !== 'undefined' ? AssetRegistry.overlay() : null,
            overlayName: typeof AssetRegistry !== 'undefined' ? AssetRegistry.overlayName() : null,
            variants: typeof Variant !== 'undefined' ? Variant.exportAll() : null,
            activeVariant: typeof Variant !== 'undefined' ? Variant.currentId() : null,
            camera: typeof Camera !== 'undefined' ? Camera.params() : null,
            lighting: typeof Lighting !== 'undefined' ? Lighting.get() : null,
            gameplayHash: GameModel.booted() ? GameModel.gameplayHash() : null,
            saveSchemaHash: GameModel.booted() ? Save.schemaHash() : null,
            entityIds: GameModel.booted() ? GameModel.entities.map(e => e.id) : [],
            sceneIds: GameModel.booted() ? GameModel.scenes().map(s => s.id) : [],
            rules: GameModel.booted() ? GameModel.rules() : {},
            profile: GameModel.booted() ? GameModel.renderProfile() : null
        };
    },

    /** Restore the last snapshot (a failed conversion leaves the project exactly as it was). */
    rollback(snapshot) {
        const s = snapshot || Migration._snapshot;
        if (!s) return { ok: false, reason: 'nothing to roll back to' };
        if (s.spec) {
            GameModel.boot(s.spec);
            if (typeof AssetRegistry !== 'undefined' && s.registry) AssetRegistry.fromSpec(s.registry);
            if (typeof AssetRegistry !== 'undefined') AssetRegistry.setOverlay(s.overlay, s.overlayName);
        }
        if (typeof Variant !== 'undefined' && s.variants) {
            Variant.boot(s.variants);
            if (s.activeVariant && Variant.has(s.activeVariant)) Variant.activate(s.activeVariant, { apply: false });
        }
        if (typeof Camera !== 'undefined' && s.camera) Camera.applyConfig(s.camera);
        if (typeof Lighting !== 'undefined' && s.lighting) Lighting.applyConfig(s.lighting);
        if (typeof VisualEntity !== 'undefined' && typeof RenderProfile !== 'undefined' && !RenderProfile.isHeadless()) {
            try { RenderProfile.apply({ lenient: true }); } catch (e) { console.error('Migration.rollback: re-apply failed', e); }
        }
        Migration._snapshot = null;
        return { ok: true, restoredTo: s.at, profile: s.profile, variant: s.activeVariant };
    },

    /**
     * Prove that the game did not change: the digest a conversion must preserve.
     * Returns { ok, failed[], gameplayHash, entityIds, sceneIds, saveSchemaHash, coordinates }.
     */
    verify(snapshot) {
        const s = snapshot || Migration._snapshot;
        const failed = [];
        const nowHash = GameModel.booted() ? GameModel.gameplayHash() : null;
        const nowSave = GameModel.booted() ? Save.schemaHash() : null;
        const nowIds = GameModel.booted() ? GameModel.entities.map(e => e.id) : [];
        const nowScenes = GameModel.booted() ? GameModel.scenes().map(x => x.id) : [];
        if (!s) return { ok: false, failed: ['no snapshot'], gameplayHash: nowHash, entityIds: nowIds, sceneIds: nowScenes, saveSchemaHash: nowSave };
        if (s.gameplayHash !== nowHash) failed.push('gameplay hash changed (' + s.gameplayHash + ' -> ' + nowHash + ')');
        if (s.saveSchemaHash !== nowSave) failed.push('save schema changed (' + s.saveSchemaHash + ' -> ' + nowSave + ')');
        if (JSON.stringify(s.entityIds) !== JSON.stringify(nowIds)) failed.push('entity ids changed');
        if (JSON.stringify(s.sceneIds) !== JSON.stringify(nowScenes)) failed.push('scene ids changed');
        if (JSON.stringify(s.rules) !== JSON.stringify(GameModel.rules())) failed.push('rules changed');
        // logical coordinates: every entity stands where it stood
        const moved = [];
        if (s.spec && s.spec.entities) {
            for (const before of s.spec.entities) {
                const e = GameModel.entity(before.id);
                if (!e) { moved.push(before.id + ' (gone)'); continue; }
                if (!Coords.equals(Coords.from(before.position), e.position, 1e-6)) moved.push(before.id);
            }
        }
        if (moved.length) failed.push('logical coordinates changed: ' + moved.slice(0, 5).join(', '));
        return {
            ok: !failed.length, failed: failed,
            gameplayHash: nowHash, saveSchemaHash: nowSave,
            entityIds: nowIds.length, entityIdsPreserved: JSON.stringify(s.entityIds) === JSON.stringify(nowIds),
            sceneIds: nowScenes, sceneIdsPreserved: JSON.stringify(s.sceneIds) === JSON.stringify(nowScenes),
            coordinatesPreserved: !moved.length,
            rulesPreserved: JSON.stringify(s.rules) === JSON.stringify(GameModel.rules()),
            saveSchemaPreserved: s.saveSchemaHash === nowSave,
            gameplayPreserved: s.gameplayHash === nowHash
        };
    },

    // --- journal (§ VisualMigrationJournal) ----------------------------------------------------------

    /** Append a journal entry to the spec (the tooling writes it back into js/GameSpec.js). */
    _journal(report, status) {
        const entry = {
            id: 'mig-' + ((GameModel.booted() && GameModel.spec.visualMigrationJournal ? GameModel.spec.visualMigrationJournal.length : 0) + 1),
            from: report.from, to: report.to,
            source: report.sourceVariant || null, target: report.targetVariant || null,
            profile: report.to,
            timestamp: new Date().toISOString(),
            status: status,
            changes: Migration.changeList(),
            preserved: Migration.preserveList(),
            assetsGenerated: (report.assetsGenerated || []).slice(),
            fallbacksUsed: (report.fallbacksUsed || []).slice(0, 40),
            counts: report.plan ? report.plan.counts : null,
            preservedProof: report.preserved || null,
            error: report.error || null,
            rollbackAvailable: !!report.rollbackAvailable,
            ms: report.ms || 0,
            by: report.by || null
        };
        if (GameModel.booted()) {
            GameModel.spec.visualMigrationJournal = GameModel.spec.visualMigrationJournal || [];
            GameModel.spec.visualMigrationJournal.push(entry);
            if (GameModel.spec.visualMigrationJournal.length > 100) GameModel.spec.visualMigrationJournal.shift();
        }
        if (typeof Variant !== 'undefined') {
            Variant._record('convert', { from: report.from, to: report.to, source: entry.source, target: entry.target, status: status, by: entry.by });
        }
        Migration._lastEntry = entry;
        return entry;
    },

    /** The journal: "what changed when the game was converted to 3D?" */
    journal() {
        const spec = GameModel.booted() ? (GameModel.spec.visualMigrationJournal || []) : [];
        return JSON.parse(JSON.stringify(spec));
    },

    last() { return Migration._lastEntry ? JSON.parse(JSON.stringify(Migration._lastEntry)) : null; },

    /** A structured answer for an agent: the conversions of a project, newest first. */
    summarize() {
        const j = Migration.journal();
        return {
            conversions: j.length,
            profiles: [...new Set(j.map(e => e.to))],
            last: j.length ? j[j.length - 1] : null,
            assetsGenerated: [...new Set(j.flatMap(e => e.assetsGenerated || []))],
            rolledBack: j.filter(e => e.status !== 'committed').length,
            entries: j.slice().reverse()
        };
    },

    /** The machine-readable report an agent gets after a conversion. */
    inspect() {
        const r = Migration.lastReport;
        return {
            steps: Migration.steps(),
            preserve: Migration.preserveList(),
            change: Migration.changeList(),
            nonDestructive: true,
            last: r ? { ok: r.ok, from: r.from, to: r.to, status: r.status, targetVariant: r.targetVariant, counts: r.plan ? r.plan.counts : null, ms: r.ms } : null,
            journal: Migration.journal().slice(-5),
            snapshotHeld: !!Migration._snapshot
        };
    },

    _now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
};
