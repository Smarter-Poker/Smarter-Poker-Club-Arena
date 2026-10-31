import { runMatchup } from '../src/benchmark/HorseLeague.js';
const cards = [
  { name: 'nlh_v62_100bb', a: {}, b: { v62RiverBettorPolarity: false } },
  { name: 'nlh_v62_40bb', stackBB: 40, a: {}, b: { v62RiverBettorPolarity: false } },
  { name: 'nlh_v62_200bb', stackBB: 200, a: {}, b: { v62RiverBettorPolarity: false } },
  { name: 'nlh_v61_only_no_v62', a: { v62RiverBettorPolarity: false }, b: { v61RiverOnePairShade: false, v62RiverBettorPolarity: false } },
  { name: 'nlh_v60', a: {}, b: { v60CashPressure: false } },
] as const;
const pairs = Number(process.argv[2] ?? 20000);
const seed = Number(process.argv[3] ?? 2026103003);
for (const card of cards) {
  const r = await runMatchup(card as never, pairs, seed);
  console.log(JSON.stringify({ name: card.name, hands: r.hands, bb100: +r.bb100.toFixed(2), stderr: +r.stderr.toFixed(2), divergentPairs: r.divergentPairs, inert: r.inert, minutes: +(r.durationMs / 60000).toFixed(1) }));
}
