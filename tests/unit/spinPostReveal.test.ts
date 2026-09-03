/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AFTER THE WHEEL: CHIPS, THEN BUTTON, THEN CARDS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-21: "AFTER THE SPIN COMPLETES, CHIP STACKS GET ADDED, BUTTON
 * RANDOMLY ASSIGNED AND THE SPIN STARTS!"
 *
 * Two things were wrong before this.
 *
 * 1. THE STACKS ARRIVED EARLY. A seat is a reservation at zero chips until the
 *    multiplier is known — stack depth belongs to the tier, and spin tiers run
 *    300/400/500, so there is no honest number to seat someone with before the
 *    draw. But the credit ran at start, BEFORE the reveal broadcast, so the
 *    stacks landed on the felt while the wheel was still turning. The table
 *    had already answered the question the wheel was in the middle of asking.
 *
 * 2. THE BUTTON WAS NOT RANDOM. The first hand's dealer was `sortedSeats[0]`,
 *    the lowest occupied seat. On a 3-handed Spin that is a genuine positional
 *    edge, and in a seat-first format the low seat goes to whoever clicked
 *    first — so the edge was awarded for reaction time.
 *
 * The ordering is enforced by the ENGINE HOLD, not by hope: the hold now runs
 * to `spinRevealToDealMs()`, which includes the two post-reveal beats. Holding
 * only for the wheel would leave the engine free to deal in the same instant
 * the stacks are being written, and the deal wins that race.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod, sliceEnclosingBlock } from '../helpers/sourceWindow';
import {
  SPIN_REVEAL,
  spinRevealTotalMs,
  spinPostRevealMs,
  spinRevealToDealMs,
} from '../../src/config/spinSpec';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const MANAGER = strip(read('server/src/tournament/TournamentManagerBase.ts'));
const SEAT_CREDIT = strip(read('server/src/tournament/seatStackCredit.ts'));
const DEALING = strip(read('server/src/engine/ServerTableEngineDealing.ts'));
const ENGINE = strip(read('server/src/engine/ServerTableEngineBase.ts'));

describe('the hold covers the whole sequence, not just the wheel', () => {
  it('deal time is the reveal PLUS the chip drop and the button draw', () => {
    expect(spinPostRevealMs()).toBe(SPIN_REVEAL.CHIP_DROP_MS + SPIN_REVEAL.BUTTON_DRAW_MS);
    expect(spinRevealToDealMs()).toBe(spinRevealTotalMs() + spinPostRevealMs());
    expect(spinRevealToDealMs()).toBeGreaterThan(spinRevealTotalMs());
  });

  it('the engine is held to the DEAL time, never merely to the wheel time', () => {
    // The distinction is the entire fix. `holdUntil = revealAt +
    // spinRevealTotalMs()` would expire the moment the wheel stops, which is
    // exactly when the chips are still being written.
    //
    /* UPDATED 2026-08-27, house rule 8. The arithmetic moved, the rule did not.
       `holdUntil` is no longer computed at broadcast time: the hold is stamped
       alongside the reveal in `stampSpinRevealAnchor` (from the third payment)
       and returned by `resolveSpinReveal`, which also re-stamps both if the
       start path overran the animation. That gave the single expression this
       pin named three homes instead of one.

       Pinning all three is what the pin should have done from the start. A
       single-line assertion could never have caught a SECOND assignment that
       used the wheel time, which is precisely the defect described above. */
    const holdAssignments = MANAGER.match(/this\.spinHoldUntil =[^;]+;/g) ?? [];
    // stampSpinRevealAnchor, plus the no-anchor and overrun paths in
    // resolveSpinReveal. A refactor that loses one must fail here, not go quiet.
    expect(holdAssignments.length).toBeGreaterThanOrEqual(3);
    for (const assignment of holdAssignments) {
      expect(assignment).toMatch(/spinRevealToDealMs\(\)/);
      // The wheel time may not appear in ANY of them.
      expect(assignment).not.toMatch(/spinRevealTotalMs\(\)/);
    }
    // And the number handed to the engine is that same stamped hold.
    expect(MANAGER).toMatch(/const \{ revealAt, holdUntil \} = this\.resolveSpinReveal\(\)/);
    expect(MANAGER).toMatch(
      /return \{ revealAt: this\.spinRevealAt, holdUntil: this\.spinHoldUntil \}/
    );
    /* UPDATED 2026-08-30, round 18, house rule 8 again. The engine is now
       handed `effectiveHold`, not `holdUntil` directly, and the RULE this pin
       exists for is unchanged and still checked: the hold is the DEAL time,
       never the wheel time.

       Why the indirection exists. The reveal is broadcast the instant the draw
       resolves now, so `holdUntil` is decided BEFORE the settle, the row write
       and the table build rather than after them. Freezing it that early means
       a pathologically slow start could in principle consume the whole hold,
       and the re-anchor that used to catch that is deliberately disabled once
       the moment is public (three wheels are already turning on those exact
       numbers). So the HOLD is extended instead of the reveal being moved.

       It is ONE-SIDED by construction — `Math.max(holdUntil, ...)` — so it can
       only ever be later than the stamped deal time, never earlier. A client
       is allowed to finish early and wait; it must never be dealt over. */
    expect(MANAGER).toMatch(
      /const effectiveHold = Math\.max\(holdUntil, Date\.now\(\) \+ spinPostRevealMs\(\)\);/
    );
    expect(MANAGER).toMatch(/engine\.holdDealingUntil\(effectiveHold\)/);
    // The wheel time may not sneak in through the new expression either.
    expect(MANAGER).not.toMatch(/effectiveHold[^;]*spinRevealTotalMs\(\)/);
  });

  it('both post-reveal beats have real duration, or the order is decorative', () => {
    expect(SPIN_REVEAL.CHIP_DROP_MS).toBeGreaterThan(0);
    expect(SPIN_REVEAL.BUTTON_DRAW_MS).toBeGreaterThan(0);
  });
});

describe('the stacks wait for the wheel', () => {
  it('a spin with a drawn multiplier DEFERS the credit', () => {
    expect(MANAGER).toMatch(/deferStacksForSpinReveal/);
    const fn = sliceMethod(MANAGER, 'private async deferStacksForSpinReveal');
    expect(fn).toMatch(/isSpin && Number\(tournament\?\.spin_multiplier\) > 0/);
  });

  it('everything else is still credited at start', () => {
    // The negation matters: a non-spin table must not sit at zero chips
    // waiting for a wheel that will never turn.
    expect(MANAGER).toMatch(
      /if \(!\(await this\.deferStacksForSpinReveal\(tournament\)\)\) \{\s*await this\.creditSeatStacks\(tournament\);/
    );
  });

  it('a spin that reached start WITHOUT a multiplier is credited immediately too', () => {
    // Same reason. A missing draw is a bug, but stranding three players on
    // zero chips forever is a worse one.
    const fn = sliceMethod(MANAGER, 'private async deferStacksForSpinReveal');
    expect(fn).toMatch(/> 0/);
  });

  it('the credit is idempotent, because it runs from a timer', () => {
    // A restart between the reveal and the credit has to be recoverable by
    // simply calling it again, so it may only ever write the value start
    // already decided, and only to seats that disagree.
    //
    // 2026-08-22: "disagree" tightened from `!== target` to `< target` — the
    // credit strictly RAISES a reservation seat to the decided stack and never
    // lowers one, because an early-bird seat (starting chips + bonus) sits
    // ABOVE the plain starting stack and flattening it would destroy the
    // bonus. Idempotence is unchanged: a healthy seat still writes nothing.
    //
    // 2026-09-02 (chip-std, tournament chips are conserved): the "which seats"
    // decision moved out of the manager into the pure selectSeatsToFund in
    // server/src/tournament/seatStackCredit.ts, so the credit can also refuse
    // when raising seats would mint chips. The `< target` rule lives there
    // now; the manager must hand the decision to it and write only what it
    // returns.
    const fn = sliceMethod(MANAGER, 'protected async creditSeatStacks');
    const body = fn;
    expect(body).toMatch(/selectSeatsToFund\(\{/);
    expect(body).toMatch(/const stale = decision\.fund;/);
    expect(body).toMatch(/if \(stale\.length === 0\) return 0;/);
    expect(body).toMatch(/\.update\(\{ stack: target \}\)/);
    const rule = sliceMethod(SEAT_CREDIT, 'export function selectSeatsToFund(');
    expect(rule).toMatch(/num\(s\.stack\) < target/);
  });

  it('a failed credit is reported, never thrown into the start path', () => {
    const fn = sliceMethod(MANAGER, 'protected async creditSeatStacks');
    expect(fn).toMatch(/reportError/);
  });
});

describe('the three beats, in order, each announced', () => {
  it('chips land when the reveal ends', () => {
    expect(MANAGER).toMatch(/const chipsAt = revealAt \+ spinRevealTotalMs\(\)/);
    expect(MANAGER).toMatch(/type: 'spin_chips'/);
  });

  it('the button is drawn one chip-drop later', () => {
    expect(MANAGER).toMatch(/const buttonAt = chipsAt \+ SPIN_REVEAL\.CHIP_DROP_MS/);
    expect(MANAGER).toMatch(/type: 'spin_button'/);
  });

  it('the button beat carries the seat, so a client can animate it', () => {
    const block = sliceEnclosingBlock(MANAGER, "type: 'spin_button'");
    expect(block).toMatch(/dealer_seat: seat/);
  });

  it('a dead tournament cannot have chips written into it seconds later', () => {
    expect(MANAGER).toMatch(/const stillLive = \(\) => this\.isRunning\(\)/);
    expect(MANAGER).toMatch(/if \(!stillLive\(\)\) return;/);
  });

  it('the timers never hold the process open for theatre', () => {
    expect(MANAGER).toMatch(/unref/);
  });

  it('a missed chip drop self-heals rather than stranding the table', () => {
    // Without this a transient DB error at beat 1 leaves every seat on zero
    // chips and NO hand can ever start — the table just sits there.
    expect(MANAGER).toMatch(/safety net/i);
    expect(MANAGER).toMatch(/buttonAt \+ SPIN_REVEAL\.BUTTON_DRAW_MS \+ \d+/);
  });
});

describe('the button is drawn, not awarded to the low seat', () => {
  it('the tournament picks uniformly from the occupied seats', () => {
    const block = sliceEnclosingBlock(MANAGER, 'const seats = engine.getOccupiedSeatNumbers()');
    /* UPDATED 2026-08-27, house rule 8. `Math.floor(Math.random() * n)` became
       `secureRandomInt(n)`. Uniformity is the only thing this pin was ever
       about, and it is not weakened: secureRandomInt rejection-samples against
       `floor(0xffffffff / n) * n` to remove modulo bias, where the expression
       it replaces is uniform only as far as Math.random is — a predictable
       PRNG. The first button on a three-handed hyper is a real positional edge,
       drawn once, in public, on a table where two of the three players are
       horses, so it belongs on the same generator as the deck. */
    expect(block).toMatch(/seats\[secureRandomInt\(seats\.length\)\]/);
    // And the predictable PRNG may not come back to this draw.
    expect(block).not.toMatch(/Math\.random\(\)/);
    // From the engine's crypto module, not a local re-implementation.
    expect(MANAGER).toMatch(/import \{ secureRandomInt \} from '\.\.\/engine\/CryptoRandom\.js'/);
    expect(block).toMatch(/engine\.setFirstButtonSeat\(seat\)/);
  });

  it('an empty table is skipped rather than crashing the draw', () => {
    const block = sliceEnclosingBlock(MANAGER, 'const seats = engine.getOccupiedSeatNumbers()');
    expect(block).toMatch(/if \(seats\.length === 0\) continue;/);
  });

  it('the engine exposes the seats instead of the tournament re-querying them', () => {
    // A second query would be a second source of truth for who is sitting
    // where, and they would disagree the moment someone left.
    expect(ENGINE).toMatch(/public getOccupiedSeatNumbers\(\): number\[\]/);
  });

  it('the FIRST hand honours the draw', () => {
    expect(DEALING).toMatch(/const drawnButton = this\.forcedFirstButtonSeat;/);
    // `const` became `let` on 2026-08-25 when the "the button must always move"
    // guard landed below it (a single button-eligible player already holding the
    // button used to keep it, making the same two players post both blinds twice
    // running). The draw still wins outright — what matters here is that
    // dealerSeat is seeded from drawnIsSeated...
    expect(DEALING).toMatch(/(?:const|let) dealerSeat = drawnIsSeated/);
    // ...and that the new guard cannot reach in and move a DRAWN button, which
    // would silently undo the Spin's reveal.
    expect(DEALING).toMatch(/!drawnIsSeated &&/);
  });

  it('it is consumed exactly once, so hand two rotates normally', () => {
    const at = DEALING.indexOf('const drawnButton = this.forcedFirstButtonSeat;');
    expect(at).toBeGreaterThan(-1);
    // Cleared immediately after being read, before anything can throw.
    expect(sliceEnclosingBlock(DEALING, 'const drawnButton = this.forcedFirstButtonSeat;')).toMatch(
      /this\.forcedFirstButtonSeat = null;/
    );
  });

  it('a drawn seat that emptied falls back to normal rotation', () => {
    // A player can leave between the draw and the deal; the button must not
    // strand itself on an empty seat.
    expect(DEALING).toMatch(
      /const drawnIsSeated =[\s\S]{0,120}sortedSeats\.includes\(drawnButton\)/
    );
    expect(DEALING).toMatch(/: prevButtonSeat > 0/);
  });

  it('the setter rejects nonsense rather than storing it', () => {
    const fn = sliceMethod(ENGINE, 'public setFirstButtonSeat');
    expect(fn).toMatch(/Number\.isFinite\(seat\) && seat > 0/);
  });
});
