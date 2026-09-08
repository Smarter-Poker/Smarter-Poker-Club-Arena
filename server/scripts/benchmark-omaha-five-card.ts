// Run from server/: npx tsx scripts/benchmark-omaha-five-card.ts
// Diagnostic only: wall-clock speed is not a CI assertion.
import type { Card } from '../src/types.js';
import { RANKS, SUITS } from '../src/engine/PokerEngine.js';
import { scoreHoldem, scoreOmahaHi } from '../src/engine/HorseEval.js';

const deck: Card[] = RANKS.flatMap((rank) => SUITS.map((suit) => ({ rank, suit })));
const pairs: [number, number][] = [];
const triples: [number, number, number][] = [];
for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) pairs.push([a, b]);
for (let a = 0; a < 5; a++)
  for (let b = a + 1; b < 5; b++) for (let c = b + 1; c < 5; c++) triples.push([a, b, c]);
const scratch: Card[] = new Array(5);
function reference(hole: Card[], board: Card[]): number {
  let best = 0;
  for (const [a, b] of pairs) {
    scratch[0] = hole[a];
    scratch[1] = hole[b];
    for (const [x, y, z] of triples) {
      scratch[2] = board[x];
      scratch[3] = board[y];
      scratch[4] = board[z];
      best = Math.max(best, scoreHoldem(scratch, 5, false));
    }
  }
  return best;
}
let seed = 72319;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
const samples = Array.from({ length: 1000 }, () => {
  const indices = new Set<number>();
  while (indices.size < 11) indices.add(random() % 52);
  const cards = [...indices].map((i) => deck[i]);
  return { hole: cards.slice(0, 6), board: cards.slice(6) };
});
for (let pass = 0; pass < 4; pass++) {
  for (const [name, evaluate] of [
    ['reference', reference],
    ['optimized', scoreOmahaHi],
  ] as const) {
    let checksum = 0;
    const started = performance.now();
    for (let repeat = 0; repeat < 10; repeat++) {
      for (const sample of samples) checksum += evaluate(sample.hole, sample.board);
    }
    console.log(
      JSON.stringify({
        pass,
        name,
        evaluations: 10000,
        ms: Math.round(performance.now() - started),
        checksum,
      })
    );
  }
}
