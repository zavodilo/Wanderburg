// Model3D.parse: FBX diffuse textures ride along — an embedded Content blob wins over a
// RelativeFilename; an OP connection binds the texture to the material's DiffuseColor.
// A minimal binary FBX is written here by hand (uncompressed arrays, string ids).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadScripts, stub } from './browser-scripts.mjs';

const page = loadScripts(['js/Model3D.js'], { pc: stub(), Gltf3D: { is: () => false }, TextDecoder });
const Model3D = page.get('Model3D');
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); // pooled Buffers!

// --- minimal FBX 7.4 binary writer (children emitted inside the parent record) ----
class Fbx {
    constructor() { this.parts = []; this.len = 0; }
    raw(buf) { this.parts.push(buf); this.len += buf.length; return buf; }
    u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }
    header() {
        const b = Buffer.alloc(27);
        b.write('Kaydara FBX Binary', 0, 'latin1');
        b[18] = 0x20; b[19] = 0x20; b[20] = 0; b[21] = 0x1a; b[22] = 0x00;
        b.writeUInt32LE(7400, 23);
        this.raw(b);
    }
    propS(s) { const b = Buffer.from(String(s), 'latin1'); return Buffer.concat([Buffer.from('S'), this.u32(b.length), b]); }
    propArr(type, arr) {
        const data = Buffer.from(arr.buffer ? arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) : Buffer.from(arr));
        return Buffer.concat([Buffer.from(type), this.u32(arr.length), this.u32(0), this.u32(data.length), data]);
    }
    // name, props (buffers), children(): emits children at the current position,
    // then patches this record's absolute end offset.
    // record: EndOffset(u32) NumProperties(u32) PropertyListLen(u32) NameLen(u8) Name
    node(name, props, children) {
        const startAt = this.len;
        const head = Buffer.concat([this.u32(0), this.u32(props.length), this.u32(0),
            Buffer.from([name.length]), Buffer.from(name, 'latin1')]);
        this.raw(head);
        for (const p of props) this.raw(p);
        if (children) children();
        const end = this.len;
        head.writeUInt32LE(end, 0);
        head.writeUInt32LE(end - (startAt + 13 + name.length), 8);
    }
    finish() { this.raw(Buffer.alloc(9)); return Buffer.from(Buffer.concat(this.parts)); }
}

function makeFbx(withContent) {
    const f = new Fbx();
    f.header();
    const texBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    f.node('Objects', [], () => {
        f.node('Material', [f.propS('mat0'), f.propS('mat0name'), f.propS('')], () => {
            f.node('Properties70', [], () => {
                f.node('P', [f.propS('DiffuseColor'), f.propS('d'), f.propS(''), f.propS(''), f.propArr('d', new Float64Array([0.8, 0.2, 0.2]))]);
            });
        });
        f.node('Video', [f.propS('vid0'), f.propS('bark'), f.propS('')], () => {
            f.node('Properties70', [], () => {
                f.node('P', [f.propS('RelativeFilename'), f.propS('S'), f.propS(''), f.propS(''), f.propS('tex/bark.jpg')]);
                if (withContent) f.node('P', [f.propS('Content'), f.propS('R'), f.propS(''), f.propS(''), f.propArr('b', texBytes)]);
            });
        });
        f.node('Texture', [f.propS('tex0'), f.propS('bark'), f.propS('')]);
        f.node('Geometry', [f.propS('geo0'), f.propS('geo0'), f.propS('Mesh')], () => {
            f.node('Vertices', [f.propArr('d', new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0]))]);
            f.node('PolygonVertexIndex', [f.propArr('i', new Int32Array([0, 1, -2]))]);
        });
        f.node('Model', [f.propS('m0'), f.propS('box\u0000\u0001Model'), f.propS('')]);
    });
    f.node('Connections', [], () => {
        f.node('C', [f.propS('OO'), f.propS('geo0'), f.propS('m0')]);
        f.node('C', [f.propS('OO'), f.propS('mat0'), f.propS('m0')]);
        f.node('C', [f.propS('OO'), f.propS('vid0'), f.propS('tex0')]);
        f.node('C', [f.propS('OP'), f.propS('tex0'), f.propS('mat0'), f.propS('DiffuseColor')]);
    });
    return f.finish();
}

test('parse: встроенная текстура едет байтами, путь нормализуется под assets/', async () => {
    const model = await Model3D.parse(ab(makeFbx(true)));
    assert.equal(model.materials.length, 1);
    const tex = model.materials[0].texture;
    assert.ok(tex, 'текстура привязана к материалу');
    assert.equal(tex.path, 'assets/models/bark.jpg');
    assert.deepEqual(Array.from(tex.bytes), [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
});

test('parse: без Content — только путь, bytes null', async () => {
    const model = await Model3D.parse(ab(makeFbx(false)));
    const tex = model.materials[0].texture;
    assert.equal(tex.path, 'assets/models/bark.jpg');
    assert.equal(tex.bytes, null);
});

test('parse: материал без текстурной связи остаётся с цветом', async () => {
    const model = await Model3D.parse(ab(makeFbx(true)));
    assert.ok(model.parts.length >= 1);
    assert.ok(Array.isArray(model.materials[0].color));
});
