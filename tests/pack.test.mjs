// The CC0 pack (Kenney Nature/Castle Kits) and its bake into the scenery batcher.
// The pack is PROVENANCE + data: js/WanderPackGeo.js is generated from assets/models/pack/*.glb
// by tools/make-pack-geo.mjs, and js/WanderView.js falls back to WanderMesh.* when the generated
// file is absent — so the contract here is: sources parse, the bake is normalized and reproducible,
// and the view never hard-depends on it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { loadScripts } from './browser-scripts.mjs';
import { ROOT } from './browser-scripts.mjs';

const PACK = path.join(ROOT, 'assets', 'models', 'pack');
const SOURCES = ['tree_cone.glb', 'tree_default.glb', 'tree_blocks.glb', 'rock_largeA.glb', 'rock_largeC.glb',
    'rock_smallA.glb', 'plant_bush.glb', 'plant_bushSmall.glb', 'tent_smallOpen.glb', 'fence_simple.glb',
    'campfire_stones.glb', 'log_stack.glb', 'gate.glb', 'tower-square.glb', 'wall.glb',
    'flag-banner-long.glb', 'siege-catapult.glb'];

test('пак на месте: CC0-источники парсятся как GLB, лицензии приложены', () => {
    for (const f of SOURCES) {
        const buf = fs.readFileSync(path.join(PACK, f));
        assert.equal(buf.toString('latin1', 0, 4), 'glTF', f + ': magic GLB');
        assert.equal(buf.readUInt32LE(8), buf.length, f + ': длина в заголовке');
    }
    for (const f of ['LICENSE-nature-kit.txt', 'LICENSE-castle-kit.txt']) {
        const t = fs.readFileSync(path.join(PACK, f), 'utf8');
        assert.match(t, /CC0|Creative Commons/i, f + ': лицензия CC0');
    }
    assert.ok(fs.existsSync(path.join(PACK, 'Textures', 'colormap.png')), 'текстура Castle Kit приложена');
});

test('запечённая геометрия: нормирована, воспроизводима, взгляду не обязательна', () => {
    const page = loadScripts(['js/WanderPackGeo.js']);
    const G = page.get('WANDER_PACK_GEO');
    for (const kind of ['tree', 'rock', 'bush', 'tent', 'fence', 'campfire', 'log', 'gate', 'tower', 'wall', 'flag', 'catapult', 'peak', 'house', 'chapel']) {
        assert.ok(Array.isArray(G[kind]) && G[kind].length >= 1, kind + ' запечён');
        for (const v of G[kind]) {
            assert.ok(v.parts.length >= 1, kind + ': части есть');
            // Normalization is per MODEL (a catapult wheel is shorter than the catapult), so the
            // unit height is asserted over all parts of the variant together.
            let maxY = -1e9, minY = 1e9;
            for (const part of v.parts) {
                assert.ok(part.pos.length >= 9 && part.pos.length % 3 === 0, kind + ': позиции — треугольники');
                for (let i = 1; i < part.pos.length; i += 3) { maxY = Math.max(maxY, part.pos[i]); minY = Math.min(minY, part.pos[i]); }
                let pMax = -1e9, pMin = 1e9;
                for (let i = 1; i < part.pos.length; i += 3) { pMax = Math.max(pMax, part.pos[i]); pMin = Math.min(pMin, part.pos[i]); }
                assert.ok(pMin > -0.02 && pMax < 1.03, kind + ': часть в нормированном габарите');
            }
            assert.ok(maxY > 0.97 && maxY < 1.03, kind + ': высота модели нормирована в 1, есть ' + maxY);
            assert.ok(minY > -0.02, kind + ': основание на нуле, есть ' + minY);
        }
    }
    // reproducible: the generator's --check compares a fresh bake with the file on disk
    const r = spawnSync(process.execPath, ['tools/make-pack-geo.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // the view treats the pack as optional (the kit's "a missing asset never holes the scene")
    const view = fs.readFileSync(path.join(ROOT, 'js', 'WanderView.js'), 'utf8');
    assert.match(view, /typeof WANDER_PACK_GEO === 'undefined'/, 'WanderView падает без пака? нет — проверяет наличие');
});
