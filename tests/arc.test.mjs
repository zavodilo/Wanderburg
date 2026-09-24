// arc CLI: the single cross-platform entry (ROADMAP: launcher layer). The .bat/.sh
// wrappers forward to it; servers keep their own port/browser logic.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from './browser-scripts.mjs';

const arc = (...args) => spawnSync(process.execPath, ['tools/arc.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });

test('arc help: список команд и подсказка про обёртки', () => {
    const r = arc('help');
    assert.equal(r.status, 0);
    for (const c of ['run', 'editor', 'check', 'build', 'gate', 'sync', 'manifest', 'scaffold']) {
        assert.match(r.stdout, new RegExp('^  ' + c, 'm'), c);
    }
    assert.match(r.stdout, /run\.bat/);
    assert.match(r.stdout, /run\.sh/);
});

test('arc: неизвестная команда — код 1 и список', () => {
    const r = arc('fly');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown command/);
});

test('arc sync/manifest --check: быстрые проверки через CLI', () => {
    assert.equal(arc('sync', '--check').status, 0);
    assert.equal(arc('manifest', '--check').status, 0);
});

test('обёртки существуют и форвардят в arc.mjs (bat — Windows, sh — Unix)', () => {
    for (const [cmd, ext] of [['run', 'bat'], ['editor', 'bat'], ['check', 'bat'], ['build', 'bat'],
        ['run', 'sh'], ['editor', 'sh'], ['check', 'sh'], ['build', 'sh']]) {
        const f = path.join(ROOT, cmd + '.' + ext);
        assert.ok(fs.existsSync(f), cmd + '.' + ext);
        const text = fs.readFileSync(f, 'utf8');
        assert.match(text, /arc\.mjs/, cmd + '.' + ext + ' форвардит в arc.mjs');
        assert.match(text, new RegExp('\\b' + cmd + '\\b'), cmd + '.' + ext);
    }
});

test('run.mjs/editor.mjs — тонкие форвардеры dispatch()', () => {
    for (const [f, cmd] of [['tools/run.mjs', 'run'], ['tools/editor.mjs', 'editor']]) {
        const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
        assert.ok(text.includes("dispatch(['" + cmd), f + ': dispatch([' + cmd + ' …)');
        assert.match(text, /from '\.\/arc\.mjs'/);
    }
});

// The published package is what `npx create-arcengine` scaffolds FROM: tools/create-arcengine.mjs
// copies its own tree, so anything missing from package.json#files is missing from every game
// created from npm. Regression: the unified visual pipeline (manifest/, presentation/,
// project.json) and the Unix wrappers were not listed, so a scaffolded game had no profile canon.
test('package.json#files carries everything a scaffolded game needs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const files = pkg.files || [];
    for (const need of ['tools/', 'js/', 'libs/', 'assets/', 'claude/', '_utils/', 'tests/',
        'manifest/', 'presentation/', 'project.json', 'index.html',
        'CLAUDE.md', 'AGENTS.md', 'README.md', 'LICENSE', 'NOTICE',
        'globals.d.ts', 'tsconfig.json', '*.bat', '*.sh']) {
        assert.ok(files.includes(need), 'package.json#files misses ' + need);
    }
    // the canon the runtime reads must exist in the repo too (a listed path that is not there
    // would silently ship nothing)
    for (const rel of ['manifest/render-profiles.json', 'manifest/game-schema.json', 'manifest/variant-schema.json',
        'manifest/asset-schema.json', 'manifest/migration-schema.json', 'project.json',
        'presentation/profiles/lowpoly3d.json', 'js/presentation/Variants.js', 'js/GameSpec.js']) {
        assert.ok(fs.existsSync(path.join(ROOT, rel)), rel + ' is packed but does not exist');
    }
});

// A gate that runs nothing and prints "all passed" is worse than no gate: `check --profiles` and
// `check --variants` used to match no step at all. Every known flag must run something, and a
// typo must fail instead of quietly falling back to the default profile.
test('check.mjs: каждый флаг запускает проверку, неизвестный флаг — ошибка', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools/check.mjs'), 'utf8');
    const knownLine = /const KNOWN = \[([^\]]+)\]/.exec(src);
    assert.ok(knownLine, 'check.mjs declares KNOWN flags');
    const known = knownLine[1].split(',').map(x => x.trim().replace(/['"]/g, '')).filter(Boolean);
    const stepped = [...src.matchAll(/\{ flag: '(--[a-z]+)'/g)].map(m => m[1]);
    for (const f of known) {
        assert.ok(stepped.includes(f), 'check.mjs: ' + f + ' не запускает ни одного шага — молчаливый «успех»');
    }
    const bogus = spawnSync(process.execPath, ['tools/check.mjs', '--no-such-flag'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(bogus.status, 1, 'неизвестный флаг должен падать');
    assert.match(bogus.stderr, /неизвестный флаг/);
});
