import { runMatchup } from '../src/benchmark/HorseLeague.js';
const shares: Record<string, [number, number, number]> = {
  measured: [0.25, 0.22, 0.18],
  mid: [0.3, 0.27, 0.24],
  balanced: [0.35, 0.32, 0.29],
  wide: [0.42, 0.38, 0.34],
};
const depth = Number(process.argv[2] ?? 100);
const pairs = Number(process.argv[3] ?? 20000);
for (const [label, s] of Object.entries(shares)) {
  const card = { name: `v62_${label}_${depth}bb`, stackBB: depth, a: { v62RiverBettorPolarity: true, v62BluffShares: s }, b: { v62RiverBettorPolarity: false } };
  const r = await runMatchup(card as never, pairs, 2026103004);
  console.log(JSON.stringify({ name: card.name, bb100: +r.bb100.toFixed(2), stderr: +r.stderr.toFixed(2), divergentPairs: r.divergentPairs, minutes: +(r.durationMs / 60000).toFixed(1) }));
}
