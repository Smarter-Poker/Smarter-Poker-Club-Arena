import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Dan 2026-08-23: "time banks aren't working... when a time bank is used or
 * auto used it must reset the action clock, using the remainder of the
 * original 15 seconds, and adding 20 more seconds."
 *
 * The server was already correct on both paths — the manual one arms
 * `remainingBeforeBank + bankSeconds` and the auto one arms the full 20 with no
 * remainder to add, because the primary clock has by definition just expired.
 * The clock hook was correct too - though it used extendTimer then; it is
 * resetTimer now, because a bank RESETS the clock rather than stacking on
 * the remainder (2026-08-23).
 *
 * THE EVENT WAS DROPPED ON ARRIVAL. The engine hub speaks snake_case
 * (`table_id`, `player_id`) and TablePage forwarded `evt.data` verbatim to the
 * bus, while the subscriber opens with
 *
 *     if (payload.tableId !== tableId) return;
 *
 * `payload.tableId` is undefined on every hub event, so every one of them
 * returned on its first line and extendTimer was never called. The parallel
 * supabase-broadcast transport DID map the names, which is why this presented
 * as flaky rather than dead.
 *
 * This is a source-level test on purpose: the failure was a name, not a
 * behaviour, and a rendering test would have passed against the broken build
 * by exercising the transport that happened to be right.
 */
const SRC = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

describe('time bank events survive the hub', () => {
  it('normalises table_id and player_id before putting them on the bus', () => {
    // The forwarding block must not hand raw hub data straight to the bus.
    expect(SRC).not.toMatch(
      /case 'TIME_BANK_ACTIVATED': \{\s*masterBus\.emit\(\s*'TIME_BANK_ACTIVATED',\s*evt\.data as any\s*\)/
    );
    // And it must derive both keys the subscriber reads.
    const block = SRC.slice(
      SRC.indexOf("case 'TIME_BANK_ACTIVATED':"),
      SRC.indexOf("case 'TIME_BANK_ACTIVATED':") + 1400
    );
    expect(block).toContain('table_id');
    expect(block).toContain('player_id');
    expect(block).toMatch(/tableId:/);
    expect(block).toMatch(/playerId:/);
  });

  it('accepts either shape at the subscriber, so a third publisher cannot re-break it', () => {
    const sub = SRC.slice(
      SRC.indexOf("useMasterBusSubscription('TIME_BANK_ACTIVATED'"),
      SRC.indexOf("useMasterBusSubscription('TIME_BANK_ACTIVATED'") + 1600
    );
    expect(sub).toMatch(/payload\.tableId \?\? payload\.table_id/);
    expect(sub).toMatch(/payload\.playerId \?\? payload\.player_id/);
    // The guard must compare the normalised value, never payload.tableId.
    expect(sub).toMatch(/if \(evtTableId !== tableId\) return;/);
  });

  it('still uses the seconds the engine granted, not a hardcoded guess', () => {
    // Wider window: the handler carries a long note between the guard and the
    // extension, and the first draft of this test sliced it off mid-comment.
    const sub = SRC.slice(
      SRC.indexOf("useMasterBusSubscription('TIME_BANK_ACTIVATED'"),
      SRC.indexOf("useMasterBusSubscription('TIME_BANK_ACTIVATED'") + 3200
    );
    expect(sub).toContain('payload.secondsGranted');
    expect(sub).toContain('payload.additional_seconds');
    // resetTimer, not extendTimer, since 2026-08-23. The invariant this test
    // exists to protect is that the number comes FROM THE EVENT rather than
    // being a literal in the client - that is unchanged and still asserted by
    // the two lines above. What changed is what we do with it: Dan, "if the
    // time bank is used, it must reset the clock for 20 more seconds."
    // extendTimer ADDS to whatever is left, so a bank pressed with twelve
    // seconds on the clock produced a 32-second turn and the ring then
    // disagreed with an engine that had started a fresh 20.
    expect(sub).toMatch(/resetTimer\(seconds\)/);
  });
});
