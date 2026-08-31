/**
 * WEIGHTED CONTRIBUTED RAKE — canonical allocator test matrix (Dan 2026-08-29).
 *
 * These vectors are SHARED with the SQL twin: the migration
 * 20260829_weighted_contributed_rake.sql asserts the same §35-§38 reference
 * hands in its self-test DO block, so a divergence between
 * fn_allocate_rake_credits and this module turns something red on whichever
 * side changed.
 */
import { describe, it, expect } from 'vitest';
import {
  allocateWeightedShareCents,
  allocateEqualShareCents,
  sharesForRakeRecord,
  sharesForRakeRecordWithLedger,
  WEIGHTED_CONTRIBUTED,
  DEALT_EQUAL,
} from './rakeAllocation.js';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
const D = '00000000-0000-0000-0000-00000000000d';
const E = '00000000-0000-0000-0000-00000000000e';
const F = '00000000-0000-0000-0000-00000000000f';

function sum(m: Map<string, number>): number {
  let s = 0;
  for (const v of m.values()) s += Math.round(v * 100);
  return s / 100;
}

describe('weighted contributed allocation - spec reference vectors', () => {
  it('§35: six dealt, two with zero contribution - credits follow money, zeros get nothing', () => {
    const shares = allocateWeightedShareCents(5, {
      [A]: 50,
      [B]: 25,
      [C]: 15,
      [D]: 10,
      [E]: 0,
      [F]: 0,
    });
    expect(shares.get(A)).toBe(2.5);
    expect(shares.get(B)).toBe(1.25);
    expect(shares.get(C)).toBe(0.75);
    expect(shares.get(D)).toBe(0.5);
    expect(shares.has(E)).toBe(false);
    expect(shares.has(F)).toBe(false);
    expect(sum(shares)).toBe(5);
    // The retired equal-dealt result (0.8333 per dealt player) must NOT appear.
    for (const v of shares.values()) expect(Math.abs(v - 0.83)).toBeGreaterThan(0.005);
  });

  it('§36: blinds count - SB $1, BB $20, BTN $20, rake $2 reconciles exactly', () => {
    const shares = allocateWeightedShareCents(2, { [A]: 1, [B]: 20, [C]: 20 });
    expect(sum(shares)).toBe(2);
    // SB's exact share is 1/41*2 = 0.0487..; largest-remainder gives the odd cent
    // deterministically (SB's remainder is the largest).
    expect(shares.get(A)).toBe(0.05);
    expect(shares.get(B)).toBe(0.98);
    expect(shares.get(C)).toBe(0.97);
  });

  it('§37: uncalled bet excluded upstream - A eligible 40, B all-in 40, rake $4 → $2 each', () => {
    // The engine excludes the returned $60 BEFORE contributions are captured
    // (returnUncalledBet decrements totalInvested), so the allocator sees 40/40.
    const shares = allocateWeightedShareCents(4, { [A]: 40, [B]: 40 });
    expect(shares.get(A)).toBe(2);
    expect(shares.get(B)).toBe(2);
  });

  it('§38: short all-in - A $25, B $100, C $100, rake $4 → 0.44 / 1.78 / 1.78', () => {
    const shares = allocateWeightedShareCents(4, { [A]: 25, [B]: 100, [C]: 100 });
    expect(shares.get(A)).toBe(0.44);
    expect(shares.get(B)).toBe(1.78);
    expect(shares.get(C)).toBe(1.78);
    expect(sum(shares)).toBe(4);
  });
});

describe('invariants', () => {
  it('invariant 4/9: allocation always reconciles exactly to the rake collected', () => {
    const cases: Array<[number, Record<string, number>]> = [
      [5, { [A]: 1.11, [B]: 2.22, [C]: 3.33 }],
      [0.01, { [A]: 1, [B]: 1, [C]: 1 }],
      [0.02, { [A]: 1, [B]: 1, [C]: 1 }],
      [7.77, { [A]: 0.01, [B]: 999999.99 }],
      [3, { [A]: 33.33, [B]: 33.33, [C]: 33.34 }],
      [12.5, { [A]: 5, [B]: 10, [C]: 20, [D]: 40, [E]: 80, [F]: 160 }],
    ];
    for (const [rake, contribs] of cases) {
      const shares = allocateWeightedShareCents(rake, contribs);
      expect(sum(shares), `rake=${rake}`).toBe(Math.round(rake * 100) / 100);
    }
  });

  it('invariant 5: zero rake → zero credit for every player', () => {
    const shares = allocateWeightedShareCents(0, { [A]: 50, [B]: 50 });
    expect(sum(shares)).toBe(0);
  });

  it('invariant 6: zero or negative contribution → no credit entry at all', () => {
    const shares = allocateWeightedShareCents(5, { [A]: 100, [B]: 0, [C]: -5 });
    expect(shares.has(B)).toBe(false);
    expect(shares.has(C)).toBe(false);
    expect(shares.get(A)).toBe(5);
  });

  it('invariant 10: same hand twice → identical allocation (deterministic)', () => {
    const contribs = { [C]: 17.23, [A]: 42.01, [B]: 17.23, [D]: 0.5 };
    const first = allocateWeightedShareCents(6.66, contribs);
    const second = allocateWeightedShareCents(6.66, contribs);
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
    // Insertion order of the input must not matter either.
    const reordered = allocateWeightedShareCents(6.66, {
      [D]: 0.5,
      [B]: 17.23,
      [A]: 42.01,
      [C]: 17.23,
    });
    expect(shares2obj(first)).toEqual(shares2obj(reordered));
  });

  it('remainder ties break by user id ascending (stable)', () => {
    // Equal contributions, 1 leftover cent: goes to the lowest user id.
    const shares = allocateWeightedShareCents(0.01, { [B]: 10, [A]: 10 });
    expect(shares.get(A)).toBe(0.01);
    expect(shares.get(B)).toBe(0);
  });

  it('folded money still earns credit; winning or losing is irrelevant', () => {
    // §11: A contributed 20 then folded; B and C 50 each.
    const shares = allocateWeightedShareCents(6, { [A]: 20, [B]: 50, [C]: 50 });
    expect(shares.get(A)).toBe(1);
    expect(shares.get(B)).toBe(2.5);
    expect(shares.get(C)).toBe(2.5);
  });

  it('huge play-chip pots stay exact (BigInt path, no float drift)', () => {
    const shares = allocateWeightedShareCents(20000, {
      [A]: 123456789.01,
      [B]: 987654321.99,
      [C]: 555555555.55,
    });
    expect(sum(shares)).toBe(20000);
  });

  it('heads-up, 3-handed, 6-max, 9-handed field sizes all reconcile', () => {
    for (const n of [2, 3, 6, 8, 9]) {
      const contribs: Record<string, number> = {};
      for (let i = 0; i < n; i++) {
        contribs[`00000000-0000-0000-0000-0000000000${i.toString(16).padStart(2, '0')}`] =
          (i + 1) * 3.17;
      }
      const shares = allocateWeightedShareCents(4.99, contribs);
      expect(sum(shares), `n=${n}`).toBe(4.99);
      expect(shares.size).toBe(n);
    }
  });
});

describe('method-aware sharesForRakeRecord (the settler entry point)', () => {
  it('WEIGHTED_CONTRIBUTED rows allocate proportionally', () => {
    const shares = sharesForRakeRecord({
      rake_amount: 5,
      player_contributions: { [A]: 50, [B]: 25, [C]: 15, [D]: 10 },
      rake_method: WEIGHTED_CONTRIBUTED,
    });
    expect(shares.get(A)).toBe(2.5);
    expect(shares.get(D)).toBe(0.5);
  });

  it('legacy DEALT_EQUAL rows reproduce the historical equal split exactly', () => {
    const shares = sharesForRakeRecord({
      rake_amount: 5,
      player_contributions: { [A]: 50, [B]: 25, [C]: 15 },
      rake_method: DEALT_EQUAL,
    });
    // Historical rule: integer cents, remainder to the earliest keys.
    expect(shares.get(A)).toBe(1.67);
    expect(shares.get(B)).toBe(1.67);
    expect(shares.get(C)).toBe(1.66);
  });

  it('rows with no method stamp (pre-migration) default to the legacy equal split', () => {
    const shares = sharesForRakeRecord({
      rake_amount: 3,
      player_contributions: { [A]: 10, [B]: 90 },
      rake_method: null,
    });
    expect(shares.get(A)).toBe(1.5);
    expect(shares.get(B)).toBe(1.5);
  });

  it('null contributions → no shares', () => {
    expect(sharesForRakeRecord({ rake_amount: 5, player_contributions: null }).size).toBe(0);
  });
});

describe('legacy equal split (kept only for DEALT_EQUAL rows)', () => {
  it('is byte-compatible with the retired settler implementation', () => {
    const shares = allocateEqualShareCents(5, [A, B, C, D, E, F]);
    expect(shares.get(A)).toBe(0.84);
    expect(shares.get(B)).toBe(0.84);
    expect(shares.get(C)).toBe(0.83);
    expect(sum(shares)).toBe(5);
  });
});

function shares2obj(m: Map<string, number>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const [k, v] of [...m.entries()].sort()) o[k] = v;
  return o;
}

describe('POLISH 4 - ledger-first shares (sharesForRakeRecordWithLedger)', () => {
  const HAND = '11111111-2222-3333-4444-555555555555';

  it('prefers the stored ledger over recomputation', () => {
    // A ledger that deliberately disagrees with what the allocator would
    // produce: the stored value must win, because it is what was banked.
    const ledger = new Map([
      [
        HAND,
        new Map([
          [A, 3.33],
          [B, 1.67],
        ]),
      ],
    ]);
    const shares = sharesForRakeRecordWithLedger(
      {
        hand_id: HAND,
        rake_amount: 5,
        player_contributions: { [A]: 50, [B]: 50 },
        rake_method: WEIGHTED_CONTRIBUTED,
      },
      ledger
    );
    expect(shares.get(A)).toBe(3.33);
    expect(shares.get(B)).toBe(1.67);
  });

  it('falls back to the allocator when the hand has no ledger rows', () => {
    const shares = sharesForRakeRecordWithLedger(
      {
        hand_id: HAND,
        rake_amount: 5,
        player_contributions: { [A]: 75, [B]: 25 },
        rake_method: WEIGHTED_CONTRIBUTED,
      },
      new Map()
    );
    expect(shares.get(A)).toBe(3.75);
    expect(shares.get(B)).toBe(1.25);
  });

  it('falls back for a null-hand row (tournament fee shape)', () => {
    const shares = sharesForRakeRecordWithLedger(
      {
        hand_id: null,
        rake_amount: 4,
        player_contributions: { [A]: 50, [B]: 50 },
        rake_method: WEIGHTED_CONTRIBUTED,
      },
      new Map([[HAND, new Map([[A, 99]])]])
    );
    expect(shares.get(A)).toBe(2);
    expect(shares.get(B)).toBe(2);
  });

  it('an empty ledger entry is not mistaken for an answer', () => {
    const shares = sharesForRakeRecordWithLedger(
      {
        hand_id: HAND,
        rake_amount: 6,
        player_contributions: { [A]: 50, [B]: 50 },
        rake_method: WEIGHTED_CONTRIBUTED,
      },
      new Map([[HAND, new Map()]])
    );
    expect(shares.get(A)).toBe(3);
    expect(shares.get(B)).toBe(3);
  });
});
