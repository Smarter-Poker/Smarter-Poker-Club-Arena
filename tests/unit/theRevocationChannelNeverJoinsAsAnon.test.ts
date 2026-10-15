import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installPlayerSessionRevocationEvents,
  REVOCATION_CHANNEL_RETRY_MS,
  type RevocationRealtimeClient,
} from '../../src/lib/sessionRevoked';

/**
 * 2026-10-15: production logged "invalid column for filter user_id" about 300
 * times an hour, around the clock. The player-session-control channel joined
 * with no user token (bound from localStorage, or kept bound after the session
 * could not be refreshed), so Realtime evaluated it as `anon`, which holds no
 * column privilege on ca_player_session_revocations, and realtime-js re-joined
 * every ten seconds for as long as the tab stayed open.
 */
type Session = { access_token?: string | null; user?: { id?: string | null } | null } | null;

function fakeClient(liveSession: Session = null) {
  const joined: string[] = [];
  const removed: unknown[] = [];
  const statusCallbacks: Array<(status: string) => void> = [];
  let authCb: ((event: string, session: Session) => void) | null = null;
  const client: RevocationRealtimeClient = {
    channel(name: string) {
      return {
        on() {
          return {
            subscribe(cb?: (status: string) => void) {
              joined.push(name);
              if (cb) statusCallbacks.push(cb);
              return { name };
            },
          };
        },
      };
    },
    removeChannel(channel: unknown) {
      removed.push(channel);
      return Promise.resolve();
    },
    auth: {
      getSession: () => Promise.resolve({ data: { session: liveSession } }),
      onAuthStateChange(cb) {
        authCb = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };
  return {
    client,
    joined,
    removed,
    statusCallbacks,
    emit: async (event: string, session: Session) => {
      authCb?.(event, session);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('the revocation channel never joins as anon', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.setItem(
      'smarter-poker-auth',
      JSON.stringify({ user: { id: 'stale-user' }, access_token: 'expired' })
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('does not bind from the user id left in localStorage', async () => {
    const f = fakeClient();
    const stop = installPlayerSessionRevocationEvents(() => Promise.resolve(f.client));
    await flush();
    expect(f.joined).toEqual([]);
    await f.emit('INITIAL_SESSION', null);
    expect(f.joined).toEqual([]);
    stop();
  });

  it('binds only a session that carries a token, once per user', async () => {
    const f = fakeClient();
    const stop = installPlayerSessionRevocationEvents(() => Promise.resolve(f.client));
    await flush();
    await f.emit('INITIAL_SESSION', { user: { id: 'u1' }, access_token: null });
    expect(f.joined).toEqual([]);
    await f.emit('SIGNED_IN', { user: { id: 'u1' }, access_token: 't1' });
    await f.emit('TOKEN_REFRESHED', { user: { id: 'u1' }, access_token: 't2' });
    expect(f.joined).toEqual(['player-session-control:u1']);
    stop();
  });

  it('a refused join is removed, not retried every ten seconds', async () => {
    const f = fakeClient(null);
    const stop = installPlayerSessionRevocationEvents(() => Promise.resolve(f.client));
    await flush();
    await f.emit('INITIAL_SESSION', { user: { id: 'u1' }, access_token: 't1' });
    f.statusCallbacks[0]('CHANNEL_ERROR');
    f.statusCallbacks[0]('CHANNEL_ERROR');
    expect(f.removed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(REVOCATION_CHANNEL_RETRY_MS * 5);
    await flush();
    // GoTrue has no live session for this tab, so nothing re-joins.
    expect(f.joined).toEqual(['player-session-control:u1']);
    stop();
  });

  it('re-joins after a refusal once GoTrue returns a live session', async () => {
    const f = fakeClient({ user: { id: 'u1' }, access_token: 'fresh' });
    const stop = installPlayerSessionRevocationEvents(() => Promise.resolve(f.client));
    await flush();
    await f.emit('INITIAL_SESSION', { user: { id: 'u1' }, access_token: 't1' });
    f.statusCallbacks[0]('CHANNEL_ERROR');
    await vi.advanceTimersByTimeAsync(REVOCATION_CHANNEL_RETRY_MS);
    await flush();
    expect(f.joined).toEqual(['player-session-control:u1', 'player-session-control:u1']);
    stop();
  });

  it('signing out removes the channel', async () => {
    const f = fakeClient();
    const stop = installPlayerSessionRevocationEvents(() => Promise.resolve(f.client));
    await flush();
    await f.emit('SIGNED_IN', { user: { id: 'u1' }, access_token: 't1' });
    await f.emit('SIGNED_OUT', null);
    expect(f.removed).toHaveLength(1);
    stop();
  });
});
