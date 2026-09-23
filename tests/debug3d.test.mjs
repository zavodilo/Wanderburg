// Debug3D without 3D: the winding rule of the scene lint, the normal map verdict and the held
// view pose. PlayCanvas is a stub — only the pure parts are called.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadScripts, stub } from './browser-scripts.mjs';

const page = loadScripts(['js/Debug3D.js'], { pc: stub(), World3D: stub() });
const Debug3D = page.get('Debug3D');

// A unit quad in the XZ plane with normals up. Indices (0, 1, 2): cross(b - a, c - a) — down,
// AGAINST the normals (Babylon's clockwise convention); reversed — along them (glTF).
const P = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
const N = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
const CW = [0, 1, 2, 0, 2, 3];
const CCW = [0, 2, 1, 0, 3, 2];

test('обход граней: доля треугольников против нормалей вершин', () => {
  assert.equal(Debug3D.windingAgainstNormals(P, N, CW).against, 1);
  assert.equal(Debug3D.windingAgainstNormals(P, N, CCW).against, 0);
  assert.equal(Debug3D.windingAgainstNormals(P, N, [0, 1, 2, 0, 3, 2]).against, 0.5);
  // Вырожденный треугольник и нулевые нормали в счёт не идут.
  assert.equal(Debug3D.windingAgainstNormals(P, N, [0, 0, 1]).total, 0);
  assert.equal(Debug3D.windingAgainstNormals(P, new Array(12).fill(0), CW).total, 0);
  // Выборка: не больше maxTris треугольников, результат тот же.
  const many = [];
  for (let i = 0; i < 500; i++) many.push(...CW);
  const r = Debug3D.windingAgainstNormals(P, N, many, 100);
  assert.equal(r.against, 1);
  assert.ok(r.total <= 100, 'выборка ' + r.total);
});

test('вердикт стороны: обход по нормалям — норма, зеркало меняет местами', () => {
    const v = (against, mirrored) => Debug3D.sideVerdict(against, mirrored).verdict;
    assert.equal(v(0, false), 'ok');            // PlayCanvas: front face is counter-clockwise
    assert.equal(v(1, false), 'inverted');      // the mesh draws its inside
    assert.equal(v(1, true), 'ok');             // a mirrored node scale flips the winding
    assert.equal(v(0, true), 'inverted');
    assert.equal(v(0.5, false), 'mixed');       // double-sided cards
    assert.equal(v(0.05, false), 'ok');         // single flipped triangles — noise
    assert.equal(Debug3D.sideVerdict(0.2, false).wrong, 0.2);
    assert.equal(Debug3D.sideVerdict(0.2, true).wrong, 0.8);
});

test('карта нормалей: OpenGL-карта читается как есть, DirectX — с инверсией', () => {
    const v = (url, inverted) => Debug3D.normalMapVerdict(url, inverted);
    assert.equal(v('assets/bark_nor_gl.jpg', false), 'ok');
    assert.equal(v('assets/bark_nor_gl.jpg', true), 'wrong');
    assert.equal(v('assets/bark_nor_dx.png', true), 'ok');
    assert.equal(v('assets/bark_nor_dx.png', false), 'wrong');
    assert.equal(v('assets/rock.glb#normal', false), 'ok');
    assert.equal(v('assets/rock.glb#normal', true), 'wrong');
    assert.equal(v('assets/unknown.png', false), 'unknown');
});

test('поза удержанного вида: глаз не ниже рельефа, цель — точкой или курсом и наклоном', () => {
  const terrain = { heightAt: () => 50 };
  const a = Debug3D.poseFrom({ eye: [100, 200, 10], target: [300, 400, 0] }, terrain);
  assert.equal(a.clamped, true);
  assert.equal(a.eye.h, 54);
  assert.deepEqual({ ...a.target }, { x: 300, y: 400, h: 0 });
  const b = Debug3D.poseFrom({ eye: [100, 200, 90], target: [0, 0, 0] }, terrain, 10);
  assert.equal(b.clamped, false);
  assert.equal(b.eye.h, 90);
  // Курс π/2 — вниз по карте (+y), наклон вверх поднимает цель.
  const c = Debug3D.poseFrom({ eye: [0, 0, 100], yaw: Math.PI / 2, pitch: 0.5 }, null);
  assert.ok(Math.abs(c.target.x) < 1e-6 && c.target.y > 80 && c.target.h > 140, JSON.stringify(c.target));
});

test('assert*: машиночитаемые исходы вместо исключений', () => {
    const page = loadScripts(['js/Debug3D.js'], { pc: stub(), World3D: stub() });
    const Debug3D = page.get('Debug3D');
    const objects = [
        { def: { name: 'ok', x: 100, y: 100, h: 0 }, mesh: {}, error: null },
        { def: { name: 'unloaded', x: 100, y: 100, h: 0 }, mesh: null, error: '404' },
        { def: { name: 'buried', x: 100, y: 100, h: -5 }, mesh: {}, error: null },
    ];
    page.ctx.app = { location: { objects, terrain: { heightAt: () => 0 } }, camera: {} };
    page.ctx.World3D = {
        view: { refreshMatrices() {}, projectToScreen: (x, y) => ({ x: 10, y: 10, visible: x < 200, behind: x >= 200 }) },
        fps: () => 60
    };
    assert.equal(JSON.stringify(Debug3D.assertPosition('ok', 100, 100, 1)), JSON.stringify({ ok: true, code: 'position', details: { name: 'ok', x: 100, y: 100 } }));   // cross-realm
    const bad = Debug3D.assertPosition('ok', 150, 100, 1);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'position-mismatch');
    assert.equal(Debug3D.assertInFrame('ok').code, 'in-frame');
    objects.push({ def: { name: 'far', x: 900, y: 900, h: 0 }, mesh: {}, error: null });
    assert.equal(Debug3D.assertInFrame('far').code, 'behind-camera');
    assert.equal(Debug3D.assertVisible('unloaded').code, 'not-loaded');
    assert.equal(Debug3D.assertVisible('buried').code, 'under-ground');
    assert.equal(Debug3D.assertVisible('ok').code, 'visible');
    assert.equal(Debug3D.assertVisible('nope').code, 'no-object');
    assert.equal(Debug3D.capture().code, 'no-canvas');
});
