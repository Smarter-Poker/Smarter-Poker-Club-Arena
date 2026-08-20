/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CHIP-CONSERVATION SOAK
 * ═══════════════════════════════════════════════════════════════════════════════
 * Long-running version of src/engine/ChipConservation.property.test.ts. The
 * vitest leg runs ~11,000 hands on every deploy (it has to stay inside the CI
 * budget); this runs however many you ask for and prints a coverage breakdown
 * so you can see WHAT was exercised, not just that nothing broke.
 *
 *     npm run soak                 # 100,000 hands from seed 1
 *     npm run soak -- 2000000      # 2,000,000 hands
 *     npm run soak -- 500000 9000000   # 500,000 hands starting at seed 9,000,000
 *
 * A failure prints the invariant, the seed, and a complete replay (config, hole
 * cards, board, every action) — reproduce a single hand with:
 *
 *     CHIP_CONSERVATION_SEED=<seed> CHIP_CONSERVATION_HANDS=1 \
 *       CHIP_CONSERVATION_EXPLORE=0 npx vitest run ChipConservation
 */

import { fuzzOneHand, ChipConservationError } from '../src/engine/HandFuzzer.js';

const N = Number(process.argv[2] ?? 100_000);
const START = Number(process.argv[3] ?? 1);

let ok = 0;
let checks = 0;
let actions = 0;
let showdowns = 0;
let runouts = 0;
let maxSide = 0;
let rakeTaken = 0;
const byInvariant: Record<string, number> = {};
const firstSeed: Record<string, number> = {};
const variants: Record<string, number> = {};
const seatCounts: Record<number, number> = {};
const firstFailures: string[] = [];

const t0 = Date.now();
for (let s = START; s < START + N; s++) {
  try {
    const r = fuzzOneHand(s);
    ok++;
    checks += r.checks;
    actions += r.actions;
    rakeTaken += r.rake + r.bbjFee;
    if (r.reachedShowdown) showdowns++;
    if (r.allInRunout) runouts++;
    if (r.sidePots > maxSide) maxSide = r.sidePots;
    variants[r.variant] = (variants[r.variant] ?? 0) + 1;
    seatCounts[r.players] = (seatCounts[r.players] ?? 0) + 1;
  } catch (err) {
    const key =
      err instanceof ChipConservationError
        ? err.invariant
        : `THROW:${(err as Error).message.split('\n')[0].slice(0, 80)}`;
    byInvariant[key] = (byInvariant[key] ?? 0) + 1;
    if (firstSeed[key] === undefined) {
      firstSeed[key] = s;
      if (firstFailures.length < 3) {
        firstFailures.push(`seed ${s}\n${(err as Error).message}`);
      }
    }
  }
  if (N >= 100_000 && (s - START + 1) % 100_000 === 0) {
    const failed = N - ok - (N - (s - START + 1));
    process.stdout.write(
      `  ... ${s - START + 1}/${N} hands, ${failed} failures, ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s\n`
    );
  }
}

const secs = (Date.now() - t0) / 1000;
const failed = N - ok;
console.log(
  `\nhands=${N} ok=${ok} FAIL=${failed}  ${secs.toFixed(1)}s  ` +
    `(${(N / secs).toFixed(0)} hands/s)`
);
console.log(
  `invariant checks=${checks}  actions=${actions}  showdowns=${showdowns}  ` +
    `allInRunouts=${runouts}  maxSidePots=${maxSide}  rake+bbj taken=${rakeTaken.toFixed(2)}`
);
console.log('variants:  ', JSON.stringify(variants));
console.log('seatCounts:', JSON.stringify(seatCounts));
if (failed > 0) {
  console.log('failures by invariant:', JSON.stringify(byInvariant, null, 1));
  console.log('first seed per invariant:', JSON.stringify(firstSeed, null, 1));
  for (const f of firstFailures) console.log('\n' + f);
  process.exit(1);
}
console.log('\nNo chip was created or destroyed.');
