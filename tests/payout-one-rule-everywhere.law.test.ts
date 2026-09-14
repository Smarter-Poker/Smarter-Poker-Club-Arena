/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE PAYOUT RULE, EVERYWHERE — LAW (Dan, 2026-08-29, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "THIS NEEDS TO BE EXACT AND 100% ACCURATE AT ALL TIMES ... THERE CAN
 * NEVER EVER EVER BE MISTAKES WHEN PAYING OUT."
 *
 * On 2026-08-29 this platform had FOUR implementations of "what is one place
 * paid", using THREE different rules:
 *
 *   server/src/tournament/payoutMath.ts   round each, last place takes the
 *                                          residual  <- pays the money
 *   src/components/.../types.ts           trunc(pool * pct) / 100
 *   src/services/TournamentService.ts     trunc(pool * pct) / 100
 *   src/services/PayoutEngine.ts          trunc, then shave any excess off
 *                                          FIRST place
 *
 * What that cost, measured the same day:
 *
 *   * 13 of the 78 pool-and-structure combinations in production showed a
 *     player a different number in the lobby from the one that reached their
 *     wallet;
 *   * the client's places did not sum to the pool at all;
 *   * PayoutEngine's fallback trimmed the HEADLINE prize, which is the exact
 *     opposite of the engine's rule -- the engine puts the adjustment on the
 *     smallest prize on purpose.
 *
 * And a fifth implementation lives in SQL, in fn_tournament_payout_reconcile.
 * That one moves money: when it disagreed with the engine by a cent it
 * "topped up" the difference and pushed a 513.00 pool to 513.01, on every run
 * of Union Morning Classic, twice a day.
 *
 * So: one rule. The client copy is VERBATIM from the server, and this test is
 * what keeps it that way. If it fails, the two have drifted -- copy the
 * server's version over the client's, do not edit one to match the other by
 * hand.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { computePlacePrize, prizePoolAvailableToPlaces } from '../src/lib/payoutMath';
import { CHIP_UNIT_CENTS } from '../server/src/tournament/tournamentUnit';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/** Strip comments, so a guard cannot fail on prose describing the old code. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SERVER = 'server/src/tournament/payoutMath.ts';
const CLIENT = 'src/lib/payoutMath.ts';

/** Everything from the function's doc comment onward — the part that must match. */
function rule(src: string): string {
  const i = src.indexOf('/**\n * The single rule for turning a prize pool');
  return i === -1 ? '' : src.slice(i);
}

describe('the payout rule is written once', () => {
  it('the client copy is byte-identical to the engine', () => {
    const server = rule(read(SERVER));
    const client = rule(read(CLIENT));
    expect(server.length, `could not find the rule in ${SERVER}`).toBeGreaterThan(500);
    expect(client.length, `could not find the rule in ${CLIENT}`).toBeGreaterThan(500);
    expect(
      client,
      `${CLIENT} has drifted from ${SERVER}. Copy the server's version over it — ` +
        `do not hand-edit one to match the other.`
    ).toBe(server);
  });

  it('no display code prices a place on its own any more', () => {
    // The three ad-hoc client implementations, by their signatures. Each one
    // showed a player a number the engine would not pay.
    const types = code(read('src/components/tournament/details/types.ts'));
    const svc = code(read('src/services/TournamentService.ts'));
    const eng = code(read('src/services/PayoutEngine.ts'));

    expect(types).not.toMatch(/Math\.trunc\(p \* pct\) \/ 100/);
    expect(svc).not.toMatch(/Math\.trunc\(prizePool \* entry\.percentage\) \/ 100/);
    expect(eng).not.toMatch(
      /Math\.trunc\(\(\(prizePool \* p\.percentage\) \/ 100\) \* 100\) \/ 100/
    );

    // ...and each now defers to the one rule.
    for (const [name, src] of [
      ['types.ts', types],
      ['TournamentService.ts', svc],
      ['PayoutEngine.ts', eng],
    ] as const) {
      expect(src, `${name} does not use computePlacePrize`).toMatch(/computePlacePrize/);
    }

    for (const file of [
      'src/pages/TournamentPage.tsx',
      'src/components/tournament/TournamentInfoPanel.tsx',
      'src/components/lobby/GameLobbyPanel.tsx',
      'src/components/tournament/details/RewardsTab.tsx',
    ]) {
      const display = code(read(file));
      expect(display, `${file} bypasses the shared place calculation`).toMatch(/placePrize/);
      expect(display, `${file} bypasses the pool-funded bubble reserve`).toMatch(
        /effectivePlaceLadderPool/
      );
      expect(display, `${file} multiplies a raw pool by one percentage`).not.toMatch(
        /prize_pool[^;\n]{0,120}\*[^;\n]{0,120}percentage|percentage[^;\n]{0,120}\*[^;\n]{0,120}prize_pool/
      );
    }
  });

  it('nothing shaves the excess off first place', () => {
    // PayoutEngine's old fallback adjusted amounts[0] — the headline prize —
    // when truncation overshot. The engine's rule puts any adjustment on the
    // SMALLEST prize, deliberately.
    expect(code(read('src/services/PayoutEngine.ts'))).not.toMatch(/amounts\[0\]\.amount =/);
  });

  it('every tournament payout surface resolves a Spin from its canonical multiplier', () => {
    for (const file of [
      'src/pages/TournamentPage.tsx',
      'src/components/lobby/GameLobbyPanel.tsx',
      'src/components/tournament/TournamentInfoPanel.tsx',
      'src/components/tournament/details/DetailOverviewTab.tsx',
      'src/components/tournament/details/RankingTab.tsx',
      'src/components/tournament/details/RewardsTab.tsx',
    ]) {
      const display = code(read(file));
      expect(display, `${file} can still advertise a stale Spin placeholder`).toContain(
        'resolvePayoutStructure'
      );
      expect(display, `${file} reads the raw Spin payout copy directly`).not.toMatch(
        /parsePayoutStructure\([^)]*payout_structure/
      );
    }
  });

  it('the open tournament detail refresh carries both Spin payout witnesses', () => {
    const page = code(read('src/pages/TournamentPage.tsx'));
    const panel = code(read('src/components/tournament/TournamentInfoPanel.tsx'));
    for (const [name, source] of [
      ['TournamentPage.tsx', page],
      ['TournamentInfoPanel.tsx', panel],
    ] as const) {
      expect(source, `${name} detail query omits spin_multiplier`).toMatch(
        /\.select\([\s\S]{0,900}spin_multiplier[\s\S]{0,900}\)/
      );
      expect(source, `${name} detail query omits payout_structure`).toMatch(
        /\.select\([\s\S]{0,900}payout_structure[\s\S]{0,900}\)/
      );
    }
  });
});

describe('cash bubble protection comes from the prize pool', () => {
  const ladder = [50, 30, 20].map((percentage, i) => ({ place: i + 1, percentage }));

  it('reserves exactly one base buy-in and the ladder plus bubble equals the pool', () => {
    const placePool = prizePoolAvailableToPlaces(1000, ladder, 4, true, 100);
    expect(placePool).toBe(900);
    const ladderCents = ladder.reduce(
      (sum, row) =>
        sum + Math.round(computePlacePrize(placePool!, ladder, row.place, CHIP_UNIT_CENTS) * 100),
      0
    );
    expect(ladderCents).toBe(90000);
    expect(ladderCents + 10000).toBe(100000);
  });

  it('does not reserve when protection is disabled or no stone bubble exists', () => {
    expect(prizePoolAvailableToPlaces(1000, ladder, 4, false, 100)).toBe(1000);
    expect(prizePoolAvailableToPlaces(1000, ladder, 3, true, 100)).toBe(1000);
  });

  it('leaves a satellite pool untouched for its separate residual authority', () => {
    expect(prizePoolAvailableToPlaces(1000, ladder, 4, false, 100)).toBe(1000);
  });

  it('fails closed on values the database settlement refuses', () => {
    expect(prizePoolAvailableToPlaces(1000.001, ladder, 4, true, 100)).toBeNull();
    expect(prizePoolAvailableToPlaces(1000, ladder, 4, true, 100.001)).toBeNull();
    expect(prizePoolAvailableToPlaces(50, ladder, 4, true, 100)).toBeNull();
    expect(prizePoolAvailableToPlaces(1000, [], 4, true, 100)).toBeNull();
    expect(prizePoolAvailableToPlaces(1000, ladder, 0, true, 100)).toBeNull();
  });
});

describe('the client prices exactly what the engine pays', () => {
  // The structures actually used in production, on 2026-08-29.
  const STRUCTURES: Array<[string, number[]]> = [
    ['winner takes all', [100]],
    ['5-place', [40, 25, 18, 10, 7]],
    ['heads-up', [65, 35]],
    ['9-place', [30, 20, 15, 10, 8, 6, 5, 3.5, 2.5]],
    ['spin 80/20', [80, 20]],
    ['3-place', [50, 30, 20]],
    ['spin 80/12/8', [80, 12, 8]],
  ];

  for (const [name, pcts] of STRUCTURES) {
    it(`${name}: the places always sum to the pool`, () => {
      const entries = pcts.map((percentage, i) => ({ place: i + 1, percentage }));
      const bad: string[] = [];
      for (let cents = 1; cents <= 60000; cents += cents < 2000 ? 1 : 13) {
        const pool = cents / 100;
        let sum = 0;
        for (let place = 1; place <= pcts.length; place++) {
          sum += Math.round(computePlacePrize(pool, entries, place, CHIP_UNIT_CENTS) * 100);
        }
        if (sum !== cents) {
          bad.push(`pool ${pool.toFixed(2)} -> ${(sum / 100).toFixed(2)}`);
          if (bad.length > 4) break;
        }
      }
      expect(bad, bad.join('; ')).toEqual([]);
    });
  }

  it('the 513.00 pool that overpaid twice a day now pays 513.00', () => {
    const nine = [30, 20, 15, 10, 8, 6, 5, 3.5, 2.5].map((percentage, i) => ({
      place: i + 1,
      percentage,
    }));
    expect(computePlacePrize(513, nine, 8, CHIP_UNIT_CENTS)).toBe(17.96);
    const total = nine.reduce(
      (s, e) => s + Math.round(computePlacePrize(513, nine, e.place, CHIP_UNIT_CENTS) * 100),
      0
    );
    expect(total).toBe(51300);
  });
});
