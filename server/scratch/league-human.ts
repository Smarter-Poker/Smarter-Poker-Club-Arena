import { runMatchup, humanFieldTwin } from '../src/benchmark/HorseLeague.js';
const cards = [
  { name: 'nlh_v62_river_polarity', a: {}, b: { v62RiverBettorPolarity: false } },
  { name: 'nlh_v61_v62_both', a: {}, b: { v61RiverOnePairShade: false, v62RiverBettorPolarity: false } },
  { name: 'nlh_v60_cash_pressure', a: {}, b: { v60CashPressure: false } },
  { name: 'nlh_v61_only_no_v62', a: { v62RiverBettorPolarity: false }, b: { v61RiverOnePairShade: false, v62RiverBettorPolarity: false } },
] as const;
const pairs = Number(process.argv[2] ?? 12000);
const seed = Number(process.argv[3] ?? 2026103002);
for (const card of cards) {
  const twin = humanFieldTwin(card as never);
  const r = await runMatchup(twin, pairs, seed);
  console.log(JSON.stringify({ name: twin.name, hands: r.hands, bb100: +r.bb100.toFixed(2), stderr: +r.stderr.toFixed(2), divergentPairs: r.divergentPairs, inert: r.inert, illegal: r.illegalActions, truncated: r.truncatedStreets, minutes: +(r.durationMs / 60000).toFixed(1) }));
}
