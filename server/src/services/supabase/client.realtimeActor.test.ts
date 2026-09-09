import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabase, maintenanceSupabase } from './client.js';
import {
  bindTournamentDataAuthority,
  currentTournamentDataAuthority,
  runWithTournamentDataAuthority,
} from './dataActorContext.js';

const a = {
  tournamentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leaseGeneration: '11111111-1111-4111-8111-111111111111',
};
const b = {
  tournamentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  leaseGeneration: '22222222-2222-4222-8222-222222222222',
};
let serial = 0;
function channel(client = supabase) {
  // Exercise the installed SDK dispatcher without opening a real socket.
  return client.channel('actor-probe-' + ++serial) as ReturnType<typeof client.channel> & {
    _trigger(type: string, payload: unknown, ref?: string): void;
    _rejoin(timeout?: number): void;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('shared Realtime callbacks retain registration authority', () => {
  it.each([
    ['ordinary', supabase],
    ['maintenance', maintenanceSupabase],
  ] as const)(
    '%s client service callbacks can wake manager B when the shared socket belongs to A',
    (_name, client) => {
      const seen = vi.fn();
      const managerB = bindTournamentDataAuthority(b, () => {
        expect(currentTournamentDataAuthority()).toEqual(b);
        seen();
      });
      const c = channel(client);
      c.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tournament_bounty_obligations' },
        () => managerB()
      );
      expect(() =>
        runWithTournamentDataAuthority(a, () =>
          c._trigger('UPDATE', { new: { state: 'settled', tournament_id: b.tournamentId } })
        )
      ).not.toThrow();
      expect(seen).toHaveBeenCalledOnce();
      expect(currentTournamentDataAuthority()).toBeNull();
    }
  );

  it('a manager callback retains its own authority through async work and the HTTP boundary', async () => {
    const seen: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        seen.push(new Headers(init?.headers));
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      })
    );
    let work: Promise<void> = Promise.resolve();
    const c = channel();
    runWithTournamentDataAuthority(b, () =>
      c.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tournament_players' },
        () => {
          work = (async () => {
            expect(currentTournamentDataAuthority()).toEqual(b);
            await Promise.resolve();
            expect(currentTournamentDataAuthority()).toEqual(b);
            await supabase
              .from('tournament_players')
              .select('id')
              .eq('tournament_id', b.tournamentId);
          })();
        }
      )
    );
    runWithTournamentDataAuthority(a, () => c._trigger('UPDATE', { new: {} }));
    await work;
    expect(seen).toHaveLength(1);
    expect(seen[0].get('x-smarter-data-actor')).toBe('tournament-manager');
    expect(seen[0].get('x-smarter-tournament-id')).toBe(b.tournamentId);
    expect(seen[0].get('x-smarter-tournament-lease-generation')).toBe(b.leaseGeneration);
    expect(currentTournamentDataAuthority()).toBeNull();
  });

  it('each handler on one channel has its own context, not the first creator context', () => {
    const c = runWithTournamentDataAuthority(a, () => channel());
    const seen: unknown[] = [];
    c.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'tournament_manager_wakes' },
      () => seen.push(currentTournamentDataAuthority())
    );
    runWithTournamentDataAuthority(b, () =>
      c.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournament_manager_wakes' },
        () => seen.push(currentTournamentDataAuthority())
      )
    );
    runWithTournamentDataAuthority(a, () => c._trigger('INSERT', { new: {} }));
    expect(seen).toEqual([null, b]);
  });

  it.each(['broadcast', 'presence'] as const)('also restores %s handler context', (type) => {
    const c = channel();
    const seen = vi.fn();
    runWithTournamentDataAuthority(b, () =>
      (c.on as any)(type, { event: '*' }, () => seen(currentTournamentDataAuthority()))
    );
    runWithTournamentDataAuthority(a, () => c._trigger(type, { event: 'probe' }));
    expect(seen).toHaveBeenCalledWith(b);
  });

  it('does not permit a manager callback to rebind itself to another manager', () => {
    const c = channel();
    const refused = vi.fn();
    runWithTournamentDataAuthority(a, () =>
      c.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tournament_players' },
        () => {
          expect(() => runWithTournamentDataAuthority(b, () => {})).toThrow('cannot be rebound');
          refused();
        }
      )
    );
    c._trigger('UPDATE', { new: {} });
    expect(refused).toHaveBeenCalledOnce();
  });

  it.each(['phx_close', 'phx_error'] as const)(
    'service subscription status callback can dispatch manager B on %s from socket A',
    (event) => {
      vi.useFakeTimers();
      vi.spyOn(supabase.realtime, 'connect').mockImplementation(() => {});
      const c = channel();
      const rejoin = vi.spyOn(c, '_rejoin').mockImplementation(() => {});
      const seen = vi.fn();
      const managerB = bindTournamentDataAuthority(b, () => {
        expect(currentTournamentDataAuthority()).toEqual(b);
        seen();
      });
      expect(c.subscribe(() => managerB(), 1234)).toBe(c);
      expect(rejoin).toHaveBeenCalledWith(1234);
      expect(() =>
        runWithTournamentDataAuthority(a, () =>
          c._trigger(event, new Error('transport interrupted'))
        )
      ).not.toThrow();
      expect(seen).toHaveBeenCalledOnce();
      expect(currentTournamentDataAuthority()).toBeNull();
      vi.clearAllTimers();
    }
  );

  it('subscription status keeps a manager registration scoped to that manager', () => {
    vi.useFakeTimers();
    vi.spyOn(supabase.realtime, 'connect').mockImplementation(() => {});
    const c = channel();
    vi.spyOn(c, '_rejoin').mockImplementation(() => {});
    const seen = vi.fn();
    runWithTournamentDataAuthority(b, () =>
      c.subscribe((status, error) => {
        seen(status, error, currentTournamentDataAuthority());
      })
    );
    const error = new Error('transport interrupted');
    runWithTournamentDataAuthority(a, () => c._trigger('phx_error', error));
    expect(seen).toHaveBeenCalledWith('CHANNEL_ERROR', error, b);
    vi.clearAllTimers();
  });

  it('preserves subscribe without a callback', () => {
    vi.spyOn(supabase.realtime, 'connect').mockImplementation(() => {});
    const c = channel();
    const rejoin = vi.spyOn(c, '_rejoin').mockImplementation(() => {});
    expect(c.subscribe(undefined, 4321)).toBe(c);
    expect(rejoin).toHaveBeenCalledWith(4321);
    expect(() => c._trigger('phx_close', {})).not.toThrow();
  });
});
