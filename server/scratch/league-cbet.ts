import { runMatchup } from '../src/benchmark/HorseLeague.js';
const pairs = Number(process.argv[2] ?? 20000);
const arms: Record<string, [number, number]> = { half: [0.5, 0.6], twothirds: [0.66, 0.75], tiny: [0.2, 0.25] };
for (const [label, r] of Object.entries(arms)) {
  const card = { name: `cbet_${label}_100bb`, a: { cbetSizeFrac: r }, b: {} };
  const res = await runMatchup(card as never, pairs, 2026103005);
  console.log(JSON.stringify({ name: card.name, bb100: +res.bb100.toFixed(2), stderr: +res.stderr.toFixed(2), divergentPairs: res.divergentPairs, minutes: +(res.durationMs / 60000).toFixed(1) }));
}
