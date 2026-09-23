// Editor server security contract (review P0): localhost-only bind, no path traversal,
// no dot-path serving, body limits, JSON validation, model import containment.
// The server is started on a free port; every probe must be rejected or contained.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ROOT } from './browser-scripts.mjs';

const PORT = 8391;
let srv;

before(async () => {
    srv = spawn(process.execPath, ['_utils/editor/server.mjs', '--port=' + PORT, '--no-open'], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/api/status`);
            if (r.ok) return;
        } catch { /* not up yet */ }
    }
    throw new Error('editor server did not start');
});

after(() => { if (srv) srv.kill(); });

const get = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, { redirect: 'manual' });
const post = (p, body, headers) => fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST', body, headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
});

test('статус отдаёт контракт, сервер слушает только localhost', async () => {
    const r = await get('/api/status');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    // the bind address is 127.0.0.1 in the server source (listen(port, '127.0.0.1'))
    const src = fs.readFileSync(path.join(ROOT, '_utils/editor/server.mjs'), 'utf8');
    assert.match(src, /listen\(port, '127\.0\.0\.1'/);
});

test('traversal и dot-пути отклоняются: /../, /%2e%2e/, /.git/, /.claude/', async () => {
    // '/../CLAUDE.md' is normalized by the URL parser to '/CLAUDE.md' — inside ROOT, served
    // by design (the static root IS the project); the encoded forms keep the dot segments
    // and must be rejected, together with every dot-path.
    const ok = await get('/../CLAUDE.md');
    assert.equal(ok.status, 200, 'URL normalization contains plain dot segments inside ROOT');
    await ok.text();
    for (const p of ['/..%2fCLAUDE.md', '/%2e%2e/%2e%2e/etc/passwd', '/.git/config',
        '/.claude/settings.local.json', '/js/..%2f..%2fpackage.json', '/_utils/.backups/']) {
        const r = await get(p);
        assert.ok(r.status === 403 || r.status === 404, p + ' -> ' + r.status);
        if (r.status === 403) await r.text();
    }
});

test('обычные маршруты редактора и игры продолжают отдаваться', async () => {
    for (const p of ['/_utils/editor/', '/js/Constants.js', '/index.html']) {
        const r = await get(p);
        assert.equal(r.status, 200, p);
        await r.text();
    }
});

test('битый JSON в save-constants — 400, а не 500', async () => {
    const r = await post('/api/save-constants', '{not json');
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.code, 'bad_json');
});

test('save-constants: инъекция в имени отклоняется по IDENT, файл не тронут', async () => {
    const before = fs.readFileSync(path.join(ROOT, 'js/Constants.js'), 'utf8');
    const r = await post('/api/save-constants', JSON.stringify({
        changes: [{ name: 'GAME_VERSION); globalThis.pwned = 1; //', value: 1 }]
    }));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.results[0].code, 'bad_name');
    assert.equal(fs.readFileSync(path.join(ROOT, 'js/Constants.js'), 'utf8'), before);
    assert.equal((globalThis).pwned, undefined);
});

test('save-objects: не-массив и левый model path отклоняются валидатором', async () => {
    let r = await post('/api/save-objects', JSON.stringify({ objects: { nope: 1 } }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, false);
    r = await post('/api/save-objects', JSON.stringify({
        objects: [{ name: 'x', model: '../../evil.glb', kind: 'prop', x: 0, y: 0, h: 0, rot: [0, 0, 0], scale: [1, 1, 1] }]
    }));
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.match(String(j.error), /assets/);
});

test('import-model: имя с traversal приводится к basename внутри assets/models', async () => {
    const glb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(64)]);
    const r = await fetch(`http://127.0.0.1:${PORT}/api/import-model?name=..%2F..%2Fevil.glb`, {
        method: 'POST', body: glb, headers: { 'Content-Type': 'model/gltf-binary' }
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.path, /^assets\/models\/[A-Za-z0-9_-]+\.glb$/);
    assert.ok(!fs.existsSync(path.join(ROOT, '..', 'evil.glb')));
    assert.ok(!fs.existsSync(path.join(ROOT, 'evil.glb')));
    fs.rmSync(path.join(ROOT, j.path), { force: true });   // clean the probe artifact
});

test('предел тела запроса: 2MB в save-objects -> 413', async () => {
    const r = await post('/api/save-objects', 'x'.repeat(2 * 1024 * 1024));
    assert.equal(r.status, 413);
    await r.json().catch(() => {});
});
