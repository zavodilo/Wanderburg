---
name: 2d
description: The 2D render profile — orthographic top-down/side camera, sprites and tilemaps on the x/z plane (y presented as 0), flat lighting, declarative depth (renderLayer/drawOrder/zIndex). Read when presenting or debugging the 2d variant.
---

# Profile `2d`

Classic 2D: top-down, side-scroller, platformer, arena, tile-based. Everything is a sprite;
the logical world is still 3D coordinates with `y = 0` presented.

- **camera**: orthographic; modes `topdown` (default), `side`, `platformer`; no orbit.
  `side`/`platformer` drive the input plane `xy`, everything else `xz`.
- **representations**: sprite, tile, particle, none. Models are NOT drawable here: a role with
  only 3D assets resolves to a generated placeholder, not to a model.
- **world**: tilemap; the terrain is flattened (`environment.flatten: 1`), floor tiles become
  the ground texture once there are many of them (Visual3D skips them).
- **lighting**: `flat` — no toon bands, no ink, no shadows, no fog; sprites are unlit.
- **depth**: declarative — `renderLayer`, `drawOrder`, `zIndex` on the entity; sprites live in
  their own layer sorted by drawOrder (SORTMODE_CUSTOM), never by camera distance.
- **animation**: sprite frames from an atlas grid (`frames: { cols, rows, fps, states }`).
- **assets**: `assets/visual/2d/*.png`, nearest sampling (pixel art stays crisp).
- **budget**: very-low (maxDrawCalls 400, no shadow lights, textures ≤ 1024).

Gotchas: a sprite's authored registry size is final (the entity scale belongs to models);
placeholder textures carry a hatch + checker so they read as generated.
