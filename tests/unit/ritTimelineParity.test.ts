/**
 * THE CLIENT'S REVEAL AND THE SERVER'S HOLD ARE ONE ARITHMETIC (2026-09-04).
 *
 * They were written twice and had drifted: the server omitted the ribbon
 * beat, and the client's pot_win-first fallback forgot the streets-per-run
 * factor and shipped a pot 8.4s early. Both now read ritRevealTimelineMs.
 * This holds them to it across every shape a runout can take, and pins the
 * one asymmetry that is by design: the server cannot see a client's animation
 * speed, so the client CLAMPS its reveal to speed <= 1 and the engine's hold
 * always covers the reveal.
 */
import { describe, expect, it } from 'vitest';
import {
  HAND_COMPLETION,
  boardClearMs,
  handCompletionHoldMs,
  ritRevealTimelineMs,
} from '../../src/config/handCompletionSpec';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const H = HAND_COMPLETION;

describe('run-it-multiple-times timeline parity', () => {
  it('the hold covers the last ribbon for every runs x streets shape', () => {
    for (const runs of [2, 3]) {
      for (const streets of [1, 2, 3]) {
        const t = ritRevealTimelineMs({ runs, streetsPerRun: streets, speed: 1 });
        const hold = handCompletionHoldMs({
          wentToShowdown: true,
          showdownHands: 2,
          ritRuns: runs,
          ritStreetsPerRun: streets,
        });
        // The hold is the reveal plus the push beats, exactly.
        const push = H.BETS_SWEEP_MS + H.POT_PUSH_MS + H.MUCK_MS + H.POST_PUSH_PAUSE_MS;
        expect(hold, `runs=${runs} streets=${streets}`).toBe(t.doneAt + push);
        // And the engine never deals over a reveal, even before the sweep.
        expect(hold + boardClearMs(true)).toBeGreaterThan(t.doneAt);
      }
    }
  });

  it('the arithmetic is the one the client used to write by hand', () => {
    const t = ritRevealTimelineMs({ runs: 3, streetsPerRun: 3, speed: 1 });
    expect(t.riversDoneAt).toBe(
      H.RIT_REVEAL_LEAD_MS + 3 * 3 * H.RIT_STREET_MS + 2 * H.RIT_RUN_GAP_MS
    );
    expect(t.firstRibbonAt).toBe(t.riversDoneAt + H.RIT_RIBBON_MS);
    expect(t.doneAt).toBe(t.firstRibbonAt + 3 * H.RIT_RESULT_RUN_MS);
    // Dan's hand: preflop all-in, 3 runs, at 1x = 25.5s to the last ribbon.
    expect(t.doneAt).toBe(25_500);
  });

  it('a faster preference shortens the reveal; a slower one is clamped by the client', () => {
    const fast = ritRevealTimelineMs({ runs: 3, streetsPerRun: 3, speed: 0.25 });
    const spec = ritRevealTimelineMs({ runs: 3, streetsPerRun: 3, speed: 1 });
    expect(fast.doneAt).toBeLessThan(spec.doneAt);
    // The client never builds this timeline slower than spec: it clamps.
    const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    expect(page).toContain('const speed = Math.min(1, getAnimationSpeed());');
    // And its pot_win-first fallback reads the same helper, three streets deep.
    expect(page).toMatch(
      /const pendingRitMs = ritRevealTimelineMs\(\{\s*runs,\s*streetsPerRun: 3,\s*speed: Math\.min\(1, getAnimationSpeed\(\)\),\s*\}\)\.firstRibbonAt;/
    );
  });

  it('the client hands the hold the same inputs the server has', () => {
    const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    expect(page).toContain('ritRuns: ritForHold?.boards?.length ?? 0,');
    expect(page).toContain('potAwardGroups: Math.max(1, ritForHold?.boards?.length ?? 1),');
  });
});
