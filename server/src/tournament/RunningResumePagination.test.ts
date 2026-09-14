import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
import { RunningResumeCooldowns } from '../tournamentResumeBudget.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
beforeEach(() => vi.mocked(reportError).mockClear());
afterEach(() => vi.restoreAllMocks());
const row = (id: string, started_at: string | null = '2026-09-14T10:00:00Z') => ({
  id,
  name: id,
  started_at,
});
const firstPage = () =>
  Array.from({ length: 1000 }, (_, i) => row(`a${String(i).padStart(4, '0')}`));

function harness(rows: ReturnType<typeof row>[]) {
  const server = Object.create(GameServer.prototype) as any;
  let running = true;
  const pages: Array<{ cursor: string | null; limit: number; order: string; select: string }> = [];
  const response = vi.fn((cursor: string | null) => ({
    data: rows.filter((r) => !cursor || r.id > cursor).slice(0, 1000),
    error: null as unknown,
  }));
  vi.spyOn(supabase, 'from').mockImplementation(() => {
    let cursor: string | null = null,
      limit = 0,
      order = '',
      select = '';
    const query = {
      select: (value: string) => {
        select = value;
        return query;
      },
      eq: () => query,
      gt: (key: string, value: string) => {
        expect(key).toBe('id');
        cursor = value;
        return query;
      },
      order: (value: string) => {
        order = value;
        return query;
      },
      limit: (value: number) => {
        limit = value;
        return query;
      },
      then: (resolve: (value: unknown) => unknown) => {
        pages.push({ cursor, limit, order, select });
        return Promise.resolve(response(cursor)).then(resolve);
      },
    };
    return query as never;
  });
  Object.assign(server, {
    lifecycleGeneration: 1,
    tournamentEngines: new Map(),
    tournamentManagerAdmissionOperations: new Map(),
    tournamentManagerAdmissionRetryTimers: new Map(),
    tournamentResumesInFlight: new Map(),
    tournamentResumeCooldowns: new RunningResumeCooldowns(),
    tournamentResumeDistress: 0,
    tournamentResumeBudget: 2,
    discoveryJobs: new Set(),
    directAdmissionIsCurrent: (g: number) => running && g === server.lifecycleGeneration,
    sleep: vi.fn(async (ms: number) => {
      if (ms === 5000) running = false;
    }),
    ensureTournamentManagerAdmission: vi.fn((id: string) => {
      const pending = new Promise<void>(() => {});
      server.tournamentManagerAdmissionOperations.set(id, pending);
      return pending;
    }),
  });
  return {
    server,
    pages,
    response,
    admitted: () => server.ensureTournamentManagerAdmission.mock.calls.map((c: unknown[]) => c[0]),
  };
}

describe('actual RUNNING discovery reads the complete recovery board', () => {
  it.each([false, true])(
    'retains recovery history when a null page has no error, later=%s',
    async (later) => {
      const { server, response, admitted } = harness([]);
      server.tournamentResumeCooldowns.recordFailure('still-unresolved', Date.now());
      const settle = vi.spyOn(server.tournamentResumeCooldowns, 'settle');
      response.mockImplementation((cursor) => ({
        data: (later && !cursor ? firstPage() : null) as any,
        error: null,
      }));
      await server.discoverRunningResumes();
      expect(admitted()).toEqual([]);
      expect(settle).not.toHaveBeenCalled();
      expect(server.tournamentResumeCooldowns.coolingDown('still-unresolved', Date.now())).toBe(
        true
      );
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        'GameServer.running_board_read_failed'
      );
    }
  );

  it('offers the managerless tail beyond the first 1000 rows to the same admission authority', async () => {
    const first = firstPage();
    const { server, pages, admitted } = harness([...first, row('z-union', '2026-09-14T10:36:46Z')]);
    first.forEach((r) => server.tournamentEngines.set(r.id, {}));
    await server.discoverRunningResumes();
    expect(admitted()).toEqual(['z-union']);
    expect(pages.map(({ cursor, limit, order }) => ({ cursor, limit, order }))).toEqual([
      { cursor: null, limit: 1000, order: 'id' },
      { cursor: 'a0999', limit: 1000, order: 'id' },
    ]);
    expect(server.ensureTournamentManagerAdmission).toHaveBeenCalledWith(
      'z-union',
      'resume',
      expect.any(String),
      1
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it('orders the full board by oldest start, with deterministic ties and null starts last', async () => {
    const { server, admitted } = harness([
      row('a-null', null),
      row('b-new', '2026-09-14T10:30:00Z'),
      row('c-old'),
      row('d-old'),
    ]);
    server.tournamentResumeBudget = 4;
    await server.discoverRunningResumes();
    expect(admitted()).toEqual(['c-old', 'd-old', 'b-new', 'a-null']);
  });

  it('selects an older event on a later id page before spending the admission budget', async () => {
    const { server, admitted } = harness([...firstPage(), row('z-old', '2026-09-13T00:00:00Z')]);
    server.tournamentResumeBudget = 1;
    await server.discoverRunningResumes();
    expect(admitted()).toEqual(['z-old']);
  });

  it('does not forget the failure streak of an event beyond the first page', async () => {
    const { server, admitted } = harness([...firstPage(), row('z-cooling')]);
    server.tournamentResumeCooldowns.recordFailure('z-cooling', Date.now());
    await server.discoverRunningResumes();
    expect(server.tournamentResumeCooldowns.coolingDown('z-cooling', Date.now())).toBe(true);
    expect(admitted()).not.toContain('z-cooling');
  });

  it('cannot settle cooldowns or admit from a partial board when a later page fails', async () => {
    const { server, response, admitted } = harness(firstPage());
    server.tournamentResumeBudget = 20;
    const settle = vi.spyOn(server.tournamentResumeCooldowns, 'settle');
    response.mockImplementation((cursor) => ({
      data: cursor ? [] : firstPage(),
      error: cursor ? new Error('offline') : null,
    }));
    await server.discoverRunningResumes();
    expect(admitted()).toEqual([]);
    expect(settle).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'GameServer.running_board_read_failed'
    );
    expect(server.tournamentResumeBudget).toBe(10);
  });

  it.each(['missing id', 'empty id', 'invalid start'])(
    'refuses a malformed %s as unknown',
    async (kind) => {
      const bad = row('bad');
      if (kind === 'missing id') (bad as any).id = null;
      else if (kind === 'empty id') bad.id = '';
      else bad.started_at = 'not-a-date';
      const { server, admitted } = harness([bad]);
      const settle = vi.spyOn(server.tournamentResumeCooldowns, 'settle');
      await server.discoverRunningResumes();
      expect(admitted()).toEqual([]);
      expect(settle).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalled();
    }
  );

  it('does not settle or admit when its generation retires during the read', async () => {
    const { server, response, admitted } = harness([row('event')]);
    const settle = vi.spyOn(server.tournamentResumeCooldowns, 'settle');
    response.mockImplementation(() => {
      server.lifecycleGeneration++;
      return { data: [row('event')], error: null };
    });
    await server.discoverRunningResumes();
    expect(admitted()).toEqual([]);
    expect(settle).not.toHaveBeenCalled();
  });

  it('rechecks retirement after the stagger before offering another event', async () => {
    const { server, admitted } = harness([row('first'), row('second')]);
    server.sleep.mockImplementation(async (ms: number) => {
      if (ms !== 5000) server.lifecycleGeneration++;
    });
    await server.discoverRunningResumes();
    expect(admitted()).toEqual(['first']);
  });

  it('preserves inflight and retry capacity without cancelling pending operations', async () => {
    const { server, admitted } = harness([row('pending'), row('retry'), row('ready')]);
    const pending = new Promise<void>(() => {});
    server.tournamentManagerAdmissionOperations.set('pending', pending);
    server.tournamentResumesInFlight.set('pending', Date.now());
    server.tournamentManagerAdmissionRetryTimers.set('retry', {});
    await server.discoverRunningResumes();
    expect(admitted()).toEqual([]);
    expect(server.tournamentManagerAdmissionOperations.get('pending')).toBe(pending);
    expect(server.tournamentManagerAdmissionRetryTimers.has('retry')).toBe(true);
  });

  it('settles an actually empty complete board without offering an admission', async () => {
    const { server, admitted } = harness([]);
    server.tournamentResumeCooldowns.recordFailure('departed', Date.now());
    await server.discoverRunningResumes();
    expect(admitted()).toEqual([]);
    expect(server.tournamentResumeCooldowns.size).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('requires an empty final page when the board has exactly 1000 rows', async () => {
    const { server, pages } = harness(firstPage());
    await server.discoverRunningResumes();
    expect(pages.map((p) => p.cursor)).toEqual([null, 'a0999']);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('refuses a board at the bounded ceiling instead of forgetting its unknown tail', async () => {
    const { server, response, pages, admitted } = harness([]);
    response.mockImplementation((cursor) => {
      const first = cursor ? Number(cursor.slice(1)) + 1 : 0;
      return {
        data: Array.from({ length: 1000 }, (_, i) => row(`r${String(first + i).padStart(6, '0')}`)),
        error: null,
      };
    });
    const settle = vi.spyOn(server.tournamentResumeCooldowns, 'settle');
    await server.discoverRunningResumes();
    expect(pages).toHaveLength(50);
    expect(admitted()).toEqual([]);
    expect(settle).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'GameServer.runningResumes.row_ceiling'
    );
  });

  it('cannot use a final page delivered to a retired generation', async () => {
    const { server, response, pages, admitted } = harness(firstPage());
    response.mockImplementation((cursor) => {
      if (cursor) server.lifecycleGeneration++;
      return { data: cursor ? [row('z-tail')] : firstPage(), error: null };
    });
    const settle = vi.spyOn(server.tournamentResumeCooldowns, 'settle');
    await server.discoverRunningResumes();
    expect(pages).toHaveLength(2);
    expect(admitted()).toEqual([]);
    expect(settle).not.toHaveBeenCalled();
  });
});
