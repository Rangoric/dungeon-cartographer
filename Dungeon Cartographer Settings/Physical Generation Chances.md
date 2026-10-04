Plugin-shipped default for the **Dungeon Cartographer Settings** system (see "Dungeon Generation/Dungeon Cartographer Settings Plan.md"). This is the version "Dungeon Cartographer: Reset Settings to Defaults" copies into the vault's `Dungeon Cartographer Settings/` folder — edit the vault copy to retune values, not this one (this one only changes when the plugin's own defaults change).

Every `GenerateConfig` field (`src/generate.ts`) that's a true 0–1 probability — one `| Setting | Value |` row each, `Floor N Setup.md`-style. Not read by generation code yet; see the plan's Plan step 6 for the deferred `parseGenerateSettings()` reader that will eventually make this file live.

---

## Door rolls

Independent per-door rolls, not mutually exclusive with each other.

| Setting | Value |
| --- | --- |
| secretDoorChance | 0.05 |
| lockedDoorChance | 0.3333 |
| trappedDoorChance | 0 |
| stuckDoorChance | 0.1667 |

(lockedDoorChance is 1-in-3, stuckDoorChance is 1-in-6 — see `DEFAULT_GENERATE_CONFIG` in `src/generate.ts`. trappedDoorChance was 1-in-3 until 2026-10-03 and is now 0: doors no longer roll traps. The floor's traps are the 2–3 the encounter generator rolls, placed by hand on a door, on treasure or in a room. A door can still be marked `trapped` by hand in the `.dungeon` file.)

---

## Corridors

| Setting | Value |
| --- | --- |
| corridorWidthBaseChance | 0.2 |
| corridorWidthDoorChance | 0.8 |
| corridorWindyChance | 0.4 |

corridorWidthBaseChance/corridorWidthDoorChance are each corridor branch's odds of rolling a 10' (vs 5') width — the Door variant applies when the branch is attached to a 10' door on at least one end.

---

## Stairs

| Setting | Value |
| --- | --- |
| stairEmbeddedChance | 0.5 |
| spiralStairChance | 0.4 |

---

## Dead ends

| Setting | Value |
| --- | --- |
| deadEndPruneFraction | 0.5 |

Fraction of generated spurs pruned back to their nearest junction/room, skewed toward pruning the short ones first.
