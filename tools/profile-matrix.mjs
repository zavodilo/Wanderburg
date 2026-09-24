// ============================================================================
//  ArcEngine — the profile / variant / migration matrix (headless, no browser)
// ----------------------------------------------------------------------------
//  node tools/profile-matrix.mjs [--json[=FILE]]
//
//  The test matrix of the unified visual pipeline, run on the real semantic code in
//  node:vm (tools/headless.mjs): the same GameModel/Registry/Variant/Migration the browser
//  runs, with the engine replaced by "nothing" — which is exactly the point: if a profile
//  or a migration needs the renderer to be correct, the architecture is broken.
//
//  Per profile:   project loads · scene loads · entities exist · ids stable · gameplay
//                 systems run · UI definition present · assets resolve · camera matches the
//                 profile · presentation applies (bindings) · save round-trips
//  Migrations:    the ladder 2d -> 2.5d -> isometric3d -> lowpoly3d -> full3d -> 2d and the
//                 direct 2d <-> full3d, 2.5d -> isometric3d, isometric3d -> lowpoly3d, each
//                 proving entity ids, world, rules, coordinates and the save schema survived
//  Variants:      every enabled variant validates (tools/variants.mjs validate)
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { bootPipeline, collectPresentation, scanAssets, ROOT } from './headless.mjs';

const args = process.argv.slice(2);
const JSON_ARG = args.find(a => a.startsWith('--json'));
const AS_JSON = !!JSON_ARG;
const JSON_OUT = JSON_ARG && JSON_ARG.includes('=') ? JSON_ARG.slice(7) : null;
const C = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', cyn: '\x1b[36m', yel: '\x1b[33m' };
const say = (m) => { if (!AS_JSON) console.log(m); };

const LADDER = ['2d', '2.5d', 'isometric3d', 'lowpoly3d', 'full3d'];
const MIGRATIONS = [
    ['2d', '2.5d'], ['2.5d', 'isometric3d'], ['isometric3d', 'lowpoly3d'], ['lowpoly3d', 'full3d'],
    ['full3d', '2d'], ['2d', 'full3d'], ['full3d', '2d'], ['2.5d', 'isometric3d'], ['isometric3d', 'lowpoly3d']
];

/** One profile of the matrix. */
function checkProfile(kit, profileId) {
    const out = { profile: profileId, ok: true, checks: {}, problems: [] };
    const fail = (m) => { out.ok = false; out.problems.push(m); };
    try {
        kit.PlayArcRuntime.start({ profile: profileId, apply: true });
        out.checks.boot = true;
    } catch (e) { fail('boot: ' + ((e && e.message) || e)); return out; }
    const cfg = kit.RenderProfile.config();
    out.checks.scene = !!kit.GameModel.activeScene;
    out.checks.entities = kit.GameModel.entities.length;
    // A project may declare no entities yet (the `empty` starter, a game that spawns everything
    // from code): legal, but then there is nothing to present and the checks below are vacuous.
    if (!out.checks.entities) out.checks.noEntities = true;
    out.checks.entityIds = kit.GameModel.entities.map(e => e.id);
    out.checks.gameplayHash = kit.GameModel.gameplayHash();
    out.checks.saveSchemaHash = kit.Save.schemaHash();
    // gameplay systems run without a renderer
    const ran = kit.GameModel.run(1 / 60) + kit.GameModel.run(1 / 60);
    out.checks.systems = ran;
    // the UI definition exists and is profile-independent
    out.checks.ui = (kit.GAME_SPEC.ui && kit.GAME_SPEC.ui.elements || []).length;
    if (!out.checks.ui) fail('no UI definition');
    // assets resolve for this profile (a placeholder counts as resolved, and is reported)
    const roles = kit.AssetRegistry.roles();
    let resolved = 0, placeholders = 0;
    const unresolved = [];
    for (const r of roles) {
        const res = kit.AssetRegistry.resolve(r.role, profileId, { entityType: r.entityType });
        // A GENERATED placeholder IS the resolution the registry promises ("a missing asset
        // degrades to a placeholder instead of breaking the game or blocking a migration"), so it
        // counts as resolved and is reported separately. Only a role that resolves to neither a
        // file nor a placeholder is a failure. A project with no imported art (every mesh built
        // in code) legitimately resolves all of its roles to placeholders.
        if (res.resolvedBy === 'placeholder' || res.resolvedBy === 'unresolved') {
            placeholders++;
            if (!res.placeholder) unresolved.push(r.role);
        } else resolved++;
    }
    out.checks.assets = { roles: roles.length, resolved, placeholders };
    if (!roles.length) fail('the registry has no roles');
    for (const role of unresolved) fail('role ' + role + ' resolves to nothing (no file, no placeholder)');
    // the camera matches the profile's projection and one of its modes
    const cam = kit.Camera.params();
    const prof = kit.RenderProfile.info(profileId);
    out.checks.camera = { projection: cam.projection, mode: cam.mode, follow: cam.follow };
    if (cam.projection !== prof.projection) fail('camera projection ' + cam.projection + ' != ' + prof.projection);
    if (!(prof.camera.modes || []).includes(cam.mode)) fail('camera mode ' + cam.mode + ' not allowed by ' + profileId);
    // presentation applies: every visible entity gets a binding of a type the profile allows
    const rep = kit.VisualEntity.sync(kit.GameModel.entities, cfg, {});
    out.checks.bindings = rep.bindings;
    out.checks.byType = rep.byType;
    // A project may present its own entities (representation 'none': a view module on the engine
    // layer). Those count as presented — the pipeline must not draw a second copy of them.
    out.checks.selfPresented = rep.selfPresented;
    if (out.checks.entities && !rep.bindings && !rep.selfPresented) fail('nothing is presented');
    const allowed = prof.entityRepresentations.allowed;
    for (const b of kit.VisualEntity.bindings()) {
        if (!allowed.includes(b.type)) fail('binding type ' + b.type + ' not allowed by ' + profileId);
    }
    // the world presents (tiles/ground) without touching the world data
    const world = kit.VisualEntity.presentWorld(cfg, {});
    out.checks.world = { ground: world.ground, tiles: world.tiles };
    // animation states map to the profile's system
    const anim = kit.GameAnimation.system(profileId);
    out.checks.animation = anim.system;
    // save round trip: same schema, same entities
    const data = kit.Save.serialize({ slot: 'matrix' });
    const before = kit.GameModel.entities.map(e => e.id).join(',');
    const restored = kit.Save.restore(JSON.parse(JSON.stringify(data)));
    out.checks.save = restored.restored;
    if (restored.restored !== kit.GameModel.entities.length) fail('save round trip restored ' + restored.restored);
    if (kit.GameModel.entities.map(e => e.id).join(',') !== before) fail('entity ids changed across a save');
    // the budget is machine-readable and checked
    const budget = kit.RenderProfile.checkBudget(profileId);
    out.checks.budget = { ok: budget.ok, tier: budget.tier, warnings: budget.warnings };
    return out;
}

/** One conversion of the matrix. */
function checkMigration(kit, from, to) {
    const out = { from: from, to: to, ok: true, problems: [] };
    const fail = (m) => { out.ok = false; out.problems.push(m); };
    const idsBefore = kit.GameModel.entities.map(e => e.id).join(',');
    const hashBefore = kit.GameModel.gameplayHash();
    const saveBefore = kit.Save.schemaHash();
    const worldBefore = JSON.stringify(kit.GameModel.world.toSpec());
    const rulesBefore = JSON.stringify(kit.GameModel.rules());
    const posBefore = JSON.stringify(kit.GameModel.entities.map(e => [e.id, e.position]));
    let report = null;
    try {
        report = kit.Migration.convert({ source: from, target: to, by: 'matrix' });
    } catch (e) {
        fail('convert threw: ' + ((e && e.message) || e));
        return out;
    }
    if (!report.ok) fail('report not ok: ' + report.error);
    out.status = report.status;
    out.steps = report.steps.length;
    out.counts = report.plan.counts;
    out.assetsGenerated = report.assetsGenerated.length;
    if (report.plan.counts.gameplayFilesChanged !== 0) fail('gameplay files changed');
    if (kit.GameModel.entities.map(e => e.id).join(',') !== idsBefore) fail('entity ids changed');
    if (kit.GameModel.gameplayHash() !== hashBefore) fail('gameplay hash changed');
    if (kit.Save.schemaHash() !== saveBefore) fail('save schema changed');
    if (JSON.stringify(kit.GameModel.world.toSpec()) !== worldBefore) fail('the world changed');
    if (JSON.stringify(kit.GameModel.rules()) !== rulesBefore) fail('the rules changed');
    if (JSON.stringify(kit.GameModel.entities.map(e => [e.id, e.position])) !== posBefore) fail('logical coordinates changed');
    if (kit.RenderProfile.id() !== to) fail('after the conversion the profile is ' + kit.RenderProfile.id());
    // the source profile is still presentable (non-destructive)
    const srcVariant = kit.Variant.forProfile(from);
    if (!srcVariant) fail('the source variant of ' + from + ' disappeared (destructive!)');
    out.journal = kit.Migration.journal().length;
    return out;
}

// --- run -------------------------------------------------------------------------
const kit = bootPipeline({ files: scanAssets(ROOT), quiet: true });
kit.PlayArcRuntime.start({ variants: collectPresentation(ROOT), apply: false });
const baseHash = kit.GameModel.gameplayHash();
const baseContract = kit.GameModel.contractHash();
const baseSave = kit.Save.schemaHash();
const baseIds = kit.GameModel.entities.map(e => e.id).join(',');

say('\n' + C.cyn + C.b + '  ArcEngine' + C.r + ' ' + C.dim + '— profile / migration matrix (headless)' + C.r);
say('  ' + C.dim + 'project ' + kit.Variant.project.id + ' · contract ' + baseContract + ' · gameplay hash ' + baseHash + ' · save schema ' + baseSave + C.r);

const profiles = LADDER.map(p => checkProfile(kit, p));
for (const p of profiles) {
    say('  ' + (p.ok ? C.grn + 'ok  ' + C.r : C.red + 'FAIL' + C.r) + ' profile ' + C.b + p.profile.padEnd(12) + C.r +
        C.dim + 'entities ' + p.checks.entities + ' · bindings ' + p.checks.bindings + ' ' + JSON.stringify(p.checks.byType || {}) +
        (p.checks.selfPresented ? ' · self-presented ' + p.checks.selfPresented : '') +
        ' · camera ' + (p.checks.camera ? p.checks.camera.projection + '/' + p.checks.camera.mode : '-') +
        ' · assets ' + (p.checks.assets ? p.checks.assets.resolved + '/' + p.checks.assets.roles : '-') +
        ' · save ' + (p.checks.save || 0) + C.r);
    for (const m of p.problems) say('      ' + C.red + m + C.r);
}

// the ladder, then the direct conversions
say('\n  ' + C.dim + 'conversions (non-destructive: the source variant always survives)' + C.r);
const migrations = [];
for (const [from, to] of [['2d', '2.5d'], ['2.5d', 'isometric3d'], ['isometric3d', 'lowpoly3d'], ['lowpoly3d', 'full3d'], ['full3d', '2d']]) {
    const m = checkMigration(kit, from, to);
    migrations.push(m);
    say('  ' + (m.ok ? C.grn + 'ok  ' + C.r : C.red + 'FAIL' + C.r) + ' ' + from.padEnd(12) + '→ ' + to.padEnd(12) +
        C.dim + 'steps ' + m.steps + ' · replacements ' + (m.counts ? m.counts.visualReplacements : 0) +
        ' · generated ' + (m.assetsGenerated || 0) + C.r);
    for (const p of m.problems) say('      ' + C.red + p + C.r);
}
for (const [from, to] of [['2d', 'full3d'], ['full3d', '2d'], ['2.5d', 'isometric3d'], ['isometric3d', 'lowpoly3d']]) {
    const m = checkMigration(kit, from, to);
    migrations.push(m);
    say('  ' + (m.ok ? C.grn + 'ok  ' + C.r : C.red + 'FAIL' + C.r) + ' ' + from.padEnd(12) + '→ ' + to.padEnd(12) + C.dim + '(direct)' + C.r);
    for (const p of m.problems) say('      ' + C.red + p + C.r);
}

// after all of that: the game is still the same game
const shared = {
    idsSame: kit.GameModel.entities.map(e => e.id).join(',') === baseIds,
    hashSame: kit.GameModel.gameplayHash() === baseHash,
    contractSame: kit.GameModel.contractHash() === baseContract,
    saveSame: kit.Save.schemaHash() === baseSave
};
say('\n  shared after ' + migrations.length + ' conversions: ids ' + (shared.idsSame ? C.grn + 'same' : C.red + 'CHANGED') + C.r +
    C.dim + ', contract ' + (shared.contractSame ? C.grn + 'same' : C.red + 'CHANGED') + C.r +
    C.dim + ', gameplay ' + (shared.hashSame ? C.grn + 'same' : C.red + 'CHANGED') + C.r +
    C.dim + ', save schema ' + (shared.saveSame ? C.grn + 'same' : C.red + 'CHANGED') + C.r);

// every variant of the project validates
const validation = kit.Variant.validateAll({});
say('  variants: ' + validation.count + ' validated, ' + (validation.ok ? C.grn + 'all ok' + C.r : C.red + validation.variants.filter(v => !v.ok).length + ' failed' + C.r));
for (const v of validation.variants) for (const p of v.problems || []) say('      ' + C.red + v.variant + ': ' + p + C.r);

const ok = profiles.every(p => p.ok) && migrations.every(m => m.ok) && shared.idsSame && shared.contractSame && shared.hashSame && shared.saveSame && validation.ok;
const report = { ok, profiles, migrations, shared, validation, contractHash: baseContract, gameplayHash: baseHash, saveSchemaHash: baseSave };
if (JSON_OUT) { fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true }); fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n'); say('  ' + C.dim + 'report: ' + path.resolve(JSON_OUT) + C.r); }
else if (AS_JSON) console.log(JSON.stringify(report, null, 2));
say('  ' + (ok ? C.grn + C.b + 'Matrix passed.' + C.r : C.red + C.b + 'Matrix FAILED.' + C.r) + '\n');
process.exit(ok ? 0 : 1);
