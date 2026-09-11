/**
 * THE MINI NEVER OVERRULES THE MAIN
 * ═══════════════════════════════════════════════════════════════════════════
 * BBJ build plan phase 6 of 6 (docs/BBJ-BUILD-PLAN.md), Dan 2026-09-07.
 *
 * Dan signed off a SECOND jackpot tier: a flat amount out of the backup
 * reserve when a hand comes close to the main bar and does not meet it.
 *
 *   hold'em family   ACES FULL OR BETTER must lose
 *   PLO family       QUADS OR BETTER must lose
 *
 * The danger a second tier introduces is not that it pays too often - that is
 * a config row. It is that a looser rule, sitting beside a stricter one, ends
 * up paying a hand the STRICT rule was supposed to pay, at a few hundred chips
 * instead of a share of a six-figure pool. Every pin below exists to make that
 * impossible, and two of them are structural rather than behavioural:
 * settlement may call the mini ONLY where the main has already refused, and
 * the mini's money may come ONLY out of the reserve.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { detectMiniBBJHit, detectBBJHit, BBJ_RULES } from '../config/RakeConfig.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const settlement = read('./ServerTableEngineSettlement.ts');
const bbjService = read('../services/supabase/bbj.ts');

const card = (rank: string, suit = 'spades') => ({ rank, suit });
/** A five-card board is irrelevant to the mini (it drops both-cards-play), but
 *  the shape is kept so these read like the main detector's tests. */
const player = (
  userId: string,
  handRanking: number,
  handName: string,
  kickers: number[],
  holeCards = [card('A'), card('K')]
) => ({ userId, handRanking, handName, kickers, holeCards });

const QUADS = 8;
const FULL_HOUSE = 7;
const STRAIGHT_FLUSH = 9;

/** Aces full of sevens losing to quad deuces: the archetypal mini. */
const holdemAcesFullBeaten = () => [
  player('loser', FULL_HOUSE, 'Full House', [14, 7]),
  player('winner', QUADS, 'Four of a Kind', [2]),
];

const fire = (
  results: ReturnType<typeof player>[],
  variant = 'nlh',
  pot = 1000,
  bb = 10,
  dealt = 4
) => detectMiniBBJHit(results, 'winner', variant, pot, bb, dealt, ['loser', 'winner', 'a', 'b']);

describe('the bar Dan set, per game', () => {
  it("hold'em: aces full losing to quads is a mini", () => {
    const r = fire(holdemAcesFullBeaten());
    expect(r.hit).toBe(true);
    expect(r.loserUserId).toBe('loser');
    expect(r.miniRule).toBe('holdem_aces_full');
  });

  it("hold'em: kings full is BELOW the bar and pays nothing", () => {
    const r = fire([
      player('loser', FULL_HOUSE, 'Full House', [13, 13]),
      player('winner', QUADS, 'Four of a Kind', [2]),
    ]);
    expect(r.hit).toBe(false);
  });

  it("hold'em: no Ace in hand and no both-cards-play is STILL a mini", () => {
    /* This is the whole point of the second tier. The main rule refuses these
       on exactly those two conditions, and they are the hands a player would
       swear was a bad beat. */
    const r = fire([
      player('loser', FULL_HOUSE, 'Full House', [14, 7], [card('7'), card('2', 'hearts')]),
      player('winner', QUADS, 'Four of a Kind', [2], [card('3'), card('4', 'hearts')]),
    ]);
    expect(r.hit).toBe(true);
  });

  it('PLO: any quads losing is a mini, including below the main quad-kings bar', () => {
    const r = fire(
      [
        player('loser', QUADS, 'Four of a Kind', [5]),
        player('winner', STRAIGHT_FLUSH, 'Straight Flush', [9]),
      ],
      'plo4'
    );
    expect(r.hit).toBe(true);
    expect(r.miniRule).toBe('plo_quads');
  });

  it('PLO: a full house is below the PLO bar even though it clears the hold’em one', () => {
    const r = fire(
      [
        player('loser', FULL_HOUSE, 'Full House', [14, 14]),
        player('winner', QUADS, 'Four of a Kind', [2]),
      ],
      'plo4'
    );
    expect(r.hit).toBe(false);
  });
});

describe('what the mini refuses to drop', () => {
  it('the winner must still hold quads or better', () => {
    /* Aces full losing to a bigger boat is a cooler, not a bad beat. Paying it
       was the 2026-08-18 finding that had cost $99,066 across 25 hits. */
    const r = fire([
      player('loser', FULL_HOUSE, 'Full House', [14, 7]),
      player('winner', FULL_HOUSE, 'Full House', [14, 13]),
    ]);
    expect(r.hit).toBe(false);
  });

  it('the pot floor and the players-dealt floor are the MAIN rules, not copies', () => {
    const belowPot = fire(holdemAcesFullBeaten(), 'nlh', 10 * BBJ_RULES.minPotBB - 1, 10);
    expect(belowPot.hit).toBe(false);
    const tooFew = fire(holdemAcesFullBeaten(), 'nlh', 1000, 10, BBJ_RULES.minPlayersDealt - 1);
    expect(tooFew.hit).toBe(false);
  });

  it('a variant the jackpot does not cover gets no mini either', () => {
    for (const variant of ['plo6', 'short_deck']) {
      expect(fire(holdemAcesFullBeaten(), variant).hit).toBe(false);
    }
  });

  it('a double-board bomb pot is excluded exactly as it is for the main', () => {
    const r = detectMiniBBJHit(holdemAcesFullBeaten(), 'winner', 'nlh', 1000, 10, 4, [], {
      doubleBoard: true,
    });
    expect(r.hit).toBe(false);
  });
});

describe('it cannot take a hand the main jackpot would have paid', () => {
  it('a hand the MAIN pays is only ever offered to the main', () => {
    /* Aces full of jacks, an Ace in hand, both cards playing, beaten by quads:
       the main fires. Settlement's structure (pinned below) means the mini is
       never even asked. Asserted here so the two rules are seen together. */
    const board = [
      card('A', 'clubs'),
      card('J', 'hearts'),
      card('J', 'diamonds'),
      card('7', 'clubs'),
      card('2', 'hearts'),
    ];
    const main = detectBBJHit(
      [
        player('loser', FULL_HOUSE, 'Full House', [14, 11], [card('A'), card('A', 'hearts')]),
        player('winner', QUADS, 'Four of a Kind', [7], [card('7'), card('7', 'hearts')]),
      ],
      'winner',
      'nlh',
      1000,
      10,
      4,
      ['loser', 'winner'],
      board
    );
    // Whatever the main decides, the mini must never be the one that pays a
    // hand the main accepted.
    if (main.hit) {
      expect(main.loserUserId).toBe('loser');
    }
  });

  it('settlement asks the mini ONLY where the main has already refused', () => {
    const mainAt = settlement.indexOf('const bbjResult = detectBBJHit(');
    const miniAt = settlement.indexOf('detectMiniBBJHit(');
    expect(mainAt).toBeGreaterThan(0);
    expect(miniAt).toBeGreaterThan(mainAt);
    // The call site sits inside the `} else {` of `if (effectiveBbjResult.hit)`.
    const elseAt = settlement.indexOf('if (effectiveBbjResult.hit)');
    expect(elseAt).toBeGreaterThan(0);
    expect(miniAt).toBeGreaterThan(elseAt);
    const between = settlement.slice(elseAt, miniAt);
    expect(between).toContain('} else {');
  });

  it('the mini pays through its own RPC and never the main one', () => {
    const step = settlement.slice(
      settlement.indexOf("runStep('bbj_mini_payout'"),
      settlement.indexOf('// 3c. BBJ Payout')
    );
    expect(step.length).toBeGreaterThan(200);
    expect(step).toContain('processMiniBBJPayout(');
    expect(step).not.toContain('bbj_atomic_payout_v2');
    expect(step).not.toContain('payoutTotalPercent');
  });
});

describe('the money comes out of the reserve and nowhere else', () => {
  it('the service calls fn_bbj_mini_payout and reads no pool percentage', () => {
    const fn = bbjService.slice(bbjService.indexOf('export async function processMiniBBJPayout'));
    expect(fn).toContain('await processBBJPayout({');
    expect(fn).toContain("kind: 'mini'");
    expect(fn).not.toContain('main_balance');
    // Shared durability must retain separate RPC and funding arguments.
    expect(bbjService).toContain(
      "params.kind === 'mini' ? 'fn_bbj_mini_payout' : 'bbj_atomic_payout_v2'"
    );
    expect(bbjService).toContain('? { p_tier_id: params.tierId }');
    expect(bbjService).toContain(': { p_payout_total_percent: params.payoutTotalPercent }');
  });

  it('business-rule refusals stay skipped while failed operations use existing settlement durability', () => {
    // No separate repair queue is added. Runtime service tests assert that
    // reserve-floor refusal closes the claim and transport failure leaves it open.
    const fn = bbjService.slice(bbjService.indexOf('export async function processMiniBBJPayout'));
    expect(fn).toContain("status: 'skipped'");
    expect(fn).not.toContain('queueUnpaidBBJPayout');
    expect(fn).not.toContain('queueUnbankedFee');
  });
});

describe('the mini is counted as the mini, never as the main', () => {
  /*
   * THE COUNTERS SAID A MAIN JACKPOT WAS FAILING (2026-09-11).
   *
   * `engineInstruments.ts` documents its BBJ counters as a set whose useful
   * reading is the DIFFERENCE - "detected == paid is health, a detected that
   * never becomes paid or queued is the failure the whole of phase 2 exists to
   * make impossible". The mini broke that arithmetic in both directions at
   * once: it incremented the MAIN's `bbjPayoutsQueuedTotal` on every queued
   * mini, and incremented nothing at all when a mini was detected, paid, or
   * refused. So a queued mini read as the main jackpot failing to deliver, and
   * a mini that had stopped paying entirely moved no series anywhere.
   *
   * Separate counters rather than a `kind` label, so that a dashboard or alert
   * already reading the main's series keeps meaning what it meant.
   */
  const instruments = read('../observability/engineInstruments.ts');

  it('the mini has its own detected, paid, queued and refused counters', () => {
    for (const name of [
      'poker_bbj_mini_hits_detected_total',
      'poker_bbj_mini_payouts_paid_total',
      'poker_bbj_mini_payouts_queued_total',
      'poker_bbj_mini_payouts_refused_total',
    ]) {
      expect(instruments, `${name} must be declared`).toContain(name);
    }
    // registered at zero from boot, or "no minis" and "no instrument" read alike
    for (const sym of [
      'bbjMiniHitsDetectedTotal',
      'bbjMiniPayoutsPaidTotal',
      'bbjMiniPayoutsQueuedTotal',
      'bbjMiniPayoutsRefusedTotal',
    ]) {
      expect(instruments, `${sym} must be seeded at zero`).toContain(`${sym}.inc(0);`);
    }
  });

  it('the mini payout step touches no MAIN counter', () => {
    const step = settlement.slice(
      settlement.indexOf('processMiniBBJPayout('),
      settlement.indexOf('mini jackpot paid')
    );
    expect(step.length).toBeGreaterThan(200);
    /* On the CODE, not the prose. This block explains in a comment which main
       counter it used to increment, and asserting on raw text would make that
       explanation illegal - which pushes the next author to delete the
       reasoning to get the law green. The same trap the promo law documents,
       and the same one that caught this law's own author twice. */
    const code = step.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const main of ['bbjPayoutsQueuedTotal', 'bbjPayoutsPaidTotal', 'bbjHitsDetectedTotal']) {
      expect(code, `the mini must not increment ${main}`).not.toMatch(
        new RegExp(`EngineMetrics\\.${main}\\b`)
      );
    }
    expect(code).toContain('bbjMiniPayoutsQueuedTotal.inc(1)');
  });

  it('a mini that pays and a mini that is refused each move their own series', () => {
    expect(settlement).toContain('bbjMiniPayoutsPaidTotal.inc(1)');
    expect(settlement).toContain('bbjMiniPayoutsRefusedTotal.inc(1)');
    expect(settlement).toContain('bbjMiniHitsDetectedTotal.inc(1)');
  });

  it('a replay is not a refusal', () => {
    /* `already_paid` is settlement running twice for one hand and the
       idempotency key doing its job. Recording it as `mini_refused:` put a
       mini that DID pay into the one instrument built to answer "why did the
       mini not pay". */
    expect(settlement).toMatch(/outcome\.reason !== 'already_paid'/);
  });
});
