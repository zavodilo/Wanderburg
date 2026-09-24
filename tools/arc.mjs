// ============================================================================
//  arc — the single cross-platform CLI of the kit (any OS: Windows/macOS/Linux)
// ----------------------------------------------------------------------------
//  node tools/arc.mjs <command> [args…]
//
//    run      [port] [--no-open] [--variant <id>] [--all]
//                                    game dev server (tools/dev-server.mjs); --all starts
//                                    one instance per visual variant (tools/run-all.mjs)
//    editor   [port] [--no-open]     editor server (_utils/editor/server.mjs)
//    check    [--types|--tests|--skills|--render|--visual|--all]
//    build    [--version=X|--no-zip|--force|--keep-unused|--quiet]
//    gate     [--render|--visual|--all]     headless render/visual gate (puppeteer, dev-only)
//    sync     [--check]              regenerate / verify the agent skill copies
//    manifest [--check]              regenerate / verify js/core/SceneSchema.js
//    profiles [--check]              regenerate / verify js/presentation/RenderProfiles.js
//    variant  <subcommand> …         variants: list|inspect|validate|runtime|plan|convert|
//                                    create|clone|create-all|compare|journal (--check regenerates)
//    validate [--all] [--json]       every variant: boot, entities, assets, camera, save
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
    manifest: { script: 'tools/manifest.mjs',          hint: 'regenerate js/core/SceneSchema.js from Constants.js + the editor schema' },
    profiles: { script: 'tools/render-profiles.mjs',   hint: 'regenerate js/presentation/RenderProfiles.js from manifest/render-profiles.json' },
    variant:  { script: 'tools/variants.mjs',          hint: 'visual variants: list, inspect, validate, runtime, plan, convert, create, clone, compare' },
    variants: { script: 'tools/variants.mjs',          hint: 'the same as `variant` (the generator form: no subcommand = regenerate)' },
    validate: { script: 'tools/variants.mjs',          hint: 'validate every visual variant of the project (--all, --json)' },
    scaffold: { script: 'tools/create-arcengine.mjs',  hint: 'scaffold a new game on the kit (starters kit/empty/survival)' }
};

export function dispatch(argv) {
    const [name, ...rest] = argv;
    if (!name || name === 'help' || name === '--help' || name === '-h') return usage(0);
    // `run --all`: one runtime instance per visual variant (one game model, many tabs)
    if (name === 'run' && (rest.includes('--all') || rest.includes('--variants'))) {
        const cmdAll = { script: 'tools/run-all.mjs' };
        const r = spawnSync(process.execPath, [path.join(ROOT, cmdAll.script), ...rest.filter(a => a !== '--all' && a !== '--variants')], { cwd: ROOT, stdio: 'inherit' });
        return r.status == null ? 1 : r.status;
    }
    // `run --variant <id>` / `--variant=<id>`: this instance presents one variant
    if (name === 'run') {
        const i = rest.indexOf('--variant');
        if (i >= 0 && rest[i + 1]) rest.splice(i, 2, '--variant=' + rest[i + 1]);
    }
    // `validate` is `variants validate`
    if (name === 'validate') rest.unshift('validate');
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
