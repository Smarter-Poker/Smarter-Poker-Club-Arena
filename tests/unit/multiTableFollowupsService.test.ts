/**
 * MULTI-TABLE FOLLOW-UPS (2026-10-04), item 4, against the REAL service.
 *
 * `getTournaments` answers [] for a failed read, which is the right default
 * for a lobby and the wrong answer for a caller that must tell "none" from
 * "unreadable". `{ throwOnError: true }` is that caller's option, the same one
 * `getTournament` already takes.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ listError: { message: 'statement timeout' } as unknown }));

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): unknown => {
    const handler: ProxyHandler<object> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle') return async () => ({ data: null, error: null });
        if (prop === 'then') {
          return (ok: (v: unknown) => void) => ok({ data: null, error: h.listError });
        }
        return () => new Proxy({}, handler);
      },
    };
    return new Proxy({}, handler);
  };
  return {
    getAuthUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }),
    supabase: { from: () => buildChain(), rpc: vi.fn() },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { tournamentService } from '../../src/services/TournamentService';
import { reportError } from '../../src/utils/errorReporter';

describe('TournamentService.getTournaments on a failed read', () => {
  it('still answers [] and reports by default', async () => {
    await expect(tournamentService.getTournaments('club-1')).resolves.toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      h.listError,
      'TournamentService.Error_fetching_tournaments'
    );
  });

  it('throws the read error when asked to', async () => {
    await expect(tournamentService.getTournaments('club-1', { throwOnError: true })).rejects.toBe(
      h.listError
    );
  });
});
