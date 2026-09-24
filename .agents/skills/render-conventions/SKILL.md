---
name: render-conventions
description: Conventions and hard limits for anything you add to the scene yourself — custom geometry (winding in the mirrored world, culling), normal maps (OpenGL vs DirectX), extra lights (shadow casters, the single sun of the toon shader), shader limits, instancing, procedural placement. Read before building a mesh from vertex data, porting a generator or importing glTF, before creating a material with a normal map, before adding a light, and whenever something looks inside out, lit from the wrong side, or a light or a mesh silently disappears.
---

# Render conventions: what the engine assumes about your meshes, materials and lights

Every rule here is a defect that once reached the screen and was found by eye, not by test.
`Debug3D.lint()` (`js/engine/Debug3D.js`, editor button "Lint scene") checks most of them — run it
after adding geometry, materials or lights. Skill `verify` tells how to look at the result.

The engine is PlayCanvas 2 (WebGL2 only), and the kit's world is the map space MIRRORED on X
(skill `world3d`, §Coordinates): geometry you build by hand goes into the world as
`(-x, h, y)`, and its winding follows the rules below.

## Winding and culling

Back-face culling is on by default (`material.cull = pc.CULLFACE_BACK`); PlayCanvas keeps the
counter-clockwise side as the front (`material.frontFace = pc.FRONTFACE_CCW`). Vertex normals
do not take part in the decision. A mesh with the opposite order is drawn INSIDE OUT: front
faces are culled and you see the far inner wall. The silhouette is unchanged, so it looks
plausible — but the texture is mirrored and the light comes from the wrong side.

The rule for THIS kit (measured on the terrain, the FBX parser and glTF imports;
`Debug3D.windingAgainstNormals`). Take the triangle normal as `cross(b - a, c - a)` in the
mirrored world space:

| Index order | The cross product points | Verdict |
|---|---|---|
| Kit geometry: `Terrain3D`, `Model3D` (FBX fan order, mirrored world; mirrored node transforms reversed) | ALONG the vertex normals | correct (`against ≈ 0`) |
| the same mesh with the order reversed | AGAINST the vertex normals | inside out |

- A negative scale on the entity (`worldScaleSign < 0`) flips the side once more — the
  renderer accounts for it when drawing, and so does the lint (`sideVerdict(against, mirrored)`).
- Fix by reversing the indices of the offending part (or `cull = pc.CULLFACE_NONE` for cards
  and leaves): PlayCanvas has no per-mesh side flag, only the material's cull/frontFace.
- A check that compares winding with normals INSIDE one mesh proves only that they agree
  with each other. Whether the mesh is inside out is decided against the convention — compare
  with a `pc.Mesh` built by the kit or a loaded glTF in the same scene.
- Fast look: editor toolbar "view: back faces" (`Debug3D.setMode('backfaces')`) — an
  inside-out mesh is red from the outside.
- An open hull (a trunk without a bottom cap, a wall without a back) shows its inside wherever
  the ground does not hide the rim: a trunk planted at the ground height of its CENTER hangs
  in the air on the downhill side of a slope. Extend the mesh below the ground by the radius
  times the steepest slope, or add a cap.

## Normal maps

A map's convention is not in its pixels, only in its origin: Poly Haven `*_nor_gl`, glTF and
Blender bakes are OpenGL (Y up); `*_nor_dx`, Unreal and most "game ready" packs are DirectX.
PlayCanvas reads OpenGL maps as they are (the glTF path needs nothing); a DirectX map needs
its green channel inverted — `material.bumpiness < 0` inverts the whole map, which is close
enough for flat-ish surfaces, re-exporting is cleaner. With the wrong sign grooves look like
ridges lit from the opposite side — easy to mistake for flipped mesh normals. Keep
`_nor_gl` / `_nor_dx` in the file name: the lint judges by it and only leaves a note when the
name says nothing.

## Lights

- The kit has ONE shadow-casting directional light (`view.sun`): the toon chunks record the
  shadow of the directional light in the loop, and a second caster would fight over the one
  colored shadow. Extra lights: non-shadow local lights are fine; keep the sun the only
  `castShadows` directional (`Debug3D.lint` counts them).
- A mesh receives shadows when `meshInstance.receiveShadow` and casts when
  `meshInstance.castShadow` (`World3D.addObject` sets both; the terrain only receives).
- Shadow quality comes from `sun.shadowDistance` (the depth range the cascade spans): the
  tighter, the more texels per world px. `View3D.fitShadowFrustum` keeps it around the visible
  area; a hand-made light should not widen it.
- WebGL2 limits still apply: every shadow map and texture takes a sampler unit (16), and each
  light adds uniforms to every lit shader — dozens of local lights belong in one clustered
  light setup (`scene.clusteredLightingEnabled`), which casts no shadows.
- A feature toggled by a preset or a constant must be tested in the state the player runs,
  not with the value you set by hand in the console.

## Custom shaders (`pc.ShaderMaterial`, toon chunks)

- A `ShaderMaterial` needs an explicit attribute map
  (`attributes: { vertex_position: pc.SEMANTIC_POSITION, … }`) and, for custom streams,
  `mesh.setVertexStream(pc.SEMANTIC_ATTR6, …)`. An unmapped attribute reads as ZEROS without
  any error: the ink ribbons once exploded into screen-filling quads because their "other
  end" stream was unmapped.
- Chunk overrides on a `StandardMaterial` (`material.shaderChunks.glsl.set(name, src)`) must
  define every helper in a chunk included EARLIER in the pass — the forward pass includes
  `litUserDeclarationPS` but not `litUserCodePS`.
- The engine's own chunk sources are read through
  `pc.ShaderChunks.get(device, pc.SHADERLANGUAGE_GLSL).get(name)`; a string patch on them
  needs a stable anchor and a silent fallback (see `ArcToon.register`).
- A NaN spreads through the whole frame: `normalize()` of a zero vector or `pow()` of a
  negative poisons every pixel that uses the result (the outline hull once vanished into a
  NaN clip position). Clamp inputs; guard `normalize(x + 1e-9)`.
- Noise evaluated per pixel every frame is the most expensive way to get detail. Bake a
  seamless texture once at load (a sum of sinusoids with INTEGER wave vectors is periodic by
  construction), sample it two or three times at non-commensurate scales and rotations —
  mipmaps then remove far-field sparkle for free and the tile does not read.
- Transparent surfaces over an already rendered scene: `material.blendType =
  pc.BLEND_PREMULTIPLIED`, `depthWrite = false`; marks that must ignore the world depth also
  set `depthTest = false` and live in the OVERLAY layer (`view.setLayer`).

## Instancing and procedural placement

- One mesh per kind + instanced mesh instances (or a `pc.MeshInstance` per copy when the
  count is small); after changing instance buffers refresh the bounds, or frustum culling
  works on stale bounds. Picking sees instances through the engine's Picker.
- Placement rules are written in RELATIVE terms (fractions of the snow line, of the map size),
  never as absolute px offsets from a constant the user tunes in the editor: a slider move must
  not wipe out the forest.
- Whatever refers to a placed instance (saved edits, game state) needs a stable id — a tag or
  the position at placement — not its index: indices shift whenever a rule or a constant
  changes the scatter.

## Vertex colors: one mesh, many colors (voxels, palettes, tints)

A mesh with a color per vertex needs neither a material per color nor a texture:

- `mesh.setColors(floatArray, 4)` (RGBA per vertex) plus `material.vertexColors = true`.
- The albedo multiply is OPT-IN per channel group: `material.diffuseVertexColor = true`
  (with `diffuseVertexColorChannel`, default `'rgb'`) defines `STD_DIFFUSE_VERTEX`, which does
  `dAlbedo *= saturate(vVertexColor.rgb)`. `vertexColors` alone only binds the attribute —
  without `diffuseVertexColor` the colors are silently ignored and the mesh renders white.
- Keep `material.diffuse` white and write the vertex colors in the SAME space the kit writes
  `material.diffuse` (hex/255, `World3D.hexColor3`): the toon chunks and the sRGB output then
  treat them exactly like any other object's albedo. `useVertexColorGamma` stays off — the kit
  does not gamma-decode its diffuse either. One shared material per render group then serves
  every mesh of that group, so a whole voxel cabinet is one draw call.
- Bake per-corner ambient occlusion straight into the vertex color (multiply the rgb). For a
  box face corner read the two side neighbours and the diagonal one, all pushed out along the
  face normal: `level = (side1 && side2) ? 0 : 3 - (side1 + side2 + corner)`, brightness
  `[0.44, 0.63, 0.82, 1.0][level]`; split the quad along the OTHER diagonal when
  `ao[0] + ao[2] > ao[1] + ao[3]`, or the gradient bends visibly across the seam.
- Cull hidden faces before baking (a voxel face whose neighbour is solid is never seen): a
  twenty-thousand-voxel model bakes down to a few thousand quads.

Transparent panels (glass, holograms): PlayCanvas 2 has NO `pc.BLEND_ALPHA` — the constants are
`BLEND_NONE`, `BLEND_NORMAL`, `BLEND_PREMULTIPLIED`, `BLEND_ADDITIVE` and friends. For a
see-through surface use `blendType = pc.BLEND_PREMULTIPLIED` (ONE, ONE_MINUS_SRC_ALPHA) with the
vertex rgb ALREADY multiplied by the panel alpha and `material.opacity` set to that same alpha,
plus `depthWrite = false`, `cull = pc.CULLFACE_NONE`, `useLighting = false`, and
`castShadow = false` in the `World3D.addObject` opts. With `BLEND_NORMAL` and an unmultiplied
color the panel renders effectively opaque and hides what it was meant to show.

## Checklist

1. `await Debug3D.lint()` in the game and "Lint scene" in the editor: no errors.
1b. Vertex-colored mesh: `diffuseVertexColor` set, colors in the kit's diffuse space, hidden
    faces culled; a transparent one premultiplied and without depth write.
2. "view: back faces": nothing red from the outside.
3. New light: the sun is still the only shadow caster, shadows still fall at night and by day,
   the ground and the biggest props receive them.
4. Looked at from the player's camera with the player's constants — skill `verify`.
