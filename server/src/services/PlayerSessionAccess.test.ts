import { describe, expect, it, vi } from 'vitest';
vi.mock('./supabase.js', () => ({ supabase: {} }));
import { playerSessionVerdict, tokenSessionId } from './PlayerSessionAccess.js';
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
