import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import { StatsCashSessionService } from '../../src/services/StatsCashSessionService';

const payload = {
  contract_version: 2,
  scope: {
    target_user_id: 'u1',
    club_id: 'c1',
    asset: 'chips',
    range_days: 30,
    range_tz: 'UTC',
    visibility: 'owner',
  },
  coverage: {
    source: 'cash_player_session+ca_hand_facts',
    total_sessions: 0,
    returned_sessions: 0,
    capped: false,
  },
  sessions: [],
  generated_at: '2026-10-03T00:00:00Z',
};
describe('StatsCashSessionService', () => {
  beforeEach(() => rpc.mockReset());
  it('sends the complete owner scope and clamps the page bound', async () => {
    rpc.mockResolvedValue({ data: payload, error: null });
    await StatsCashSessionService.get('u1', 'c1', 30, 'UTC', 'chips', 999);
    expect(rpc).toHaveBeenCalledWith('ca_player_stats_cash_sessions', {
      p_user: 'u1',
      p_club_id: 'c1',
      p_days: 30,
      p_tz: 'UTC',
      p_asset: 'chips',
      p_limit: 250,
    });
  });
  it('rejects a payload from another scope', async () => {
    rpc.mockResolvedValue({
      data: { ...payload, scope: { ...payload.scope, club_id: 'c2' } },
      error: null,
    });
    await expect(StatsCashSessionService.get('u1', 'c1', 30, 'UTC', 'chips')).rejects.toThrow(
      'Scope Mismatch'
    );
  });
});
