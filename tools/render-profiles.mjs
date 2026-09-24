// ============================================================================
//  ArcEngine — render profile manifest generator
// ----------------------------------------------------------------------------
//  node tools/render-profiles.mjs            regenerate js/presentation/RenderProfiles.js
//  node tools/render-profiles.mjs --check    fail if the generated file drifts
//
//  Canon: manifest/render-profiles.json (machine-readable, read by agents, the editor
//  and tools/migrate.mjs). Generated: js/presentation/RenderProfiles.js — a classic
//  script with RENDER_PROFILES, so the runtime reads the same canon without a fetch
//  and without JSON in the archive twice.
//
//  The generator also VALIDATES the manifest: a profile without a camera, an unknown
//  lighting profile, a budget missing a field or a migration step that is not in the
//  canonical list fail here, not in the browser.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const SRC = path.join(ROOT, 'manifest', 'render-profiles.json');
const OUT = path.join(ROOT, 'js', 'presentation', 'RenderProfiles.js');

const BUDGET_FIELDS = ['maxDrawCalls', 'maxTextureMemoryMB', 'maxShadowLights', 'maxTextureResolution',
    'maxParticles', 'maxPolycount', 'maxAnimatedEntities'];
const REP_TYPES = ['sprite', 'billboard', 'model', 'primitive', 'tile', 'terrain', 'particle', 'none'];
const ENTITY_TYPES = ['character', 'creature', 'prop', 'structure', 'vehicle', 'projectile', 'item',
    'terrain', 'trigger', 'zone', 'effect'];

/** @type {string[]} */
const problems = [];
const bad = (m) => problems.push(m);

export function loadManifest(root = ROOT) {
    const raw = fs.readFileSync(path.join(root, 'manifest', 'render-profiles.json'), 'utf8');
    let m;
    try { m = JSON.parse(raw); } catch (e) { throw new Error('manifest/render-profiles.json is not valid JSON: ' + e.message); }
    validate(m);
    return m;
}

export function validate(m) {
    problems.length = 0;
    if (!Array.isArray(m.order) || !m.order.length) bad('order: a non-empty list of profile ids is required');
    if (!m.profiles || typeof m.profiles !== 'object') bad('profiles: an object keyed by profile id is required');
    const ids = m.order || [];
    for (const id of ids) {
        const p = (m.profiles || {})[id];
        if (!p) { bad('profiles.' + id + ': declared in order but missing'); continue; }
        if (p.id !== id) bad('profiles.' + id + ': id mismatch (' + p.id + ')');
        for (const f of ['name', 'description', 'projection', 'geometry']) if (!p[f]) bad(id + ': field ' + f + ' is required');
        if (!['orthographic', 'perspective'].includes(p.projection)) bad(id + ': projection must be orthographic|perspective');
        // camera
        const cam = p.camera;
        if (!cam) bad(id + ': camera block is required');
        else {
            if (cam.projection !== p.projection) bad(id + ': camera.projection disagrees with the profile projection');
            if (!m.cameraModes || !m.cameraModes[cam.defaultMode]) bad(id + ': unknown camera.defaultMode ' + cam.defaultMode);
            if (m.cameraModes && m.cameraModes[cam.defaultMode] && m.cameraModes[cam.defaultMode].projection !== p.projection) {
                bad(id + ': default camera mode ' + cam.defaultMode + ' is ' + m.cameraModes[cam.defaultMode].projection + ', the profile is ' + p.projection);
            }
            for (const mode of cam.modes || []) if (!m.cameraModes || !m.cameraModes[mode]) bad(id + ': unknown camera mode ' + mode);
            if (p.projection === 'orthographic' && !(cam.orthoHeightPx > 0)) bad(id + ': orthoHeightPx is required for an orthographic profile');
            if (p.projection === 'perspective' && !(cam.fovDeg > 0)) bad(id + ': fovDeg is required for a perspective profile');
            for (const k of ['azimuthDeg', 'elevationDeg']) if (typeof cam[k] !== 'number') bad(id + ': camera.' + k + ' must be a number (parameterized, never hardcoded in code)');
        }
        // representations
        const er = p.entityRepresentations;
        if (!er) bad(id + ': entityRepresentations block is required');
        else {
            if (!REP_TYPES.includes(er.primary)) bad(id + ': unknown primary representation ' + er.primary);
            for (const t of er.allowed || []) if (!REP_TYPES.includes(t)) bad(id + ': unknown allowed representation ' + t);
            for (const et of ENTITY_TYPES) {
                if (!er.byType || !(et in er.byType)) bad(id + ': entityRepresentations.byType.' + et + ' is required');
                else if (!REP_TYPES.includes(er.byType[et])) bad(id + ': unknown representation for ' + et + ': ' + er.byType[et]);
                else if (er.allowed && !er.allowed.includes(er.byType[et])) bad(id + ': representation of ' + et + ' (' + er.byType[et] + ') is not in allowed');
            }
        }
        // world / depth / lighting / animation / ui / audio / physics / materials
        for (const f of ['worldRepresentation', 'depth', 'assetRequirements', 'lighting', 'animation', 'materials', 'physics', 'ui', 'audio']) {
            if (!p[f]) bad(id + ': block ' + f + ' is required');
        }
        if (p.lighting && !m.lightingProfiles[p.lighting.profile]) bad(id + ': unknown lighting profile ' + (p.lighting && p.lighting.profile));
        if (p.animation) {
            for (const s of p.animation.states || []) if (!m.animationStates.includes(s)) bad(id + ': unknown animation state ' + s);
        }
        // budget
        const b = p.performanceBudget;
        if (!b) bad(id + ': performanceBudget is required');
        else for (const f of BUDGET_FIELDS) if (typeof b[f] !== 'number') bad(id + ': performanceBudget.' + f + ' must be a number');
        if (!Array.isArray(p.capabilities) || !p.capabilities.length) bad(id + ': capabilities must be a non-empty list');
        if (!p.migrationRules) bad(id + ': migrationRules block is required');
    }
    for (const id of Object.keys(m.profiles || {})) if (!ids.includes(id)) bad('profiles.' + id + ': not listed in order');
    // migration block
    const mig = m.migration;
    if (!mig) bad('migration block is required');
    else {
        for (const f of ['preserve', 'change', 'steps']) if (!Array.isArray(mig[f]) || !mig[f].length) bad('migration.' + f + ' must be a non-empty list');
        for (const s of ['validate-source', 'snapshot', 'commit']) if (!(mig.steps || []).includes(s)) bad('migration.steps must include ' + s);
        for (const s of ['gameplay', 'entity_ids', 'save_schema']) if (!(mig.preserve || []).includes(s)) bad('migration.preserve must include ' + s);
        for (const s of ['camera', 'visual_assets', 'lighting']) if (!(mig.change || []).includes(s)) bad('migration.change must include ' + s);
    }
    // shared dictionaries
    for (const [name, dict] of [['cameraModes', m.cameraModes], ['lightingProfiles', m.lightingProfiles], ['representationTypes', m.representationTypes], ['tileKinds', m.tileKinds]]) {
        if (!dict || !Object.keys(dict).length) bad(name + ': dictionary is required');
    }
    for (const [k, t] of Object.entries(m.tileKinds || {})) {
        if (typeof t.blocked !== 'boolean') bad('tileKinds.' + k + '.blocked must be a boolean');
    }
    for (const f of BUDGET_FIELDS) if (!(m.performanceBudgetFields || []).includes(f)) bad('performanceBudgetFields must list ' + f);
    if (!m.coordinateSystem || m.coordinateSystem.y !== 'vertical / height (up)') bad('coordinateSystem: canonical axes are required (x horizontal, y height, z depth)');
    if (!m.aiDecisionRules || !Array.isArray(m.aiDecisionRules.examples)) bad('aiDecisionRules.examples: the AI decision rules are required');
    return problems.slice();
}

// --- generate -----------------------------------------------------------------
export function generate(m) {
    return `// RenderProfiles.js — GENERATED by tools/render-profiles.mjs — do not edit by hand.
// Canon: manifest/render-profiles.json. Machine-readable visual profile contract for the
// runtime, the editor, tools/migrate.mjs and AI agents: a profile decides HOW the game
// looks (camera, projection, representations, lighting, animation, depth, budget), never
// HOW it plays. Behaviour adapters: js/profiles/<id>/profile.js.
/** @satisfies {Record<string, any>} */
const RENDER_PROFILES = ${JSON.stringify(m, null, 4)};
`;
}

// --- CLI (importing this module for loadManifest()/validate() must not write anything) ----
const IS_MAIN = process.argv[1] && import.meta.url === url.pathToFileURL(path.resolve(process.argv[1])).href;

export function main() {
    const manifest = loadManifest();
    if (problems.length) {
        console.error('render-profiles: manifest problems');
        for (const p of problems) console.error('  - ' + p);
        process.exit(1);
    }
    const body = generate(manifest);
    if (CHECK) {
        const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
        if (have !== body) {
            console.error('render-profiles drift: js/presentation/RenderProfiles.js — run node tools/render-profiles.mjs');
            process.exit(1);
        }
        console.log('render-profiles: ok (' + manifest.order.length + ' profiles, manifest v' + manifest.manifestVersion + ')');
        return manifest;
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, body);
    console.log('render-profiles: js/presentation/RenderProfiles.js (' + manifest.order.join(', ') + ')');
    return manifest;
}

if (IS_MAIN) main();
