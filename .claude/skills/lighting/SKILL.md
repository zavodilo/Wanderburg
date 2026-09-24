---
name: lighting
description: The semantic lighting API — presets flat/stylized/isometric/lowpoly/realistic, Lighting.setProfile/setSun/setAmbient/setShadows/setFog, and how a preset becomes World3D.cfg overrides without rewriting Constants.js. Read before touching Lighting.*, Lighting3D or WORLD3D_* light constants.
---

# Semantic lighting

```js
Lighting.setProfile('flat');        // 2D: textures as authored
Lighting.setProfile('stylized');    // 2.5D: toon bands + one shadow
Lighting.setProfile('isometric');   // stylized 3D, crisp shadows, ink
Lighting.setProfile('lowpoly');     // one directional light, flat-ish colors
Lighting.setProfile('realistic');   // full stack: smooth shading, soft shadows, fog, rim
Lighting.setSun({ azimuthDeg, elevationDeg, intensity, color });
Lighting.setAmbient({ intensity, skyColor, groundColor });
Lighting.setShadows(0|1); Lighting.setFog(density); Lighting.get(); Lighting.inspect();
```

A profile declares its default preset (`manifest profiles[*].lighting.profile`); a variant may
override it (`variant.lighting.preset` + fields). Gameplay never calls this file.

## Implementation note

`js/engine/Lighting3D.js` turns a preset into `World3D.cfg()` OVERRIDES
(`World3D.setLightOverrides`), so the editor's Global Settings and a variant preset COMPOSE:
nothing rewrites `Constants.js`, and clearing the overrides restores exactly the constants.
Shadows off also disables the shadow-caster pass (`view.sun.castShadows`).
