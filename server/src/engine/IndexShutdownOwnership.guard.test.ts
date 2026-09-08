import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const INDEX = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

function windowBetween(start: string, end: string): string {
  const startAt = INDEX.indexOf(start);
  const endAt = INDEX.indexOf(end, startAt);
  expect(startAt, `${start} is missing`).toBeGreaterThan(-1);
  expect(endAt, `${end} is missing after ${start}`).toBeGreaterThan(startAt);
  return INDEX.slice(startAt, endAt);
}

describe('process shutdown has one ownership certificate', () => {
  it('registers every index-owned writer behind GameServer before listening', () => {
    const stop = windowBetween(
      'function stopLeaderOwnedServices()',
      'gameServer.registerExternalShutdownOwnershipBarrier(stopLeaderOwnedServices)'
    );
    const registrationAt = INDEX.indexOf(
      'gameServer.registerExternalShutdownOwnershipBarrier(stopLeaderOwnedServices)'
    );
    const listenAt = INDEX.indexOf('httpServer.listen(PORT');

    expect(registrationAt).toBeGreaterThan(-1);
    expect(registrationAt).toBeLessThan(listenAt);
    expect(stop).toContain('.then<LeaderStopResult, LeaderStopResult>(');
    expect(stop).toContain('const results = await Promise.all(stops)');
    expect(stop).toContain('throw new AggregateError(');
    for (const writer of [
      'HorseOverlayGuard',
      'HorseSessionRotator',
      'StableHandExecutor',
      'HorseSelfTuner',
      'HorseLeague',
      'HorseDailyAudit',
      'BrainTelemetryFlush',
      'HorseDataLedgerSync',
      'HorseLaneLoader',
      'GtoAggregationDriver',
      'GtoAggregationDriverV31',
      'HorseOnboardingBootSweep',
    ]) {
      expect(stop).toContain(`['${writer}',`);
    }
  });

  it('fences through GameServer even when startup has already rejected', () => {
    const shutdown = windowBetween('async function performShutdown()', 'const shutdown =');
    const startupObservation = shutdown.indexOf('const startupCompletion = leaderStartOperation');
    const ownershipStop = shutdown.indexOf('await gameServer.stop()');
    const startupJoin = shutdown.indexOf(
      'const localResults = await Promise.all([startupCompletion, ...localStops])'
    );

    expect(startupObservation).toBeGreaterThan(-1);
    expect(ownershipStop).toBeGreaterThan(startupObservation);
    expect(startupJoin).toBeGreaterThan(ownershipStop);
    expect(shutdown).not.toContain('await leaderStartOperation');
    expect(shutdown).not.toContain('stopLeaderOwnedServices()');
  });

  it('observes every transport and never reports a clean fatal exit', () => {
    const shutdown = windowBetween('async function performShutdown()', 'const shutdown =');
    const fatal = INDEX.slice(
      INDEX.indexOf('const fatal ='),
      INDEX.indexOf("process.on('uncaughtException'")
    );

    expect(shutdown).toContain("beginShutdownStep('HTTP server', closeHttpServer)");
    expect(shutdown).toContain("beginShutdownStep('table WebSocket server'");
    expect(shutdown).toContain("beginShutdownStep('channel WebSocket server'");
    expect(shutdown).toContain('process.exit(shutdownMustFail ? 1 : 0)');
    expect(fatal).toContain('shutdownMustFail = true');
    expect(fatal).toContain('void shutdown().catch(');
    expect(fatal).not.toMatch(/process\.exit\(0\)/);
  });
});
