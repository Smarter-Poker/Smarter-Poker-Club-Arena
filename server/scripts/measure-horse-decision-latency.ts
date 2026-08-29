/**
 * HOW LONG DOES A HORSE TAKE TO THINK?
 *
 *     npx tsx scripts/measure-horse-decision-latency.ts
 *
 * Dan 2026-08-29 asked how long a horse takes to identify its hand, read the
 * board, read the table and choose a play. Nothing in the engine could answer
 * it: the decision carried a documented "<15ms" budget and no timer.
 *
 * `horse_decision_latency` now answers it from PRODUCTION, which is the number
 * that matters. This script answers it on demand, offline, per variant and per
 * street, which is the number you want when you have just changed the brain
 * and do not want to wait a day to find out what it cost.
 *
 * It calls the real HorseLogic.decide — the same single synchronous call the
 * live engine makes, containing hand strength, board texture, the opponent
 * model, blockers, ICM, the Monte Carlo equity run, every version layer and
 * the final sizing. There is no partial measurement here; the whole read is
 * inside that call.
 */
import { HorseLogic } from '../src/engine/HorseLogic.js';

const VARIANTS: Array<{ variant: string; hole: number }> = [
  { variant: 'nlh', hole: 2 },
  { variant: 'short_deck', hole: 2 },
  { variant: 'pineapple', hole: 3 },
  { variant: 'plo4', hole: 4 },
  { variant: 'plo5', hole: 5 },
  { variant: 'plo6', hole: 6 },
  { variant: 'plo8', hole: 4 },
];

const STREETS: Array<{ stage: string; board: number }> = [
  { stage: 'preflop', board: 0 },
  { stage: 'flop', board: 3 },
  { stage: 'turn', board: 4 },
  { stage: 'river', board: 5 },
];

// A card is an OBJECT here, not a string. The evaluator's cardKey() reads
// `c.rank` and `c.suit[0]`, so a string card throws inside the Monte Carlo -
// and HorseLogic catches it, returns a tidy check/fold, and the timing you get
// back is the timing of the CATCH. Two orders of magnitude too fast, reported
// as if it were the brain. That is the exact shape of confident-wrong-number
// this exercise exists to stop, so the script refuses to print a cell that threw.
type Card = { rank: string; suit: string };

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];

/** Short deck really is a different deck: 36 cards, no 2 through 5. */
function ranksFor(variant: string): string[] {
  return variant === 'short_deck'
    ? ['6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
    : ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
}

/** A deterministic deck walk, so two runs of the script are comparable. */
function makeDeck(seed: number, variant: string): Card[] {
  const cards: Card[] = [];
  for (const suit of SUITS) for (const rank of ranksFor(variant)) cards.push({ rank, suit });
  // Fisher-Yates with a small LCG rather than Math.random: the point of the
  // script is to compare runs, and a different shuffle each time would make
  // small regressions unreadable.
  let x = seed >>> 0;
  const next = () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function buildCase(
  variant: string,
  hole: number,
  board: number,
  stage: string,
  seed: number,
  seats: number
) {
  const deck = makeDeck(seed, variant);
  let k = 0;
  const players = Array.from({ length: seats }, (_, i) => ({
    seat: i,
    user_id: `horse-${seed}-${i}`,
    stack: 200,
    bet: 0,
    folded: false,
    allIn: false,
    cards: Array.from({ length: hole }, () => deck[k++]),
    is_horse: true,
  }));
  const community = Array.from({ length: board }, () => deck[k++]);
  return {
    hero: players[0],
    gs: {
      players,
      communityCards: community,
      pot: stage === 'preflop' ? 3 : 24,
      currentBet: stage === 'preflop' ? 2 : 8,
      minRaise: stage === 'preflop' ? 4 : 16,
      stage,
      gameVariant: variant,
      bigBlind: 2,
      dealerSeat: 3,
      actionHistory: [],
      lastRaise: stage === 'preflop' ? 2 : 8,
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[i];
}

const ITERATIONS = Number(process.env.ITERATIONS ?? 400);

/**
 * Count the swallowed exceptions. HorseLogic.decide wraps everything in a
 * try/catch and degrades to check/fold, which means a case built wrong is
 * INVISIBLE in the return value and shows up only as a ~0.02ms timing that
 * looks like excellent news. Watching the error channel is the only way to
 * tell a fast decision from a decision that never happened.
 */
let threwHere = 0;
let skipped = 0;
const realConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (args.some((a) => String(a).includes('decide_threw'))) {
    threwHere++;
    return;
  }
  realConsoleError(...(args as []));
};

console.log(
  `\nHorse decision latency — ${ITERATIONS} live-shaped decisions per cell, real HorseLogic.decide\n`
);
console.log(
  ['variant', 'street', 'p50', 'p90', 'p99', 'max', 'mean'].map((h) => h.padEnd(11)).join('')
);
console.log('-'.repeat(77));

const worst: { label: string; ms: number } = { label: '', ms: 0 };
let grandTotal = 0;
let grandCount = 0;

for (const { variant, hole } of VARIANTS) {
  for (const { stage, board } of STREETS) {
    // Every card must come from one deck: short deck is 36 cards, and 6-card
    // PLO deals 6 to a seat, so the table has to shrink or the deal runs out
    // and the "measurement" times an exception instead of a decision.
    const deckSize = ranksFor(variant).length * 4;
    const seats = Math.max(2, Math.min(6, Math.floor((deckSize - 5 - 8) / hole)));

    const cases = Array.from({ length: 40 }, (_, i) =>
      buildCase(variant, hole, board, stage, i + 1, seats)
    );

    // A decision that THREW is not a fast decision. HorseLogic catches its own
    // errors and degrades to check/fold, so a broken case reports ~0.02ms and
    // looks like a triumph. The catch is invisible from the return value - it
    // hands back a perfectly well-formed check/fold - so the only way to see it
    // is the error report it writes on the way past.
    threwHere = 0;
    for (const c of cases) HorseLogic.decide(c.hero as never, c.gs as never, 'balanced');
    if (threwHere > 0) {
      console.log(
        `${variant.padEnd(11)}${stage.padEnd(11)}SKIPPED - ${threwHere}/${cases.length} decisions threw; the timing would be the catch, not the brain`
      );
      skipped++;
      continue;
    }

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const c = cases[i % cases.length];
      const t = performance.now();
      HorseLogic.decide(c.hero as never, c.gs as never, 'balanced');
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const max = samples[samples.length - 1];
    grandTotal += samples.reduce((a, b) => a + b, 0);
    grandCount += samples.length;
    if (max > worst.ms) ((worst.ms = max), (worst.label = `${variant} ${stage}`));

    console.log(
      [
        variant,
        stage,
        percentile(samples, 0.5).toFixed(3),
        percentile(samples, 0.9).toFixed(3),
        percentile(samples, 0.99).toFixed(3),
        max.toFixed(3),
        mean.toFixed(3),
      ]
        .map((c) => String(c).padEnd(11))
        .join('')
    );
  }
}

console.log('-'.repeat(77));
console.log(
  `mean across every variant and street: ${(grandTotal / grandCount).toFixed(3)}ms over ${grandCount} decisions`
);
console.log(`slowest single decision: ${worst.ms.toFixed(3)}ms (${worst.label})`);
console.log(`\nThe documented budget is 15ms. Production numbers, which are the ones that`);
console.log(`matter, are in horse_decision_latency (day, scope).\n`);
