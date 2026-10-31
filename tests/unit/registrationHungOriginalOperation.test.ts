import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockEmit,
  mockRpc,
  mockUuid,
  formatProjection,
  mockTournamentUpdate,
  mockRoster,
  mockFresh,
  mockNudge,
  signals,
} = vi.hoisted(() => ({
  mockRoster: vi.fn(),
  mockFresh: vi.fn((row) => ({ data: row, error: null })),
  mockNudge: vi.fn(() => ({ data: null, error: null })),
  signals: [] as AbortSignal[],
  mockEmit: vi.fn(),
  mockRpc: vi.fn(),
  mockUuid: vi.fn(),
  formatProjection: {} as Record<string, unknown>,
  mockTournamentUpdate: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => {
  const tournament = {
    id: 'tournament-1',
    name: 'Sunday Major',
    club_id: 'club-1',
    status: 'REGISTERING',
    current_players: 1,
    max_players: 100,
    variant: 'mtt',
    format_contract: 'mtt-v1',
  };
  const player = {
    id: 'registration-1',
    tournament_id: 'tournament-1',
    user_id: 'user-1',
    username: 'Player',
    status: 'registered',
    table_id: 'table-1',
  };

  const chain = (row: unknown): any => {
    let fresh = false;
    let update = false;
    const query: any = {
      select: vi.fn((columns: string) => {
        fresh = columns.startsWith('current_players,');
        return query;
      }),
      abortSignal: vi.fn((signal: AbortSignal) => {
        signals.push(signal);
        return query;
      }),
      eq: vi.fn(() => query),
      update: vi.fn((patch) => {
        update = true;
        mockTournamentUpdate(patch);
        return query;
      }),
      maybeSingle: vi.fn(async () =>
        (row as any)?.id === 'registration-1'
          ? mockRoster(row)
          : fresh
            ? mockFresh(row)
            : { data: row, error: null }
      ),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(update ? mockNudge() : { data: row, error: null }).then(resolve),
    };
    return query;
  };

  return {
    getAuthUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    supabase: {
      rpc: (...args: unknown[]) => {
        const result = Promise.resolve(mockRpc(...args));
        return Object.assign(result, {
          abortSignal: (signal: AbortSignal) => {
            signals.push(signal);
            return result;
          },
        });
      },
      from: vi.fn((table: string) =>
        chain(
          table === 'tournaments'
            ? { ...tournament, ...formatProjection }
            : table === 'tournament_players'
              ? player
              : null
        )
      ),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: mockEmit, subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('club-1'),
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

vi.mock('../../src/utils/uuid', () => ({ uuid: mockUuid }));

import { tournamentService } from '../../src/services/TournamentService';

beforeEach(() => {
  signals.length = 0;
  mockFresh.mockImplementation((row) => ({ data: row, error: null }));
  mockNudge.mockImplementation(() => ({ data: null, error: null }));
  for (const key of Object.keys(formatProjection)) delete formatProjection[key];
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('navigator', {
    locks: { request: (_key: string, fn: () => Promise<unknown>) => fn() },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

import { createServer, get, type ServerResponse } from 'node:http';
function transportRead(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve(JSON.parse(body)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

// Real local HTTP transport, actual TournamentService and persisted intent owner.
// Only the Supabase endpoint routing and unrelated UI dependencies are adapters.
describe('registration original operation under a held HTTP response', () => {
  it.each(['admission', 'roster'])(
    'retains the same operation while %s response is hung',
    async (stage) => {
      mockEmit.mockReset();
      mockRpc.mockReset();
      mockUuid.mockReset();
      mockUuid.mockReturnValue('00000000-0000-4000-8000-000000000001');
      let held: ServerResponse | undefined;
      let observed!: () => void;
      const arrived = new Promise<void>((resolve) => {
        observed = resolve;
      });
      let charges = 0;
      let admissions = 0;
      let holdNext = true;
      const underlyingReads: Promise<unknown>[] = [];
      const receipt = {
        ok: true,
        registration_id: 'registration-1',
        request_id: '00000000-0000-4000-8000-000000000001',
        tournament_id: 'tournament-1',
        user_id: 'user-1',
      };
      const roster = { id: 'registration-1', tournament_id: 'tournament-1', user_id: 'user-1' };
      const server = createServer((request, response) => {
        if (request.url === '/admission') {
          admissions++;
          if (admissions === 1) charges++;
        }
        response.setHeader('content-type', 'application/json');
        if (holdNext && request.url === '/' + stage) {
          holdNext = false;
          held = response;
          observed();
          return;
        }
        response.end(
          JSON.stringify({ data: request.url === '/admission' ? receipt : roster, error: null })
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as { port: number };
      const base = 'http://127.0.0.1:' + address.port;
      const request = (path: string) => {
        const read = transportRead(base + path);
        underlyingReads.push(read);
        return read;
      };
      mockRpc.mockImplementation(() => request('/admission'));
      mockRoster.mockImplementation(() => request('/roster'));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let settled = false;
      const first = tournamentService.registerPlayer('tournament-1', 'user-1', 'Player');
      void first.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      try {
        await arrived;
        const key = 'ca:tournament-unregister:v1:user-1:registration:tournament-1';
        const original = localStorage.getItem(key);
        expect(JSON.parse(original!).state).toBe('pending');
        const repeated = tournamentService.registerPlayer('tournament-1', 'user-1', 'Player');
        const outcomes = Promise.allSettled([first, repeated]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(settled).toBe(true);
        expect(admissions).toBe(1);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(localStorage.getItem(key)).toBe(original);
        expect(mockEmit).not.toHaveBeenCalledWith('TOURNAMENT_REGISTERED', expect.anything());
        vi.useRealTimers();
        held!.end(JSON.stringify({ data: stage === 'admission' ? receipt : roster, error: null }));
        expect(await outcomes).toEqual([
          {
            status: 'rejected',
            reason: expect.objectContaining({
              message: expect.stringContaining('Could Not Confirm'),
            }),
          },
          {
            status: 'rejected',
            reason: expect.objectContaining({
              message: expect.stringContaining('Could Not Confirm'),
            }),
          },
        ]);
        await Promise.all(underlyingReads);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(mockEmit).not.toHaveBeenCalledWith('TOURNAMENT_REGISTERED', expect.anything());
        expect(charges).toBe(1);
        expect(JSON.parse(localStorage.getItem(key)!).state).toBe('pending');
        expect(mockUuid).toHaveBeenCalledTimes(1);
        // An explicit subsequent user request releases the retired in-memory slot
        // and reads the same idempotent operation, never a new payment identity.
        const recovered = await tournamentService.registerPlayer(
          'tournament-1',
          'user-1',
          'Player'
        );
        expect(recovered.id).toBe('registration-1');
        expect(mockRpc).toHaveBeenCalledTimes(2);
        expect(mockRpc.mock.calls[1]).toEqual(mockRpc.mock.calls[0]);
        expect(charges).toBe(1);
        expect(mockUuid).toHaveBeenCalledTimes(1);
        expect(JSON.parse(localStorage.getItem(key)!).state).toBe('resolved');
        expect(
          mockEmit.mock.calls.filter(([event]) => event === 'TOURNAMENT_REGISTERED')
        ).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        if (held && !held.writableEnded)
          held.end(JSON.stringify({ data: stage === 'admission' ? receipt : roster, error: null }));
        await Promise.allSettled([first, ...underlyingReads]);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});

describe('confirmed registration survives optional start nudge transport loss', () => {
  it.each(['mtt-v1', 'sng-v1', 'spin-v1', 'seat-first-satellite-v1'])(
    'returns the verified roster after a hung fresh read for %s',
    async (format) => {
      vi.useFakeTimers();
      mockEmit.mockReset();
      mockRpc.mockReset();
      mockTournamentUpdate.mockReset();
      mockUuid.mockReturnValue('00000000-0000-4000-8000-000000000001');
      Object.assign(formatProjection, {
        format_contract: format,
        current_players: 3,
        max_players: 3,
      });
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          registration_id: 'registration-1',
          request_id: '00000000-0000-4000-8000-000000000001',
          tournament_id: 'tournament-1',
          user_id: 'user-1',
        },
        error: null,
      });
      mockRoster.mockImplementation((row) => ({ data: row, error: null }));
      let release!: (value: any) => void;
      mockFresh.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }) as any
      );
      const registration = tournamentService.registerPlayer('tournament-1', 'user-1', 'Player');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(registration).resolves.toMatchObject({ id: 'registration-1' });
      expect(
        JSON.parse(
          localStorage.getItem('ca:tournament-unregister:v1:user-1:registration:tournament-1')!
        ).state
      ).toBe('resolved');
      release({ data: { ...formatProjection }, error: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockTournamentUpdate).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(
        mockEmit.mock.calls.filter(([event]) => event === 'TOURNAMENT_REGISTERED')
      ).toHaveLength(1);
    }
  );
  it.each(['sng-v1', 'spin-v1', 'seat-first-satellite-v1'])(
    'returns the verified roster when the %s nudge response is lost',
    async (format) => {
      vi.useFakeTimers();
      mockEmit.mockReset();
      mockRpc.mockReset();
      mockTournamentUpdate.mockReset();
      mockUuid.mockReturnValue('00000000-0000-4000-8000-000000000001');
      Object.assign(formatProjection, {
        format_contract: format,
        current_players: 3,
        max_players: 3,
      });
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          registration_id: 'registration-1',
          request_id: '00000000-0000-4000-8000-000000000001',
          tournament_id: 'tournament-1',
          user_id: 'user-1',
        },
        error: null,
      });
      mockRoster.mockImplementation((row) => ({ data: row, error: null }));
      let release!: (value: any) => void;
      mockNudge.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }) as any
      );
      const registration = tournamentService.registerPlayer('tournament-1', 'user-1', 'Player');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(registration).resolves.toMatchObject({ id: 'registration-1' });
      expect(
        JSON.parse(
          localStorage.getItem('ca:tournament-unregister:v1:user-1:registration:tournament-1')!
        ).state
      ).toBe('resolved');
      expect(mockTournamentUpdate).toHaveBeenCalledTimes(1);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      release({ data: null, error: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockTournamentUpdate).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(
        mockEmit.mock.calls.filter(([event]) => event === 'TOURNAMENT_REGISTERED')
      ).toHaveLength(1);
    }
  );
});
