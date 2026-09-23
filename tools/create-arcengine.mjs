// ============================================================================
//  create-arcengine — scaffold a new game on the kit (ROADMAP phase C)
// ----------------------------------------------------------------------------
//  node tools/create-arcengine.mjs <target-dir> [--starter kit|empty|survival]
//                                   [--no-skills] [--overwrite]
//
//  Copies the whole kit (game, editor, tools, tests, skills canon) into <target-dir>,
//  overlays the starter's js/ files, regenerates the agent skill copies inside the
//  target (tools/sync-skills.mjs) unless --no-skills, and prints the next steps.
//  No npm, no build step: the target runs with `node tools/dev-server.mjs` alone.
//
//  Starters (scaffold/starters/<name>/):
//    kit      — the kit as is (sample Game.js, mill + character)   [default]
//    empty    — blank scene: no objects, no logic, title HUD only
//    survival — waves of wanderers chase the hero; Scene API + HUD by data
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => {
    const eq = argv.find(x => x.startsWith('--' + n + '='));
    if (eq) return eq.slice(n.length + 3);
    const i = argv.indexOf('--' + n);          // --starter survival (space form, like create-playcanvas)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const target = path.resolve(argv.find(a => !a.startsWith('--')) || '');
const starter = opt('starter', 'kit');
const NO_SKILLS = flag('no-skills');
const OVERWRITE = flag('overwrite');

const die = (m) => { console.error('create-arcengine: ' + m); process.exit(1); };
if (!target) die('target directory required: node tools/create-arcengine.mjs my-game');
if (!['kit', 'empty', 'survival'].includes(starter)) die('unknown starter ' + starter);
if (fs.existsSync(target)) {
    const entries = fs.readdirSync(target);
    if (entries.length && !OVERWRITE) die(target + ' is not empty (pass --overwrite)');
}

// --- copy the kit -------------------------------------------------------------
const EXCLUDE = new Set(['.git', 'build', 'dist', 'node_modules', 'verify', 'scaffold',
    '.claude', '.agents', '.cursor', 'AGENTS.md', 'package-lock.json']);
let files = 0;
const copy = (rel) => {
    const src = path.join(ROOT, rel);
    const st = fs.statSync(src);
    if (st.isDirectory()) {
        for (const e of fs.readdirSync(src, { withFileTypes: true })) {
            if (rel === '' && EXCLUDE.has(e.name)) continue;
            copy(path.join(rel, e.name));
        }
        return;
    }
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    files++;
};
copy('');

// --- starter overlay ----------------------------------------------------------
const sdir = path.join(ROOT, 'scaffold', 'starters', starter);
if (starter !== 'kit') {
    for (const f of fs.readdirSync(path.join(sdir, 'js'))) {
        fs.copyFileSync(path.join(sdir, 'js', f), path.join(target, 'js', f));
        files++;
    }
}

// --- agent skill copies inside the target --------------------------------------
if (!NO_SKILLS) {
    const r = spawnSync(process.execPath, ['tools/sync-skills.mjs'], { cwd: target, stdio: 'inherit' });
    if (r.status !== 0) die('skills sync failed in the target');
}

fs.writeFileSync(path.join(target, 'STARTER.md'),
    `# Starter: ${starter}\n\n` +
    (starter === 'kit'
        ? 'The kit as is: sample Game.js (Run button, energy bar), mill + character.\n'
        : starter === 'empty'
            ? 'Blank scene: no objects, no logic. Spawn from code or an agent:\n`Scene.spawn(\'assets/models/mill.fbx\', { kind: \'prop\', x: 900, y: 900 })`.\n'
            : 'Survival skeleton: waves of wanderers chase the hero (Scene API), stamina HUD by data.\n') +
    '\nRun: `node tools/dev-server.mjs` (game), `node _utils/editor/server.mjs` (editor),\n' +
    '`node tools/check.mjs` (types + tests + skills sync). Agents start from AGENTS.md / CLAUDE.md.\n');

console.log('create-arcengine: ' + files + ' files -> ' + path.relative(process.cwd(), target) +
    ' (starter: ' + starter + (NO_SKILLS ? ', no skills' : '') + ')');
console.log('next: cd ' + path.relative(process.cwd(), target) + ' && node tools/dev-server.mjs');
