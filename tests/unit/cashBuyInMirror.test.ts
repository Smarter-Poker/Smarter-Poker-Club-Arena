/**
 * server/src/config/cashBuyIn.ts is a MIRROR of src/lib/cashBuyIn.ts.
 *
 * It has to be a copy rather than an import: server/tsconfig.json sets
 * `rootDir: ./src`, so nothing under server/ can reach the app's src/. The same
 * arrangement already exists between server/src/config/buyIn.ts and
 * src/utils/buyIn.ts, pinned by tournamentRakeMirror.test.ts.
 *
 * This file is what stops the two drifting. The engine now decides whether a
 * busted cash player keeps their seat by asking whether they can cover the
 * table minimum (Dan 2026-08-28: "CHECK IF THEY HAVE ENOUGH CHIPS TO REBUY, (40
 * BB MINIMUM)"). If the server's idea of that floor ever parts company with the
 * client's, the lobby will advertise a buy-in the felt will not honour and
 * players will be stood up for failing a test they were told they passed —
 * which is the same class of bug src/lib/cashBuyIn.ts was created to end.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CASH_MIN_BB, CASH_MAX_BB, cashBuyInRange } from '../../src/lib/cashBuyIn';
import {
  cashMinBuyIn,
  CASH_MIN_BB as SERVER_MIN_BB,
  CASH_MAX_BB as SERVER_MAX_BB,
} from '../../server/src/config/cashBuyIn';

describe('cash buy-in mirror', () => {
  it('the constants agree', () => {
    expect(SERVER_MIN_BB).toBe(CASH_MIN_BB);
    expect(SERVER_MAX_BB).toBe(CASH_MAX_BB);
  });

  it('40 big blinds is still the floor Dan named', () => {
    expect(CASH_MIN_BB).toBe(40);
  });

  it('the server floor matches the client range floor, row for row', () => {
    const rows = [
      { big_blind: 2, min_buy_in: 80, max_buy_in: 400 },
      { big_blind: 2, min_buy_in: null, max_buy_in: null }, // fall back to 40bb
      { big_blind: 50, min_buy_in: 100, max_buy_in: 200 }, // the incoherent row
      { big_blind: 0.5, min_buy_in: 0, max_buy_in: 0 },
      { big_blind: 100, min_buy_in: null, max_buy_in: 5000 },
    ];

    for (const row of rows) {
      expect(cashMinBuyIn(row), `min for bb=${row.big_blind}`).toBe(cashBuyInRange(row).min);
    }
  });

  it('an unpriceable row answers 0, which the caller must read as UNKNOWN', () => {
    /* Not "free". A table we cannot price is not a table anyone is stood up
       from — anyBustedPlayerCanAffordARebuy fails open on this exact value. */
    expect(cashMinBuyIn({ big_blind: 0, min_buy_in: 0, max_buy_in: 0 })).toBe(0);
    expect(cashMinBuyIn(null)).toBe(0);
    expect(cashMinBuyIn(undefined)).toBe(0);
  });

  it('both files still carry the change-one-change-both warning', () => {
    const client = readFileSync(join(process.cwd(), 'src/lib/cashBuyIn.ts'), 'utf8');
    const server = readFileSync(join(process.cwd(), 'server/src/config/cashBuyIn.ts'), 'utf8');
    expect(server).toMatch(/CHANGE ONE, CHANGE BOTH/i);
    expect(server).toMatch(/cashBuyInMirror/);
    // The client file is the authority and says so.
    expect(client).toMatch(/CASH_MIN_BB = 40/);
  });
});
