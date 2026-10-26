import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReplacementSubjectClient, supabase } from './client.js';
import { runWithTournamentDataAuthority } from './dataActorContext.js';
import { registerTournamentManagerFenceHandler } from './tournamentManagerFence.js';

const url = process.env.SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
const authority = {
  tournamentId: '11111111-1111-4111-8111-111111111111',
  leaseGeneration: '22222222-2222-4222-8222-222222222222',
};
const reply = () =>
  new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('the original replacement subject uses the shared bounded client owner', () => {
  it('carries the original authenticated subject through Auth, ordinary join and local cleanup', async () => {
    const calls: Array<{ path: string; headers: Headers; scope: string | null }> = [];
    const user = { id: '33333333-3333-4333-8333-333333333333', aud: 'authenticated' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const target = new URL(String(input));
        calls.push({
          path: target.pathname,
          headers: new Headers(init.headers),
          scope: target.searchParams.get('scope'),
        });
        const payload =
          target.pathname === '/auth/v1/verify'
            ? {
                access_token: 'original-subject-token',
                token_type: 'bearer',
                expires_in: 3600,
                refresh_token: 'fixture-refresh',
                user,
              }
            : target.pathname === '/auth/v1/user'
              ? user
              : { ok: true };
        return new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    const subject = createReplacementSubjectClient(url);
    const login = await subject.auth.verifyOtp({
      token_hash: 'fixture-original-token',
      type: 'email',
    });
    expect(login.error).toBeNull();
    expect((await subject.auth.getUser()).data.user?.id).toBe(user.id);
    expect(
      (
        await subject.rpc('fn_join_club_atomic', {
          p_identifier: 'fixture',
          p_request_id: 'fixture-request',
        })
      ).error
    ).toBeNull();
    const beforeCleanup = calls.length;
    expect((await subject.auth.signOut({ scope: 'global' })).error?.message).toContain(
      'original_subject_request_boundary'
    );
    expect(calls).toHaveLength(beforeCleanup);
    expect((await subject.auth.signOut({ scope: 'local' })).error).toBeNull();
    expect(calls.map((call) => call.path)).toEqual([
      '/auth/v1/verify',
      '/auth/v1/user',
      '/rest/v1/rpc/fn_join_club_atomic',
      '/auth/v1/logout',
    ]);
    for (const call of calls.slice(1)) {
      expect(call.headers.get('authorization')).toBe('Bearer original-subject-token');
      expect(call.headers.has('x-smarter-data-actor')).toBe(false);
    }
    expect(calls.at(-1)!.scope).toBe('local');
  });

  it('keeps ordinary player traffic unmarked even inside a manager context', async () => {
    const calls: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        calls.push(new Headers(init.headers));
        return reply();
      })
    );
    const subject = createReplacementSubjectClient(url);
    const result = await runWithTournamentDataAuthority(authority, () =>
      subject.rpc('fn_join_club_atomic', {
        p_identifier: 'fixture',
        p_request_id: 'fixture-request',
      })
    );
    expect(result.error).toBeNull();
    expect(calls).toHaveLength(1);
    for (const name of [
      'x-smarter-data-actor',
      'x-smarter-data-protocol',
      'x-smarter-tournament-id',
      'x-smarter-tournament-lease-generation',
    ])
      expect(calls[0]!.has(name)).toBe(false);
    expect(calls[0]!.get('apikey')).toMatch(/^sb_publishable_/);
  });

  it('refuses every other Data API path before making a request', async () => {
    const transport = vi.fn(async () => reply());
    vi.stubGlobal('fetch', transport);
    const subject = createReplacementSubjectClient(url);
    for (const pending of [subject.rpc('fn_admin_probe'), subject.from('profiles').select('id')]) {
      const result = await pending;
      expect(result.error?.message).toContain('original_subject_request_boundary');
    }
    expect(transport).not.toHaveBeenCalled();
    expect(() => createReplacementSubjectClient('https://different.invalid')).toThrow(
      'original_subject_configuration_mismatch'
    );
  });

  it('retains actor authority on the ordinary shared service client', async () => {
    const calls: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        calls.push(new Headers(init.headers));
        return reply();
      })
    );
    await runWithTournamentDataAuthority(authority, () => supabase.rpc('fn_fixture_probe'));
    expect(calls[0]!.get('x-smarter-data-actor')).toBe('tournament-manager');
    expect(calls[0]!.get('x-smarter-tournament-id')).toBe(authority.tournamentId);
    expect(calls[0]!.get('x-smarter-tournament-lease-generation')).toBe(authority.leaseGeneration);
  });

  it('never turns a player response into a manager withdrawal', async () => {
    const fenced = vi.fn();
    const unregister = registerTournamentManagerFenceHandler(authority, fenced);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"message":"TOURNAMENT_MANAGER_FENCED"}', {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
    try {
      const subject = createReplacementSubjectClient(url);
      await runWithTournamentDataAuthority(authority, () => subject.rpc('fn_join_club_atomic'));
      expect(fenced).not.toHaveBeenCalled();
      await runWithTournamentDataAuthority(authority, () => supabase.rpc('fn_fixture_probe'));
      expect(fenced).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });
});
