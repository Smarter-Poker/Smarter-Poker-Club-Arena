import { runMatchup } from '../src/benchmark/HorseLeague.js';
const pairs = Number(process.argv[2] ?? 20000);
for (const depth of [200, 100, 40]) {
  const card = { name: `v62_bluffcatch_only_${depth}bb`, stackBB: depth, a: { v62RiverBettorPolarity: true, v62BluffCatchOnly: true }, b: { v62RiverBettorPolarity: false } };
  const r = await runMatchup(card as never, pairs, 2026103004);
  console.log(JSON.stringify({ name: card.name, bb100: +r.bb100.toFixed(2), stderr: +r.stderr.toFixed(2), divergentPairs: r.divergentPairs, minutes: +(r.durationMs / 60000).toFixed(1) }));
}
