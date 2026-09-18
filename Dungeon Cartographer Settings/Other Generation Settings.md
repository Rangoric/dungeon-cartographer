Plugin-shipped default for the **Dungeon Cartographer Settings** system (see "Dungeon Generation/Dungeon Cartographer Settings Plan.md"). This is the version "Dungeon Cartographer: Reset Settings to Defaults" copies into the vault's `Dungeon Cartographer Settings/` folder — edit the vault copy to retune values, not this one.

The remaining `GenerateConfig` fields (`src/generate.ts`) that are still design decisions rather than engine tuning. Not read by generation code yet — see the plan's Plan step 6.

Does **not** include `maxAttempts`, `shrinkAfter`, `corridorMaxSearchCost`, `minRoomSize`/`maxRoomSize`, or `gridHeight` — those describe generator robustness/mechanics, not what kind of map to generate, and stay TS constants in `DEFAULT_GENERATE_CONFIG`.

---

## Doors & special rooms

| Setting | Value |
| --- | --- |
| doorMaterials | wood, metal, stone |
| specialKinds | (none) |

`specialKinds` is a comma-separated list of optional per-dungeon special rooms, e.g. `boss`. Empty by default.

---

## Room footprint

| Setting | Value |
| --- | --- |
| footprintTarget | 0.4 |
| footprintTargetVariance | 0.1 |

Room-only footprint budget (rooms + their lobes, not corridors/walls), as a fraction of the grid's total area. Each generation run rolls an actual target uniformly within ± `footprintTargetVariance` (relative) of `footprintTarget`.

---

## Loops, spurs & extra entrances

Ranges are `min – max`, inclusive on both ends.

| Setting | Value |
| --- | --- |
| loopCountRange | 1 – 3 |
| spurCountRange | 2 – 6 |
| spurLengthRange | 2 – 9 |
| extraEntranceCountRange | 0 – 0 |

---

## Stairs

| Setting | Value |
| --- | --- |
| stairCountRange | 1 – 2 |

---

## Extension regions (lobes)

| Setting | Value |
| --- | --- |
| regionCountWeights | 0.55, 0.25, 0.12, 0.06, 0.02 |

Index *i* is the probability of *i* extension regions (0–4) on a given room — typically 1–3, occasionally 4. Must sum to 1.
