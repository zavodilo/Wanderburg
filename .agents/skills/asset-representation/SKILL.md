---
name: asset-representation
description: The semantic asset registry — roles (player.visual) instead of files, one variant per render profile, fallback chains, generated placeholders, variant visualMappings overlays. Read before adding/changing assets, GAME_SPEC.assets, presentation/mappings/*, or debugging a missing-asset fallback.
---

# Asset roles and per-profile representations

Gameplay and entities reference ROLES, never files:

```
player.visual   enemy.zombie.visual   world.tree.visual   weapon.pistol.visual   audio.step
```

The registry (`js/presentation/AssetRegistry.js`, data in `GAME_SPEC.assets`) maps each role to
one variant per profile:

```json
{ "role": "player.visual", "variants": {
    "2d":          { "type": "sprite",    "asset": "assets/visual/2d/player.png", "size": [72,96] },
    "2.5d":        { "type": "billboard", "asset": "assets/visual/2d/player.png" },
    "isometric3d": { "type": "model",     "asset": "assets/models/character.glb", "clips": { "run": "run" } },
    "lowpoly3d":   { "type": "model",     "asset": "assets/models/character.glb" },
    "full3d":      { "type": "model",     "asset": "assets/models/character.glb" } } }
```

## Resolution (never throws)

```
variant mapping overlay (presentation/mappings/<variant>.json)
   -> the role's variant for the profile
   -> fallback chain (same/lower dimension first, then higher)
   -> generated placeholder (canvas card in the browser, PNG on disk via tools/placeholder.mjs)
```

Rules: a fallback must still be DRAWABLE in the target profile (no 3D model in a sprite-only
2D profile — there the placeholder is the answer); sprite/billboard coerce into each other;
`resolvedBy` reports `variant | fallback | placeholder` and the migration lists it.

## Files on disk

`assets/visual/<profile>/<role>.png|glb` — the kit's asset scanner only sees LITERAL paths, so
every asset path stays a quoted literal. Generated placeholders are marked `"generated": true`
in the mapping and are meant to be replaced by production art later.

## Commands

```js
AssetRegistry.resolve('player.visual', 'full3d')      // { type, asset, resolvedBy, … }
AssetRegistry.missing('2d')                           // roles without a real file
AssetRegistry.setOverlay(map, name)                   // a variant's visualMappings, non-destructive
```
