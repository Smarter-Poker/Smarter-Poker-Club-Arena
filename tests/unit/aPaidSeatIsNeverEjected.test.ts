/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PLAYER WHO PAID IS NEVER SENT TO THE LOBBY BY A DECISION CLOCK
 *  (Dan, live 2026-08-30 — round 16)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "IT DID SPIN ABOUT 20 SECONDS LATER, NEVER FINISH AND
 * 'ANNOUNCE THE AMOUNT'. THEN BOOTED ME OFF THE TABLE, CLOSED THE GAME AND
 * SENT ME BACK TO THE LOBBY!"
 *
 * THE EVIDENCE, from production:
 *
 *   - he bought seat 3 of "20 Chip Spin PLO4" at 07:33:41.366Z — the row is
 *     there, `tournament_players.registered_at`, and his stack was on the
 *     felt (280 chips) with the game still running WITHOUT him;
 *   - error reporting logged ZERO client events in that window.
 *
 * Nothing threw. So a deliberate code path decided to leave, and there is
 * exactly one that closes the tab and navigates to the lobby while logging
 * nothing: the 60-second buy-in window.
 *
 * HOW IT FIRED AGAINST A COMPLETED PURCHASE. Round 14 (mine) handed the
 * seat-first sheet to that clock, whose guard was
 * `showBuyInModal || seatFirstConfirm !== null`. On the seat-first path
 * `seatFirstConfirm` is cleared only AFTER `fn_take_seat_and_buy_in`
 * RESOLVES — so pressing Buy In, the RPC, and the round trip were all still
 * "sheet open" with the clock running. The effect's own comment claimed this
 * could not happen "because onConfirmBuyIn closes the modal before the RPC
 * resolves": true of the CASH modal, never true of the sheet round 14 added.
 *
 * The odds ladder (round 9) made it likelier BY DESIGN — it gives the player
 * something to read, so spending fifty seconds on this sheet is now the
 * normal way to use it. Add one slow RPC (the engine was restarting at 07:34;
 * hand throughput fell 182 -> 88 per minute) and the timer beats a purchase
 * that had already succeeded.
 *
 * The pins hold the two guards. The second is the one that matters most,
 * because it kills the whole class rather than this instance: a clock about
 * DECIDING to buy in may never eject someone who has already bought in.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod, sliceEnclosingBlock } from '../helpers/sourceWindow';

const root = join(__dirname, '..', '..');
const PAGE = readFileSync(join(root, 'src', 'pages', 'TablePage.tsx'), 'utf8');

/** The window effect, comments stripped so no pin can be met by prose. */
const EFFECT = sliceEnclosingBlock(PAGE, 'const commitInFlight =', 0, 1)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the clock stops when the money moves', () => {
  it('a commit in flight is not an open sheet', () => {
    expect(EFFECT.replace(/\s+/g, ' ')).toContain(
      'seatFirstPending || seatFirstPendingRef.current'
    );
    expect(EFFECT).toContain('cashBuyInRecovery !== null');
    expect(EFFECT).toContain('if (cashBuyInPendingRef.current) return;');
    expect(EFFECT).toMatch(/!commitInFlight/);
  });

  it('a held seat is not an open sheet either', () => {
    expect(EFFECT).toContain('tableState.heroSeat > 0 || heroSeatRef.current > 0');
    expect(EFFECT).toMatch(/!alreadySeated/);
  });

  it('both guards gate the same sheetOpen the interval depends on', () => {
    expect(EFFECT).toMatch(
      /const sheetOpen =\s*\(showBuyInModal \|\| seatFirstConfirm !== null\) && !commitInFlight && !alreadySeated;/
    );
    expect(EFFECT).toMatch(/if \(!sheetOpen\) \{[\s\S]{0,120}?return;/);
  });
});

describe('and it checks again in the instant it would eject', () => {
  it('re-reads the refs at fire time, after the guard has been evaluated', () => {
    /* A whole second sits between the effect running and the timeout firing,
       and the RPC can land inside it. That second is exactly the race that
       took Dan off a seat he had paid for. */
    expect(EFFECT.replace(/\s+/g, ' ')).toContain(
      'if (buyInProcessingRef.current || seatFirstPendingRef.current || heroSeatRef.current > 0) return;'
    );
  });

  it('the last look happens BEFORE anything is released or navigated', () => {
    const fireIdx = EFFECT.indexOf(
      'if (buyInProcessingRef.current || seatFirstPendingRef.current || heroSeatRef.current > 0)'
    );
    expect(fireIdx).toBeGreaterThan(-1);
    for (const after of ['setShowBuyInModal(false)', 'setSeatFirstConfirm(null)', 'navigate(']) {
      expect(EFFECT.indexOf(after), `${after} must come after the last look`).toBeGreaterThan(
        fireIdx
      );
    }
  });
});

describe('the guard is actually re-evaluated', () => {
  it('pending and heroSeat are dependencies, not just reads', () => {
    /* A guard that never re-runs is not a guard: pressing Buy In must tear
       the interval down in the same commit that flips the flag. */
    const deps = sliceMethod(PAGE, 'return () => window.clearInterval(id);');
    const tail = PAGE.slice(PAGE.indexOf('return () => window.clearInterval(id);'));
    const depsLine = tail.slice(0, tail.indexOf(');') + 2);
    expect(depsLine + deps).toMatch(/seatFirstPending/);
    expect(depsLine + deps).toMatch(/tableState\.heroSeat/);
  });
});

describe('the message the player is shown is still lawful', () => {
  it('Title Case and no em dash (CLAUDE.md 5.7)', () => {
    const msg = 'Your Seat Was Released Because The Buy In Was Not Completed In 60 Seconds.';
    expect(PAGE).toContain(msg);
    expect(msg).not.toMatch(/—/);
    for (const w of msg.replace(/\.$/, '').split(' ')) {
      expect(w[0], `"${w}" must be capitalised`).toBe(w[0].toUpperCase());
    }
  });
});
