import { runMatchup } from '../src/benchmark/HorseLeague.js';
const cards = [
  { name: 'nlh_v62_river_polarity', a: {}, b: { v62RiverBettorPolarity: false } },
  { name: 'nlh_v61_river_shade', a: {}, b: { v61RiverOnePairShade: false } },
  { name: 'nlh_v61_v62_both', a: {}, b: { v61RiverOnePairShade: false, v62RiverBettorPolarity: false } },
  { name: 'nlh_v60_cash_pressure', a: {}, b: { v60CashPressure: false } },
  { name: 'nlh_v62_40bb', stackBB: 40, a: {}, b: { v62RiverBettorPolarity: false } },
  { name: 'nlh_v62_hu', seats: 2, a: {}, b: { v62RiverBettorPolarity: false } },
] as const;
const pairs = Number(process.argv[2] ?? 3000);
const seed = Number(process.argv[3] ?? 2026103001);
for (const card of cards) {
  const r = await runMatchup(card as never, pairs, seed);
  console.log(JSON.stringify({ name: card.name, hands: r.hands, bb100: +r.bb100.toFixed(2), stderr: +r.stderr.toFixed(2), divergentPairs: r.divergentPairs, inert: r.inert, illegal: r.illegalActions, truncated: r.truncatedStreets, minutes: +(r.durationMs / 60000).toFixed(1) }));
}
