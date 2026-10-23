/**
 * The standing Lightning pilot assignment, as the fleet reads it (2026-10-22).
 * Regression for Madness falling out of Lightning at 17:14 UTC: every idle,
 * uncapped assigned horse failed the bankroll gate at the 0.02/0.04 pilot
 * (reference buy-in 4.00) while the same horses passed at 0.01/0.02, and 24
 * of the 42 seated assigned horses were spending their day in Midway Union
 * and Diamond Arena games.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bankrollBuyIn,
  bankrollPolicyFor,
  bankrollTemperamentFor,
  canOpenAnotherTable,
  canSit,
  referenceBuyIn,
} from './HorseBankroll.js';
import {
  getPilotSeatScope,
  loadPilotSeatScope,
  parsePilotAssignmentStatus,
  pilotSeatVerdict,
  PILOT_BUY_INS_TO_SIT,
  PILOT_MAX_BANKROLL_FRACTION,
  seatPolicyFor,
  setPilotSeatScope,
} from './LightningPilotSeatScope.js';

const PILOT_CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
const MIDWAY = 'fade0000-0000-0000-0000-000000000001';
/* Real assigned horses from the 2026-10-22 18:12 UTC read, with their
   temperaments and pilot wallets at that moment. */
const STANDARD_96 = '01bd8786-371e-4ba2-85d6-baab469bba07'; // 96.37
const NIT_139 = '0a9625c9-f679-4d98-9ebe-d8bb005c45b6'; // 139.06
const GAMBLER_23 = '3faa1e32-afb8-4b21-9530-2a9fd81c5766'; // 23.50
const NOT_ASSIGNED = '11111111-2222-4333-8444-555555555555';

const status = (over: Record<string, unknown> = {}) => ({
  club_id: PILOT_CLUB,
  active: true,
  player_ids: [STANDARD_96, NIT_139, GAMBLER_23],
  manifest_sha256: 'x',
  ...over,
});
const scope = parsePilotAssignmentStatus(status())!;
const MADNESS_REF = referenceBuyIn(0.04, 4, 8);
const ACTION_REF = referenceBuyIn(0.02, 1, 4);

afterEach(() => setPilotSeatScope(null));

describe('reading the assignment', () => {
  it('only an active, well-formed assignment is a scope', () => {
    expect(scope.clubId).toBe(PILOT_CLUB);
    expect(scope.playerIds.size).toBe(3);
    expect(parsePilotAssignmentStatus(status({ active: false }))).toBeNull();
    expect(parsePilotAssignmentStatus(status({ club_id: 'nope' }))).toBeNull();
    expect(parsePilotAssignmentStatus(status({ player_ids: [] }))).toBeNull();
    expect(parsePilotAssignmentStatus(status({ player_ids: ['x'] }))).toBeNull();
    expect(parsePilotAssignmentStatus(null)).toBeNull();
  });

  it('a failed read clears the scope (today behaviour), a good one sets it', async () => {
    setPilotSeatScope(scope);
    expect(await loadPilotSeatScope({ rpc: async () => ({ data: null, error: { m: 1 } }) })).toBe(
      'unread'
    );
    expect(getPilotSeatScope()).toBeNull();
    expect(
      await loadPilotSeatScope({
        rpc: async () => {
          throw new Error('down');
        },
      })
    ).toBe('unread');
    expect(await loadPilotSeatScope({ rpc: async () => ({ data: status(), error: null }) })).toBe(
      'active'
    );
    expect(getPilotSeatScope()?.clubId).toBe(PILOT_CLUB);
    expect(
      await loadPilotSeatScope({
        rpc: async () => ({ data: status({ active: false }), error: null }),
      })
    ).toBe('inactive');
    expect(getPilotSeatScope()).toBeNull();
  });
});

describe('where an assigned horse may take a new seat', () => {
  it('pilot club yes, any other club no, everybody else unchanged', () => {
    expect(pilotSeatVerdict(STANDARD_96, PILOT_CLUB, scope)).toBe('pilot');
    expect(pilotSeatVerdict(STANDARD_96, MIDWAY, scope)).toBe('elsewhere');
    expect(pilotSeatVerdict(NOT_ASSIGNED, MIDWAY, scope)).toBe('free');
    expect(pilotSeatVerdict(NOT_ASSIGNED, PILOT_CLUB, scope)).toBe('free');
    // Unknown wallet fails open, like the club gate; no scope changes nothing.
    expect(pilotSeatVerdict(STANDARD_96, undefined, scope)).toBe('free');
    expect(pilotSeatVerdict(STANDARD_96, MIDWAY, null)).toBe('free');
  });
});

describe('the pilot wallet at a pilot seat', () => {
  it('reproduces the defect: the temperament bar refused Madness, not Action', () => {
    expect(bankrollTemperamentFor(STANDARD_96)).toBe('standard');
    expect(bankrollTemperamentFor(NIT_139)).toBe('nit');
    expect(canSit(96.37, MADNESS_REF, bankrollPolicyFor(STANDARD_96))).toBe(false);
    expect(canSit(139.06, MADNESS_REF, bankrollPolicyFor(NIT_139))).toBe(false);
    expect(canSit(96.37, ACTION_REF, bankrollPolicyFor(STANDARD_96))).toBe(true);
    // And the share-of-roll sizing refuses a thinner wallet a second time
    // (03951af5, standard, 77.70: 5% is 3.89 < the 4.00 minimum).
    expect(bankrollTemperamentFor('03951af5-7cf1-4164-aaf0-571b647d98d5')).toBe('standard');
    expect(
      bankrollBuyIn({
        bankroll: 77.7,
        desired: 4,
        minBuyIn: 4,
        maxBuyIn: 8,
        policy: bankrollPolicyFor(STANDARD_96),
      })
    ).toBe(0);
  });

  it('seats and sizes them at Madness once the pilot policy applies', () => {
    for (const [id, roll] of [
      [STANDARD_96, 96.37],
      [NIT_139, 139.06],
    ] as const) {
      const p = seatPolicyFor(id, PILOT_CLUB, scope);
      expect(canSit(roll, MADNESS_REF, p)).toBe(true);
      expect(
        bankrollBuyIn({ bankroll: roll, desired: 4, minBuyIn: 4, maxBuyIn: 8, policy: p })
      ).toBeGreaterThanOrEqual(4);
      expect(
        canOpenAnotherTable({ bankroll: roll, liveExposure: 4, nextBuyIn: 4, policy: p })
      ).toBe(true);
    }
  });

  it('never seats a wallet below ten pilot buy-ins', () => {
    const p = seatPolicyFor(GAMBLER_23, PILOT_CLUB, scope);
    expect(canSit(23.5, MADNESS_REF, p)).toBe(false);
    expect(canSit(23.5, ACTION_REF, p)).toBe(true);
    expect(PILOT_BUY_INS_TO_SIT).toBe(10);
    expect(PILOT_MAX_BANKROLL_FRACTION).toBe(0.1);
  });

  it('only ever loosens, and only for an assigned horse at a pilot seat', () => {
    for (const id of [STANDARD_96, NIT_139, GAMBLER_23]) {
      const base = bankrollPolicyFor(id);
      const p = seatPolicyFor(id, PILOT_CLUB, scope);
      expect(p.buyInsToSit).toBeLessThanOrEqual(base.buyInsToSit);
      expect(p.maxBankrollFraction).toBeGreaterThanOrEqual(base.maxBankrollFraction);
      // Every other rule is the temperament's own.
      expect(p.stopLossBuyIns).toBe(base.stopLossBuyIns);
      expect(p.stopWinBuyIns).toBe(base.stopWinBuyIns);
      expect(p.moveDownAt).toBe(base.moveDownAt);
      expect(seatPolicyFor(id, MIDWAY, scope)).toEqual(base);
      expect(seatPolicyFor(id, PILOT_CLUB, null)).toEqual(base);
    }
    expect(seatPolicyFor(NOT_ASSIGNED, PILOT_CLUB, scope)).toEqual(bankrollPolicyFor(NOT_ASSIGNED));
  });
});

describe('the seating path reads the assignment', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
  const SIT = readFileSync(join(process.cwd(), 'src/services/HorseSitVerdict.ts'), 'utf8');
  it('loads assignments and preserves pilot scope outside the bankroll-only cash roster', () => {
    expect(SRC).toContain('await loadPilotSeatScope(supabase)');
    expect(SRC).toContain('const bankrollOnly = cashRosterAllows(h.id) === true;');
    expect(SRC).toMatch(
      /if \(!bankrollOnly && pilotSeatVerdict\(h\.id, seatClub\) === 'elsewhere'\) \{\s*pilotElsewhereDropped\+\+;\s*return false;\s*\}/
    );
    expect(SRC).toMatch(
      /if \(\s*cashRosterAllows\(offer\.user_id\) !== true &&\s*pilotSeatVerdict\(offer\.user_id, seatClub\) === 'elsewhere'\s*\)\s*continue;/
    );
  });
  it('the gate, the sizing and the aggregate ceiling all use the seat policy', () => {
    expect(SRC).toContain('canSit(roll, ref, seatPolicyFor(h.id, seatClub))');
    expect(SRC).toContain('policy: seatPolicyFor(horseId, seatClub),');
    expect(SIT).toContain('policy: seatPolicyFor(horseId, seatClub),');
  });
});
