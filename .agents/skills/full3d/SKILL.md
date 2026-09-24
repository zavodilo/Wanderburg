---
name: full3d
description: The Full 3D render profile — perspective camera, PBR, GLB models with skeletal animation, dynamic lighting and shadows, particles, post effects, terrain with height, spatial audio, optional world-space UI. Read when presenting or debugging the full3d variant.
---

# Profile `full3d`

The richest presentation of the same semantic model.

- **camera**: perspective; `thirdPerson` (default), `firstPerson`, `orbit`, `free`.
- **representations**: models (GLB recommended; the kit also parses FBX); the fallback chain is
  `full3d -> lowpoly3d -> isometric3d -> primitive -> generated placeholder`.
- **world**: terrain with height; tiles become meshes.
- **lighting**: `realistic` — smooth shading (toon off), soft shadows, fog, rim.
- **animation**: skeletal; semantic states map to clip names through the registry `clips`.
- **ui**: screen-space by default, world-space allowed (`ui.worldSpace`); the UI DEFINITION
  (UILayout records, ids, bindings) is unchanged from every other profile.
- **audio**: spatial — a cue with a position is heard from where the camera is.
- **budget**: high (2000 draw calls, 3 shadow lights, textures ≤ 4096).
