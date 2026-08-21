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

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('the reveal timing is one spec, mirrored into the engine', () => {
  it('client and server copies of spinSpec stay byte-identical', () => {
    expect(read('server/src/config/spinSpec.ts')).toBe(read('src/config/spinSpec.ts'));
  });

  it('the sequence is lead-in, countdown, spin, result', () => {
    expect(SPIN_REVEAL.LEAD_IN_MS).toBe(1000); // "ONE SECOND LATER"
    expect(SPIN_REVEAL.COUNTDOWN_MS).toBeGreaterThan(0); // 3 . 2 . 1
    expect(SPIN_REVEAL.SPIN_MS).toBeGreaterThan(0);
    expect(spinRevealTotalMs()).toBe(
      SPIN_REVEAL.LEAD_IN_MS +
        SPIN_REVEAL.COUNTDOWN_MS +
        SPIN_REVEAL.SPIN_MS +
        SPIN_REVEAL.RESULT_HOLD_MS
    );
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
    const block = BASE.slice(BASE.indexOf("type: 'spin_reveal'"));
    for (const field of ['multiplier', 'buy_in', 'locked_tiers']) {
      expect(block.slice(0, 800), `missing ${field}`).toContain(field);
    }
  });

  it('every table is held for the full reveal', () => {
    expect(BASE).toMatch(/holdDealingUntil\(holdUntil\)/);
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
    const fn = ENGINE_BASE.slice(ENGINE_BASE.indexOf('holdDealingUntil'));
    expect(fn.slice(0, 300)).toMatch(/>\s*this\.dealHoldUntilMs/);
  });

  it('a broadcast failure can never stop a game from starting', () => {
    const block = BASE.slice(BASE.indexOf("type: 'spin_reveal'") - 600);
    expect(block.slice(0, 1400)).toMatch(/catch/);
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

  it('the wheel can only play once per game, whichever trigger arrives first', () => {
    const keys = TABLE_PAGE.match(/spin-reveal-\$\{/g) || [];
    // one in the broadcast handler, one in the DB fallback — same key.
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });
});
