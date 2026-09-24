---
name: 2.5d
description: The 2.5D render profile — hybrid presentation: billboard sprites for characters in a real 3D environment, orthographic tilted camera, stylized lighting, z-buffer depth with declarative sprite order. Read when presenting or debugging the 2.5d variant.
---

# Profile `2.5d`

The proof profile: 2D characters in a 3D world. Same sprite assets as `2d`, same models as the
3D profiles — one registry, both used at once.

- **camera**: orthographic, default mode `isometric` (elevation ~60°), a slight tilt allowed.
- **representations**: characters/creatures/vehicles → `billboard` (the 2D sprite facing the
  camera); props/structures → `model`; projectiles → `sprite`; ground → plane + tiles.
- **lighting**: `stylized` — toon bands, one shadow, light ink.
- **depth**: z-buffer (3D occludes sprites honestly) + drawOrder inside the sprite layer.
- **animation**: hybrid — sprite frames for billboards, skeletal clips for models; the semantic
  state (`GameAnimation.play('run')`) is the same for both.
- **budget**: low (700 draw calls, 1 shadow light, textures ≤ 1024).
