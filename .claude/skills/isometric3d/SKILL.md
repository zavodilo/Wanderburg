---
name: isometric3d
description: The Isometric 3D render profile — real 3D geometry through a fixed PARAMETERIZED orthographic camera (azimuth/elevation/orthoHeight/target), stylized 3D lighting with crisp shadows, grid gameplay. Read when presenting or debugging the isometric3d variant.
---

# Profile `isometric3d`

Diablo / Monument Valley / tactics look: a real 3D world, an orthographic camera at a fixed
angle. Gameplay still says `movement = { x: 0, z: -1 }` for "north"; the camera decides how
north looks.

- **camera**: orthographic, mode `isometric`; the pose is DATA, never hardcoded:
  `camera.azimuthDeg / elevationDeg / orthoHeightPx` in the manifest, overridable per variant.
- **representations**: models primary; a sprite-only role becomes a billboard; nothing becomes
  a hole (primitive fallback, then a placeholder).
- **world**: height field + 3D tiles for the logical WorldMap.
- **lighting**: `isometric` — stylized 3D, crisp directional shadows, ink on.
- **animation**: skeletal (clip names via the registry's `clips` map per state).
- **budget**: medium (1200 draw calls, textures ≤ 2048).
