---
name: materials
description: How each render profile shades surfaces — unlit sprites, toon bands, stylized low-poly, PBR — plus the kit's toon/ink/outline switches and the sprite material conventions (unlit, alpha, own layer). Read before changing materials, shaders or a variant's materials block.
---

# Materials per profile

| profile | shading | textures | notes |
|---|---|---|---|
| 2d | unlit | diffuse-only (nearest) | sprites are their own color; no light, no shadow |
| 2.5d | toon | diffuse | billboards unlit, models toon |
| isometric3d | toon | diffuse | + ink edges and silhouette outline |
| lowpoly3d | stylized | diffuse or none | flat-ish colors, no PBR maps |
| full3d | pbr | albedo+normal+metalness | smooth shading, real specular |

`variant.materials.shading` selects the row; the kit's switches (`WORLD3D_TOON`,
`WORLD3D_TOON_INK`, `WORLD3D_TOON_OUTLINE`) remain editor-tunable and compose with the preset
through `World3D.cfg()` overrides (skill `lighting`).

## Sprite materials (js/engine/Sprite2D.js)

- `useLighting = false`, emissive map = the texture, opacity from the alpha channel;
- `cull = CULLFACE_NONE` (a screen-aligned quad has no back), `depthWrite = false`;
- depthTest on for 2.5D+ (3D occludes sprites), off for pure 2D (declarative order rules);
- atlas frames = UV tiling/offset on the same material — one texture per animation;
- nearest filtering for pixel art (`Sprite2D.pixelArt`, set by the 2d/2.5d adapters).

Engine-side material rules (winding, normal maps, shared meshes) stay in skill
`render-conventions`.
