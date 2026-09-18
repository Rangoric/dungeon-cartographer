First of the `Dungeon Generation/Rules/` folder sketched (never built) in [[Dungeon Generator Architecture]]'s Guiding Principles — "the tables/weights/thresholds that drive [mechanics] come from external vault files and get injected in, no magic numbers hardcoded in scripts." This is that: an editable table, not code.

Moved into the **Dungeon Cartographer Settings** system 2026-09-18 (see "Dungeon Generation/Dungeon Cartographer Settings Plan.md") — same "external tunable table" spirit as the other settings files, shipped/reset the same way. This is the plugin-shipped default; the version to hand-edit lives in the vault's `Dungeon Cartographer Settings/` folder.

Keys off a floor's `Level` (the row in `Floor N Setup.md`, parsed by `src/floorSetup.ts` as of 2026-09-14). Nothing in code reads this file yet — it's the reference a person uses by hand during the Room Content pass (filling in each locked/trapped/stuck door's actual content note). If that pass ever gets automated, this is the table it should read ([[Locks & Traps Content Plan]] owns that `parseLockTrapRules()` plan).

3.5e-based, and a **starting point** in the same spirit as `GenerateConfig`'s door-roll weights (`lockedDoorChance` etc.) — not tuned against real play yet. Sanity-check against the DMG's own Trap Design guidelines before treating any single number as gospel, and retune freely.

---

## Locked doors — Open Lock DC

Straight from the 3.5e SRD's lock-quality tiers, bucketed evenly across floor levels 1–20:

| Floor Level | Lock Quality | Open Lock DC |
| --- | --- | --- |
| 1–5   | Very simple | 20 |
| 6–10  | Average     | 25 |
| 11–15 | Good        | 30 |
| 16–20 | Superior    | 40 |

---

## Trapped doors — Search / Disable Device DC

Homebrew straight-line approximation, **not** a verbatim DMG table: treats the trap's CR as equal to the floor's Level (the DMG's own "a trap of CR X is a fair challenge for level X" guidance), then approximates Search DC = Disable Device DC = 19 + Level.

| Floor Level | Search / Disable Device DC |
| --- | --- |
| 1  | 20 |
| 5  | 24 |
| 10 | 29 |
| 15 | 34 |
| 20 | 39 |

Damage/effect isn't tabled here yet — pick something that fits the floor's level (a CR-1-ish trap should sting, not one-shot) and write it straight into the door's content along with the DC.

---

## Stuck doors — Strength check DC to force

Flat, **not** level-scaled — a stuck door is about swelling/construction, not a designed challenge. Stacks with the other two conditions on the same door:

| Condition | Break DC |
| --- | --- |
| Stuck only | 15 |
| Stuck + Locked | 20 |
| Stuck + Trapped | 20 |
| Stuck + Locked + Trapped | 25 |

---

## Open question

Where the actual per-door content (the rolled DC, the trap's mechanism/effect, any treasure) gets *written* — its own note per door (matching the room-note pattern) vs. one combined table on the floor — is still undecided (see [[Dungeon Generator Status]]'s "Content notes" open question). This file is the DCs to use once that's settled, not a decision about where they live.
