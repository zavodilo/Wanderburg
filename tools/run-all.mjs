// ============================================================================
//  ArcEngine — run every visual variant of the project at once
// ----------------------------------------------------------------------------
//  node tools/run-all.mjs [--port=8080] [--no-open] [--project <id>] [--validate]
//
//  ONE Master Project, ONE game model, MANY runtime instances: this starts one dev server
//  per enabled variant (presentation/variants/*.json) on its own port and opens
//
//      http://localhost:8080/?project=<id>&variant=<variant-2d>
//      http://localhost:8081/?project=<id>&variant=<variant-2.5d>
//      …
//
//  in separate tabs. No files are copied and nothing is replaced: every tab serves the same
//  js/ and assets/ tree, and only the variant in the URL differs. Ctrl+C stops them all.
// ============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFile } from 'node:child_process';
import { collectPresentation, ROOT } from './headless.mjs';

const argv = process.argv.slice(2);
const NO_OPEN = argv.includes('--no-open');
const VALIDATE = argv.includes('--validate');
const portArg = argv.find(a => a.startsWith('--port='));
const BASE = portArg ? Number(portArg.split('=')[1]) : 8080;
const projectArg = argv.find(a => a.startsWith('--project='));
const PROJECT_FILTER = projectArg ? projectArg.split('=')[1] : null;

const C = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', cyn: '\x1b[36m', yel: '\x1b[33m' };

const presentation = collectPresentation(ROOT);
const project = presentation.project || {};
if (PROJECT_FILTER && project.id && PROJECT_FILTER !== project.id) {
    console.error('run-all: this project is ' + project.id + ', not ' + PROJECT_FILTER + ' (one repo = one Master Project)');
    process.exit(1);
}
const variants = Object.values(presentation.variants || {}).filter(v => v.enabled !== false);
if (!variants.length) {
    console.error('run-all: the project has no enabled variants — run `node tools/variants.mjs create-all`');
    process.exit(1);
}

console.log('\n' + C.cyn + C.b + '  ArcEngine' + C.r + ' ' + C.dim + '— one game model, ' + variants.length + ' runtime instances' + C.r);
console.log('  ' + C.dim + 'project ' + (project.id || '?') + ' · gameplay is shared, only presentation differs' + C.r);

/** @type {{ child: any, id: string, profile: string, url: string | null, port: number }[]} */
const running = [];

if (VALIDATE) {
    const r = spawn(process.execPath, [path.join(ROOT, 'tools/variants.mjs'), 'validate', '--all'], { cwd: ROOT, stdio: 'inherit' });
    r.on('exit', (code) => { if (code) process.exit(code); start(); });
} else start();

function start() {
    variants.forEach((v, i) => {
        const port = BASE + i;
        const args = [path.join(ROOT, 'tools/dev-server.mjs'), '--port=' + port, '--no-open',
            '--variant=' + v.id, '--project=' + (project.id || '')];
        const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        const rec = { child: child, id: v.id, profile: v.profile, url: null, port: port };
        running.push(rec);
        child.stdout.on('data', (d) => {
            const text = String(d);
            const m = text.match(/http:\/\/localhost:\d+\/\S*/);
            if (m && !rec.url) {
                rec.url = m[0];
                console.log('  ' + C.grn + '▲' + C.r + ' ' + rec.id.padEnd(34) + C.dim + rec.profile.padEnd(13) + C.r + rec.url);
                if (!NO_OPEN) open(rec.url);
            }
        });
        child.stderr.on('data', (d) => process.stderr.write('  [' + rec.id + '] ' + String(d)));
        child.on('exit', (code) => {
            if (code) console.log('  ' + C.red + '■' + C.r + ' ' + rec.id + ' exited with ' + code);
            if (running.every(r => r.child.exitCode !== null)) process.exit(0);
        });
    });

    const stop = () => {
        console.log('\n' + C.dim + '  stopping every runtime instance…' + C.r);
        for (const r of running) { try { r.child.kill('SIGTERM'); } catch (e) { /* already gone */ } }
        setTimeout(() => process.exit(0), 300);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    console.log('  ' + C.dim + 'Ctrl+C stops all of them' + C.r + '\n');
}

function open(addr) {
    const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const args = process.platform === 'win32' ? ['/c', 'start', '', addr] : [addr];
    execFile(cmd, args, () => {});
}
