import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const response = () =>
  new Response('[]', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('shared Supabase Data API actor transport', () => {
  it('marks both bounded clients as service outside manager authority', async () => {
    const seen: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        seen.push(headers);
        return response();
      })
    );

    const { supabase, maintenanceSupabase } = await import('./client.js');
    await supabase.from('tournaments').select('id').limit(1);
    await maintenanceSupabase.from('maintenance_breaks').select('id').limit(1);

    expect(seen).toHaveLength(2);
    for (const headers of seen) {
      expect(headers.get('x-smarter-data-actor')).toBe('service');
      expect(headers.get('x-smarter-data-protocol')).toBe('1');
      expect(headers.has('x-smarter-tournament-id')).toBe(false);
      expect(headers.has('x-smarter-tournament-lease-generation')).toBe(false);
      expect(headers.has('authorization')).toBe(true);
    }
  });

  it('stamps manager authority at the actual fetch boundary', async () => {
    const seen: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        seen.push(headers);
        return response();
      })
    );

    const [{ supabase }, { runWithTournamentDataAuthority }] = await Promise.all([
      import('./client.js'),
      import('./dataActorContext.js'),
    ]);
    const tournamentId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const leaseGeneration = 'bbbbbbbb-0000-4000-8000-000000000001';

    await runWithTournamentDataAuthority({ tournamentId, leaseGeneration }, () =>
      supabase.from('tournament_players').update({ chips: 5000 }).eq('tournament_id', tournamentId)
    );
    await supabase.from('tables').select('id').limit(1);

    expect(seen).toHaveLength(2);
    expect(seen[0].get('x-smarter-data-actor')).toBe('tournament-manager');
    expect(seen[0].get('x-smarter-data-protocol')).toBe('2');
    expect(seen[0].get('x-smarter-tournament-id')).toBe(tournamentId);
    expect(seen[0].get('x-smarter-tournament-lease-generation')).toBe(leaseGeneration);
    expect(seen[1].get('x-smarter-data-actor')).toBe('service');
    expect(seen[1].has('x-smarter-tournament-id')).toBe(false);
    expect(seen[1].has('x-smarter-tournament-lease-generation')).toBe(false);
  });

  it('keeps external manager and child-engine callbacks out of service authority', async () => {
    const seen: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        seen.push(headers);
        return response();
      })
    );

    const [{ supabase }, { bindTournamentDataAuthorityMethods }] = await Promise.all([
      import('./client.js'),
      import('./dataActorContext.js'),
    ]);
    const authority = {
      tournamentId: 'aaaaaaaa-0000-4000-8000-000000000001',
      leaseGeneration: 'bbbbbbbb-0000-4000-8000-000000000001',
    };

    class PublishedOwner {
      constructor(readonly relation: 'tournaments' | 'table_seats') {}

      externalDatabaseCallback() {
        return supabase.from(this.relation).update({ updated_at: new Date(0).toISOString() });
      }
    }

    const publishedManager = bindTournamentDataAuthorityMethods(
      authority,
      new PublishedOwner('tournaments')
    );
    const publishedChildEngine = bindTournamentDataAuthorityMethods(
      authority,
      new PublishedOwner('table_seats')
    );

    // Both calls begin outside any manager-created async chain, exactly like a
    // GameServer/WebSocket callback on an already-published owner.
    await publishedManager.externalDatabaseCallback();
    await publishedChildEngine.externalDatabaseCallback();

    expect(seen).toHaveLength(2);
    for (const headers of seen) {
      expect(headers.get('x-smarter-data-actor')).toBe('tournament-manager');
      expect(headers.get('x-smarter-data-protocol')).toBe('2');
      expect(headers.get('x-smarter-tournament-id')).toBe(authority.tournamentId);
      expect(headers.get('x-smarter-tournament-lease-generation')).toBe(authority.leaseGeneration);
    }
  });

  it('detaches the upstream abort listener after a completed request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response())
    );
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');

    const { supabase } = await import('./client.js');
    await supabase.from('tournaments').select('id').limit(1).abortSignal(controller.signal);

    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    const forwarded = add.mock.calls.find(([event]) => event === 'abort')?.[1];
    expect(remove).toHaveBeenCalledWith('abort', forwarded);
  });

  it('keeps the hard deadline active until the response body reaches EOF', async () => {
    vi.stubEnv('SUPABASE_TIMEOUT_MS', '10');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('['));
            signal?.addEventListener(
              'abort',
              () => controller.error(signal.reason ?? new Error('supabase_timeout')),
              { once: true }
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    const { supabase } = await import('./client.js');
    const { error } = await supabase.from('tournaments').select('id').limit(1);

    expect(error?.message).toContain('supabase_timeout');
  });

  it('refuses an already-aborted upstream signal before fetch without retaining a listener', async () => {
    const seen: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.signal) seen.push(init.signal);
        return response();
      })
    );
    const controller = new AbortController();
    const reason = new Error('caller_cancelled');
    controller.abort(reason);
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');

    const { supabase } = await import('./client.js');
    const { error } = await supabase
      .from('tournaments')
      .select('id')
      .limit(1)
      .abortSignal(controller.signal);

    expect(seen).toHaveLength(0);
    expect(error?.message).toContain('caller_cancelled');
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
