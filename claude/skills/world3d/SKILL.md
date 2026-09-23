---
name: world3d
description: The kit's 3D engine — World3D (engine, View3D, light, shadows, toon shader chunks, ink edges and silhouette outline, addObject), Terrain3D (ground), Location3D (location), Model3D and Gltf3D (static FBX meshes with material colors; GLB models with skeleton, textures and animation clips), CameraControl (camera), Game.js (sample game). Read before editing World3D.js, Terrain3D.js, Location3D.js, Model3D.js, Gltf3D.js, CameraControl.js, Game.js, main.js and the CAMERA_*/WORLD3D_*/TERRAIN_*/LOCATION_* blocks of Constants.js, before adding objects or animated characters to the scene.
---

# 3D world: World3D, Terrain3D, Location3D, camera

PlayCanvas 2 (`libs/playcanvas.min.js`, UMD, global `pc`), no build step. The frame loop
belongs to the owner: `main.js` in the game, `_utils/editor/lab.js` in the editor.
`World3D.renderFrame()` steps the app (`app.update(dt)` + `app.render()`) and draws one
frame; the app itself never runs its own loop.

```
main.js: World3D.init(canvas) -> new Location3D() -> new CameraController(view) -> UI.init(canvas) -> new Game(app)
         rAF loop: game.update(dt) -> location.update(dt) -> camera.update(dt) -> World3D.renderFrame()
```

## Files (`js/`)

| File | What |
|---|---|
| `World3D.js` | `World3D`: `init(canvas)`, `renderFrame()`, `fps()`, `createView(opts)`, `cfg()` (all render constants), `applyRenderConstants(view)`, `addObject/removeObject`, ink edges (`inkMesh`), outline hull (`outlineAdd/Remove`), `sunDirection()`, `hexColor3()`, `rotQuat/eulerFromQuat` (map euler <-> mirrored-world quaternion). `ArcToon` (`World3D.toon`: shader CHUNKS on `StandardMaterial`) and the hull/ink shader sources (`ArcOutline`, `ArcInk`). `View3D`: entity subtree, camera facade, sun light, layers, `pointerToGround`, `projectToScreen`, `putInLayer/layerOf`, `dispose` |
| `Terrain3D.js` | height field from noise, grid `[0..W]×[0..H]`, ground ring beyond the edge, `heightAt`, `tiltAt`, `setGroundImage`, `applyTileSize` |
| `Location3D.js` | location = `View3D` + `Terrain3D` + ground texture (`GROUNDS`) + objects (`opts.objects` = `LOCATION_OBJECTS`); `ready` (promise: ground, models, first frame), `buildTerrain()` (objects settle on the new ground), `loadGround()`, `objects` (`{ def, mesh, error, loaded, fallbackUsed? }` — `mesh` is the model's ROOT ENTITY), `addObject(def)`, `placeObject(rec)`, `removeObject(rec)`, `update(dt)` (every frame: `spinPart` per `def.anim`, `playClip` per `def.clip`). A def whose `model` file is missing/unreadable falls back to a Procedural3D stand-in: `def.fallback` (kind) or the name heuristic, marked by `rec.fallbackUsed` — the scene stays playable instead of silently empty |
| `Procedural3D.js` | `Procedural3D`: deterministic stand-in meshes without any file — `KINDS` (`box`, `crate`, `tree`, `rock`, `pole`), `geometry(kind, seed)`, `spawn(view, kind, opts)` (registered like any world object), `fallbackKindFor(def)` (name heuristic: tree/rock/pole/crate), `hashName(name)` (stable seed). `Mesh3D.build(view, name, geo)`: positions in WORLD (pc) space, normals computed per vertex, winding FIXED against them (against ≈ 0) plus an outward-safety pass for closed shapes |
| `Model3D.js` | binary FBX -> `pc.Mesh`: `load(url)` (own parser with cache), `build(model, view, { name })` (root entity without geometry; per part a spin-root entity at the node origin + a mesh entity; `partRoot.meta = { part, pivot, axes }` — FBX object name, its origin and unit local axes, in the mirrored world), `dispose(view, root)` (with materials), `M4` (row-vector 4x4 for the FBX transform chain). 1 cm in the file = 1 px, the origin comes from the file. FBX diffuse TEXTURES are read too: `Video` nodes (`RelativeFilename` + optional embedded `Content` blob) bound through `Texture` + `OP DiffuseColor` connections land on the material (`material.texture = { path, bytes }`, `_attachTexture` — embedded bytes win, else the file next to the model). A `.glb` / `.gltf` url goes through the same `load(url, view)` / `build` / `dispose` into `Gltf3D`; `clips(root)` — its `Clips3D` (null for FBX) |
| `Gltf3D.js` | glTF/GLB through the engine's container asset (no separate loader script): skeleton, textures, animation clips; PBR -> `StandardMaterial` for the toon chunks. `Clips3D` on the `AnimComponent`: `names()`, `has(name)`, `play(name, { loop, speed, blend, then })`, `stop()`, `current` — §GLB models |
| `Objects.js` | `LOCATION_OBJECTS`: `{ name, model: 'assets/models/….fbx' \| '….glb', kind, x, y, h, rot: [x, y, z]°, scale: [x, y, z], anim?, clip? }`; `rot[1]` is the heading; `anim: { part, axis: 'x'\|'-x'\|'y'\|…, speed: rpm, dir: 'cw'\|'ccw' }` (FBX part spin); `clip: 'idle'` — looped clip of a GLB. Written by the editor |
| `Game.js` | the sample game — where game logic starts: `constructor(app)`, `update(dt)` before the render; keeps its own state (`running`, `energy`) and shows it through `Model3D.clips` and `UI.get` (skill `ui`) |
| `Debug3D.js` | dev tools, inert until called: `lint(view?)` (inside-out meshes, normal map convention, shadow-caster count, heavy meshes, blank frame — zero findings on the kit's scene), `hold(pose)`/`release()` (a view that bypasses the camera controller, eye kept above the ground), `frames(n)`, `bench()`/`benchToggle(target)`, `setMode('backfaces' \| 'normals' \| 'wireframe' \| 'off')`. Skills `render-conventions` and `verify` |
| `CameraControl.js` | `CameraController`: target, azimuth, pitch, zoom; DOM input; game and free modes; `ignorePointer(e)` — a press that is not for the camera. Talks to the camera through the `ArcCamera` facade (map-space position/target, fov in radians) |

## Coordinates

PlayCanvas is LEFT-handed; the kit's map space is right-handed by tradition. Everything
crosses the border MIRRORED on X, so the picture stays the one the right-handed scene had:

| Map (px) | PlayCanvas world | |
|---|---|---|
| `x` | `-position.x` | right on screen with north up |
| `y` | `position.z` | down the map = +Z |
| height | `position.y` | up |
| `heading` (rad, `atan2(vy, vx)`) | quaternion from `World3D.rotQuat(rx, -heading, rz)` | model nose along +X |

Game code, `CameraController`, `heightAt`, `pointerToGround` results — all stay in MAP
space; only placement (`Location3D.placeObject`), geometry building (`Terrain3D`,
`Model3D.parse`) and light directions mirror. Mirroring the world AND the camera cancels
with the chirality flip of the projection — east stays on the right.

Projections — only through `View3D`:
- `pointerToGround(px, py, h, terrain?)` — canvas CSS px -> map `{x, y}`: with `terrain` —
  intersection with the terrain (march + bisection), without — the plane `h`;
  `null` — the ray goes into the sky. Screen px are scaled by the render scale
  (`device.width / canvas.clientWidth`) before `camera.screenToWorld`.
- `projectToScreen(x, y, h)` -> `{x, y, visible, behind}` in CSS px (`camera.worldToScreen`,
  behind by the sign of the view-projection w).
- Camera moved but no frame rendered yet — call `view.refreshMatrices()` first
  (`camEntity.syncHierarchy()`).

## World objects

Objects are `pc.Entity` trees; a built model's root entity plays the role the root mesh
played before (`LocationObject.mesh`). Custom geometry: build a `pc.Mesh`
(`setPositions/setNormals/setUvs/setIndices` + `update(pc.PRIMITIVE_TRIANGLES)`), put it on
an entity with a `render` component and assign `render.meshInstances`, or add bare
`pc.MeshInstance`s to a layer through `view.putInLayer(mi, layerId)`.

```js
const node = new pc.Entity('crate');
location.view.root.addChild(node);
node.addComponent('render', { layers: [pc.LAYERID_WORLD] });
node.render.meshInstances = [new pc.MeshInstance(mesh, material, node)];
World3D.addObject(location.view, node, 'prop');          // 'actor' | 'prop'
node.setPosition(-x, location.terrain.heightAt(x, y) + 32, y);   // mirrored world!
World3D.removeObject(location.view, node);               // materials are the owner's job
```

`addObject` assigns the materials a group (`mat.arc.group`: specular from constants, toon
chunks), marks shadow cast/receive, puts the creased edges into the ink ribbons, and all
parts into ONE outline hull per kind (the line follows the common silhouette). `actor` —
main objects of the frame (ink/outline level 1), `prop` — environment (level 2). The ground
is group `ground`. Render groups: `view.setLayer(entity, World3D.LAYER.OVERLAY|ACTOR)` —
separate `pc.Layer`s after World with `clearDepthBuffer: false` (overlay marks use
`depthTest: false` + `depthWrite: false` on their materials).

Everything created in the view dies with `view.dispose()` (with the container assets it
loaded). A separate `removeObject` is needed only for what dies before the view.

## Light, shadows, toon, ink edges

All render numbers are read in ONE place — `World3D.cfg()` (typeof per name + default: in
the game the constants are lexical, in the editor they live on `window`).
`applyRenderConstants(view)` applies them to the live scene without a rebuild.

- **Light:** the hemispheric sky lives in the toon ambient chunk (`addAmbient`: sky color
  from above, `WORLD3D_GROUNDLIGHT_COLOR` from below, `WORLD3D_SKYLIGHT_INTENSITY`); the sun
  is a single directional light entity (direction mirrored, color×intensity in one
  component). Flat ground ≈1.0 at `SUN 0.8 + SKYLIGHT 0.45`.
- **Shadows:** directional shadow map, one cascade; the engine fits the ortho frustum to the
  casters in range (`sun.shadowDistance` = distance to the frame center + the visible-area
  radius from `fitShadowFrustum`). Shadow color and strength are painted by the toon chunks:
  the light loop records the sun's hidden fraction (`arcShadowA`) and the hidden light
  (`arcSunAdd`); `endPS` reconstructs the unshadowed light and multiplies it by
  `mix(white, SHADOW_COLOR, STRENGTH·arcShadowA)` — the tint factor enters linear light
  through `decodeGamma` (it is authored in display space). Acne: `shadowBias` (a fraction of
  the depth range, `WORLD3D_SHADOW_BIAS × 50`) and `normalOffsetBias` in world px
  (`WORLD3D_SHADOW_NORMAL_BIAS × texel`). `WORLD3D_SHADOW_SOFT` 0/1/2/3 -> PCF1/1/3/5 taps.
- **Toon:** `ArcToon.attach(view, material)` puts chunk overrides on a `StandardMaterial`:
  `litUserDeclarationPS` (uniforms + the band function), `ambientPS` (hemispheric),
  `lightFunctionLightPS` (the engine default + the shadow recording injection), `endPS`
  (colored shadow, bands, specular threshold, rim light, then fog/tone/gamma). All values
  are uniforms (`arcToonA/B`, `arcShadowColor`, `arcHemi*`) — the editor sliders never
  recompile shaders; `WORLD3D_TOON = 0` gates bands/rim/outline by a uniform and removes
  the hulls in JS. The band quantization happens on the sRGB-ENCODED light (the old pipeline
  quantized raw gamma-space light) and folds back as a ratio.
- **Ink edges:** creased edges (dihedral > `WORLD3D_TOON_INK_ANGLE`, adjacency by welded
  positions) become a fat-line ribbon mesh (`SEMANTIC_ATTR6/7` carry the other end and the
  corner sign), width in world px (`WORLD3D_TOON_INK_WIDTH / 25`), depth-tested, fog-tinted
  in the shader. Cached per source mesh (`mesh._arcInkCache`).
- **Silhouette outline:** inverted hull — a second mesh instance of the same mesh with a
  hull shader (vertices pushed along their normals by a screen-px width,
  `cull = CULLFACE_BACK` keeps the far shell: measured for the kit's winding in the mirrored
  world, do not "fix"), ink color, EXP2 fog tinted per fragment by view depth. One hull
  material per kind (`view._outlineMats`), width in screen px. Part of the toon look: at
  `WORLD3D_TOON = 0` `applyOutlines` removes the hulls and restores them live. Skinned
  meshes share their `skinInstance` with the hull, so the line dances with the bones.

## Terrain3D and Location3D

- Height = `TERRAIN_BASE + noise` (two octaves). `heightAt` interpolates over THE SAME
  triangles as the mesh (diagonal `(i,j)-(i+1,j+1)`); beyond the grid — noise, like the ring.
- Geometry is built mirrored (`-x, h, y`); winding is the map order, and a normal check
  (+Y) flips it if the faces came out downward-facing; the ring takes the same verdict.
- Material — a tile (`pc.Texture` from a canvas, `flipY` false so V goes down the map),
  repeat through `material.diffuseMapTiling` = `(W/tile, H/tile)`, UV `(x/W, y/H)` for both
  grid and ring — no seam at the edge. Ring brightness — `WORLD3D_OUTER_TINT`.
- Mobile: cell no finer than 12 px. Terrain is a picture: game logic does not ask 3D for
  height (the cell depends on the device).
- `Location3D` loads the texture by `LOCATION_GROUND` from `GROUNDS` — paths as LITERALS
  (the builder's asset scanner sees only those); no file — flat color, the scene lives on.
- `spinPart`: the part entity (the builder put it AT the node origin, the mesh entity hangs
  off it at `-pivot`) gets a quaternion around `meta.axes[axis]` (minus — the opposite end);
  the angle accumulates in `rec.spin`, `def` is untouched. A positive angle is
  counterclockwise as seen from the end of the axis in MAP space (the quaternion negates it
  for the mirrored world). Only a separate FBX object spins: in Blender the part is its own
  object with the origin on the axis.

## GLB models: skeleton and animation clips

```js
const model = await Model3D.load('assets/models/character.glb', view);   // a LITERAL path
const hero = Model3D.build(model, view, { name: 'hero' });
World3D.addObject(view, hero, 'actor');
hero.setPosition(-x, terrain.heightAt(x, y), y);
hero.setRotation(World3D.rotQuat(0, -heading, 0));      // the model's nose looks along +X, like FBX
const clips = Model3D.clips(hero);                // Clips3D
clips.play(moving ? 'run' : 'idle');              // every frame is fine: the current clip is not restarted
clips.play('attack', { loop: false, then: 'idle' });
```

- A model placed in the editor: `rec = app.location.objects.find(o => o.def.name === 'character')`,
  `Model3D.clips(rec.mesh)` — `rec.mesh` is null until the file has loaded (`rec.loaded`).
  `def.clip` is the clip the location loops by itself; it acts only when the field CHANGES,
  so game code may drive the same model.
- `play` cross-fades over `MODEL_CLIP_BLEND_SEC` through the AnimComponent layer
  transition; the first play starts the layer, a switch mid-fade transitions from the
  current weights. Non-looped clips chain through `then` (the view's before-frame hook
  watches the layer clock against the track duration). `stop()` — the rest pose
  (`layer.reset()`).
- Units and axes: glTF is meters with the front along +Z — `build` wraps the instantiated
  hierarchy in a node scaled by 100 (1 cm = 1 px) and turned −90° about Y (the mirror). The
  root it returns is a plain entity without geometry: position, heading and scale go on it,
  like for an FBX model.
- Materials: glTF gives PBR, the toon chunks live on `StandardMaterial` in the
  diffuse-specular workflow — every build converts the container's materials (base color,
  base color texture, normal map, alpha/alphaTest, blending, culling). The file is loaded
  once per view (a container asset in `view._assets`), each `build` instantiates it: own
  entities, skeleton and clips.
- Blender: one armature, actions named `idle`, `run`… pushed to NLA or exported as separate
  animations, format glTF Binary (`.glb`), +Y up. The kit's `character.glb` is generated by
  `node tools/make-character.mjs` (skill `build`) — a stand-in to replace.
- No loader script on the page — a `.glb` fails like a missing file (the object has `error`),
  the scene lives on.

## Camera

Zoom — screen px per world px at the look-at point; `dist = H / (2·tan(fov/2)·zoom)`.
Camera = target − (cos az, sin az)·cos(pitch)·dist, height + sin(pitch)·dist, no lower than
ground + 40 (`EYE_MIN`). The facade (`ArcCamera`) mirrors position/target into the entity
and keeps `fov` in RADIANS for the old math. The target normally sits on the ground; flight
lifts it: `target.h = ground + lift`. Pitch is the angle below the horizon: negative —
looking up.

| | game mode | free (`setFree(true)`, editor) |
|---|---|---|
| WASD, arrows | flight: W/S along the view (pitch included), A/D — strafe; speed `CAMERA_FLY_SPEED` screen px/s (÷ zoom over the world) | same |
| Q / E | down / up along the world vertical | same |
| RMB | look around if `CAMERA_ORBIT = 1`: the camera stays, the target swings around it (`_look`); while `follow` is active — orbit around the object | look around |
| LMB | not taken (game input) | orbit around the target; Shift — pan |
| middle, finger | pan "follows the pointer" | same |
| wheel / pinch | zoom to cursor within `CAMERA_ZOOM_MIN..MAX` | wider limits |
| limits | none by default; `CAMERA_LIMITS = 1`: pitch `CAMERA_ORBIT_PITCH_*` and ground edge kept out of frame, target inside the location, `lift ≤ CAMERA_LIFT_MAX` | none: pitch −85°..88°, orbit not below 8° |

`home()` (key R) — orientation and zoom from constants, target — the `follow` object or the
center, on the ground (`lift = 0`; `lookAt(x, y)` drops `lift` too, `follow` decays it).
`applyConstants()` re-reads constants (FOV — immediately). Keys (`e.code`: WASD, arrows, Q,
E, R — `FLY_KEYS`) are not intercepted inside input fields. A game that steers its own object
with those keys sets `camera.flightKeys = false`: the controller stops adding them to `_keys`
(and stops calling `preventDefault`), while RMB orbit, the wheel and R stay with the camera —
no need to mutate the static `FLY_KEYS` table. `camera.lookAt(x, y, h)` puts the look-at point
`h` px above the ground (without `h` it drops to the ground as before): a game framing a tall
prop calls it once at boot, and the lift survives because following an object is what decays it.
Flight (`_fly`) moves the target
by a world vector normalized to the step, keeps absolute height (`_setTarget3` turns it into
`lift`) and holds the camera above the ground (`_floorEye` raises `lift`, the view direction
stays). Pan keeps the ground point under the cursor by intersecting the plane at its height,
in two passes. `groundFocus()` — the ground point at the frame center (`{ x, y, h, k }`): in
flight it is ahead of the target; the shadow range is fitted around it, the editor drops new
objects there.

## Pitfalls (each one already cost an iteration)

- Which screen side a map axis lands on is NOT to be derived by hand from the mirror table:
  measure it. `view.projectToScreen(mx + d, my, h)` versus `view.projectToScreen(mx - d, my, h)`
  tells you where +x actually projects for the current azimuth (on PlayCanvas 2.22 with the
  kit's default camera it is the LEFT side). Author asymmetric props — a sign, a chute, a
  control deck — only after that check, and place them by the measured answer.
- A bake that mirrors X (the kit convention for geometry authored in map space) mirrors authored
  TEXT with it: a sign reads backwards on screen. Write sign strings with a pre-mirrored pen
  (glyphs reversed in order and in columns) so the bake's mirror cancels it, or verify the sign
  with a screenshot before shipping.

- The engine is WebGL2-only in PlayCanvas 2: no WebGL1 fallback path exists anywhere in the
  kit (the old Poisson-shadow branch is gone).
- `pc.shaderChunks` (the global proxy) is deprecated and type-less: read engine chunk
  sources through `pc.ShaderChunks.get(device, pc.SHADERLANGUAGE_GLSL).get(name)`. The toon
  light-loop patch is a string replace on the default `lightFunctionLightPS` at the anchor
  `dAtten *= shadow;` — if a future engine renames the anchor, `ArcToon.register` keeps the
  unpatched chunk and the colored shadow silently degrades to a plain one.
- Chunk overrides must define every function they call in a chunk included EARLIER: the band
  function lives in `litUserDeclarationPS`, not in `litUserCodePS` (the latter is not part
  of the forward pass).
- Custom `ShaderMaterial`s need an explicit attribute->semantic map
  (`attributes: { vertex_position: pc.SEMANTIC_POSITION, … }`); custom streams go through
  `mesh.setVertexStream(pc.SEMANTIC_ATTR6, …)`. A missing binding reads as zeros: the ink
  ribbons once exploded into screen-filling quads.
- The silhouette hull is an inverted-hull post pass on the SAME mesh at equal view depth:
  on some hand-built meshes (procedural boxes/cones, imported convex props) the hull wins
  the depth tie and paints the object over with the ink color — a black shell with the ink
  creases on top. Remedy: register such objects with
  `World3D.addObject(view, ent, kind, { outline: false })` (toon bands and ink edges stay),
  or keep the hull for kit/Blender meshes only. Symptom to recognize: the object renders
  lit and correct with `WORLD3D_TOON_OUTLINE = 0` and black with it on.
- FBX carries NO textures, bones or clips into this kit (only vertex colors of materials):
  an imported foliage/prop set from a DCC or a game engine renders as flat color shapes.
  Plan palettes for that, or ship GLB (textures + skeleton + clips) for anything that must
  keep its look or animate.
- `World3D.removeObject` drops the entity's instances from custom layers (OVERLAY/ACTOR,
  put there by `view.setLayer`) BEFORE destroying it: a destroyed instance left listed in a
  layer crashes the next cull on its stale aabb. If you bypass removeObject and destroy a
  layered entity yourself, call `view.dropFromLayers(mi)` for every mesh instance first.
- The outline hull cull is `CULLFACE_BACK` for the kit's winding in the mirrored world
  (measured: `CULLFACE_FRONT` drew the near shell over the object). Do not "fix" it without
  re-measuring on both an FBX prop and the skinned GLB.
- `GraphNode.find(callback)` returns an ARRAY; `attach(null)` on a gizmo keeps a null node —
  call `attach()` with no argument to detach.
- `IndexBuffer.lock()` returns the typed storage; `mesh.indexBuffer[0]` is the solid-style
  buffer (`RENDERSTYLE_SOLID = 0`).
- `placeObject` sets the rotation from `def.rot` every time: a quaternion left on the entity
  by the editor gizmo is replaced, not merged (`setRotation`).
- `Model3D`: triangles keep the FILE fan order in the mirrored world (the mirror is the
  winding flip); parts with a mirrored node transform (negative determinant) get the
  reversed fan. `DiffuseColor` in the file is linear (Blender) — `_gamma` converts to the
  sRGB values PlayCanvas materials expect.
- A mesh without a NORMAL stream breaks normal-dependent shaders (the hull pushes along
  `normalize(0)` = NaN): `Model3D.build` computes smooth normals when the file has none.
- A quoted `'assets/…'` path even in a COMMENT is treated by the builder's asset scanner as an
  asset reference — the build fails on a "missing" file. In comments — no quotes.
- A skinned mesh gets no ink edges (`addObject` skips `mi.skinInstance`): the ribbon is
  built once from the rest pose and would stay behind while the bones move the mesh. The
  silhouette outline and shadows follow the skeleton.
- There is NO `Entity.setScale` in PlayCanvas 2 — only `setLocalScale(x, y, z)` /
  `setScale` was Babylon. Uniform scale: `node.setLocalScale(s, s, s)`.
- Meshes are ref-counted: destroying a mesh/asset that another live entity still renders
  kills that entity's draw (or crashes the next cull). `Model3D.dispose` frees only what the
  model itself created; never destroy shared kit meshes (ground, hull, ink) by hand.
- Destroying an entity whose mesh instances were added to a CUSTOM layer (ink, outline hull)
  leaves dangling instances in the layer lists — pc then crashes on a stale `_aabbVer` during
  culling. `World3D.removeObject` and `View3D.dispose` remove the instances from every custom
  layer BEFORE destroy; any new code that destroys such entities must go through them.
- Mirror-world normals: geometry is authored in map space but rendered mirrored (map X ->
  world −X), which flips handedness. `Mesh3D.build` takes positions already in WORLD space,
  computes normals there and fixes the winding against them (`against ≈ 0` — the
  `Debug3D.lint` convention). Hand-rolled meshes that skip this read as "consistent winding"
  while lighting from inside — the classic black outline-hull shell.
- `setTarget` degenerates at ±90° pitch — limits are 88–89° (−85° looking up).
- Camera math goes through `_eye()` (position from target/azimuth/pitch/zoom), not through
  the facade position: the facade also carries shake and the ground floor.

## Semantic Scene API (agents and game code)

```js
Scene.spawn('assets/models/mill.fbx', { kind: 'prop', x: 800, y: 900, heading: 30 });
Scene.move('mill-2', { x: 820, clip: 'idle' });      // patch the def, re-place
Scene.query({ kind: 'actor' });                       // plain JSON snapshots
await Scene.inspect();                                // totals + Debug3D.lint, silent
Scene.follow('hero');                                 // camera on the object
Scene.manifest();                                     // SCENE_SCHEMA
```

- `js/SceneAPI.js` + generated `js/SceneSchema.js` (`tools/manifest.mjs`): every call is
  validated against the manifest (constants with editor ranges, record fields) and fails
  with a readable `Error` BEFORE anything reaches the frame — an agent can self-correct
  from the message alone.
- Records are the canon `Location3D.objects` defs (the same objects the editor edits):
  `spawn` goes through `Location3D.addObject` (group/ink/outline applied), `move` edits the
  def in place and calls `placeObject`. Nothing here bypasses `World3D.addObject`.
- `inspect(filter?)` is the agent's verification loop: `{ kind?, name?, model?, area? }`
  selectors, machine-readable `{ objects, loaded, errors, triangles, fps, findings,
  entities, camera, warnings }`; pair it with a headless screenshot for the look
  (skill `verify`).
- Visual assertions return `{ ok, code, details }` instead of throwing:
  `Debug3D.assertVisible(name)` (loaded + at/above ground + in frame),
  `assertInFrame(name)`, `assertPosition(name, x, y, tol)`, `Debug3D.capture()`
  (render now + PNG dataUrl). The headless gate aggregates them and writes a JSON report
  (`tools/headless-gate.mjs --json=FILE`).
- Composite edits are transactions: `Edit.begin(label).add(model, opts).update(name, patch)
  .remove(name).commit()` — every op is validated BEFORE anything is applied; an apply
  failure rolls the snapshot back and rethrows, the outcome lands in `Scene.journal()`
  (committed / rolledback / rejected / discarded). `tx.rollback()` drops a pending tx.
- Determinism: `Scene.seed(n)` fixes `Scene.random()` (starters use only it, never
  `Math.random` — the apigate test enforces); terrain noise comes from the
  `TERRAIN_NOISE_SEED` constant and is independent of the seed.
- Game-loop/state/UI/assets without `pc.*`: `Kit.state(key, value?)`, `Kit.onFrame(name, fn)`
  / `offFrame`, `Kit.time()/dt()/fps()`; `UI.query()`, `UI.patch(id, patch)` (schema-validated,
  `id`/`kind` immutable), `UI.add/remove/get`; `Asset.preload(path)`, `Asset.list()`,
  `Asset.loaded(path)`. The name `Game.*` is deliberately free: every scaffolded game
  defines its own `class Game`.

## Constants

Groups in `Constants.js`: `LOCATION_*`/`GROUND_TILE_SIZE`/`TERRAIN_*` (location),
`CAMERA_*` (camera), `WORLD3D_*` (render), `MODEL_*` (clips), `UI_*` (skill `ui`), `GAME_*`
(the sample game). Values live in the file; the editor tunes them.

## Edit checklist

1. New constant: numeric literal in `Constants.js` + read via `typeof` with a default
   (`World3D.cfg()` / `CameraController.cfg()`) + a row in `_utils/editor/schema.js`
   (labels `{ en, ru }`, skill `editor`).
2. New script: file in `js/`, `<script src="js/…">` in `index.html` (after `Constants.js`,
   before `main.js`) and a line in `CODE_FILES` (`tools/asset-scan.mjs`); for the editor — the
   same script in its `index.html` (`/js/…`).
3. New world object — through `World3D.addObject`; screen↔world projections — through `View3D`.
4. Do not touch: the mirror convention, CSS-px scaling in `pointerToGround`, the hull cull,
   the terrain normal check, the chunk anchor in `ArcToon.register`.
5. `node tools/check.mjs` passes (types and tests, skill `build`); a new field on an engine
   object goes into `globals.d.ts` (`ArcMaterial`/`ArcNode`/`ArcMesh` interfaces).
6. Check the game (`run.bat`) and the editor (`editor.bat`) in the browser: console without
   errors.
7. Own geometry, a material with a normal map, a new light or shader: `await Debug3D.lint()`
   — no errors (skill `render-conventions`); how to look and measure — skill `verify`.
