---
name: render-profile
description: The orchestration skill of the unified visual pipeline — profiles (2d, 2.5d, isometric3d, lowpoly3d, full3d) vs variants, what each decides, how to read and switch them, and which checks to run. Read before touching js/presentation/, js/profiles/, manifest/render-profiles.json, presentation/variants/* or GAME_SPEC.renderProfile.
---

# Render profiles: one game, many presentations

## The model (canonical)

```
ONE GAME MODEL (js/GameSpec.js: GAME_SPEC)
   rules · systems · world · entities · scenes · assets · ui · audio · progression · saveState
        │
        ├── PROFILE   a TYPE of presentation: camera/projection, representations, lighting,
        │             animation system, depth model, capabilities, performance budget
        │             canon: manifest/render-profiles.json -> js/presentation/RenderProfiles.js
        │
        └── VARIANT   one CONCRETE presentation of THIS project: a profile + overrides
                      (camera, lighting preset, visual mappings, environment, effects)
                      canon: presentation/variants/<id>.json (one file each)
```

**Profile != Variant.** Five variants of one project share one game model, one asset
registry, one save schema. Converting never copies the project and never rewrites gameplay.

## Runtime API (semantic; never pc.*)

```js
RenderProfile.get() / .list() / .info(id) / .capabilities(id) / .budget(id)
RenderProfile.set('2d')                 // present the same game as 2D (activates its variant)
RenderProfile.config()                  // profile defaults <- variant overrides <- scene preset
RenderProfile.canConvert(from, to)      // { ok, reason, warnings }
RenderProfile.plan(from, to)            // DRY RUN: the MigrationPlan (show it to a human first)
RenderProfile.convert(from, to)         // non-destructive: creates/updates the target variant
RenderProfile.suggest('pixel-art top-down RPG')   // intent -> profile (never genre == profile)
RenderProfile.inspect()                 // machine-readable state for an agent

Variant.list() / .current() / .activate(id) / .create / .clone / .compare(a, b)
PlayArcRuntime.start({ project, variant })        // one runtime instance per variant
PlayArcRuntime.context()                          // { project, variant, profile, hashes… }
```

The canonical coordinate system is `x` horizontal, `y` height, `z` depth. A 2D game is the
`y = 0` case of the same space. Gameplay never branches on a profile.

## Files

| Path | Role |
|---|---|
| `manifest/render-profiles.json` | the profile canon (validated by `tools/render-profiles.mjs`) |
| `js/presentation/RenderProfiles.js` | GENERATED from the canon — do not hand-edit |
| `js/presentation/RenderProfile.js` | the runtime: get/set/plan/convert/inspect/suggest/budget |
| `js/presentation/Variant.js` | variants: create/clone/convert/compare/effective/validate |
| `js/presentation/Runtime.js` | `PlayArcRuntime`: one project, many runtime instances |
| `js/profiles/<id>/profile.js` | per-profile BEHAVIOUR adapters (all data from the manifest) |
| `presentation/variants/<id>.json` | one variant each (hand/agent/editor authored) |
| `project.json`, `js/presentation/Variants.js`, `presentation/profiles/*.json` | GENERATED (`tools/variants.mjs`) |

## Choosing a profile (AI decision rules)

Use user intent + visual constraints, not a genre table: camera, art style, geometry, depth,
lighting, animation, performance target, wording. `RenderProfile.suggest()` scores the same
signals; record the decision in `GAME_SPEC.renderProfileReason`. If several profiles fit, pick
the most direct match and say why.

## Commands

```
node tools/arc.mjs variant list | inspect | validate --all | runtime --variant <id>
node tools/arc.mjs variant plan --from 2d --to full3d
node tools/arc.mjs variant convert --source <variant> --profile full3d [--dry-run] [--write-placeholders]
node tools/arc.mjs run --variant <id>          node tools/arc.mjs run --all
node tools/check.mjs --profiles                # the headless profile/migration matrix
```

## Checks after any profile work

1. `node tools/check.mjs` (types, tests, skills sync, manifests, drift)
2. `node tools/check.mjs --profiles` (every profile presents, every conversion preserves)
3. with a browser environment: `node tools/check.mjs --variants` (five live runtime instances)
4. gameplay proof, one session: `GameModel.gameplayHash()` identical before/after a conversion
   (it covers LIVE model state — positions, logic, progression — so it only means something
   inside the session that made the conversion).
5. shared-game proof, across instances: `PlayArcRuntime.context().contractHash` and
   `saveSchemaHash` identical in every variant/tab (the contract covers the spec: rules, systems,
   the authored world, entity identities, scenes, roles, input, cue ids, the save schema — never
   live state, so a playing game does not move it).
