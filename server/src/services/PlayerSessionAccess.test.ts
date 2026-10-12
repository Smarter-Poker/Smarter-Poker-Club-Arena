import { describe, expect, it, vi } from 'vitest';
const events = vi.hoisted(() => ({
  status: null as null | ((status: string) => void),
  row: null as null | ((payload: unknown) => void),
  remove: vi.fn(),
}));
vi.mock('./supabase.js', () => ({
  supabase: {
    channel: () => {
      const channel = {
        on: (_kind: string, _filter: unknown, cb: typeof events.row) => {
          events.row = cb;
          return channel;
        },
        subscribe: (cb: typeof events.status) => {
          events.status = cb;
          return channel;
        },
      };
      return channel;
    },
    removeChannel: events.remove,
  },
}));
import {
  playerSessionVerdict,
  tokenSessionId,
  subscribePlayerSessionRevocations,
} from './PlayerSessionAccess.js';
const sessionId = '11111111-1111-4111-8111-111111111111';
const token = `header.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.signature`;
describe('player session grants', () => {
  it('extracts only a valid session claim from already verified tokens', () => {
    expect(tokenSessionId(token)).toBe(sessionId);
    expect(tokenSessionId('malformed')).toBeNull();
  });
  it('checks every request and accepts a new valid session after revocation', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    expect(await playerSessionVerdict('player', token, { rpc })).toBe('alive');
    expect(await playerSessionVerdict('player', token, { rpc })).toBe('revoked');
    expect(await playerSessionVerdict('player', token, { rpc })).toBe('alive');
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenCalledWith('fn_ca_player_session_live', {
      p_user_id: 'player',
      p_session_id: sessionId,
    });
  });
  it('cannot mistake backend failure for revoked or alive', async () => {
    expect(
      await playerSessionVerdict('player', token, {
        rpc: vi.fn().mockRejectedValue(new Error('offline')),
      })
    ).toBe('unknown');
    expect(
      await playerSessionVerdict('player', token, {
        rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      })
    ).toBe('unknown');
  });
});

describe('original revocation subscription recovery', () => {
  it('runs once per subscribed generation and invalidates old callbacks on disconnect/disposal', () => {
    const recover = vi.fn(),
      revoke = vi.fn();
    const dispose = subscribePlayerSessionRevocations(revoke, recover);
    events.status!('SUBSCRIBED');
    events.status!('SUBSCRIBED');
    expect(recover).toHaveBeenCalledTimes(1);
    const first = recover.mock.calls[0][0];
    expect(first()).toBe(true);
    events.status!('CHANNEL_ERROR');
    expect(first()).toBe(false);
    events.status!('SUBSCRIBED');
    expect(recover).toHaveBeenCalledTimes(2);
    const second = recover.mock.calls[1][0];
    expect(second()).toBe(true);
    events.row!({ new: { user_id: 'target' } });
    expect(revoke).toHaveBeenCalledWith('target');
    dispose();
    expect(second()).toBe(false);
    events.status!('SUBSCRIBED');
    events.row!({ new: { user_id: 'late' } });
    expect(recover).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(events.remove).toHaveBeenCalledTimes(1);
  });
});
