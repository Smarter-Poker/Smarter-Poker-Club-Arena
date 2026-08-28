/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE CLIENT HORSE LOADER NEVER TOUCHES A TOURNAMENT TABLE (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, from a live Spin table: "INSIDE THE SPIN, ALL THE BUTTONS ARE 'EMPTY'
 * INSTEAD OF THE + BUTTON ... THE 'PLAYER ALREADY SITTING' SAYS 'SPECTATING'."
 *
 * Caught in the act on production with a 25ms state sampler: TablePage's
 * legacy HORSE LOADING effect painted the seated horses of a REGISTERING spin
 * with an INVENTED stack of bigBlind * 100 (2,000 on a 10/20 spin) for about
 * one second, until the real seat rows (stack 0) overwrote it. One fabricated
 * frame is all the playHasBegun latch needs — "a seat bought at zero chips
 * now holds a stack" is the Spin's start signal — and the latch is permanent
 * by design. D8 then tears down seatFirstBuyIn, every open seat renders as an
 * inert EMPTY plate, and the footer reads plain "Spectating".
 *
 * The same effect, finding no horses, called HydraService.seedTable — which
 * INSERTS table_seats rows directly from the browser. A spin's paid-seat
 * count IS its live seat-row count, so client-seeded unpaid seats read as
 * bought ones to the engine's start gate. Horses enter tournament tables
 * through the same paid server RPCs as humans (CLAUDE.md section 10.5),
 * never through a spectator's browser.
 *
 * These are source-contract pins (the repo's pattern for guards inside
 * components too heavy to render in a unit test). If one fails, read the
 * comment beside the code it points at before "fixing" the test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const src = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

describe('client horse loader never touches tournament tables', () => {
  const start = src.indexOf('HORSE LOADING');
  const end = src.indexOf('REALTIME PROFILES', start);
  const block = src.slice(start, end);

  it('the horse-loading block still exists where this test expects it', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('refuses tournament tables BEFORE latching the loaded ref', () => {
    const gate = block.indexOf('tableState.isTournament || tableState.tournamentId');
    const latch = block.indexOf('horsesLoadedRef.current = true');
    expect(gate).toBeGreaterThan(-1);
    expect(latch).toBeGreaterThan(-1);
    // The gate must come first: a latched ref would make the refusal
    // unreachable on the next run and the effect one-shot past its own guard.
    expect(gate).toBeLessThan(latch);
  });

  it('client-side seat seeding is only reachable behind that gate', () => {
    const gate = block.indexOf('tableState.isTournament || tableState.tournamentId');
    // The CALL, not the guard comment's mention of it.
    const seed = block.indexOf('await HydraService.seedTable(');
    expect(seed).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(seed);
  });
});
