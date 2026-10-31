import { runMatchup } from '../src/benchmark/HorseLeague.js';
const pairs = Number(process.argv[2] ?? 20000);
const tournament = (playersLeft: number, spotsPaid: number, stackBB: number) => ({
  gameMode: 'tournament' as const, format: 'mtt' as const, ante: 0,
  tournament: { schemaVersion: 1 as const, contextStatus: 'complete' as const, contextIssues: [], playersLeft, spotsPaid, entrants: 300, avgStackChips: stackBB * 2, medianStackChips: stackBB * 2, seatsPerTable: 6, nearBubble: false, inMoney: false, payoutPct: [30, 20, 14, 10, 8, 6, 4, 3, 3, 2], currentSmallBlind: 1, currentBigBlind: 2, currentAnte: 0, anteType: 'none' as const, nextSmallBlind: 2, nextBigBlind: 4, nextAnte: 0, nextBlindInMin: 10 },
});
for (const [depth, bump] of [[100, 0.06], [100, 0.12], [40, 0.06], [40, 0.12]] as const) {
  const card = { name: `mtt_flat_bump_${bump}_${depth}bb`, stackBB: depth, context: tournament(180, 30, depth), a: { tournamentFlatBump: bump }, b: {} };
  const r = await runMatchup(card as never, pairs, 2026103006);
  console.log(JSON.stringify({ name: card.name, bb100: +r.bb100.toFixed(2), stderr: +r.stderr.toFixed(2), divergentPairs: r.divergentPairs, inert: r.inert, illegal: r.illegalActions, minutes: +(r.durationMs / 60000).toFixed(1) }));
}
