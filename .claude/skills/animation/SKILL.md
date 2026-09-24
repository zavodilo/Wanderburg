---
name: animation
description: The semantic animation API — shared states (idle/walk/run/attack/hurt/death/jump…), GameAnimation.play/stop/state/subject, and how a state becomes sprite frames in 2D or a skeletal clip in 3D via the registry. Read before touching animation, clips, frames or GameAnimation.
---

# Semantic animation

Gameplay names a STATE; the profile names the representation:

```js
GameAnimation.play('run');                 // the default subject (the followed entity)
GameAnimation.play('player', 'attack');    // an explicit entity
GameAnimation.state('player');             // 'attack'
GameAnimation.subject('player');           // who play() targets by default
GameAnimation.system('2d');                // { profile, system: 'sprite-frames' | 'skeletal' }
```

Canonical states (manifest `animationStates`): idle, walk, run, attack, hurt, death, jump,
fall, land, use, carry, sleep. Unknown states throw — a typo must be loud.

## Representation per profile

- **2d / 2.5d sprites**: atlas frames — `frames: { cols, rows, fps, states: { run: [4,5,6,7] } }`
  on the registry variant; the UV window moves, the texture does not reload.
- **3d models**: skeletal clips — `clips: { run: 'Run', attack: 'Attack_01' }` maps a semantic
  state to the file's clip name; an unmapped state keeps the current clip and reports why
  (`GameAnimation.of(id)`), it never throws at runtime.

A visual migration therefore changes NO gameplay line: `GameAnimation.play('run')` is valid in
every profile. Cross-fade between clips is the kit's `MODEL_CLIP_BLEND_SEC`.
