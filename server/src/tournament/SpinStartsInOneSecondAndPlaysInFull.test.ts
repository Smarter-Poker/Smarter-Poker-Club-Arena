/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SPIN STARTS IN ONE SECOND, AND THE WHEEL PLAYS IN FULL (round 16)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, live 2026-08-30, verbatim:
 *
 *   "THE MOMENT THE 3RD SEAT IS BOUGHT AND PAID FOR THE SPIN ANIMATION MUST
 *    START 1 SECOND LATER! ... IT DID SPIN ABOUT 20 SECONDS LATER, NEVER
 *    FINISH AND 'ANNOUNCE THE AMOUNT'."
 *
 * Two numbers, both measured against production rather than guessed.
 *
 * ─── ONE: HOW LATE THE START WAS ────────────────────────────────────────────
 *
 * From the third paid seat to `started_at`, 524 spins over six hours:
 *
 *     p50 5.4s    p90 7.7s    max 73.8s    299 of 524 over five seconds
 *
 * Dan's own game took 39.6s (paid 07:33:41.4, started 07:34:21.0) with the
 * engine restarting inside that minute. A whole second of the floor was the
 * seat-first lane's own `sleep`, which shared the 5-second constant with two
 * far heavier loops. It has its own one-second constant now.
 *
 * ─── TWO: WHY THE WHEEL DID NOT FINISH ──────────────────────────────────────
 *
 * The reveal is anchored to the third payment so the wheel is not charged for
 * the engine's start-up work. The client honours that anchor exactly:
 *
 *     const elapsed = Math.max(0, Date.now() - data.revealAtMs);
 *     const at = (offsetMs) => Math.max(0, offsetMs - elapsed);
 *
 * so every beat already behind `elapsed` fires AT ONCE. The re-anchor that
 * exists for a late start only fired when fewer than COUNTDOWN_MS (3s) of the
 * 14.8-second sequence remained — so everything between 3s and 14.8s of
 * lateness shipped as a partially elapsed reveal, and the countdown, the
 * chase and the flash collapsed into one instant. A blur, then a result card:
 * exactly "spun, never finished, never announced".
 *
 * ANIMATION LAW (CLAUDE.md 10.6, binding): every animation plays every time
 * it is owed, FOR ITS FULL DURATION. A wheel shortened because the SERVER was
 * slow is the plainest violation there is — the player pays for the engine's
 * lateness in the one moment the format exists to sell.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SPIN_REVEAL,
  spinRevealTotalMs,
  spinRevealToDealMs,
  spinPostRevealMs,
} from '../config/spinSpec.js';

const here = new URL('.', import.meta.url).pathname;
const BASE = readFileSync(join(here, 'TournamentManagerBase.ts'), 'utf8');
const SERVER = readFileSync(join(here, '..', 'GameServer.ts'), 'utf8');

/** Source with comments stripped, so no pin is satisfied by prose about it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const BASE_CODE = code(BASE);
const SERVER_CODE = code(SERVER);

/**
 * From `anchor` through the balanced `{ ... }` that follows it.
 *
 * Inlined rather than imported: `tests/helpers/sourceWindow` lives in the
 * CLIENT tree, and this server tree refuses cross-tree imports twice over
 * (its ESM `.js` specifier guard and tsc's rootDir). Byte counts are
 * forbidden by tests/unit/noFixedSizeSourceWindows.test.ts — which caught the
 * first draft of THIS file doing exactly that, which is the rule working.
 */
function blockAfter(src: string, anchor: string): string {
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error(`blockAfter: "${anchor}" not found`);
  const open = src.indexOf('{', start);
  if (open < 0) return src.slice(start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

describe('the start lane runs at one second', () => {
  it('has its own constant, not the five-second discovery one', () => {
    expect(SERVER_CODE).toMatch(/const SEAT_FIRST_START_INTERVAL = 1000;/);
  });

  it('the seat-first lane sleeps on it', () => {
    expect(SERVER_CODE).toContain('await this.sleep(SEAT_FIRST_START_INTERVAL);');
  });

  it('and the heavy loops are left alone at five seconds', () => {
    /* Speeding those up is a different, much more expensive change. The point
       here is that the START path stopped sharing their cadence. */
    expect(SERVER_CODE).toMatch(/const TOURNAMENT_DISCOVERY_INTERVAL = 5000;/);
    const remaining =
      SERVER_CODE.split('await this.sleep(TOURNAMENT_DISCOVERY_INTERVAL);').length - 1;
    expect(remaining, 'the other discovery loops keep their own pace').toBe(2);
  });

  it('one second is inside the lead-in, so the wheel can still open on Dan beat', () => {
    /* The reveal begins LEAD_IN_MS after the third payment. A detection floor
       larger than the lead-in would make "1 second later" unreachable no
       matter what the animation does. */
    expect(1000).toBeLessThanOrEqual(SPIN_REVEAL.LEAD_IN_MS);
  });
});

describe('the wheel is never truncated by the engine being late', () => {
  it('re-anchors unless the WHOLE sequence still fits before the deal', () => {
    expect(BASE_CODE).toContain('if (this.spinHoldUntil - now < spinRevealToDealMs()) {');
  });

  it('the old three-second threshold is gone', () => {
    /* `COUNTDOWN_MS` was the entire bug: it allowed up to 11.8s of the
       sequence to be eaten before anything intervened. */
    expect(BASE_CODE).not.toMatch(/spinHoldUntil - now < SPIN_REVEAL\.COUNTDOWN_MS/);
  });

  it('re-anchoring gives back a FULL sequence, measured from now', () => {
    const block = blockAfter(BASE_CODE, 'if (this.spinHoldUntil - now < spinRevealToDealMs())');
    expect(block).toContain('this.spinRevealAt = now;');
    expect(block).toContain('this.spinHoldUntil = now + spinRevealToDealMs();');
  });

  it('and it is still REPORTED, because lateness is a defect not a setting', () => {
    expect(BASE_CODE).toContain('Tournament.spin_reveal_window_overrun');
  });

  it('the threshold is arithmetically sufficient: a full wheel always fits', () => {
    /* After a re-anchor the hold is exactly spinRevealToDealMs from now, and
       the wheel needs spinRevealTotalMs of that, leaving the post-reveal
       beats. If this ever inverts, the deal lands on top of the wheel. */
    expect(spinRevealToDealMs()).toBe(spinRevealTotalMs() + spinPostRevealMs());
    expect(spinRevealToDealMs() - spinPostRevealMs()).toBe(spinRevealTotalMs());
    expect(spinRevealTotalMs()).toBeGreaterThan(SPIN_REVEAL.COUNTDOWN_MS);
  });
});

describe('the anchor still does the job it was written for', () => {
  it('an on-time start is NOT re-anchored, so the wheel opens on the payment', () => {
    /* The re-anchor must be an exception, not the rule: when the engine is
       quick the wheel is still measured from the third payment, which is what
       makes "1 second later" true rather than "1 second after we got round
       to it". The stamp is untouched. */
    expect(BASE_CODE).toContain('protected stampSpinRevealAnchor(');
    expect(BASE_CODE).toContain('this.spinRevealAt = anchor + SPIN_REVEAL.LEAD_IN_MS;');
  });

  it('a freeroll with no anchor still gets a full wheel from now', () => {
    const block = blockAfter(BASE_CODE, 'if (this.spinRevealAt <= 0)');
    expect(block).toContain('this.spinHoldUntil = now + spinRevealToDealMs();');
    expect(block).toContain('this.spinRevealAt = now;');
  });
});
