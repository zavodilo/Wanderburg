---
name: lowpoly3d
description: The Low-poly 3D render profile — PERSPECTIVE camera, low-poly meshes, flat stylized materials, one directional light, mobile-friendly budgets; the lens difference from isometric3d. Read when presenting or debugging the lowpoly3d variant.
---

# Profile `lowpoly3d`

A full 3D game with a simplified look. The difference from `isometric3d` is the lens:
**perspective**, not orthographic.

- **camera**: perspective; modes `thirdPerson` (default), `orbit`, `free`, `isometric`.
- **representations**: models primary, primitives as fallback; projectiles → primitive.
- **world**: low-poly terrain (the same logical height field, coarser shading).
- **lighting**: `lowpoly` — banded toon light, no ink edges, cheap shadows.
- **materials**: stylized: diffuse or none, no PBR maps.
- **budget**: medium but TIGHTER than full3d on purpose (900 draw calls, textures ≤ 1024,
  48 animated entities) — a variant may only tighten it further.
