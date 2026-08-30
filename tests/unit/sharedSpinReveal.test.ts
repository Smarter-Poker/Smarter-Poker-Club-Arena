/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE WHEEL, WATCHED TOGETHER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-21: "THE WHEEL STARTS SPINNING THE MOMENT THE 3RD PLAYER PAYS
 * FOR HIS SEAT... ONE SECOND LATER, A 3...2...1... COUNT DOWN CLOCK MUST BEGIN
 * WITH A WHEEL SPIN." (PokerBros reference video.)
 *
 * WHAT WAS WRONG. The wheel was decided per client: each one loaded the
 * tournament row, saw a multiplier stamped in the last 90 seconds, and started
 * its own wheel whenever it happened to finish loading. Three players watched
 * three different wheels at three different moments, and anyone who arrived
 * late — or simply refreshed — missed the reveal and had it marked seen for
 * good. The reveal IS the format; it has to be one moment the table shares.
 *
 * Worse, nothing reserved the moment at all. The wheel escaped being dealt over
 * only because engine start-up happened to take ~22 seconds. Luck, not a
 * contract: make the engine faster and cards land under a spinning wheel.
 *
 * THE SHAPE NOW: the engine names the instant, broadcasts it, and HOLDS THE
 * DEAL for the whole sequence. Clients animate against that timestamp.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SPIN_REVEAL, spinRevealTotalMs } from '../../src/config/spinSpec';
import { sliceMethod, sliceEnclosingBlock } from '../helpers/sourceWindow';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('the reveal timing is one spec, mirrored into the engine', () => {
  it('client and server copies of spinSpec stay byte-identical', () => {
    expect(read('server/src/config/spinSpec.ts')).toBe(read('src/config/spinSpec.ts'));
  });

  it('the sequence is lead-in, countdown, spin, winner flash, result', () => {
    expect(SPIN_REVEAL.LEAD_IN_MS).toBe(1000); // "ONE SECOND LATER"
    expect(SPIN_REVEAL.COUNTDOWN_MS).toBeGreaterThan(0); // 3 . 2 . 1
    expect(SPIN_REVEAL.SPIN_MS).toBeGreaterThan(0);
    expect(SPIN_REVEAL.WINNER_FLASH_MS).toBeGreaterThan(0);
    expect(spinRevealTotalMs()).toBe(
      SPIN_REVEAL.LEAD_IN_MS +
        SPIN_REVEAL.COUNTDOWN_MS +
        SPIN_REVEAL.SPIN_MS +
        SPIN_REVEAL.WINNER_FLASH_MS +
        SPIN_REVEAL.RESULT_HOLD_MS
    );
  });

  it('THE DRIFT THAT WAS THERE: the client cannot outlast the engine hold', () => {
    // SpinWheel.tsx carried its own RESULT_MS of 4200 while the engine built
    // its hold from a spec RESULT_HOLD_MS of 2200. For two seconds the engine
    // believed the reveal was finished and was free to deal the first hand
    // over the top of the card announcing the prize. Nothing compared the two
    // numbers, so nothing caught it. Every client timing is now DERIVED.
    const WHEEL = strip(read('src/components/tournament/SpinWheel.tsx'));
    for (const literal of [
      /CHASE_MS\s*=\s*\d/,
      /RESULT_MS\s*=\s*\d/,
      /COUNTDOWN_STEP_MS\s*=\s*\d/,
    ]) {
      expect(WHEEL, `a hand-written timing literal is back: ${literal}`).not.toMatch(literal);
    }
    expect(WHEEL).toMatch(/CHASE_MS = SPIN_REVEAL\.SPIN_MS/);
    expect(WHEEL).toMatch(/SPIN_REVEAL\.WINNER_FLASH_MS \+ SPIN_REVEAL\.RESULT_HOLD_MS/);
    expect(WHEEL).toMatch(/COUNTDOWN_STEP_MS = SPIN_REVEAL\.COUNTDOWN_MS \/ COUNTDOWN_FROM/);
  });

  it('the chase got faster AND longer, which needs more laps', () => {
    // Dan 2026-08-21: "THE ROTATING SELECTOR SHOULD GO A LITTLE FASTER AND
    // LAST A LITTLE LONGER." Those pull against each other on a fixed lap
    // count, so the laps went up: 3 laps / 4200ms = 5.5 steps a second,
    // 5 laps / 6000ms = 7.7.
    const WHEEL = strip(read('src/components/tournament/SpinWheel.tsx'));
    expect(WHEEL).toMatch(/CHASE_LOOPS = 5/);
    expect(SPIN_REVEAL.SPIN_MS).toBe(6000);
    const oldRate = (3 * 8) / 4.2;
    const newRate = (5 * 8) / (SPIN_REVEAL.SPIN_MS / 1000);
    expect(newRate).toBeGreaterThan(oldRate);
    expect(SPIN_REVEAL.SPIN_MS).toBeGreaterThan(4200);
  });
});

describe('the ENGINE names the moment and holds the deal', () => {
  const BASE = strip(read('server/src/tournament/TournamentManagerBase.ts'));
  const ENGINE_BASE = strip(read('server/src/engine/ServerTableEngineBase.ts'));
  const DEALING = strip(read('server/src/engine/ServerTableEngineDealing.ts'));

  it('a spin start broadcasts spin_reveal with a shared timestamp', () => {
    expect(BASE).toMatch(/type: 'spin_reveal'/);
    expect(BASE).toMatch(/reveal_at: revealAt/);
  });

  it('the broadcast carries what the wheel needs to render the real draw', () => {
    const block = sliceEnclosingBlock(BASE, "type: 'spin_reveal'");
    for (const field of ['multiplier', 'buy_in', 'locked_tiers']) {
      expect(block, `missing ${field}`).toContain(field);
    }
  });

  it('every table is held for the full reveal', () => {
    /* UPDATED 2026-08-30, round 18, house rule 8. The engine is handed
       `effectiveHold` now — `Math.max(holdUntil, now + spinPostRevealMs())`,
       a ONE-SIDED extension of the stamped deal time. See spinPostReveal for
       the full reasoning; the rule here is unchanged: every table is held,
       and the hold can only ever be longer than the stamped one. */
    expect(BASE).toMatch(/holdDealingUntil\(effectiveHold\)/);
    expect(BASE).toMatch(/const effectiveHold = Math\.max\(holdUntil,/);
    expect(BASE).toMatch(/spinRevealTotalMs\(\)/);
  });

  it('the hold is checked BEFORE dealing, not after (pauseAfterHand cannot protect the first deal)', () => {
    expect(ENGINE_BASE).toMatch(/holdDealingUntil/);
    const holdAt = DEALING.indexOf('dealHoldUntilMs');
    const dealAt = DEALING.indexOf('await this.dealHand(');
    expect(holdAt, 'hold check missing from the dealing loop').toBeGreaterThan(-1);
    expect(holdAt).toBeLessThan(dealAt);
  });

  it('the hold only ever extends, so a second caller cannot shorten it', () => {
    const fn = sliceMethod(ENGINE_BASE, 'holdDealingUntil');
    expect(fn).toMatch(/>\s*this\.dealHoldUntilMs/);
  });

  it('a broadcast failure can never stop a game from starting', () => {
    const block = sliceEnclosingBlock(BASE, "type: 'spin_reveal'", 0, 3);
    expect(block).toMatch(/catch/);
  });
});

describe('the CLIENT animates against the shared clock', () => {
  const TABLE_PAGE = strip(read('src/pages/TablePage.tsx'));
  const WHEEL = strip(read('src/components/tournament/SpinWheel.tsx'));

  it('it handles the broadcast', () => {
    expect(TABLE_PAGE).toMatch(/case 'SPIN_REVEAL'/);
    expect(TABLE_PAGE).toMatch(/revealAtMs:/);
  });

  it('the wheel offsets everything by how much of the sequence already passed', () => {
    expect(WHEEL).toMatch(/revealAtMs\?:\s*number/);
    expect(WHEEL).toMatch(/const elapsed =/);
    // Late joiners must not replay the countdown after everyone saw the result.
    expect(WHEEL).toMatch(/const at = \(offsetMs: number\) =>/);
  });

  it("the countdown waits Dan's one second before it starts", () => {
    expect(WHEEL).toMatch(/SPIN_REVEAL\.LEAD_IN_MS/);
    expect(WHEEL).toMatch(/leadInMs \+ countdownMs/);
  });

  it('the wheel plays once per game, and "once" means PLAYED, not ARRIVED', () => {
    /**
     * REPLACED 2026-08-25 (defect D1). This used to assert the literal key was
     * written in TWO places - the broadcast handler and the DB fallback - both
     * of them stamping it the instant a trigger ARRIVED. sessionStorage
     * survives a same-tab reload, so the one case the gate was written for
     * ("the player refreshed mid-reveal") was the exact case it blocked: the
     * wheel stayed down for the rest of that tab's life and the player never
     * saw the draw they opened the Spin for.
     *
     * The contract now: ONE key builder, and the stamp is written from the
     * wheel's own onDone. Arrival is guarded in memory instead - a ref, which
     * resets on reload - so a refresh inside the sequence replays it against
     * the engine's clock, and a refresh after it finished does not.
     */
    expect(TABLE_PAGE).toMatch(/function spinRevealPlayedKey\(/);
    expect((TABLE_PAGE.match(/`spin-reveal-\$\{/g) || []).length).toBe(1);
    expect(TABLE_PAGE).toMatch(/function markSpinRevealPlayed\(/);
    // Completion, and only completion, stamps it.
    expect(TABLE_PAGE).toMatch(/markSpinRevealPlayed\(spinRevealTournamentRef\.current\)/);
    // The in-memory guard is what stops the broadcast and the DB fallback from
    // both opening the wheel in the same instant.
    expect(TABLE_PAGE).toMatch(/spinRevealPlayedRef\.current = true/);
  });

  it('a reveal whose sequence is already over never takes the screen', () => {
    /**
     * Defect D4. The DB fallback built the draw with NO revealAtMs, so
     * SpinWheel started from the top, and it let a started_at up to 90s old
     * through while the engine holds the deal for roughly 18s. A client that
     * arrived late replayed a 3-2-1 countdown as a modal takeover over a hand
     * already being played. The reveal instant travels with the draw now, and
     * past spinRevealTotalMs() the wheel does not open at all.
     */
    expect(TABLE_PAGE).toMatch(/function spinRevealStillLive\(/);
    expect(TABLE_PAGE).toMatch(/Date\.now\(\) - revealAtMs < spinRevealTotalMs\(\)/);
    expect(TABLE_PAGE).toMatch(/revealAtMs: revealAtMs \?\? Date\.now\(\)/);
    expect(TABLE_PAGE, 'the 90s window is back').not.toMatch(/90_000/);
  });

  it('a missed broadcast gets a bounded second chance once play begins', () => {
    /**
     * Defect D2. The DB fallback lived in a mount-only effect (deps
     * [tableId, userId]), and a seat-first player is already AT the table
     * before the game starts - when tournaments.spin_multiplier is still NULL,
     * because it is only drawn at start. So on the very client the fallback
     * was written for it ran once, against a NULL, and never again.
     *
     * The re-check must be bounded: a fixed attempt count, no standing poll.
     */
    expect(TABLE_PAGE).toMatch(/spin_reveal_post_start_recheck/);
    expect(TABLE_PAGE).toMatch(/MAX_ATTEMPTS = 3/);
    expect(TABLE_PAGE).toMatch(/attempts >= MAX_ATTEMPTS/);
  });
});
