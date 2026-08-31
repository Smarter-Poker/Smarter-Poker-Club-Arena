/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  YOU HAVE TO PLAY A HAND BEFORE YOU CAN SIT OUT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, binding: "A PLAYER MUST ALSO PLAY AT LEAST ONE HAND, BEFORE
 * THEY CAN SIT OUT."
 *
 * The hole it closes: sit down, sit out immediately, and you hold a seat at a
 * table you never intend to play. The seat counts toward the table and blocks a
 * paying player, and the only thing that ends it is the five-minute eviction —
 * which the same player can reset at will by sitting back in for one beat. The
 * rule refuses at the point of entry instead.
 *
 * The oracle is `dealtInUserIds`, which already existed for the button rule
 * ("NEW PLAYERS NEVER GET THE BUTTON WHEN SITTING DOWN"). It is per-table,
 * written at the deal, pruned the instant a seat empties, and seeded on the
 * engine's first pass from whoever is already seated — so a player who sits,
 * plays, leaves and returns correctly counts as new again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod, blankNonCode } from '../testHelpers/sourceWindow.js';

const SEATING = readFileSync(
  join(process.cwd(), 'src', 'engine', 'ServerTableEngineSeating.ts'),
  'utf8'
);
const sitOutBody = sliceMethod(SEATING, '  public sitOut(');

describe('sit-out requires a played hand', () => {
  it('refuses a cash player who has never been dealt in', () => {
    expect(sitOutBody).toMatch(/!this\.dealtInUserIds\.has\(userId\)/);
    expect(sitOutBody).toMatch(/success: false/);
    expect(sitOutBody).toMatch(/One Hand Before You Can Sit Out/);
  });

  it('gates only the OUTBOUND direction - sitting back in is always allowed', () => {
    /* A player must never be trapped in a sit-out they cannot leave. The guard
       is conditioned on `sitOut` being true. */
    expect(sitOutBody).toMatch(
      /if \(sitOut && !this\.isTournamentTable\(\) && !this\.dealtInUserIds/
    );
  });

  it('exempts tournaments', () => {
    /* A tournament seat is bought and the player is already committed: they are
       dealt in and blinded off whether they sit out or not, and a late entrant
       who has not yet had a hand has an obvious reason to sit out at once. */
    expect(sitOutBody).toMatch(/!this\.isTournamentTable\(\)/);
  });

  it('the refusal is raised before the sit-out is recorded or deferred', () => {
    /* If the guard sat AFTER the pendingSitOut branch, a mid-hand request would
       be queued and then drained by the idle sweep, and the refusal would be
       decorative. */
    const guardAt = sitOutBody.indexOf('dealtInUserIds');
    const pendingAt = sitOutBody.indexOf('this.pendingSitOut.add(userId)');
    const engineAt = sitOutBody.indexOf(
      "this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary')"
    );
    expect(guardAt).toBeGreaterThan(-1);
    expect(pendingAt).toBeGreaterThan(guardAt);
    expect(engineAt).toBeGreaterThan(guardAt);
  });
});

describe('the refusal actually reaches the player', () => {
  const API = readFileSync(
    join(process.cwd(), '..', 'src', 'services', 'GameServerAPI.ts'),
    'utf8'
  );
  const body = sliceMethod(API, 'export async function setSitOut(');

  it('setSitOut reads the response body before judging the status code', () => {
    /* handlers/sitout.ts answers a refusal with HTTP 400 and the reason in the
       body. This used to `return { error: 'Server error (400)' }` on any non-2xx,
       which replaced every engine refusal with a status code before a human saw
       it — so the new rule would have surfaced as a broken button.

       Ordering is checked against COMMENT-STRIPPED source. The first draft of
       this spec compared raw offsets and failed on its own prose: the phrase
       "Server error (400)" appears in the explanatory comment above the code,
       hundreds of characters before the statement it describes. A source pin
       that a comment can flip is not a pin. */
    const code = blankNonCode(body);
    const parseAt = code.indexOf('response.json()');
    /* `!response.ok`, not `response.status`: the status only appears inside a
       TEMPLATE literal, and blankNonCode blanks those along with comments and
       strings — so searching for it here always returns -1 regardless of the
       code. The guard itself is the honest anchor. */
    const statusAt = code.indexOf('!response.ok');
    expect(parseAt, 'setSitOut must parse the body').toBeGreaterThan(-1);
    expect(statusAt, 'setSitOut must still fall back to the status').toBeGreaterThan(-1);
    expect(statusAt, 'the body must be read BEFORE the status is judged').toBeGreaterThan(parseAt);
    expect(body).toMatch(/typeof body\.success === 'boolean'/);
  });
});
