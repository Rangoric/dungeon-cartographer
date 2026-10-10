import { describe, it, expect } from "vitest";
import {
  parseLockTrapRules,
  DEFAULT_LOCK_TRAP_RULES,
  lockDiceLabel,
  rollLockedDoorDC,
  lookupTrappedDoorDC,
  lookupStuckDoorBreakDC,
} from "../src/lockTrapRules";
import { Rng } from "../src/generate";

const REAL_FILE_TEXT = `
Some intro prose about where this table lives and how it's used.

## Locked doors — Open Lock DC

Open Lock DC = Floor Level + Base + Die

| Open Lock DC | Value |
| --- | --- |
| Base | 20 |
| Die | 1d10 |

## Trapped doors — Search / Disable Device DC

Search DC = Disable Device DC = 19 + Level

| Floor Level | Search / Disable Device DC |
| --- | --- |
| 1  | 20 |
| 5  | 24 |
| 10 | 29 |
| 15 | 34 |
| 20 | 39 |

## Stuck doors — Strength check DC to force

| Condition | Break DC |
| --- | --- |
| Stuck only | 15 |
| Stuck + Locked | 20 |
| Stuck + Trapped | 20 |
| Stuck + Locked + Trapped | 25 |
`;

describe("parseLockTrapRules", () => {
  it("parses all three tables from the real file shape", () => {
    expect(parseLockTrapRules(REAL_FILE_TEXT)).toEqual(DEFAULT_LOCK_TRAP_RULES);
  });

  it("reads a retuned lock formula, tolerant of spacing and case", () => {
    const text = `| Open Lock DC | Value |\n| --- | --- |\n|  base  |  15  |\n| DIE | 2d6 |`;
    expect(parseLockTrapRules(text).lockedDoorDC).toEqual({ base: 15, diceCount: 2, diceSides: 6 });
    expect(parseLockTrapRules(`| Open Lock DC | Value |\n| --- | --- |\n| Die | d12 |`).lockedDoorDC).toEqual({
      base: 20,
      diceCount: 1,
      diceSides: 12,
    });
  });

  it("keeps the default formula for the old lock-quality tier table", () => {
    const text = `| Floor Level | Lock Quality | Open Lock DC |\n| --- | --- | --- |\n| 1–5 | Very simple | 20 |\n| 6–10 | Average | 25 |`;
    expect(parseLockTrapRules(text).lockedDoorDC).toEqual(DEFAULT_LOCK_TRAP_RULES.lockedDoorDC);
  });

  it("falls back to the default locked-door formula when it's missing entirely", () => {
    const text = `# Nothing here but prose.`;
    expect(parseLockTrapRules(text).lockedDoorDC).toEqual(DEFAULT_LOCK_TRAP_RULES.lockedDoorDC);
  });

  it("falls back to the default trapped-door table on malformed rows", () => {
    const text = `| Floor Level | Search / Disable Device DC |\n| --- | --- |\n| one | twenty |`;
    expect(parseLockTrapRules(text).trappedDoorDC).toEqual(DEFAULT_LOCK_TRAP_RULES.trappedDoorDC);
  });

  it("falls back per-condition on the stuck-door table when only some rows are present", () => {
    const text = `| Condition | Break DC |\n| --- | --- |\n| Stuck only | 12 |`;
    expect(parseLockTrapRules(text).stuckDoorBreakDC).toEqual({
      stuckOnly: 12,
      stuckLocked: DEFAULT_LOCK_TRAP_RULES.stuckDoorBreakDC.stuckLocked,
      stuckTrapped: DEFAULT_LOCK_TRAP_RULES.stuckDoorBreakDC.stuckTrapped,
      stuckLockedTrapped: DEFAULT_LOCK_TRAP_RULES.stuckDoorBreakDC.stuckLockedTrapped,
    });
  });

  it("is case-insensitive on stuck-door condition names", () => {
    const text = `| Condition | Break DC |\n| --- | --- |\n| STUCK ONLY | 12 |`;
    expect(parseLockTrapRules(text).stuckDoorBreakDC.stuckOnly).toBe(12);
  });

  it("ignores unreadable formula values rather than misreading them", () => {
    const text = `| Open Lock DC | Value |\n| --- | --- |\n| Base | lots |\n| Die | a few |`;
    expect(parseLockTrapRules(text).lockedDoorDC).toEqual(DEFAULT_LOCK_TRAP_RULES.lockedDoorDC);
  });

  it("never throws on completely empty input", () => {
    expect(() => parseLockTrapRules("")).not.toThrow();
    expect(parseLockTrapRules("")).toEqual(DEFAULT_LOCK_TRAP_RULES);
  });

  it("does not pick up unrelated tables elsewhere in the file as one of its own", () => {
    const text = `| Setting | Value |\n| --- | --- |\n| Grid Size | 34 × 34 |\n| Level | 7 |`;
    expect(parseLockTrapRules(text)).toEqual(DEFAULT_LOCK_TRAP_RULES);
  });
});

describe("rollLockedDoorDC", () => {
  it("rolls floor Level + 20 + 1d10 with the default formula", () => {
    const rng = new Rng(4);
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const { dc, roll } = rollLockedDoorDC(DEFAULT_LOCK_TRAP_RULES, 4, rng);
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(10);
      expect(dc).toBe(4 + 20 + roll);
      seen.add(dc);
    }
    // Every DC from 25 to 34 turns up.
    expect([...seen].sort((a, b) => a - b)).toEqual([25, 26, 27, 28, 29, 30, 31, 32, 33, 34]);
  });

  it("scales with the floor's Level", () => {
    const fixed = { randint: () => 7 };
    expect(rollLockedDoorDC(DEFAULT_LOCK_TRAP_RULES, 1, fixed)).toEqual({ dc: 28, roll: 7 });
    expect(rollLockedDoorDC(DEFAULT_LOCK_TRAP_RULES, 12, fixed)).toEqual({ dc: 39, roll: 7 });
  });

  it("uses a retuned formula's base and dice", () => {
    const rules = { ...DEFAULT_LOCK_TRAP_RULES, lockedDoorDC: { base: 15, diceCount: 2, diceSides: 6 } };
    expect(rollLockedDoorDC(rules, 3, { randint: () => 6 })).toEqual({ dc: 30, roll: 12 });
    expect(lockDiceLabel(rules)).toBe("2d6");
    expect(lockDiceLabel(DEFAULT_LOCK_TRAP_RULES)).toBe("1d10");
  });
});

describe("lookupTrappedDoorDC", () => {
  it("returns the exact DC at a tabled level", () => {
    expect(lookupTrappedDoorDC(DEFAULT_LOCK_TRAP_RULES, 10)).toBe(29);
  });

  it("interpolates between two tabled levels, matching the 19 + Level formula", () => {
    expect(lookupTrappedDoorDC(DEFAULT_LOCK_TRAP_RULES, 3)).toBe(22);
    expect(lookupTrappedDoorDC(DEFAULT_LOCK_TRAP_RULES, 12)).toBe(31);
  });

  it("extrapolates below the lowest point along the same slope", () => {
    expect(lookupTrappedDoorDC(DEFAULT_LOCK_TRAP_RULES, 0)).toBe(19);
  });

  it("extrapolates above the highest point along the same slope", () => {
    expect(lookupTrappedDoorDC(DEFAULT_LOCK_TRAP_RULES, 21)).toBe(40);
  });
});

describe("lookupStuckDoorBreakDC", () => {
  it("returns stuckOnly when neither locked nor trapped", () => {
    expect(lookupStuckDoorBreakDC(DEFAULT_LOCK_TRAP_RULES, { locked: false, trapped: false })).toBe(15);
  });

  it("returns stuckLocked when locked but not trapped", () => {
    expect(lookupStuckDoorBreakDC(DEFAULT_LOCK_TRAP_RULES, { locked: true, trapped: false })).toBe(20);
  });

  it("returns stuckTrapped when trapped but not locked", () => {
    expect(lookupStuckDoorBreakDC(DEFAULT_LOCK_TRAP_RULES, { locked: false, trapped: true })).toBe(20);
  });

  it("returns stuckLockedTrapped when both", () => {
    expect(lookupStuckDoorBreakDC(DEFAULT_LOCK_TRAP_RULES, { locked: true, trapped: true })).toBe(25);
  });
});

describe("DEFAULT_LOCK_TRAP_RULES", () => {
  it("matches the live vault file's current values", () => {
    expect(DEFAULT_LOCK_TRAP_RULES.lockedDoorDC).toEqual({ base: 20, diceCount: 1, diceSides: 10 });
    expect(DEFAULT_LOCK_TRAP_RULES.trappedDoorDC).toHaveLength(5);
    expect(DEFAULT_LOCK_TRAP_RULES.stuckDoorBreakDC).toEqual({
      stuckOnly: 15,
      stuckLocked: 20,
      stuckTrapped: 20,
      stuckLockedTrapped: 25,
    });
  });
});
