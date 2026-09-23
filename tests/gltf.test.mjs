// glTF models: the sample character (tools/make-character.mjs -> assets/models/character.glb)
// and the clip cross-fade of js/Gltf3D.js. Babylon is not loaded — animation groups are fakes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { OUT, buildGlb } from '../tools/make-character.mjs';
import { loadScripts, stub } from './browser-scripts.mjs';

function parseGlb(buf) {
  assert.equal(buf.toString('latin1', 0, 4), 'glTF');
  assert.equal(buf.readUInt32LE(8), buf.length, 'длина в заголовке');
  const jsonLength = buf.readUInt32LE(12);
  assert.equal(buf.toString('latin1', 16, 20), 'JSON');
  const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength));
  const bin = buf.subarray(20 + jsonLength + 8);
  return { gltf, bin };
}

test('character.glb на диске совпадает с генератором (node tools/make-character.mjs)', () => {
  assert.ok(fs.readFileSync(OUT).equals(buildGlb()));
});

test('character.glb: скелет, клипы idle и run, буферы сходятся', () => {
  const { gltf, bin } = parseGlb(buildGlb());
  assert.equal(gltf.buffers[0].byteLength, bin.length);
  assert.deepEqual(gltf.animations.map(a => a.name).sort(), ['idle', 'run']);
  const skin = gltf.skins[0];
  assert.ok(skin.joints.length > 0);
  assert.equal(gltf.accessors[skin.inverseBindMatrices].count, skin.joints.length);
  for (const v of gltf.bufferViews) assert.ok(v.byteOffset + v.byteLength <= bin.length);
  for (const p of gltf.meshes[0].primitives) {
    const n = gltf.accessors[p.attributes.POSITION].count;
    for (const key of ['NORMAL', 'JOINTS_0', 'WEIGHTS_0']) assert.equal(gltf.accessors[p.attributes[key]].count, n, key);
  }
  // A looped clip has no seam: the last key repeats the first.
  for (const anim of gltf.animations) {
    for (const s of anim.samplers) {
      const a = gltf.accessors[s.output], view = gltf.bufferViews[a.bufferView], width = a.type === 'VEC4' ? 4 : 3;
      const data = new Float32Array(bin.buffer, bin.byteOffset + view.byteOffset, a.count * width);
      for (let k = 0; k < width; k++) assert.ok(Math.abs(data[k] - data[(a.count - 1) * width + k]) < 1e-6, anim.name);
    }
  }
});

// A fake AnimComponent stack: remembers what Clips3D asks of the engine.
function fakeLayer() {
    return {
        name: 'Base', played: [], transitions: [], resets: 0, activeStateCurrentTime: 0,
        play(name) { this.played.push(name); },
        transition(to, time) { this.transitions.push([to, time]); },
        reset() { this.resets++; }
    };
}

function makeClips() {
    const page = loadScripts(['js/Constants.js', 'js/Gltf3D.js'], { pc: stub(), World3D: stub() });
    const Clips3D = page.get('Clips3D');
    const layer = fakeLayer();
    const entity = {
        anim: {
            playing: false,
            assignAnimation() {},
            findAnimationLayer: () => layer
        },
        addComponent(name) { /* the anim component is already faked above */ }
    };
    const tracks = [
        { resource: { name: 'hero/idle', duration: 1 } },
        { resource: { name: 'hero/run', duration: 0.6 } }
    ];
    const clips = new Clips3D(entity, ['idle', 'run']);
    clips.setTracks(tracks);
    return { clips, layer, entity, blend: page.get('MODEL_CLIP_BLEND_SEC') };
}

test('клипы: имена из файла, неизвестного клипа нет, текущий пуст до play', () => {
    const { clips, entity } = makeClips();
    assert.deepEqual([...clips.names()], ['idle', 'run']);
    assert.equal(clips.has('idle'), true);
    assert.equal(clips.play('jump'), false);
    assert.equal(clips.play('idle'), true);
    assert.equal(clips.current, 'idle');
    assert.equal(entity.anim.playing, true);
});

test('клипы: первый play стартует слой, смена клипа — переход за MODEL_CLIP_BLEND_SEC', () => {
    const { clips, layer, blend } = makeClips();
    clips.play('idle');
    assert.deepEqual(layer.played, ['idle']);
    clips.play('run');
    assert.deepEqual(layer.transitions, [['run', blend]]);
    clips.play('run');                      // the same clip again — no new transition
    assert.equal(layer.transitions.length, 1);
});

test('клипы: stop возвращает позу покоя', () => {
    const { clips, layer, entity } = makeClips();
    clips.play('idle');
    clips.stop();
    assert.equal(entity.anim.playing, false);
    assert.equal(layer.resets, 1);
    assert.equal(clips.current, '');
});
