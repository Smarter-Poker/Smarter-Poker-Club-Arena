import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setTournamentLeaseMonotonicNowForTests } from '../services/tournamentLease.js';
import type { GameServer } from '../GameServer.js';
import type { TournamentLifecycleToken } from './TournamentLifecycleEpoch.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import {
  isTournamentManagerFencedError,
  notifyTournamentManagerFenced,
  observeFenceInResponse,
  registeredTournamentManagerFenceHandlerCount,
  registerTournamentManagerFenceHandler,
} from '../services/supabase/tournamentManagerFence.js';
import { runWithTournamentDataAuthority } from '../services/supabase/dataActorContext.js';

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../services/errorReporter.js', () => ({ reportError: reportErrorMock }));

const TOURNAMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const GENERATION = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER_GENERATION = 'bbbbbbbb-0000-4000-8000-000000000099';
const FENCED_BODY = JSON.stringify({
  code: '42501',
  message: 'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current',
  details: null,
  hint: null,
});

function fencedResponse(status = 403, body = FENCED_BODY): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

class FencedManagerHarness extends TournamentManagerBase {
  constructor(deadline: number) {
    super(TOURNAMENT_ID, {} as GameServer, GENERATION, deadline);
  }

  activate(): void {
    (
      this as unknown as { lifecycleEpoch: { begin(): TournamentLifecycleToken } }
    ).lifecycleEpoch.begin();
    this.running = true;
    (this as unknown as { armTournamentLeaseExpiryTimer(): void }).armTournamentLeaseExpiryTimer();
  }

  rawRunning(): boolean {
    return this.running;
  }

  authorityIsCurrent(): boolean {
    return this.hasCurrentTournamentLeaseAuthority();
  }

  protected override startEliminationChecker(): void {}

  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

afterEach(() => {
  _setTournamentLeaseMonotonicNowForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  reportErrorMock.mockReset();
});

/**
 * 2026-09-10 05:15-05:56 UTC: 243 TOURNAMENT_MANAGER_FENCED refusals a minute
 * for forty minutes (about twenty managers, each on the five-second retry)
 * because nothing in the engine read the database's answer. A fenced manager
 * stands down; it does not retry.
 */
describe('a fenced manager stands down', () => {
  it('recognises the database fence in any error shape', () => {
    expect(
      isTournamentManagerFencedError({
        code: '42501',
        message: 'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current',
      })
    ).toBe(true);
    expect(isTournamentManagerFencedError(new Error('TOURNAMENT_MANAGER_FENCED: stale'))).toBe(
      true
    );
    expect(isTournamentManagerFencedError({ code: '42501', message: 'permission denied' })).toBe(
      false
    );
    expect(isTournamentManagerFencedError(null)).toBe(false);
  });

  it('delivers the fence only to the exact generation that made the request', () => {
    const before = registeredTournamentManagerFenceHandlerCount();
    const stoodDown = vi.fn();
    const unregister = registerTournamentManagerFenceHandler(
      { tournamentId: TOURNAMENT_ID, leaseGeneration: GENERATION },
      stoodDown
    );
    expect(registeredTournamentManagerFenceHandlerCount()).toBe(before + 1);

    expect(
      notifyTournamentManagerFenced({
        tournamentId: TOURNAMENT_ID,
        leaseGeneration: OTHER_GENERATION,
      })
    ).toBe(false);
    expect(stoodDown).not.toHaveBeenCalled();

    expect(notifyTournamentManagerFenced(null)).toBe(false);

    expect(
      notifyTournamentManagerFenced({ tournamentId: TOURNAMENT_ID, leaseGeneration: GENERATION })
    ).toBe(true);
    expect(stoodDown).toHaveBeenCalledTimes(1);
    // A fence is delivered once. The same generation asking again finds no
    // handler, so a burst of refused requests cannot stand the manager down
    // more than once.
    expect(
      notifyTournamentManagerFenced({ tournamentId: TOURNAMENT_ID, leaseGeneration: GENERATION })
    ).toBe(false);
    expect(stoodDown).toHaveBeenCalledTimes(1);
    unregister();
    expect(registeredTournamentManagerFenceHandlerCount()).toBe(before);
  });

  it('reads the fence off a 403 only inside the manager context that sent it', async () => {
    const stoodDown = vi.fn();
    const unregister = registerTournamentManagerFenceHandler(
      { tournamentId: TOURNAMENT_ID, leaseGeneration: GENERATION },
      stoodDown
    );
    try {
      // Service work is never fenced, whatever the body says.
      await observeFenceInResponse(fencedResponse());
      expect(stoodDown).not.toHaveBeenCalled();

      await runWithTournamentDataAuthority(
        { tournamentId: TOURNAMENT_ID, leaseGeneration: GENERATION },
        async () => {
          // Other 403s and unparseable bodies are somebody else's error.
          await observeFenceInResponse(
            fencedResponse(403, JSON.stringify({ code: '42501', message: 'permission denied' }))
          );
          await observeFenceInResponse(fencedResponse(403, 'not json'));
          await observeFenceInResponse(fencedResponse(500));
          expect(stoodDown).not.toHaveBeenCalled();

          const response = fencedResponse();
          await observeFenceInResponse(response);
          expect(stoodDown).toHaveBeenCalledTimes(1);
          // The caller still gets its own error: the body was only cloned.
          expect(await response.json()).toMatchObject({ code: '42501' });
        }
      );
    } finally {
      unregister();
    }
  });

  it('fences and tears the manager down once, without re-arming', async () => {
    vi.useFakeTimers();
    let now = 0;
    _setTournamentLeaseMonotonicNowForTests(() => now);
    const before = registeredTournamentManagerFenceHandlerCount();
    const manager = new FencedManagerHarness(60_000);
    manager.activate();
    expect(registeredTournamentManagerFenceHandlerCount()).toBe(before + 1);
    expect(manager.authorityIsCurrent()).toBe(true);

    now = 1_000;
    await runWithTournamentDataAuthority(
      { tournamentId: TOURNAMENT_ID, leaseGeneration: GENERATION },
      () => observeFenceInResponse(fencedResponse())
    );

    // Authority is gone synchronously (every continuation is fenced), the
    // manager is no longer running, and the registration is released.
    expect(manager.authorityIsCurrent()).toBe(false);
    expect(manager.rawRunning()).toBe(false);
    expect(registeredTournamentManagerFenceHandlerCount()).toBe(before);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('fenced by the database') }),
      'Tournament.manager_fenced_by_database'
    );

    // A second fence (a burst of refused requests) is a no-op, not a second
    // stand-down or a second report.
    manager.standDownForDatabaseFence();
    expect(
      reportErrorMock.mock.calls.filter(
        (call) => call[1] === 'Tournament.manager_fenced_by_database'
      )
    ).toHaveLength(1);

    // The proof deadline that would have kept it "current" no longer matters.
    now = 59_000;
    await vi.advanceTimersByTimeAsync(58_000);
    expect(manager.rawRunning()).toBe(false);
    await manager.stop();
  });
});
