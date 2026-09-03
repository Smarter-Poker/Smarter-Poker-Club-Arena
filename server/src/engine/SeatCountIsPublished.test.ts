/**
 * ═══ LAW: THE ENGINE TELLS THE CLIENT HOW MANY SEATS THE TABLE HAS ═══════════
 * (Dan 2026-08-31, phase 1 of the seat-truth contract)
 *
 * The client used to GUESS the seat count. `tableState.maxPlayers` is seeded
 * to 6 and corrected only when the client's own `tables` row query lands, so
 * for the opening seconds of every mount — and indefinitely if that query
 * failed or was RLS denied — a 9-max table was drawn as a 6-max one.
 *
 * On 2026-08-31 that erased a player sitting in seat 7 from his own screen for
 * ten minutes (table 08746c1a): the engine released his wait-for-BB hold, dealt
 * him in, took his big blind and paid him a pot, while his client showed
 * "Seat Reserved, You'll Be Dealt In Next Hand", timed out every turn it could
 * not render, force-sat him out after three strikes, and let the seat be
 * evicted at the five-minute mark.
 *
 * The engine has always held `tableInfo.max_players`. This pins that it SAYS
 * so, on BOTH payloads a client can receive — the live broadcast and the idle
 * between-hands one. Publishing on only one of them would leave the exact hole
 * this closes: a player who sits down at a quiet table receives idle snapshots
 * until the next deal, which is precisely when a seat-first joiner is looking.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ENGINE = readFileSync(join(__dirname, 'ServerTableEngine.ts'), 'utf8');

/** Slice a method body by brace-matching from its signature. */
function sliceMethod(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`method not found: ${signature}`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      depth++;
      seen = true;
    } else if (ch === '}') {
      depth--;
      if (seen && depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

describe('LAW - the seat count is published, not guessed (2026-08-31)', () => {
  it('the live broadcast payload carries max_seats', () => {
    expect(ENGINE).toMatch(/max_seats:\s*Number\(this\.tableInfo\?\.max_players\)\s*\|\|\s*0/);
  });

  it('the idle between-hands payload carries it too', () => {
    // A seat-first joiner at a quiet table sees ONLY idle snapshots until the
    // next deal. Publishing on the live payload alone would leave them looking
    // at a guessed ring for exactly as long as they are most likely to look.
    const idle = sliceMethod(ENGINE, 'protected publishIdleState()');
    expect(idle).toMatch(/max_seats:/);
  });

  it('the RESYNC payload carries it - the one a confused client asks for', () => {
    /* `getTableState()` answers `GET /state/:id`, which the client fetches on a
       websocket SEQUENCE GAP and dispatches as GAME_START: the full-state
       resync. The first cut of this law covered the two hub payloads and
       missed this one, so a client that had just lost frames — exactly the
       client whose local view may be wrong — resynced from the only payload
       that could not tell it how wide the table is, and fell back to inferring
       the width from the response's players. The hand roster omits anybody not
       dealt in (a player waiting for the big blind), so that inference can
       land BELOW the truth. It is the original bug's starting position,
       reached through the recovery path. */
    const resync = sliceMethod(ENGINE, 'public getTableState(');
    expect(resync).toMatch(/max_seats:/);
  });

  it('it is sourced from the table row, never from the seated roster', () => {
    // Deriving it from who is currently sitting would reintroduce the original
    // defect from the other side: an empty high seat is still a seat, and a
    // table nobody has sat down at yet still has its full capacity.
    const occurrences = ENGINE.match(/max_seats:[^,\n]*/g) ?? [];
    // Three payloads a client can receive: live broadcast, idle, resync.
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
    for (const line of occurrences) {
      expect(line).toMatch(/tableInfo/);
      expect(line).not.toMatch(/seatedPlayers|players\.length|roster/);
    }
  });
});
