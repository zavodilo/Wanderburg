// ============================================================================
//  make-pack-geo — bake CC0 pack models into the scenery batcher's input
// ----------------------------------------------------------------------------
//  node tools/make-pack-geo.mjs          rewrite js/WanderPackGeo.js
//  node tools/make-pack-geo.mjs --check  fail when the generated file drifts
//
//  Wanderburg draws its 340 trees/rocks/bushes as 32 BATCHED static meshes (8 sectors × 4 kinds,
//  grouped by color): one draw call per batch, which is what keeps the mobile frame budget. A pack
//  model per tree would be 340 draw calls, so the models are baked ONCE, here, into flat position
//  arrays + one color per material — exactly the { geo, hex } parts js/WanderView.js feeds the
//  batcher. The source models are Kenney's CC0 Nature Kit (see NOTICE and assets/models/pack/
//  LICENSE-CC0.txt); the generated file is data, derived and reproducible from the .glb sources.
//
//  Normalization: base at y=0, centred on x/z, height 1 — the view scales each instance by its
//  own size and rotates it by its seed, so one baked tree dresses every tree of the valley.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const OUT = path.join(ROOT, 'js', 'WanderPackGeo.js');

// kind -> source models (several per kind: the seed picks a variant, so the forest is not a stamp)
// tint: the Castle Kit shades through a colormap texture; the baked geometry carries the game's
// OWN palette instead (Wanderburg is a toon-shaded, palette-driven look — a textured white gate
// would not belong in this valley). Nature Kit models are vertex-colored and keep their colors.
const SOURCES = {
    tree: ['tree_cone.glb', 'tree_default.glb', 'tree_blocks.glb'],
    rock: ['rock_largeA.glb', 'rock_largeC.glb', 'rock_smallA.glb'],
    bush: ['plant_bush.glb', 'plant_bushSmall.glb'],
    tent: ['tent_smallOpen.glb'],
    fence: ['fence_simple.glb'],
    campfire: ['campfire_stones.glb'],
    log: ['log_stack.glb'],
    gate: [{ file: 'gate.glb', tint: 0x9aa0a6 }],
    tower: [{ file: 'tower-square.glb', tint: 0x8b9198 }],
    wall: [{ file: 'wall.glb', tint: 0x9aa0a6 }],
    flag: [{ file: 'flag-banner-long.glb', tint: 0xffffff }],
    catapult: [{ file: 'siege-catapult.glb', tint: 0x7d5636 }],
    // The mountain ring: tall crags with a SNOW CAP. cap splits the triangles above a height
    // fraction into their own part with hex 0xffffff — the view tints that part to the biome's
    // cap color (snow in Хладоземье, dust in Степи), the body to the biome's rock.
    peak: [{ file: 'rock_tallA.glb', cap: 0.72 }, { file: 'rock_tallB.glb', cap: 0.7 },
        { file: 'rock_tallC.glb', cap: 0.74 }, { file: 'rock_tallD.glb', cap: 0.7 }]
};
const PACK_DIR = path.join(ROOT, 'assets', 'models', 'pack');

/** Minimal glTF-binary reader: POSITION per primitive + the material's base color. */
function readGlb(file) {
    const buf = fs.readFileSync(file);
    if (buf.toString('latin1', 0, 4) !== 'glTF') throw new Error(file + ': not a GLB');
    let off = 12, json = null, bin = null;
    while (off < buf.length) {
        const len = buf.readUInt32LE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        const chunk = buf.subarray(off + 8, off + 8 + len);
        if (type === 'JSON') json = JSON.parse(chunk.toString('utf8'));
        else if (type === 'BIN\0') bin = chunk;
        off += 8 + len;
    }
    if (!json || !bin) throw new Error(file + ': missing JSON/BIN chunk');
    const view = (i) => {
        const v = json.bufferViews[i];
        return (v.byteOffset || 0) + 0;
    };
    const acc = (i) => {
        const a = json.accessors[i], v = json.bufferViews[a.bufferView];
        const start = view(a.bufferView) + (a.byteOffset || 0);
        if (a.type === 'VEC3' && a.componentType === 5126) {
            return { arr: new Float32Array(bin.buffer, bin.byteOffset + start, a.count * 3), count: a.count, stride: 3 };
        }
        throw new Error(file + ': accessor ' + i + ' is ' + a.type + '/' + a.componentType + ' (need VEC3 float)');
    };
    // Kenney's glbs are INDEXED: positions without their indices are a fan of garbage triangles.
    const indices = (i) => {
        const a = json.accessors[i], v = json.bufferViews[a.bufferView];
        const start = view(a.bufferView) + (a.byteOffset || 0);
        const base = bin.byteOffset + start;
        if (a.componentType === 5125) return new Uint32Array(bin.buffer, base, a.count);
        if (a.componentType === 5123) return new Uint16Array(bin.buffer, base, a.count);
        if (a.componentType === 5121) return new Uint8Array(bin.buffer, base, a.count);
        throw new Error(file + ': index accessor type ' + a.componentType);
    };
    const parts = [];
    const nodes = json.nodes || [];
    const walk = (ni, parent) => {
        const n = nodes[ni];
        const t = n.translation || [0, 0, 0];
        const me = parent ? parent.slice() : [0, 0, 0];
        me[0] += t[0]; me[1] += t[1]; me[2] += t[2];
        if (n.mesh != null) {
            const m = json.meshes[n.mesh];
            for (const prim of m.primitives) {
                if (prim.attributes.POSITION == null) continue;
                const p = acc(prim.attributes.POSITION);
                const idx = prim.indices != null ? indices(prim.indices) : null;
                const mat = (prim.material != null && json.materials[prim.material]) || {};
                const pbr = mat.pbrMetallicRoughness || {};
                const f = pbr.baseColorFactor || [0.8, 0.8, 0.8, 1];
                const hex = ((Math.round(f[0] * 255) << 16) | (Math.round(f[1] * 255) << 8) | Math.round(f[2] * 255)) >>> 0;
                const pos = [];
                const n = idx ? idx.length : p.count;
                for (let i = 0; i < n; i++) {
                    const vi = idx ? idx[i] : i;
                    pos.push(p.arr[vi * 3] + me[0], p.arr[vi * 3 + 1] + me[1], p.arr[vi * 3 + 2] + me[2]);
                }
                parts.push({ hex, pos });
            }
        }
        for (const c of n.children || []) walk(c, me);
    };
    const scene = json.scenes[json.scene || 0];
    for (const ni of scene.nodes) walk(ni, null);
    return parts;
}

/** Centre on x/z, base at y=0, height 1; round to 0.001 to keep the generated file small. */
function normalize(parts) {
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const p of parts) for (let i = 0; i < p.pos.length; i += 3) {
        minX = Math.min(minX, p.pos[i]); maxX = Math.max(maxX, p.pos[i]);
        minY = Math.min(minY, p.pos[i + 1]); maxY = Math.max(maxY, p.pos[i + 1]);
        minZ = Math.min(minZ, p.pos[i + 2]); maxZ = Math.max(maxZ, p.pos[i + 2]);
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const h = Math.max(1e-6, maxY - minY);
    const out = parts.map(p => ({
        hex: p.hex,
        pos: p.pos.map((v, i) => {
            const k = i % 3;
            const n = k === 0 ? (v - cx) / h : k === 1 ? (v - minY) / h : (v - cz) / h;
            return Math.round(n * 1000) / 1000;
        })
    })).filter(p => p.pos.length >= 9);
    return { parts: out, height: Math.round(h * 1000) / 1000 };
}

const data = {};
for (const [kind, files] of Object.entries(SOURCES)) {
    data[kind] = files.map(spec => {
        const f = typeof spec === 'string' ? spec : spec.file;
        const tint = typeof spec === 'object' ? spec.tint : null;
        const file = path.join(PACK_DIR, f);
        if (!fs.existsSync(file)) throw new Error('нет исходной модели ' + path.relative(ROOT, file) + ' (pack не распакован?)');
        const n = normalize(readGlb(file));
        if (tint != null) for (const p of n.parts) p.hex = tint >>> 0;
        let parts = n.parts;
        if (typeof spec === 'object' && spec.cap) {
            const cut = Number(spec.cap);
            const split = [];
            for (const p of parts) {
                const body = [], cap = [];
                for (let i = 0; i < p.pos.length; i += 9) {
                    const ys = [p.pos[i + 1], p.pos[i + 4], p.pos[i + 7]];
                    (ys[0] >= cut && ys[1] >= cut && ys[2] >= cut ? cap : body).push(...p.pos.slice(i, i + 9));
                }
                if (body.length) split.push({ hex: p.hex, pos: body });
                if (cap.length) split.push({ hex: 0xffffff, pos: cap });
            }
            parts = split;
        }
        return { source: 'assets/models/pack/' + f, tint: tint != null ? tint >>> 0 : null, cap: (typeof spec === 'object' && spec.cap) || null, height: n.height, verts: parts.reduce((a, p) => a + p.pos.length / 3, 0), parts: parts };
    });
}

const body = `// GENERATED by tools/make-pack-geo.mjs — do not edit by hand.
// Baked CC0 geometry of Kenney's Nature Kit (assets/models/pack/*.glb, see NOTICE): flat position
// arrays, unit height, base at y=0, one color per source material. js/WanderView.js feeds these
// to the scenery batcher, so 340 pack-model trees still cost 32 draw calls. WanderMesh.* stays
// the fallback when this file is absent.
/** @satisfies {Record<string, any>} */
const WANDER_PACK_GEO = ${JSON.stringify(data)};
`;

if (CHECK) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
    if (have !== body) { console.error('make-pack-geo: drift — run node tools/make-pack-geo.mjs'); process.exit(1); }
    console.log('make-pack-geo: ok (' + Object.values(data).flat().length + ' baked models)');
} else {
    fs.writeFileSync(OUT, body);
    const verts = Object.values(data).flat().reduce((a, m) => a + m.verts, 0);
    console.log('make-pack-geo: js/WanderPackGeo.js (' + Object.values(data).flat().length + ' models, ' + verts + ' verts, ' + (body.length / 1024).toFixed(1) + ' KB)');
}
