// ============================================================================
//  ArcEngine — headless kit context
// ----------------------------------------------------------------------------
//  Boots the SEMANTIC pipeline (core + presentation + profiles) in node:vm, exactly like
//  the browser does with <script> tags, but without PlayCanvas: no WebGL, no DOM, no
//  engine files. Everything renderer-independent runs for real — GameModel, WorldMap,
//  entities, the asset registry, variants, profiles, camera/lighting/animation state,
//  migrations, saves — which is what makes the tools and the tests honest:
//
//      const kit = bootPipeline();
//      kit.PlayArcRuntime.start({ variant: 'arcengine-sample-2d' });
//      kit.Migration.plan('2d', 'full3d');
//
//  The same files, the same order as index.html, the same code path as the browser. A
//  migration that works here works in the game; only the pixels differ.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

export const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

/** The semantic pipeline, in load order (a subset of index.html: no js/engine/*). */
export const PIPELINE = [
    'js/Constants.js',
    'js/GameSpec.js',
    'js/presentation/RenderProfiles.js',
    'js/presentation/Variants.js',
    'js/core/Coords.js',
    'js/core/Entity.js',
    'js/core/World.js',
    'js/core/GameModel.js',
    'js/core/Input.js',
    'js/core/GameAudio.js',
    'js/core/Save.js',
    'js/presentation/AssetRegistry.js',
    'js/presentation/Variant.js',
    'js/presentation/RenderProfile.js',
    'js/presentation/Camera.js',
    'js/presentation/Lighting.js',
    'js/presentation/Animation.js',
    'js/presentation/VisualEntity.js',
    'js/presentation/Migration.js',
    'js/profiles/2d/profile.js',
    'js/profiles/2.5d/profile.js',
    'js/profiles/isometric3d/profile.js',
    'js/profiles/lowpoly3d/profile.js',
    'js/profiles/full3d/profile.js',
    'js/presentation/Runtime.js'
];

const DESKTOP = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) ArcEngineHeadless', platform: 'Linux x86_64', maxTouchPoints: 0 };

/**
 * @param {{ scripts?: string[], root?: string, globals?: Record<string, any>, query?: string, files?: string[] | null, quiet?: boolean }} [opts]
 */
export function bootPipeline(opts = {}) {
    const root = opts.root || ROOT;
    const scripts = opts.scripts || PIPELINE;
    const store = new Map();
    const localStorage = {
        getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
        setItem: (k, v) => { store.set(String(k), String(v)); },
        removeItem: (k) => { store.delete(String(k)); }
    };
    const ctx = vm.createContext(Object.assign({
        console: opts.quiet ? { log() {}, warn() {}, error() {}, info() {} } : console,
        navigator: DESKTOP,
        innerWidth: 1280,
        innerHeight: 720,
        performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
        localStorage,
        sessionStorage: undefined,
        Date, JSON, Math, Set, Map, Promise, Number, String, Object, Array, Boolean, Error, RegExp, parseInt, parseFloat, isNaN, Uint16Array, Uint32Array, Float32Array, Infinity, NaN, undefined
    }, opts.globals || {}));
    ctx.window = ctx;
    ctx.globalThis = ctx;
    if (opts.query != null) ctx.location = { search: String(opts.query), href: 'http://localhost/' + String(opts.query) };
    for (const rel of scripts) {
        const file = path.join(root, rel);
        if (!fs.existsSync(file)) {
            // a scaffolded game may not ship every file (starters, --no-skills)
            if (opts.optional) continue;
            throw new Error('bootPipeline: missing script ' + rel);
        }
        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: rel });
    }
    const get = (name) => vm.runInContext(name, ctx);
    /** Every asset file that exists, so AssetRegistry.exists() is truthful. */
    const files = opts.files !== undefined ? opts.files : scanAssets(root);
    if (files) get('AssetRegistry').setFileIndex(files);

    const api = {
        ctx, get, root, files,
        Coords: get('Coords'),
        Entity: get('Entity'),
        World: get('World'),
        WorldMap: get('WorldMap'),
        GameModel: get('GameModel'),
        Input: get('Input'),
        GameAudio: get('GameAudio'),
        Save: get('Save'),
        AssetRegistry: get('AssetRegistry'),
        Variant: get('Variant'),
        RenderProfile: get('RenderProfile'),
        ArcProfiles: get('ArcProfiles'),
        Camera: get('Camera'),
        Lighting: get('Lighting'),
        GameAnimation: get('GameAnimation'),
        VisualEntity: get('VisualEntity'),
        Migration: get('Migration'),
        PlayArcRuntime: get('PlayArcRuntime'),
        RENDER_PROFILES: get('RENDER_PROFILES'),
        GAME_SPEC: get('GAME_SPEC')
    };
    return api;
}

/** Every file under assets/ (relative posix paths) — the registry's existence index. */
export function scanAssets(root = ROOT, dir = 'assets') {
    const out = [];
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return out;
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else out.push(path.relative(root, full).split(path.sep).join('/'));
        }
    };
    walk(abs);
    return out.sort();
}

/** Read a JSON file from the project (null when absent). */
export function readJson(root, rel) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** The project's variants/mappings/presets as the runtime sees them (PROJECT_VARIANTS). */
export function collectPresentation(root = ROOT) {
    const variants = {};
    const mappings = {};
    const presets = {};
    const dirOf = (sub) => path.join(root, 'presentation', sub);
    const readDir = (sub) => {
        const d = dirOf(sub);
        if (!fs.existsSync(d)) return [];
        return fs.readdirSync(d).filter(f => f.endsWith('.json')).sort();
    };
    for (const f of readDir('variants')) {
        const v = JSON.parse(fs.readFileSync(path.join(dirOf('variants'), f), 'utf8'));
        variants[v.id || f.replace(/\.json$/, '')] = v;
    }
    for (const f of readDir('mappings')) mappings[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dirOf('mappings'), f), 'utf8'));
    for (const f of readDir('presets')) {
        const p = JSON.parse(fs.readFileSync(path.join(dirOf('presets'), f), 'utf8'));
        presets[p.id || f.replace(/\.json$/, '')] = p;
    }
    const project = readJson(root, 'project.json');
    return { project, variants, mappings, presets };
}
