import { runMatchup } from '../src/benchmark/HorseLeague.js';
for (const seed of [20260823, 555111]) {
  const r = await runMatchup({ name: 'v13_decision_fixes', a: {}, b: { v13: false } } as never, 25000, seed);
  const sig = Math.abs(r.bb100) > 2 * r.stderr ? 'SIGNIFICANT' : 'not resolved';
  console.log(`seed ${seed}: ${r.bb100.toFixed(2)} bb/100 (se ${r.stderr.toFixed(2)}) ${sig} hands=${r.hands} illegal=${r.illegalActions} trunc=${r.truncatedStreets}`);
}
