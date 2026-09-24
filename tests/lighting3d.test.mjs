// Lighting3D — the engine half of the semantic lighting: a preset becomes World3D.cfg()
// OVERRIDES (never a rewrite of Constants.js), and `shadows` switches the shadow MAP only.
//
// Found porting a real game (Wanderburg): a stylized 3D project casts no shadow map — every hull
// drops its own blob shadow — but keeps WORLD3D_SHADOW_STRENGTH/SHADOW_COLOR, because in the toon
// shader that is the TINT of the dark band, not the map. Zeroing shadowStrength on `shadows: 0`
// flattened the whole look, so the two are separate concepts now (the flat preset still wants
// both off, and says so explicitly).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadScripts, stub } from './browser-scripts.mjs';

function makeLighting(constants = {}) {
  // The overrides are derived from the semantic state, so the constants only matter for what
  // World3D.cfg() would return — a stub records the merge instead of running the real engine.
  const page = loadScripts(['js/Constants.js', 'js/engine/Lighting3D.js'], {
    pc: stub(),
    World3D: {
      _overrides: undefined,
      setLightOverrides(o) { this._overrides = o; return o; },
      applyRenderConstants() { this._applied = (this._applied || 0) + 1; },
      cfg() { return Object.assign({ shadowStrength: 0.5, toon: 1, ink: 2, outline: 0 }, this._overrides || {}, constants); }
    }
  });
  return { Lighting3D: page.get('Lighting3D'), World3D: page.get('World3D') };
}

test('shadows: 0 switches the shadow MAP off and keeps the toon shadow TINT', () => {
  const { Lighting3D } = makeLighting();
  const ov = Lighting3D.overridesFor({ preset: 'lowpoly', shadows: 0, shadowStrength: 0.5, toon: 1, ink: 2 });
  assert.equal(ov.shadowStrength, 0.5, 'shadowStrength is the tint: a game with blob shadows keeps it');
  assert.equal(ov.toon, 1);
  assert.equal(ov.ink, 2);
  // ...and apply() is what turns the caster pass off
  const view = { root: {}, sun: { castShadows: true } };
  const r = Lighting3D.apply(view, { preset: 'lowpoly', shadows: 0, shadowStrength: 0.5, toon: 1, ink: 2 });
  assert.equal(view.sun.castShadows, false, 'no shadow map');
  assert.equal(r.shadows, false);
});

test('shadows: 1 turns the caster pass back on without inventing a tint', () => {
  const { Lighting3D } = makeLighting();
  const view = { root: {}, sun: { castShadows: false } };
  Lighting3D.apply(view, { preset: 'lowpoly', shadows: 1, toon: 1 });
  assert.equal(view.sun.castShadows, true);
  const ov = Lighting3D.overridesFor({ preset: 'lowpoly', shadows: 1 });
  assert.equal(ov.shadowStrength, undefined, 'an unauthored tint stays a constant (World3D.cfg decides)');
});

test('the flat preset still flattens everything (2D has no shading model)', () => {
  const { Lighting3D } = makeLighting();
  const ov = Lighting3D.overridesFor({ preset: 'flat', shadows: 0, shadowStrength: 0.5, toon: 1, ink: 2, outline: 1 });
  assert.equal(ov.toon, 0);
  assert.equal(ov.ink, 0);
  assert.equal(ov.outline, 0);
  assert.equal(ov.shadowStrength, 0);
  assert.equal(ov.fog, 0);
});

test('overrides go through World3D.setLightOverrides — constants are never rewritten', () => {
  const { Lighting3D, World3D } = makeLighting();
  const view = { root: {}, sun: { castShadows: true } };
  Lighting3D.apply(view, { preset: 'isometric', shadows: 1, toon: 1, ink: 2, sunIntensity: 0.7 });
  assert.deepEqual(World3D._overrides, Lighting3D.current, 'the view merges the same overrides cfg() reports');
  assert.equal(World3D._overrides.sunIntensity, 0.7);
  assert.ok(World3D._applied >= 1, 'applyRenderConstants re-reads them into the live view');
  // reset() hands the constants their authority back
  Lighting3D.reset(view);
  assert.equal(World3D._overrides, null);
  assert.equal(Lighting3D.currentPreset, null);
});
