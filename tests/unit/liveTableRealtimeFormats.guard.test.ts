import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { remainingObservationMs } from '../e2e/support/observationDeadline';
import { assertInitialTableOwnership } from '../e2e/support/initialTableOwnership';

const root = resolve(__dirname, '../..');
const spec = readFileSync(join(root, 'tests/e2e/production-live-table-realtime.spec.ts'), 'utf8');
const server = readFileSync(join(root, 'server/src/GameServer.ts'), 'utf8');

describe('the production realtime certificate covers every live-game lane', () => {
  it('finishes late cash invitations after engine readiness and before the View assertion', () => {
    const cash = spec.slice(spec.indexOf("test('an already-running table stays live"));
    const readiness = cash.indexOf('await proveTableProgressedBeforeNavigation(');
    const dismissal = cash.indexOf(
      'await prepareCashLobbyActions(page, { retainInvitationHandler: false });'
    );
    const visibility = cash.indexOf(').toBeVisible();');
    expect(readiness).toBeGreaterThan(-1);
    expect(dismissal).toBeGreaterThan(readiness);
    expect(visibility).toBeGreaterThan(dismissal);
    expect(cash.slice(dismissal, visibility)).toContain(
      'lost its visible read-only View/Watch Table or Game action'
    );
  });

  it('accepts the retained same-transport handoff before observation', () => {
    // Actual MTT and Spin requests in production run 35249791396. Both
    // handoffs preceded their presentation journal and causal observation.
    for (const [requests, observationStartedAt] of [
      [[1789664624353, 1789664625115], 1789664625935],
      [[1789664653161, 1789664653895], 1789664657850],
    ] as const) {
      expect(() =>
        assertInitialTableOwnership(
          requests.map((at) => ({ at, socketId: 1 })),
          1,
          observationStartedAt
        )
      ).not.toThrow();
    }
    expect(spec).toContain('assertInitialTableOwnership(');
    expect(spec).toContain('preOutageTransports[0]!');
  });

  it('rejects missing acquisition, competing transports and acquisition during gameplay', () => {
    expect(() => assertInitialTableOwnership([], 1, 100)).toThrow('no subscription request');
    expect(() => assertInitialTableOwnership([{ at: 10, socketId: 2 }], 1, 100)).toThrow(
      'crossed physical transports'
    );
    expect(() =>
      assertInitialTableOwnership(
        [
          { at: 10, socketId: 1 },
          { at: 20, socketId: 2 },
        ],
        1,
        100
      )
    ).toThrow('crossed physical transports');
    for (const at of [100, 101]) {
      expect(() =>
        assertInitialTableOwnership(
          [
            { at: 10, socketId: 1 },
            { at, socketId: 1 },
          ],
          1,
          100
        )
      ).toThrow('during the observed hand cycle');
    }
    expect(() => assertInitialTableOwnership([{ at: Number.NaN, socketId: 1 }], 1, 100)).toThrow(
      'invalid subscription timestamp'
    );
    expect(() => assertInitialTableOwnership([{ at: 10, socketId: 1 }], 1, Number.NaN)).toThrow(
      'exact observation and transport'
    );
  });

  it('keeps one finite case deadline across long hands and reconnect proof', () => {
    const startedAt = 1_000_000;
    const deadline = startedAt + 390_000;
    // A legal 102-second hand must not spend the reconnect phase's allowance
    // twice or create a fresh whole-case deadline.
    expect(remainingObservationMs(deadline, startedAt + 103_000)).toBe(287_000);
    expect(remainingObservationMs(deadline, startedAt + 200_000)).toBe(190_000);
    expect(() => remainingObservationMs(deadline, deadline)).toThrow('mandatory causal proof');
    expect(() => remainingObservationMs(deadline, deadline + 1)).toThrow('mandatory causal proof');
    expect(() => remainingObservationMs(Infinity, startedAt)).toThrow('mandatory causal proof');
  });

  it('runs MTT, Spin and Sit & Go through the same read-only WebKit contract', () => {
    expect(spec).toContain("const TOURNAMENT_FORMATS = ['mtt', 'spin', 'sng'] as const");
    expect(spec).toContain('certifyReadOnlyTournamentFormat(page, request, testInfo, gameFormat)');
    expect(spec).toContain('selectProgressingTournamentTable(request, gameFormat, testInfo)');
    expect(spec).toContain('journal.waitForCausalHandCycle(');
    expect(spec).toContain('expectNextHandPresentation(page, cycle');
    expect(spec).toContain('whileConnectionBannerStaysHidden(');
    const tournamentHelper = spec.slice(
      spec.indexOf('async function certifyReadOnlyTournamentFormat('),
      spec.indexOf("test.describe('production mobile WebKit live-table realtime continuity'")
    );
    expect(tournamentHelper).toContain('await context.setOffline(true)');
    expect(tournamentHelper).toContain('await context.setOffline(false)');
    expect(tournamentHelper).toContain('did not resubscribe after network restoration');
    expect(tournamentHelper).toContain('did not recover exactly one multiplexed transport');
    expect(tournamentHelper).toContain('const observationDeadline = Date.now() + testInfo.timeout');
    expect(tournamentHelper.match(/remainingObservationMs\(observationDeadline\)/g)).toHaveLength(
      2
    );
    expect(spec).toContain('const MAX_GAMEPLAY_SILENCE_MS = 45_000');
    expect(spec).toContain('test.setTimeout(300_000)');
    expect(spec).toContain('testInfo.setTimeout(testInfo.timeout + CAUSAL_HAND_TIMEOUT_MS)');
  });

  it('observes tournament routes directly and refuses participation mutations', () => {
    expect(spec).toContain('page.goto(`table/${candidate.id}`');
    expect(spec).toContain('isSpectatorParticipationMutation(');
    expect(spec).toContain("type: 'ACTION'");
    expect(spec).toContain('participationMutations,');
    expect(spec).toContain(').toEqual([]);');
  });

  it('gets only a public format category from engine health', () => {
    expect(server).toContain('gameFormat:');
    expect(server).toContain('tournamentDescriptorByTableId.get(id)');
    expect(server).toContain('manager.getPublicLiveTableFormat()');
    expect(spec).toContain('table.clubId === CLUB_ID');
  });
});
