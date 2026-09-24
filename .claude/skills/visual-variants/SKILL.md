---
name: visual-variants
description: The Master Project workflow — inspect/create/clone/convert/compare/run/validate visual variants of ONE game (2D, 2.5D, isometric, low-poly, full 3D) without copying the project; "create all five variants" requests, run --all, and the editor's Profile tab. Read for any request that mentions variants, editions, or several visual versions of one game.
---

# Visual variants of one Master Project

One repo = one Master Project = one game model (`js/GameSpec.js`) with N variants
(`presentation/variants/*.json`). Never create `Game2D/` + `Game3D/` copies, never branch per
profile, never replace `js/` when switching.

## The canonical AI instruction this skill serves

> Create this game and provide all five visual versions: 2D, 2.5D, Isometric 3D, Low-poly 3D,
> Full 3D. One Master Project, one shared Game Model, five independent variants. Do not copy
> the project. Keep entity ids stable. Keep gameplay, world logic, quests, combat, inventory,
> progression and save schema shared. Use the common asset registry. Generate fallbacks.
> Validate and launch all five.

Answer with:

```
node tools/arc.mjs variant create-all                     # one variant per profile
node tools/arc.mjs variant convert --source <v> --profile 2d --write-placeholders   # art stubs
node tools/arc.mjs validate --all                          # per-variant load/assets/camera/save
node tools/arc.mjs run --all                               # five tabs, one source tree
```

## Operations

| Want | Command / API |
|---|---|
| see what exists | `arc variant list`, `Variant.list()` |
| one variant's truth | `arc variant runtime --variant <id>` |
| a new variant | `arc variant create <id> --profile <p>` or `Variant.createFromProfile(p)` |
| a copy of configuration only | `arc variant clone <id> <newId>` |
| convert (non-destructive) | `arc variant convert --source <v> --profile <p>` |
| diff two variants | `arc variant compare <a> <b>` |
| validate everything | `arc validate --all` |
| run everything | `arc run --all` (or `/?project=…&variant=…` per tab) |

## Variant file shape (presentation/variants/<id>.json)

`{ id, name, profile, enabled, camera{mode,follow,azimuthDeg,elevationDeg,orthoHeightPx,fovDeg,
zoom}, lighting{preset,…}, materials{shading}, environment{ground,flatten,tilePx},
animation{style}, ui{space,scale}, audio{spatial}, effects{…}, performance{…} (tighten only),
visualMappings }` — see `manifest/variant-schema.json`.

Overrides inherit: **profile defaults <- presentation/presets/<name>.json <- variant <- scene
preset**. A variant may only TIGHTEN the profile's performance budget.

## Editor

The Profile tab shows PROJECT / PROFILE / VARIANT separately, previews any variant live in the
view (no source writes), previews/applies a migration, and "Create all variants" persists via
`POST /api/save-variant(s)`, `/api/save-journal`, `/api/regenerate-variants`.
