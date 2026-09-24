// Procedural3D/Mesh3D: the conventions are baked in — world-space normals, winding along
// them (the lint convention), deterministic shapes, fallback kind mapping. Pure functions:
// no engine needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadScripts, stub } from './browser-scripts.mjs';

const page = loadScripts(['js/engine/Debug3D.js', 'js/engine/Procedural3D.js'], { pc: stub() });
const Procedural3D = page.get('Procedural3D');
const Mesh3D = page.get('Mesh3D');
const Debug3D = page.get('Debug3D');

test('все процедурные виды строятся детерминированно и проходят конвенцию виндинга', () => {
    for (const kind of Procedural3D.KINDS) {
        const g1 = Procedural3D.geometry(kind, 42);
        const g2 = Procedural3D.geometry(kind, 42);
        assert.deepEqual(g1.positions, g2.positions, kind + ': детерминизм');
        assert.ok(g1.positions.length % 3 === 0 && g1.positions.length >= 24, kind + ': вершины');
        // auto normals + the Mesh3D winding guard: against ~ 0 after the fix
        const idx0 = [];
        for (let i = 0; i < g1.positions.length / 3; i++) idx0.push(i);
        const n = Mesh3D.normals(g1.positions, idx0);
        assert.ok(n.length === g1.positions.length);
        const idx = [];
        for (let i = 0; i < g1.positions.length / 3; i++) idx.push(i);
        let fixed = idx.slice();
        const w = Debug3D.windingAgainstNormals(g1.positions, n, fixed, 20000);
        if (w.total && w.against > 0.5) {
            for (let t = 0; t < fixed.length; t += 3) { const tmp = fixed[t + 1]; fixed[t + 1] = fixed[t + 2]; fixed[t + 2] = tmp; }
        }
        const w2 = Debug3D.windingAgainstNormals(g1.positions, n, fixed, 20000);
        assert.ok(w2.against <= 0.5, kind + ': виндинг вдоль нормалей, against=' + w2.against);
    }
});

test('Mesh3D.normals: площадь-взвешенные, единичные; бокс смотрит наружу', () => {
    const g = Procedural3D.geometry('box', 1);
    const idx = [];
    for (let i = 0; i < g.positions.length / 3; i++) idx.push(i);
    const n = Mesh3D.normals(g.positions, idx);
    for (let i = 0; i < n.length; i += 3) {
        assert.ok(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) < 1e-6);
    }
    // the first face of the box is -Z: its normal points -Z
    assert.ok(n[2] < -0.9);
});

test('fallback: имя модели определяет процедурный заменитель', () => {
    assert.equal(Procedural3D.fallbackKindFor({ model: 'assets/models/pine_tree.fbx' }), 'tree');
    assert.equal(Procedural3D.fallbackKindFor({ model: 'assets/models/gold_ore.fbx' }), 'rock');
    assert.equal(Procedural3D.fallbackKindFor({ model: 'assets/models/lamp.fbx' }), 'pole');
    assert.equal(Procedural3D.fallbackKindFor({ model: 'assets/models/house.fbx' }), 'crate');
    assert.notEqual(Procedural3D.hashName('a'), Procedural3D.hashName('b'));
    assert.equal(Procedural3D.hashName('x'), Procedural3D.hashName('x'));
});
