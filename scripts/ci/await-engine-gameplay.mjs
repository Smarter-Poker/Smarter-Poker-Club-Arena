import { setTimeout as sleep } from 'node:timers/promises';
import { requireReadyEngineSha } from './production-e2e-provenance.mjs';

// One prerequisite inside the existing certification job, never a release retry.
// Allow the five-minute break, v3's release tail, and the 10.5-second resume spread.
// The September 18 release resumed 423.65 seconds after its break began.
export const GAMEPLAY_WAIT_MS = 8 * 60_000;
const POLL_MS = 5_000;

export function gameplayHasResumed(raw, expected) {
  requireReadyEngineSha(raw, expected);
  const { maintenance } = JSON.parse(raw);
  if (!maintenance || typeof maintenance.active !== 'boolean') {
    throw new Error('Engine health omitted authoritative maintenance state.');
  }
  if (maintenance.active) {
    if (!['last_hand', 'counting_down', 'finalizing'].includes(maintenance.phase)) {
      throw new Error('Engine health reported an unknown active maintenance phase.');
    }
    return false;
  }
  if (maintenance.phase !== 'idle') throw new Error('Engine maintenance is not idle.');
  const waves = maintenance.resumeWaves;
  if (waves == null) return true;
  if (
    !Number.isSafeInteger(waves.total) ||
    waves.total < 1 ||
    !Number.isSafeInteger(waves.done) ||
    waves.done < 0 ||
    waves.done > waves.total
  ) {
    throw new Error('Engine health reported invalid resume-wave progress.');
  }
  return waves.done === waves.total;
}

export async function awaitEngineGameplay(
  expected,
  {
    fetchImpl = fetch,
    now = () => performance.now(),
    pause = sleep,
    report = (message) => console.error(message),
  } = {}
) {
  if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error('Expected one full engine SHA.');
  const deadline = now() + GAMEPLAY_WAIT_MS;
  let announced = false;
  while (now() < deadline) {
    const response = await fetchImpl('https://engine.smarter.poker/health', {
      headers: { 'Cache-Control': 'no-store' },
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, Math.ceil(deadline - now())))),
    });
    if (!response.ok) throw new Error(`Engine health returned HTTP ${response.status}.`);
    const raw = await response.text();
    if (now() >= deadline) break;
    if (gameplayHasResumed(raw, expected)) return expected;
    if (!announced) {
      report('Waiting for this exact engine to finish maintenance and resume its tables.');
      announced = true;
    }
    await pause(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }
  throw new Error(
    'The exact engine did not resume gameplay within the eight-minute prerequisite budget.'
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.length !== 1) throw new Error('Usage: await-engine-gameplay.mjs <exact-engine-sha>');
    console.log(await awaitEngineGameplay(args[0]));
  })().catch((error) => {
    console.error(`[await-engine-gameplay] ${error.message}`);
    process.exitCode = 1;
  });
}
