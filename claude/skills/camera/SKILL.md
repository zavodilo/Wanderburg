---
name: camera
description: The semantic camera — modes (topdown, side, platformer, isometric, thirdPerson, firstPerson, free, orbit), Camera.follow/mode/zoom/lookAt/orbit, projection switching (orthographic vs perspective) and why gameplay never positions a camera. Read before touching Camera.*, Camera3D or CAMERA_* constants.
---

# The semantic camera

Game code says WHAT to look at:

```js
Camera.mode('isometric');  Camera.follow('player');  Camera.zoom(1.4);
Camera.lookAt(120, 0, -40);  Camera.orbit(azimuthDeg, elevationDeg);
```

Never `camera.setPosition/lookAt` on an engine camera, never projection math, never
`if (profile === …)`. The profile/variant supplies the parameters; `js/engine/Camera3D.js`
applies them to the kit's `CameraController` + PlayCanvas.

## Modes and projections

| mode | projection | notes |
|---|---|---|
| topdown | orthographic | straight down on x/z (2D, maps) |
| side / platformer | orthographic | the x/y plane faces the screen; input plane becomes `xy` |
| isometric | orthographic | fixed tilted pose: azimuth/elevation/orthoHeight are DATA |
| thirdPerson | perspective | follows from behind, orbit allowed |
| firstPerson | perspective | at the entity's eyes |
| free / orbit | perspective | editor/debug |

A mode is allowed only if the active profile declares it (`profiles[*].camera.modes`);
otherwise `Camera.mode()` falls back to the profile default and reports a warning.

## Precedence of parameters

profile manifest defaults <- variant `camera` overrides <- runtime `Camera.*` calls.
Zoom semantics are shared: screen px per world px at the look-at point; the orthographic
frustum half-height is `canvasHeight / (2 * zoom)` (`PROFILE_ORTHO_HEIGHT` when unknown).
