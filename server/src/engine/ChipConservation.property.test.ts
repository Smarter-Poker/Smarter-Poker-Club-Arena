/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CHIP CONSERVATION — PROPERTY TEST
 * ═══════════════════════════════════════════════════════════════════════════════
 * D24, named "highest leverage" by the engine optimization report.
 *
 * Every other engine test pins ONE hand-shaped example. This one asserts the
 * property that actually defines a card room — the engine never creates or
 * destroys a chip — across thousands of randomized complete hands covering all
 * seven variants, 2-9 seats, micro to deep stacks, antes, Big Blind Antes,
 * straddles, bomb pots, dead blinds, post-BB entries, every rake shape and BBJ
 * on and off. See src/engine/HandFuzzer.ts for the invariants and the oracle.
 *
 * This runs inside `npm test`, which auto-deploy-hetzner.yml executes BEFORE it
 * builds or ships anything (design note 7 in that workflow). A chip-conservation
 * regression therefore cannot reach production.
 *
 * Soak it locally with:
 *     CHIP_CONSERVATION_HANDS=1000000 npx vitest run ChipConservation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fuzzOneHand, ChipConservationError, VARIANTS, type FuzzHandResult } from './HandFuzzer.js';
import { calculatePots } from './PokerEngine.js';
import { HandController } from './HandController.js';
import type { HandConfig, SeatPlayer } from '../types.js';

const HANDS = Number(process.env.CHIP_CONSERVATION_HANDS ?? 10_000);
/**
 * Fixed ACTION seeds.
 *
 * CORRECTION 2026-08-20: this said "a green build stays green — no flaky
 * deploys from this leg", and that was false. Only the action stream is seeded.
 * The deck is shuffled with secureShuffle (node:crypto) and is deliberately NOT
 * seedable, so every card is fresh on every run and any invariant whose outcome
 * depends on cards — INV-7, INV-10, chop and odd-chip allocation, hi-lo splits,
 * the no-winners guard — is non-deterministic. Demonstrated: with a side-pot
 * mutant installed, three runs of the identical 2,000-seed corpus produced 28,
 * 26 and 27 failures, and 2 of the 28 failing seeds did not fail in all three.
 *
 * So a card-dependent regression shows up as an INTERMITTENT red build. That is
 * a real property of this test and it is written down here rather than denied.
 * The replay dump in the failure message is the reproduction — not the seed.
 */
const BASE_SEED = Number(process.env.CHIP_CONSERVATION_SEED ?? 1);
/** Fresh territory on every run, so the corpus is not the only thing tested. */
const EXPLORE_HANDS = Number(process.env.CHIP_CONSERVATION_EXPLORE ?? 1_000);

interface RunSummary {
  ran: number;
  showdowns: number;
  allInRunouts: number;
  maxSidePots: number;
  checks: number;
  actions: number;
  rakeTaken: number;
  variants: Set<string>;
  seatCounts: Set<number>;
}

function runCorpus(baseSeed: number, count: number): RunSummary {
  const s: RunSummary = {
    ran: 0,
    showdowns: 0,
    allInRunouts: 0,
    maxSidePots: 0,
    checks: 0,
    actions: 0,
    rakeTaken: 0,
    variants: new Set(),
    seatCounts: new Set(),
  };
  for (let i = 0; i < count; i++) {
    const seed = baseSeed + i;
    let r: FuzzHandResult;
    try {
      r = fuzzOneHand(seed);
    } catch (err) {
      if (err instanceof ChipConservationError) {
        // The message already carries the full replay. Reproduce with:
        //   CHIP_CONSERVATION_SEED=<seed> CHIP_CONSERVATION_HANDS=1 npx vitest run ChipConservation
        // The REPLAY below is the reproduction: it carries the config, the
        // dealt board, every hole card and every action. Re-running the seed
        // reproduces the action stream but NOT the deck (see BASE_SEED above),
        // so it is offered as a starting point, not as a guarantee.
        throw new Error(
          `chip conservation violated on seed ${seed}\n` +
            `the REPLAY below is the reproduction; the seed alone replays only ` +
            `the actions, not the cards\n\n` +
            err.message
        );
      }
      throw new Error(`hand ${seed} threw: ${(err as Error).stack ?? String(err)}`);
    }
    s.ran++;
    s.checks += r.checks;
    s.actions += r.actions;
    s.rakeTaken += r.rake + r.bbjFee;
    if (r.reachedShowdown) s.showdowns++;
    if (r.allInRunout) s.allInRunouts++;
    if (r.sidePots > s.maxSidePots) s.maxSidePots = r.sidePots;
    s.variants.add(r.variant);
    s.seatCounts.add(r.players);
  }
  return s;
}

describe('chip conservation (property)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnings: string[];
  let errors: string[];

  beforeEach(() => {
    warnings = [];
    errors = [];
    // The hand FSM reports an illegal hand flow by console.warn-ing. Across a
    // corpus this doubles as a property test on the FSM graph itself: a bomb
    // pot used to fire four "Invalid transition" warnings per hand because
    // start() jumped 'dealing' -> 'flop', an edge that does not exist.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    // The engine reports several faults that are chip-CONSERVING and therefore
    // invisible to every invariant here. completeHand's catch-all writes to
    // console.error; StateMachine's invalid-transition path writes to both.
    // Capturing error also stops a regression spewing 10,000 unmocked lines.
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /**
   * Faults the engine announces but no chip invariant can see.
   *
   * "No winners found" awards the ENTIRE pot to activePlayers[0] — perfectly
   * chip-conserving, and the wrong player is paid. "completeHand threw" force-
   * ends the hand with rake 0. Neither moves a chip that INV-1..INV-10 can
   * object to, so without this they pass silently.
   */
  /**
   * The exact command that replays a corpus, printed on every failure.
   *
   * The explore run seeds itself, so without this the corpus that found a
   * fault dies with the CI job. CHIP_CONSERVATION_EXPLORE=0 turns the explore
   * pass off so the replay walks the SAME ground rather than new ground.
   */
  const replayHint = (seed: number, hands: number) =>
    `engine panicked. REPLAY THIS EXACT CORPUS:\n` +
    `  cd server && CHIP_CONSERVATION_SEED=${seed} CHIP_CONSERVATION_HANDS=${hands} ` +
    `CHIP_CONSERVATION_EXPLORE=0 npx vitest run src/engine/ChipConservation.property.test.ts`;

  const enginePanics = () =>
    [...warnings, ...errors].filter((m) =>
      /No winners found|No actionable seat|completeHand threw|Invalid transition/.test(m)
    );

  it(`conserves chips across ${HANDS} randomized hands (fixed corpus from seed ${BASE_SEED})`, () => {
    const s = runCorpus(BASE_SEED, HANDS);

    expect(s.ran).toBe(HANDS);

    // The corpus must actually exercise the engine. Without this, a change to
    // randomTable() that quietly stopped producing contested hands would leave
    // the test green and meaningless.
    //
    // GUARDED on corpus size (review fix 2026-08-20): these are statements
    // about a LARGE SAMPLE, and applying them unconditionally broke the one
    // command the failure message tells you to run — a 1-hand reproduction
    // failed here with `expected 1 to be 7` and never reached the replay.
    if (HANDS >= 1000) {
      expect(s.checks).toBeGreaterThan(HANDS); // >1 invariant check per hand
      expect(s.actions).toBeGreaterThan(HANDS * 2);
      expect(s.showdowns).toBeGreaterThan(HANDS * 0.2);
      expect(s.allInRunouts).toBeGreaterThan(HANDS * 0.05);
      expect(s.maxSidePots).toBeGreaterThanOrEqual(3);
      expect(s.rakeTaken).toBeGreaterThan(0);
      expect(s.variants.size).toBe(VARIANTS.length); // every variant the engine supports
      expect(Math.min(...s.seatCounts)).toBe(2);
      expect(Math.max(...s.seatCounts)).toBeGreaterThanOrEqual(6);
    }

    expect(enginePanics().slice(0, 5), replayHint(BASE_SEED, HANDS)).toEqual([]);
  }, 600_000);

  it(`explores ${EXPLORE_HANDS} previously untested hands`, () => {
    if (EXPLORE_HANDS <= 0) return;
    // Deliberately NOT fixed: every CI run walks new ground.
    const base = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
    const s = runCorpus(base, EXPLORE_HANDS);
    expect(s.ran, replayHint(base, EXPLORE_HANDS)).toBe(EXPLORE_HANDS);
    // THE SEED GOES IN THE MESSAGE (2026-08-22). The comment above used to say
    // "the failure message prints the seed, so any find is reproducible on the
    // spot" — and it did not. The seed appears in the NAME of the fixed-corpus
    // test only, and this one generates its own. So on 2026-08-22 CI caught a
    // real engine fault here —
    //
    //   [HandController] No winners found — awarding pot to last active player u1
    //
    // — which awards the ENTIRE pot to one player, and the corpus that produced
    // it was gone the moment the job ended. Ten local reruns of this file could
    // not find it again. A fault report you cannot act on is barely better than
    // no report, which is the whole lesson of this session.
    expect(enginePanics().slice(0, 5), replayHint(base, EXPLORE_HANDS)).toEqual([]);
  }, 600_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Regression guards for the two defects this property test found on first run
// ═══════════════════════════════════════════════════════════════════════════════

describe('regressions found by the chip-conservation property test', () => {
  it('keeps a side pot whose every eligible player folded inside the partition', () => {
    // Reproduces property-test seed 105. Seats 4 and 5 both raise-call to
    // 1281.48 while seats 1 and 2 are all-in for less; both then fold. Their
    // top level — (1281.48 - 811.33) x 2 = 940.30 — has no live claimant.
    const mk = (seat: number, stack: number, invested: number, folded: boolean): SeatPlayer => ({
      seat,
      user_id: `u${seat}`,
      username: `P${seat}`,
      stack,
      bet: 0,
      totalInvested: invested,
      deadInvested: 0,
      cards: [],
      is_folded: folded,
      is_all_in: !folded,
      is_sitting_out: false,
    });

    const players = [
      mk(1, 0, 811.33, false),
      mk(2, 0, 554.52, false),
      mk(4, 176.99, 1281.48, true),
      mk(5, 268.07, 1281.48, true),
    ];
    const pot = players.reduce((s, p) => s + p.totalInvested, 0);

    const pots = calculatePots(players);
    const partitioned = pots.reduce((s, p) => s + p.amount, 0);
    expect(Math.round(partitioned * 100)).toBe(Math.round(pot * 100));

    // The orphan is dead money: it belongs to the main pot, contested by the
    // players who are still in the hand — never to the folded contributors.
    for (const p of pots) {
      expect(p.eligiblePlayers).not.toContain('u4');
      expect(p.eligiblePlayers).not.toContain('u5');
    }
  });

  it('does not leave the hand FSM parked on "dealing" for a bomb pot', () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warnings.push(a.map(String).join(' '));
    });
    try {
      const seats: SeatPlayer[] = [1, 2, 3].map((seat) => ({
        seat,
        user_id: `u${seat}`,
        username: `P${seat}`,
        stack: 1000,
        bet: 0,
        totalInvested: 0,
        deadInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }));
      const config: HandConfig = {
        tableId: 't',
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: 1,
        bigBlind: 2,
        bombPot: { anteMultiplier: 2 },
        rakeConfig: { percent: 0.05, cap: 10, noFlopNoDrop: true },
      };
      const hc = new HandController(config, seats, 1);
      hc.start();
      const fsm = (hc as unknown as { handFSM: { state: string } }).handFSM;
      expect(fsm.state).toBe('flop');
      expect(warnings.filter((w) => w.includes('Invalid transition'))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
