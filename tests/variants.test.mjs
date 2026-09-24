// Variants, the asset registry and non-destructive conversion (the Variant architecture).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootPipeline, collectPresentation, scanAssets, ROOT } from '../tools/headless.mjs';

const kit = bootPipeline({ files: scanAssets(ROOT), quiet: true });
const { Variant, RenderProfile, AssetRegistry, Migration, GameModel, VisualEntity } = kit;
kit.PlayArcRuntime.start({ variants: collectPresentation(ROOT), apply: false });

test('variants: one project, five presentations, each pointing at the same game model', () => {
    const list = Variant.list();
    assert.equal(list.length, 5);
    assert.deepEqual([...new Set(list.map(v => v.profile))].sort(), ['2.5d', '2d', 'full3d', 'isometric3d', 'lowpoly3d']);
    const hash = GameModel.gameplayHash();
    for (const v of list) {
        Variant.activate(v.id, { apply: false });
        assert.equal(Variant.currentId(), v.id);
        assert.equal(Variant.profileOf(v.id), v.profile);
        assert.equal(GameModel.gameplayHash(), hash, 'activating ' + v.id + ' must not touch gameplay');
    }
    assert.ok(Variant.defaultId());
});

// The inheritance MECHANISM, on a synthetic variant: this file is copied into every scaffolded
// game, so it must not know one project's variant ids or its authored numbers (a game that
// authors its own camera/lighting is the normal case, not a failure).
test('variant inheritance: profile defaults <- preset <- variant overrides <- scene preset', () => {
    const pid = RenderProfile.ids()[0];
    const info = RenderProfile.info(pid);
    Variant.setPreset('unit-inheritance-preset', { camera: { elevationDeg: 71 }, lighting: { preset: 'flat' } });
    const v = Variant.create({
        id: 'unit-inheritance', profile: pid, name: 'unit inheritance',
        camera: { preset: 'unit-inheritance-preset', elevationDeg: 88 },
        lighting: { shadows: 0 },
        scenes: { 'unit-scene': { camera: { azimuthDeg: 12 } } }
    }, { replace: true });
    const eff = Variant.effective(v.id);
    assert.equal(eff.id, pid);
    assert.equal(eff.variant, v.id);
    assert.equal(eff.camera.elevationDeg, 88, 'a variant override beats the preset it names');
    assert.equal(eff.lighting.preset, 'flat', 'the preset supplies what the variant does not');
    assert.equal(eff.lighting.shadows, 0, 'a named variant knob survives the merge');
    assert.equal(eff.camera.projection, info.projection, 'a variant never changes the profile identity');
    assert.equal(Variant.effective(v.id, 'unit-scene').camera.azimuthDeg, 12, 'a scene preset is the last word inside the variant');
    // a variant may only tighten the profile budget
    assert.throws(() => Variant.normalize({ id: 'x-loose', profile: pid, performance: { maxDrawCalls: 999999 } }), /loosens/);
    Variant.remove("unit-inheritance");
    assert.equal(Variant.has('unit-inheritance'), false, 'the synthetic variant is gone');
});

test('profiles cannot be loosened by a variant, and every profile keeps its camera identity', () => {
    for (const id of RenderProfile.ids()) {
        const p = RenderProfile.info(id);
        assert.ok(p.performanceBudget.maxDrawCalls > 0);
        assert.ok(['orthographic', 'perspective'].includes(p.projection));
        const cfg = Variant.forProfile(id) ? Variant.effective(Variant.forProfile(id).id) : RenderProfile.defaultsFor(id);
        assert.equal(cfg.camera.projection, p.projection);
    }
});

test('asset registry: roles resolve per profile with fallbacks, and placeholders never fail', () => {
    // Project-agnostic: whatever GAME_SPEC.assets declares, EVERY role resolves in EVERY profile
    // and never throws — that is the promise a migration relies on ("no art, no failure").
    const roles = AssetRegistry.roles();
    const files = scanAssets(ROOT);
    if (!roles.length) {
        // A minimal project declares no roles (the `empty` starter). The registry must still
        // answer for an UNKNOWN role with a generated placeholder instead of throwing — that is
        // the promise the rest of this test checks for declared roles.
        // An UNDECLARED role is reported unresolved/missing (a role nobody declared is a bug an
        // agent must see) and STILL produces a generated placeholder, so the game shows something.
        const unknown = AssetRegistry.resolve('no.such.role', '2d', { entityType: 'prop' });
        assert.equal(unknown.missing, true, 'an undeclared role is reported missing');
        assert.ok(unknown.placeholder && unknown.placeholder.generated, '...but it still draws a placeholder');
        return;
    }
    for (const pid of RenderProfile.ids()) {
        for (const r of roles) {
            const res = AssetRegistry.resolve(r.role, pid, { entityType: r.entityType });
            assert.ok(['variant', 'fallback', 'placeholder'].includes(res.resolvedBy),
                r.role + '/' + pid + ' resolved by ' + res.resolvedBy);
            // 'missing' is about the RESOLUTION, not about having a file: a primitive/particle
            // variant is complete geometry with asset === null and is not missing anything.
            assert.equal(res.missing, res.resolvedBy === 'placeholder' || res.resolvedBy === 'unresolved',
                r.role + '/' + pid + ': missing <=> nothing resolved');
            if (res.asset) assert.ok(files.includes(res.asset), r.role + '/' + pid + ': ' + res.asset + ' is not on disk');
            if (res.resolvedBy === 'placeholder') assert.ok(res.placeholder, r.role + '/' + pid + ': a placeholder describes itself');
        }
    }
    // a role that DOES declare a file for a profile resolves by 'variant'
    const withFile = roles.find(r => Object.keys(r.variants || {}).some(p => r.variants[p].asset));
    if (withFile) {
        const pid = Object.keys(withFile.variants).find(p => withFile.variants[p].asset);
        const res = AssetRegistry.resolve(withFile.role, pid, { entityType: withFile.entityType });
        assert.equal(res.resolvedBy, 'variant');
        assert.equal(res.missing, false);
        assert.equal(res.asset, withFile.variants[pid].asset);
        assert.ok(files.includes(res.asset), res.asset + ' is a real file of this project');
    }
    // the fallback chain respects the target profile: it starts at the profile asked for
    assert.equal(AssetRegistry.fallbackChain(roles[0].role, '2d')[0], '2d');
    assert.ok(AssetRegistry.fallbackChain(roles[0].role, '2d').length >= 1);
    // the variant overlay (visualMappings) wins without touching the shared registry
    const existing = files.find(f => /\.(png|jpg|jpeg|webp)$/i.test(f)) || files.find(f => /\.(glb|fbx)$/i.test(f));
    if (existing) {
        AssetRegistry.setOverlay({ [roles[0].role]: { '2d': { type: 'sprite', asset: existing } } }, 'unit');
        const ov = AssetRegistry.resolve(roles[0].role, '2d', { entityType: roles[0].entityType });
        assert.equal(ov.overlay, 'unit');
        assert.equal(ov.asset, existing);
        AssetRegistry.setOverlay(null);
        assert.equal(AssetRegistry.overlayName(), null);
    }
});

test('conversion is NON-DESTRUCTIVE: the source variant survives, the target is created', () => {
    const before = Variant.ids().sort().join(',');
    const idsBefore = GameModel.entities.map(e => e.id).join(',');
    const hashBefore = GameModel.gameplayHash();
    const schemaBefore = kit.Save.schemaHash();
    const source = Variant.defaultId() || Variant.ids()[0];
    const report = Migration.convert({ source: source, profile: 'full3d', by: 'unit', activate: false });
    assert.equal(report.ok, true);
    assert.equal(report.status, 'committed');
    assert.equal(report.plan.counts.gameplayFilesChanged, 0);
    assert.ok(report.sourceVariant, 'the source variant is reported');
    assert.equal(Variant.ids().sort().join(','), before, 'no variant disappeared');
    assert.equal(GameModel.entities.map(e => e.id).join(','), idsBefore);
    assert.equal(GameModel.gameplayHash(), hashBefore);
    assert.equal(kit.Save.schemaHash(), schemaBefore);
    // the journal records the conversion
    const j = Migration.journal();
    assert.ok(j.length >= 1);
    assert.equal(j[j.length - 1].status, 'committed');
    assert.ok(j[j.length - 1].rollbackAvailable);
});

test('a failed conversion rolls back: the project is exactly as it was', () => {
    const hash = GameModel.gameplayHash();
    const variants = Variant.ids().sort().join(',');
    const snap = Migration.snapshot();
    // corrupt the model on purpose, then roll back (a project may declare no entities at all —
    // the intruder alone must still come back to the exact snapshot)
    const first = GameModel.entities[0];
    if (first) first.set('health', 1);
    GameModel.entities.push({ id: 'ghost-intruder' });
    Migration.rollback(snap);
    assert.equal(GameModel.gameplayHash(), hash);
    assert.equal(Variant.ids().sort().join(','), variants);
});

test('the plan is a dry run: it counts, warns and changes nothing', () => {
    const hash = GameModel.gameplayHash();
    const plan = Migration.plan('2d', 'full3d');
    assert.equal(plan.from, '2d');
    assert.equal(plan.to, 'full3d');
    assert.equal(plan.counts.entities, GameModel.entities.length);
    assert.equal(plan.counts.preserved, plan.counts.entities);
    assert.equal(plan.counts.gameplayFilesChanged, 0);
    assert.ok(plan.preserve.includes('save_schema'));
    assert.ok(plan.change.includes('camera'));
    assert.ok(Array.isArray(plan.entities));
    assert.equal(GameModel.gameplayHash(), hash);
    const chk = RenderProfile.canConvert('2d', 'full3d');
    assert.equal(chk.ok, true);
    assert.equal(RenderProfile.canConvert('2d', 'nope').ok, false);
});

test('presentation: every entity is bound to what the profile allows, or self-presented', () => {
    // A game either lets the pipeline present its entities (a binding per entity, of a type the
    // profile allows) or presents them itself (representation 'none': a custom view module on the
    // engine layer). Both satisfy the contract; a silent zero does not.
    const total = GameModel.entities.length;
    for (const pid of RenderProfile.ids()) {
        kit.PlayArcRuntime.start({ profile: pid, apply: false });
        const cfg = RenderProfile.config();
        const rep = VisualEntity.sync(GameModel.entities, cfg, {});
        const allowed = RenderProfile.info(pid).entityRepresentations.allowed;
        for (const b of VisualEntity.bindings()) assert.ok(allowed.includes(b.type), pid + ': ' + b.type + ' is not allowed');
        assert.equal(rep.bindings + rep.selfPresented + rep.invisible, total, pid + ': every entity is accounted for');
        if (total) assert.ok(rep.bindings + rep.selfPresented >= 1, pid + ' presents nothing');
        for (const id of rep.selfPresentedIds) {
            const e = GameModel.entity(id);
            assert.equal(e.visualRequest(pid).type, 'none', id + ' is self-presented in ' + pid);
        }
    }
});

// --- regressions from porting a real game onto the pipeline (Wanderburg) -------------------------

test('a variant that does not pin zoom leaves the game the zoom it authored', () => {
    // Camera.applyConfig used to default an unauthored zoom to 1, so applying ANY variant
    // re-zoomed a game whose CAMERA_ZOOM is not 1 (a phone build, a game that zooms per state).
    const seen = [];
    kit.Camera.attachBackend({ camera: (p) => { seen.push(JSON.parse(JSON.stringify(p))); return { applied: true }; } });
    try {
        kit.Camera.applyConfig({ mode: 'orbit', projection: 'perspective' }, {});
        assert.equal(kit.Camera.params().zoom, null, 'null — nobody authored a zoom');
        assert.equal(kit.Camera.zoom(), 1, 'a reader still gets a number');
        assert.equal(seen[seen.length - 1].zoom, null, 'the engine is told not to touch the zoom');

        kit.Camera.applyConfig({ mode: 'orbit', projection: 'perspective', zoom: 1.5 }, {});
        assert.equal(kit.Camera.params().zoom, 1.5, 'an authored zoom is applied');
        // Camera.zoom(k) still works and clamps to the variant range
        const p = kit.Camera.params();
        kit.Camera.zoom(Math.max(p.zoomMin, Math.min(p.zoomMax, 2)));
        assert.ok(kit.Camera.zoom() >= p.zoomMin && kit.Camera.zoom() <= p.zoomMax);
    } finally {
        kit.Camera.attachBackend(null);
        kit.Camera._runtime.zoom = null;
    }
});

test('a self-presented entity counts as presented (a game may draw its own entities)', () => {
    // A project with its own view module on the engine layer declares representation 'none':
    // the pipeline must not draw a second copy, and must not report "this profile presents
    // nothing" either — the entity IS presented, by the game.
    kit.PlayArcRuntime.start({ profile: 'lowpoly3d', apply: false });
    const own = kit.Entity.create({ id: 'unit-selfpresented', type: 'vehicle', visual: { role: 'unit.self.visual', representation: 'none' } });
    const model = kit.GameModel.entities;
    const expected = model.filter(e => e.visualRequest('lowpoly3d').type !== 'none').length;
    const rep = kit.VisualEntity.sync([...model, own], kit.RenderProfile.config(), {});
    assert.ok(rep.selfPresentedIds.includes('unit-selfpresented'));
    assert.equal(rep.selfPresented >= 1, true);
    assert.equal(rep.bindings, expected, 'a self-presented entity gets no binding');
    // and it costs no draw call in the budget check
    // (the pipeline runs in a node:vm realm — compare through a same-realm copy)
    assert.deepEqual(JSON.parse(JSON.stringify(kit.VisualEntity.overBudget([own], { maxDrawCalls: 0 }))), []);
    kit.VisualEntity.sync(model, kit.RenderProfile.config(), {});   // leave the registry as it was
});
