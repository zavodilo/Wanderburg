---
name: visual-migration
description: Converting a game between render profiles (2d <-> 3d) as a NON-DESTRUCTIVE presentation migration — the 16-step transaction, the dry-run plan, rollback, the preservation proof and the VisualMigrationJournal. Read before RenderProfile.convert / Variant.convert / Migration.*.
---

# Visual migration: change the presentation, keep the game

A migration is **presentation only**. It creates or updates a VARIANT; the source variant
stays; no gameplay file is rewritten; a save made before still loads after.

## The contract

```
preserve: gameplay, entity_ids, scene_ids, world_logic, logical_coordinates, rules,
          systems, quests, inventory, combat, economy, progression, ui_logic,
          save_schema, audio_cues, input_actions
change:   camera, rendering, visual_assets, lighting, materials,
          animation_representation, world_presentation, depth_model, visual_effects
```

## Steps (Migration.convert runs them as a transaction)

```
validate-source -> snapshot -> preserve-gameplay -> preserve-entity-ids ->
preserve-scene-ids -> preserve-coordinates -> preserve-rules -> preserve-save-schema ->
replace-visual-mappings -> replace-camera -> replace-lighting ->
replace-world-presentation -> generate-placeholders -> validate -> headless-render -> commit
```

Any failure: `rollback()` restores the snapshot and the journal records `rolledback`.

## Always plan first

```js
const plan = RenderProfile.plan('2d', 'full3d');   // or Migration.plan(src, dst)
```

Show the counts to a human before applying a big migration:

```
Entities 124 · Preserved 124 · Visual replacements 93 · Missing 3D assets 17
Fallback geometry 17 · Camera 1 · Lighting 1 · World 1 · Gameplay files changed 0
```

`gameplayFilesChanged` must be 0. If it is not, you are rewriting the game, not migrating it.

## Missing assets are not failures

`full3d model -> lowpoly -> isometric -> primitive capsule/box -> generated placeholder`
`sprites missing -> generated placeholder card (assets/visual/<profile>/<role>.png)`

`tools/variants.mjs convert --write-placeholders` writes the placeholder PNGs (dependency-free
encoder). Replacing placeholders with production art is a later, separate step.

## The journal answers "what changed?"

`presentation/migration-journal.json` (+ `GAME_SPEC.visualMigrationJournal`) records
`{ from, to, source, target, status, changes, preserved proof, assetsGenerated, fallbacksUsed,
rollbackAvailable, by, timestamp }` for every conversion.

## Verification (mandatory after a migration)

```
node tools/check.mjs
node tools/check.mjs --profiles        # preservation proofs across the whole ladder
node tools/arc.mjs variant validate --all
```

The proof fields: `report.preserved.{gameplayPreserved, entityIdsPreserved, saveSchemaPreserved,
coordinatesPreserved}` — all must be true.
