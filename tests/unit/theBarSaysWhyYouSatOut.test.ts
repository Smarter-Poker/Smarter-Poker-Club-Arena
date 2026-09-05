/**
 * THE BAR SAYS WHY YOU SAT OUT (disconnect audit item 3, 2026-09-04)
 *
 * A forced sit-out (three consecutive timeouts) and a chosen one were
 * indistinguishable on the client: both collapsed to 'sitting_out' and the
 * hero's bar said "You Are Sitting Out" to a player who never asked to.
 * The engine now carries `sitOutReason` in the presence map and the bar
 * words the two differently, with the same I'm Back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sitOutBadgeLabel } from '../../src/lib/sitOutDeadline';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('sitOutBadgeLabel with the forced subject', () => {
  it('keeps the deadline hedge and the seat-at-risk line', () => {
    const forced = 'You Timed Out Three Times, So You Are Sitting Out';
    expect(sitOutBadgeLabel(null, forced)).toBe(forced);
    expect(sitOutBadgeLabel(0, forced)).toBe(`${forced}. Seat At Risk`);
    expect(sitOutBadgeLabel(90_000, forced)).toMatch(
      /^You Timed Out Three Times, So You Are Sitting Out\. Up To 1:30$/
    );
  });
});

describe('the wiring', () => {
  it('the engine projects sitOutReason into the presence map and restores it', () => {
    const eng = read('server/src/engine/DisconnectEngine.ts');
    expect(eng).toMatch(/sitOutReason\?: 'voluntary' \| 'forced' \| null;/);
    expect(eng).toMatch(/state\.sitOutReason = reason;/);
    expect(eng).toMatch(/sitOutReason: s\.sitOutReason \?\? null,/);
    expect(eng).toMatch(
      /sitOutReason: sittingOut \? \(entry\.sitOutReason \?\? 'voluntary'\) : null,/
    );
  });

  it("the hero's bar reads the reason off the presence map", () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(
      /disconnectStates\[userId \?\? ''\]\?\.sitOutReason === 'forced'\s*\?\s*'You Timed Out Three Times, So You Are Sitting Out'\s*:\s*'You Are Sitting Out'/
    );
    expect(read('src/utils/mapEngineSnapshot.ts')).toMatch(
      /sitOutReason\?: 'voluntary' \| 'forced' \| null;/
    );
  });
});
