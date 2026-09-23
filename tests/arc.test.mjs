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
