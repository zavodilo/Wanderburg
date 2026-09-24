// ============================================================================
//  ArcEngine — variants: generate, inspect, convert, validate (CLI + generator)
// ----------------------------------------------------------------------------
//  node tools/variants.mjs                     regenerate project.json, js/presentation/
//                                              Variants.js, presentation/profiles/*.json
//  node tools/variants.mjs --check             fail when the generated files drift
//  node tools/variants.mjs list|inspect|journal
//  node tools/variants.mjs validate [--all] [--json[=FILE]]
//  node tools/variants.mjs runtime --variant <id> [--frames N]   headless boot of one variant
//  node tools/variants.mjs plan --from <p|v> --to <p|v>
//  node tools/variants.mjs convert --source <v|p> [--target <v>] [--profile <p>]
//                                  [--dry-run] [--write-placeholders] [--no-activate]
//  node tools/variants.mjs create <id> --profile <p> [--name "…"]
//  node tools/variants.mjs clone <id> <newId> [--name "…"]
//  node tools/variants.mjs create-all
//  node tools/variants.mjs compare <a> <b>
//
//  Everything runs on the REAL semantic pipeline in node:vm (tools/headless.mjs): the same
//  GameModel, AssetRegistry, Variant, RenderProfile and Migration code the browser runs,
//  with no engine attached. That is the point of the architecture — a conversion is a
//  presentation operation, so it can be planned, applied and verified headlessly.
//
//  Conversions are NON-DESTRUCTIVE: the source variant file stays on disk, the target
//  variant file is created (or updated), the shared game source is never touched.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { bootPipeline, collectPresentation, scanAssets, ROOT } from './headless.mjs';
import { loadManifest } from './render-profiles.mjs';
import { writePlaceholderPng } from './placeholder.mjs';

const args = process.argv.slice(2);
const CMD = args.find(a => !a.startsWith('-')) || 'generate';
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => {
    const eq = args.find(a => a.startsWith('--' + n + '='));
    if (eq) return eq.slice(n.length + 3);
    const i = args.indexOf('--' + n);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    return d;
};
const positional = args.filter(a => !a.startsWith('-')).slice(1);
const JSON_ARG = args.find(a => a.startsWith('--json'));
const JSON_OUT = JSON_ARG && JSON_ARG.includes('=') ? JSON_ARG.slice(7) : null;
const AS_JSON = !!JSON_ARG;

const C = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', cyn: '\x1b[36m', yel: '\x1b[33m' };
const say = (m) => { if (!AS_JSON) console.log(m); };
const die = (m, code = 1) => { console.error('variants: ' + m); process.exit(code); };
const emit = (obj) => {
    const text = JSON.stringify(obj, null, 2) + '\n';
    if (JSON_OUT) { fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true }); fs.writeFileSync(JSON_OUT, text); say(C.dim + 'wrote ' + JSON_OUT + C.r); }
    else console.log(text);
};

// --- the canon on disk ---------------------------------------------------------
const VARIANTS_DIR = path.join(ROOT, 'presentation', 'variants');
const MAPPINGS_DIR = path.join(ROOT, 'presentation', 'mappings');
const PRESETS_DIR = path.join(ROOT, 'presentation', 'presets');
const PROFILES_DIR = path.join(ROOT, 'presentation', 'profiles');
const JOURNAL_FILE = path.join(ROOT, 'presentation', 'migration-journal.json');
const OUT_RUNTIME = path.join(ROOT, 'js', 'presentation', 'Variants.js');
const OUT_PROJECT = path.join(ROOT, 'project.json');

const readDir = (dir) => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort());
const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 4) + '\n'); };

function boot(opts = {}) {
    const presentation = collectPresentation(ROOT);
    const kit = bootPipeline(Object.assign({ files: scanAssets(ROOT) }, opts));
    if (presentation.project && presentation.project.defaultVariant) {
        // the default variant of project.json wins over the spec's profile
        presentation.variants = presentation.variants || {};
    }
    kit.PlayArcRuntime.start({ variants: presentation, apply: false, query: '' });
    return { kit, presentation };
}

// --- generation ------------------------------------------------------------------
function generated() {
    const presentation = collectPresentation(ROOT);
    const manifest = loadManifest(ROOT);
    const kit = bootPipeline({ files: scanAssets(ROOT), quiet: true });
    const spec = kit.GAME_SPEC;

    const variantIds = Object.keys(presentation.variants).sort();
    const defaultVariant = (presentation.project && presentation.project.defaultVariant && presentation.variants[presentation.project.defaultVariant])
        ? presentation.project.defaultVariant
        : (variantIds.find(id => presentation.variants[id].profile === spec.renderProfile) || variantIds[0] || null);

    const project = {
        id: spec.id,
        name: spec.title,
        kit: 'ArcEngine',
        version: (typeof kit.get('GAME_VERSION') === 'string' ? kit.get('GAME_VERSION') : '0.1.0'),
        schemaVersion: 1,
        defaultVariant: defaultVariant,
        profiles: manifest.order.slice(),
        variants: variantIds,
        variantFiles: Object.fromEntries(variantIds.map(id => [id, 'presentation/variants/' + id + '.json'])),
        gameModel: 'js/GameSpec.js',
        assetRegistry: 'GAME_SPEC.assets + presentation/mappings/*.json',
        runtime: {
            entry: 'js/presentation/Runtime.js (PlayArcRuntime.start)',
            url: '/?project=' + spec.id + '&variant=<variantId>',
            cli: 'node tools/arc.mjs run --variant <variantId>',
            all: 'node tools/arc.mjs run --all'
        },
        shared: {
            gameplay: 'ONE Game Model for every variant: rules, systems, world, entities, progression, save schema',
            entityIds: (spec.entities || []).map(e => e.id),
            scenes: (spec.scenes || []).map(s => s.id)
        },
        generated: 'tools/variants.mjs from js/GameSpec.js + presentation/variants/*.json'
    };

    const runtimeBody = `// Variants.js — GENERATED by tools/variants.mjs — do not edit by hand.
// The Master Project and its visual variants as the runtime reads them (no fetch, no build
// step). Canon: js/GameSpec.js (the shared game model) + presentation/variants/*.json (one
// file per variant) + presentation/mappings/*.json + presentation/presets/*.json.
// A variant is CONFIGURATION, never a copy: every entry presents the same GAME_SPEC.
/** @satisfies {Record<string, any>} */
const PROJECT_VARIANTS = ${JSON.stringify({
        project: project,
        variants: presentation.variants,
        mappings: presentation.mappings,
        presets: presentation.presets,
        journal: fs.existsSync(JOURNAL_FILE) ? JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')) : []
    }, null, 4)};
`;

    const profileFiles = new Map();
    for (const id of manifest.order) {
        profileFiles.set('presentation/profiles/' + id + '.json', JSON.stringify(Object.assign({
            $generated: 'tools/variants.mjs from manifest/render-profiles.json — the profile canon',
            $canon: 'manifest/render-profiles.json'
        }, manifest.profiles[id]), null, 4) + '\n');
    }

    return { project, runtimeBody, profileFiles, manifest, variantIds, defaultVariant };
}

function generate() {
    const g = generated();
    writeJson(OUT_PROJECT, g.project);
    fs.writeFileSync(OUT_RUNTIME, g.runtimeBody);
    for (const [rel, body] of g.profileFiles) {
        const abs = path.join(ROOT, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
    }
    say('variants: project.json + js/presentation/Variants.js + ' + g.profileFiles.size + ' profile files (' + g.variantIds.length + ' variants, default ' + g.defaultVariant + ')');
}

function checkDrift() {
    const g = generated();
    let drift = 0;
    const cmp = (file, body) => {
        const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if (have !== body) { console.error('  drift: ' + path.relative(ROOT, file)); drift++; }
    };
    cmp(OUT_PROJECT, JSON.stringify(g.project, null, 4) + '\n');
    cmp(OUT_RUNTIME, g.runtimeBody);
    for (const [rel, body] of g.profileFiles) cmp(path.join(ROOT, rel), body);
    // every enabled variant must be listed in project.json
    for (const id of g.variantIds) {
        if (!g.project.variants.includes(id)) { console.error('  drift: project.json misses variant ' + id); drift++; }
    }
    if (drift) { console.error('variants: ' + drift + ' file(s) drift — run node tools/variants.mjs'); process.exit(1); }
    say('variants: ok (' + g.variantIds.length + ' variants, ' + g.profileFiles.size + ' profiles, default ' + g.defaultVariant + ')');
}

// --- persistence -------------------------------------------------------------------
function persistVariant(kit, id) {
    const v = kit.Variant.get(id);
    if (!v) die('no variant ' + id);
    delete v.state;
    writeJson(path.join(VARIANTS_DIR, id + '.json'), v);
    const mapping = kit.Variant.mappings(id);
    if (mapping) writeJson(path.join(MAPPINGS_DIR, id + '.json'), mapping);
    return v;
}

function persistJournal(kit) {
    const journal = kit.Migration.journal();
    writeJson(JOURNAL_FILE, journal);
    return journal.length;
}

// --- commands ------------------------------------------------------------------------
const commands = {
    generate,
    check: checkDrift,

    list() {
        const { kit } = boot({ quiet: true });
        const rows = kit.Variant.list().map(v => ({
            id: v.id, name: v.name, profile: v.profile, enabled: v.enabled,
            createdBy: v.createdBy, createdFrom: v.createdFrom,
            default: kit.Variant.defaultId() === v.id
        }));
        if (AS_JSON) return emit({ project: kit.Variant.project, variants: rows });
        say(C.b + '  ' + (kit.Variant.project ? kit.Variant.project.name : 'project') + C.r + C.dim + ' — one Game Model, ' + rows.length + ' visual variant(s)' + C.r);
        for (const r of rows) {
            say('   ' + (r.default ? C.grn + '*' + C.r : ' ') + ' ' + C.cyn + r.id.padEnd(34) + C.r + r.profile.padEnd(13) + (r.enabled ? '' : C.dim + ' (disabled)' + C.r) + C.dim + ' ' + r.name + C.r);
        }
        say(C.dim + '   shared: ' + kit.GameModel.entities.length + ' entities, contract ' + kit.GameModel.contractHash() + ', gameplay ' + kit.GameModel.gameplayHash() + ', save schema ' + kit.Save.schemaHash() + C.r);
    },

    inspect() {
        const { kit } = boot({ quiet: true });
        emit({
            project: kit.Variant.project,
            runtime: kit.PlayArcRuntime.inspect(),
            profiles: kit.RenderProfile.list(),
            variants: kit.Variant.inspect(),
            assets: kit.AssetRegistry.inspect(),
            model: kit.GameModel.inspect(),
            migration: kit.Migration.inspect()
        });
    },

    journal() {
        const { kit } = boot({ quiet: true });
        emit(kit.Migration.summarize());
    },

    validate() {
        const { kit } = boot({ quiet: true });
        const only = opt('variant', null);
        const all = flag('all') || !only;
        const result = all ? kit.Variant.validateAll({ includeDisabled: flag('include-disabled') })
            : { ok: false, variants: [kit.Variant.validate(only)], count: 1 };
        // per-variant runtime checks: boot, entities, assets, camera, save
        for (const r of result.variants) {
            r.runtime = commands._runtimeChecks(kit, r.variant);
            if (!r.runtime.ok) r.ok = false;
        }
        result.ok = result.variants.every(v => v.ok);
        if (AS_JSON) return emit(result);
        say('\n' + C.cyn + C.b + '  ArcEngine' + C.r + ' ' + C.dim + '— variant validation' + C.r);
        for (const v of result.variants) {
            say('\n  ' + (v.ok ? C.grn + 'ok  ' + C.r : C.red + 'FAIL' + C.r) + ' ' + C.b + v.variant + C.r + C.dim + ' (' + v.profile + ')' + C.r);
            for (const p of v.problems || []) say('      ' + C.red + 'problem: ' + p + C.r);
            const rt = v.runtime || {};
            say('      ' + C.dim + 'boot ' + (rt.booted ? 'ok' : 'FAIL') + ' · entities ' + rt.entities + ' · ids ' + (rt.entityIdsStable ? 'stable' : 'CHANGED') +
                ' · assets ' + rt.assetsResolved + '/' + rt.assets + ' resolved · placeholders ' + rt.placeholders +
                ' · camera ' + rt.cameraMode + '/' + rt.projection + ' · save ' + (rt.saveRoundTrip ? 'ok' : 'FAIL') + C.r);
            for (const w of (v.warnings || []).slice(0, 6)) say('      ' + C.yel + 'warn: ' + w + C.r);
        }
        say('\n  ' + (result.ok ? C.grn + C.b + 'All variants valid.' + C.r : C.red + C.b + 'Validation failed.' + C.r) + '\n');
        if (!result.ok) process.exitCode = 1;
    },

    /** The per-variant runtime checks (load, entities, assets, camera, UI, audio, save). */
    _runtimeChecks(kit, variantId) {
        const out = { booted: false, entities: 0, entityIdsStable: false, assets: 0, assetsResolved: 0, placeholders: 0, cameraMode: null, projection: null, saveRoundTrip: false, ok: false, problems: [] };
        const beforeIds = kit.GameModel.entities.map(e => e.id).join(',');
        const beforeHash = kit.GameModel.gameplayHash();
        try {
            const r = kit.PlayArcRuntime.start({ variant: variantId, apply: true });
            out.booted = !!r.ok;
            out.context = r.context;
        } catch (e) { out.problems.push('boot: ' + ((e && e.message) || e)); return out; }
        out.entities = kit.GameModel.entities.length;
        out.entityIdsStable = kit.GameModel.entities.map(e => e.id).join(',') === beforeIds;
        if (!out.entityIdsStable) out.problems.push('entity ids changed when presenting ' + variantId);
        if (kit.GameModel.gameplayHash() !== beforeHash) out.problems.push('gameplay hash changed when presenting ' + variantId);
        const bindings = kit.VisualEntity.sync(kit.GameModel.entities, kit.RenderProfile.config(), {});
        out.visuals = bindings;
        const assets = kit.AssetRegistry.roles();
        out.assets = assets.length;
        out.placeholders = 0;
        for (const a of assets) {
            const res = kit.AssetRegistry.resolve(a.role, kit.RenderProfile.id(), { entityType: a.entityType });
            if (!res.missing) out.assetsResolved++;
            if (res.resolvedBy === 'placeholder') out.placeholders++;
        }
        out.cameraMode = kit.Camera.getMode();
        out.projection = kit.Camera.params().projection;
        const prof = kit.RenderProfile.profile();
        if (out.projection !== prof.projection) out.problems.push('camera projection ' + out.projection + ' != profile ' + prof.projection);
        // save round trip: the schema is the same in every variant
        const data = kit.Save.serialize({ slot: 'validate' });
        const restored = kit.Save.restore(JSON.parse(JSON.stringify(data)));
        out.saveRoundTrip = restored.restored === kit.GameModel.entities.length;
        if (!out.saveRoundTrip) out.problems.push('save round trip restored ' + restored.restored + ' of ' + kit.GameModel.entities.length);
        out.saveSchemaHash = kit.Save.schemaHash();
        out.gameplayHash = kit.GameModel.gameplayHash();
        out.ok = !out.problems.length;
        return out;
    },

    runtime() {
        const variantId = opt('variant', null) || opt('v', null);
        const { kit } = boot({ quiet: true });
        if (!variantId) die('runtime: pass --variant <id> (or --all for every variant)');
        const frames = Number(opt('frames', 3));
        const r = kit.PlayArcRuntime.start({ variant: variantId, apply: true });
        const out = { ok: !!r.ok, context: r.context, model: r.model, frames: [], checks: commands._runtimeChecks(kit, variantId) };
        // a few headless frames: the systems run, the animation state is applied, nothing throws
        for (let i = 0; i < frames; i++) {
            const ran = kit.GameModel.run(1 / 60);
            kit.GameAnimation.update(1 / 60);
            kit.Input.update();
            out.frames.push({ frame: i + 1, systems: ran, state: kit.GameAnimation.state(kit.GameAnimation.subject()) });
        }
        out.presentation = {
            profile: kit.RenderProfile.id(),
            camera: kit.Camera.inspect(),
            lighting: kit.Lighting.get(),
            visuals: kit.VisualEntity.inspect(),
            budget: kit.RenderProfile.checkBudget(kit.RenderProfile.id())
        };
        if (AS_JSON) return emit(out);
        say(C.b + '  runtime ' + variantId + C.r + C.dim + ' (headless: no engine attached)' + C.r);
        say('   project   ' + out.context.project);
        say('   profile   ' + C.cyn + out.context.profile + C.r + '   instance ' + out.context.instance);
        say('   contract  ' + (out.context.contractHash || '-') + '   gameplay ' + out.context.gameplayHash + '   save schema ' + out.context.saveSchemaHash);
        say('   camera    ' + out.presentation.camera.mode + ' / ' + out.presentation.camera.params.projection +
            ' az ' + out.presentation.camera.params.azimuthDeg + '° el ' + out.presentation.camera.params.elevationDeg + '°');
        say('   lighting  ' + (out.presentation.lighting.preset || '-'));
        say('   visuals   ' + out.presentation.visuals.bindings + ' binding(s), ' + out.presentation.visuals.missing + ' placeholder(s)');
        say('   frames    ' + out.frames.length + ' ok, systems per frame ' + (out.frames[0] ? out.frames[0].systems : 0));
        say('   checks    ' + (out.checks.ok ? C.grn + 'ok' + C.r : C.red + 'FAIL ' + out.checks.problems.join('; ') + C.r));
        if (!out.checks.ok) process.exitCode = 1;
    },

    plan() {
        const { kit } = boot({ quiet: true });
        const from = opt('from', opt('source', kit.RenderProfile.id()));
        const to = opt('to', opt('target', opt('profile', null)));
        if (!to) die('plan: pass --to <profile|variant>');
        const plan = kit.Migration.plan(from, to);
        if (AS_JSON) return emit(plan);
        say(C.b + '  migration plan' + C.r + ' ' + plan.from + ' → ' + plan.to + (plan.noop ? C.dim + ' (noop)' + C.r : ''));
        say('   preserve  ' + C.dim + plan.preserve.join(', ') + C.r);
        say('   change    ' + C.dim + plan.change.join(', ') + C.r);
        const c = plan.counts;
        say('   entities  ' + c.entities + '   preserved ' + c.preserved + '   visual replacements ' + c.visualReplacements);
        say('   assets    missing ' + c.missingAssets + '   fallback geometry ' + c.fallbackGeometry + '   generated ' + plan.generated.length);
        say('   camera    ' + c.cameraChanges + '   lighting ' + c.lightingChanges + '   world ' + c.worldChanges + '   ui ' + c.uiChanges);
        say('   gameplay  ' + C.grn + c.gameplayFilesChanged + ' file(s) changed' + C.r + '   hash ' + plan.gameplayHash);
        for (const w of plan.warnings) say('   ' + C.yel + 'warn: ' + w + C.r);
    },

    convert() {
        const { kit } = boot({ quiet: true });
        const source = opt('source', opt('from', null));
        const target = opt('target', opt('to', null));
        const profile = opt('profile', null);
        const o = {
            source: source, target: target && !kit.RenderProfile.isKnown(target) ? target : null,
            profile: profile || (target && kit.RenderProfile.isKnown(target) ? target : null),
            dryRun: flag('dry-run'), by: opt('by', 'cli'),
            activate: !flag('no-activate'), generatePlaceholders: !flag('no-placeholders')
        };
        if (!o.source && !o.profile && !o.target) die('convert: pass --source <variant|profile> and --target/--profile');
        let report;
        try { report = kit.Migration.convert(o); }
        catch (e) { die('convert failed and was rolled back: ' + ((e && e.message) || e)); }
        // write the results: the new variant, its mapping, the journal, the generated files
        const written = [];
        if (!o.dryRun) {
            if (report.targetVariant) { persistVariant(kit, report.targetVariant); written.push('presentation/variants/' + report.targetVariant + '.json'); }
            persistJournal(kit);
            written.push('presentation/migration-journal.json');
            if (flag('write-placeholders')) {
                const targetProfile = report.to;
                for (const ph of kit.Migration.placeholderAssets(targetProfile)) {
                    if (!ph.path) continue;
                    if (fs.existsSync(path.join(ROOT, ph.path))) continue;
                    const size = ph.size && ph.size.length ? { width: Math.round(ph.size[0]), height: Math.round(ph.size[1] || ph.size[0]) } : { width: 64, height: 64 };
                    const r = writePlaceholderPng(ROOT, ph.path, Object.assign({ color: ph.color, label: ph.label }, size));
                    written.push(r.path + ' (' + r.bytes + ' B)');
                }
                // the files exist now: the registry resolves them instead of a placeholder
                kit.AssetRegistry.setFileIndex(scanAssets(ROOT));
            }
            generate();
            written.push('project.json', 'js/presentation/Variants.js');
        }
        if (AS_JSON) return emit({ report: report, written: written });
        say('\n' + C.b + '  convert ' + report.from + ' → ' + report.to + C.r + (o.dryRun ? C.dim + ' (dry run)' + C.r : ''));
        say('   status    ' + (report.ok ? C.grn + report.status + C.r : C.red + report.status + ': ' + report.error + C.r));
        say('   source    ' + (report.sourceVariant || '-') + C.grn + ' (preserved)' + C.r);
        say('   target    ' + (report.targetVariant || '-'));
        const c = report.plan.counts;
        say('   entities  ' + c.entities + ' preserved, ' + c.visualReplacements + ' visual replacement(s), gameplay files changed ' + c.gameplayFilesChanged);
        say('   assets    ' + c.missingAssets + ' missing → ' + report.assetsGenerated.length + ' generated, ' + report.fallbacksUsed.length + ' fallback(s)');
        if (report.preserved) {
            say('   proof     gameplay ' + (report.preserved.gameplayPreserved ? C.grn + 'identical' + C.r : C.red + 'CHANGED' + C.r) +
                ', entity ids ' + (report.preserved.entityIdsPreserved ? C.grn + 'identical' + C.r : C.red + 'CHANGED' + C.r) +
                ', save schema ' + (report.preserved.saveSchemaPreserved ? C.grn + 'identical' + C.r : C.red + 'CHANGED' + C.r) +
                ', coordinates ' + (report.preserved.coordinatesPreserved ? C.grn + 'identical' + C.r : C.red + 'CHANGED' + C.r));
        }
        say('   steps     ' + report.steps.map(s => s.id + (s.ok ? '' : C.red + '! ' + s.detail + C.r)).join(' '));
        for (const w of (report.plan.warnings || []).slice(0, 8)) say('   ' + C.yel + 'warn: ' + w + C.r);
        for (const w of written) say('   ' + C.dim + 'wrote ' + w + C.r);
        say('   time      ' + report.ms + ' ms\n');
        if (!report.ok) process.exitCode = 1;
    },

    create() {
        const id = positional[0];
        const profile = opt('profile', null);
        if (!id || !profile) die('create: node tools/variants.mjs create <id> --profile <profile>');
        const { kit } = boot({ quiet: true });
        const v = kit.Variant.createFromProfile(profile, { id: id, name: opt('name', null), by: 'cli' });
        persistVariant(kit, v.id);
        generate();
        say('variants: created ' + v.id + ' (profile ' + v.profile + ') -> presentation/variants/' + v.id + '.json');
    },

    clone() {
        const [src, dst] = positional;
        if (!src || !dst) die('clone: node tools/variants.mjs clone <id> <newId>');
        const { kit } = boot({ quiet: true });
        const v = kit.Variant.clone(src, dst, { name: opt('name', null) });
        persistVariant(kit, v.id);
        generate();
        say('variants: cloned ' + src + ' -> ' + v.id + ' (configuration only: the game source is shared)');
    },

    'create-all'() {
        const { kit } = boot({ quiet: true });
        const created = kit.Variant.createAll({ by: 'cli' });
        // Materialize every profile: Variant.boot() creates the missing ones in memory (so the
        // runtime always has a full set), which used to make this command report "kept" and
        // write NOTHING when presentation/variants/ was empty. The disk is the canon — a
        // variant that has no file gets one, whether it was just created or bootstrapped.
        for (const c of created) {
            if (!c.existed || !fs.existsSync(path.join(VARIANTS_DIR, c.id + '.json'))) persistVariant(kit, c.id);
        }
        generate();
        say('variants: ' + created.length + ' profile(s) covered — ' + created.map(c => c.id + (c.existed ? ' (kept)' : ' (new)')).join(', '));
    },

    compare() {
        const [a, b] = positional;
        if (!a || !b) die('compare: node tools/variants.mjs compare <variantA> <variantB>');
        const { kit } = boot({ quiet: true });
        const cmp = kit.Variant.compare(a, b);
        if (AS_JSON) return emit(cmp);
        say('\n' + C.b + '  ' + a + C.r + C.dim + ' (' + cmp.profiles.a + ')' + C.r + '  vs  ' + C.b + b + C.r + C.dim + ' (' + cmp.profiles.b + ')' + C.r);
        say('   ' + C.grn + 'shared:' + C.r + ' ' + C.dim + cmp.shared.join(', ') + C.r);
        say('   ' + C.cyn + 'presentation differences:' + C.r);
        for (const d of cmp.presentationDifferences) say('      ' + d.field.padEnd(16) + JSON.stringify(d.a) + '  ->  ' + JSON.stringify(d.b));
        if (cmp.missing.length) {
            say('   ' + C.yel + 'missing assets:' + C.r);
            for (const m of cmp.missing.slice(0, 12)) say('      ' + m.role + '  ' + m.a + ' / ' + m.b);
        }
        say('   gameplay hash ' + cmp.gameplayHash + ' — identical for both variants\n');
    }
};

const cmd = commands[CMD];
if (!cmd) die('unknown command ' + CMD + ' (generate|check|list|inspect|journal|validate|runtime|plan|convert|create|clone|create-all|compare)');
if (CMD === 'generate' && flag('check')) commands.check();
else cmd();
