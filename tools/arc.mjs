// ============================================================================
//  arc — the single cross-platform CLI of the kit (any OS: Windows/macOS/Linux)
// ----------------------------------------------------------------------------
//  node tools/arc.mjs <command> [args…]
//
//    run      [port] [--no-open]     game dev server (tools/dev-server.mjs)
//    editor   [port] [--no-open]     editor server (_utils/editor/server.mjs)
//    check    [--types|--tests|--skills|--render|--visual|--all]
//    build    [--version=X|--no-zip|--force|--keep-unused|--quiet]
//    gate     [--render|--visual|--all]     headless render/visual gate (puppeteer, dev-only)
//    sync     [--check]              regenerate / verify the agent skill copies
//    manifest [--check]              regenerate / verify js/SceneSchema.js
//    scaffold <dir> [--starter kit|empty|survival] [--no-skills] [--overwrite]
//
//  The .bat / .sh files at the repo root are THIN wrappers over this CLI; the servers
//  themselves pick a free port, print the URL and open the browser cross-platform.
//  Zero npm dependencies, as everything else in the kit.
// ============================================================================
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const COMMANDS = {
    run:      { script: 'tools/dev-server.mjs',        hint: 'game dev server: free port, prints the URL, opens the browser' },
    editor:   { script: '_utils/editor/server.mjs',    hint: 'editor server: location, camera, render settings, Objects/UI tabs' },
    check:    { script: 'tools/check.mjs',             hint: 'types + tests + skills sync + scene manifest (--all adds the headless gates)' },
    build:    { script: 'tools/build.mjs',             hint: 'playable zip archive of the game' },
    gate:     { script: 'tools/headless-gate.mjs',     hint: 'headless render/visual gate (needs puppeteer in the verify environment)' },
    sync:     { script: 'tools/sync-skills.mjs',       hint: 'regenerate .claude/skills, .agents/skills, .cursor/rules, AGENTS.md, agent-manifest.json' },
    manifest: { script: 'tools/manifest.mjs',          hint: 'regenerate js/SceneSchema.js from Constants.js + the editor schema' },
    scaffold: { script: 'tools/create-arcengine.mjs',  hint: 'scaffold a new game on the kit (starters kit/empty/survival)' }
};

export function dispatch(argv) {
    const [name, ...rest] = argv;
    if (!name || name === 'help' || name === '--help' || name === '-h') return usage(0);
    const cmd = COMMANDS[name];
    if (!cmd) {
        console.error('arc: unknown command ' + JSON.stringify(name) + '\n');
        return usage(1);
    }
    const r = spawnSync(process.execPath, [path.join(ROOT, cmd.script), ...rest], { cwd: ROOT, stdio: 'inherit' });
    if (r.error) { console.error('arc: ' + r.error.message); return 1; }
    return r.status == null ? 1 : r.status;
}

function usage(code) {
    console.log('arc — the cross-platform CLI of ArcEngine\n');
    console.log('  node tools/arc.mjs <command> [args…]\n');
    for (const [name, c] of Object.entries(COMMANDS)) {
        console.log('  ' + name.padEnd(9) + c.hint);
    }
    console.log('\n  Shortcuts: run.bat/editor.bat/check.bat/build.bat (Windows), ./run.sh … (macOS/Linux).');
    console.log('  Every command forwards its args; servers pick a free port and open the browser.');
    return code;
}

// direct run: node tools/arc.mjs …  (importers call dispatch() themselves)
const direct = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));
if (direct) process.exit(dispatch(process.argv.slice(2)));
