// Ink edges of an INDEXED mesh: the regression that silently killed the toon ink of a whole
// game. Two engine bugs stacked in _inkEdgeMesh:
//   1. IndexBuffer.lock() returns a RAW ArrayBuffer for a GPU-created buffer — no .length,
//      nTri became NaN, both loops ran zero times and the mesh cached "no creases" forever;
//   2. pc.Mesh.setPositions/setNormals builds a PLANAR vertex buffer (POSITION block, then
//      NORMAL block), where the element's own stride (12) is the truth — reading with
//      fmt.size (24) walks straight into the normals and welds garbage.
// The fixture is a cube: 12 edges, every one creased 90° (sharper than the default 42°),
// so a correct build inks 12 edges = 48 ribbon vertices = 144 floats / 72 indices.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadScripts } from './browser-scripts.mjs';

// A recording pc: World3D only needs a handful of constants plus a Mesh it can fill — the
// fake keeps the streams so the test can count the creased edges the ink build produced.
function makePage() {
    const built = [];
    const pcFake = {
        SEMANTIC_POSITION: 'POSITION',
        SEMANTIC_ATTR6: 'ATTR6',
        SEMANTIC_ATTR7: 'ATTR7',
        INDEXFORMAT_UINT8: 0,
        INDEXFORMAT_UINT16: 1,
        INDEXFORMAT_UINT32: 2,
        PRIMITIVE_TRIANGLES: 4,
        Mesh: function () {
            const self = this;
            this.setPositions = (a) => { self._pos = a; };
            this.setVertexStream = () => {};
            this.setIndices = (a) => { self._idx = a; };
            this.update = () => { built.push(self); };
        }
    };
    const page = loadScripts(['js/Constants.js', 'js/engine/World3D.js'], { pc: pcFake });
    return { World3D: page.get('World3D'), built, pcFake };
}

const VIEW = { world: { app: { graphicsDevice: {} } } };
const CFG = { inkAngle: 42 };

// The unit cube: 8 corners, 12 triangles. Planar vertex buffer (positions, then normals),
// exactly what pc.Mesh.update() leaves behind for setPositions+setNormals.
const CUBE_POS = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
const CUBE_IDX = [0, 1, 2, 0, 2, 3, 5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7,
    1, 5, 6, 1, 6, 2, 4, 5, 1, 4, 1, 0, 3, 2, 6, 3, 6, 7];

function cubeMesh(pcFake, indexLock) {
    const buf = new Float32Array(48);          // 24 pos floats + 24 normal floats, planar
    buf.set(CUBE_POS, 0);
    const vb = {
        numVertices: 8,
        format: {
            size: 24,
            elements: [
                { name: pcFake.SEMANTIC_POSITION, offset: 0, stride: 12 },
                { name: 'NORMAL', offset: 96, stride: 12 }
            ]
        },
        lock: () => buf.buffer,
        unlock: () => {}
    };
    const idx16 = new Uint16Array(CUBE_IDX);
    const ib = {
        format: pcFake.INDEXFORMAT_UINT16,
        lock: () => indexLock === 'view' ? idx16 : idx16.buffer,   // GPU buffer vs initial-data view
        unlock: () => {}
    };
    return { vertexBuffer: vb, indexBuffer: [ib] };
}

// The same cube as a flat-shaded soup (36 unique vertices, no index buffer): the path the
// engine tests always covered — it must keep working.
function cubeSoupMesh(pcFake) {
    const pos = [];
    for (let t = 0; t < 12; t++) {
        for (const v of [CUBE_IDX[t * 3], CUBE_IDX[t * 3 + 1], CUBE_IDX[t * 3 + 2]]) {
            pos.push(CUBE_POS[v * 3], CUBE_POS[v * 3 + 1], CUBE_POS[v * 3 + 2]);
        }
    }
    const nrm = new Array(pos.length).fill(0);
    const buf = Float32Array.from(pos.concat(nrm));
    const vb = {
        numVertices: 36,
        format: {
            size: 24,
            elements: [
                { name: pcFake.SEMANTIC_POSITION, offset: 0, stride: 12 },
                { name: 'NORMAL', offset: 432, stride: 12 }
            ]
        },
        lock: () => buf.buffer,
        unlock: () => {}
    };
    return { vertexBuffer: vb, indexBuffer: [] };
}

function assertTwelveCreases(out, built, label) {
    assert.ok(out, label + ': ink mesh built (12 creased cube edges)');
    const m = built[built.length - 1];
    assert.equal(m._pos.length, 12 * 4 * 3, label + ': 12 edges × 4 corners × xyz');
    assert.equal(m._idx.length, 12 * 6, label + ': 12 edge ribbons × 6 indices');
}

test('индексированный куб, lock() = ArrayBuffer: 12 рёбер в ink-меш (баг NaN-циклов)', () => {
    const { World3D, built, pcFake } = makePage();
    const out = World3D._inkEdgeMesh(VIEW, cubeMesh(pcFake, 'buffer'), CFG);
    assertTwelveCreases(out, built, 'indexed/ArrayBuffer');
});

test('индексированный куб, lock() = typed view: планарный stride элемента, не fmt.size', () => {
    const { World3D, built, pcFake } = makePage();
    const out = World3D._inkEdgeMesh(VIEW, cubeMesh(pcFake, 'view'), CFG);
    assertTwelveCreases(out, built, 'indexed/view');
});

test('неиндексированный куб (soup): контракт прежний — 12 рёбер', () => {
    const { World3D, built, pcFake } = makePage();
    const out = World3D._inkEdgeMesh(VIEW, cubeSoupMesh(pcFake), CFG);
    assertTwelveCreases(out, built, 'soup');
});

test('гладкая сфера-подобная сетка: рёбра мельче порога не красятся', () => {
    const { World3D, built, pcFake } = makePage();
    // An octagon prism is smooth enough at 45° creases vs the 42° threshold? No — 45° > 42°
    // creases still ink. Use a 16-gon: 22.5° creases < 42° — nothing inks, and the cache
    // records the honest null (a mesh with no ink is a valid answer, not an error).
    const N = 16, pos = [], idx = [];
    for (let i = 0; i < N; i++) {
        const a = i / N * Math.PI * 2;
        pos.push(Math.cos(a), 0, Math.sin(a), Math.cos(a), 1, Math.sin(a));
    }
    for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        idx.push(i * 2, j * 2, j * 2 + 1, i * 2, j * 2 + 1, i * 2 + 1);   // side quads
    }
    const buf = new Float32Array(pos.length * 2);
    buf.set(pos, 0);
    const vb = {
        numVertices: N * 2,
        format: {
            size: 24,
            elements: [
                { name: pcFake.SEMANTIC_POSITION, offset: 0, stride: 12 },
                { name: 'NORMAL', offset: pos.length * 4, stride: 12 }
            ]
        },
        lock: () => buf.buffer,
        unlock: () => {}
    };
    const idx16 = new Uint16Array(idx);
    const mesh = { vertexBuffer: vb, indexBuffer: [{ format: 1, lock: () => idx16.buffer, unlock: () => {} }] };
    const out = World3D._inkEdgeMesh(VIEW, mesh, CFG);
    assert.equal(out, null, 'пологие грани (22.5° < 42°) не красятся');
    assert.equal(mesh._arcInkCache.mesh, null, 'честный null кэшируется');
    assert.equal(built.length, 0, 'ink-меш не создавался');
});
