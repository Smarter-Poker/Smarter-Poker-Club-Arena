import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), reportError: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));

import { StatsEvidenceService } from '../../src/services/StatsEvidenceService';

describe('StatsEvidenceService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the complete club-scoped keyset contract and clamps its page size', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        hands: [{ hand_id: 'hand-2' }],
        has_more: true,
        next_cursor: { played_at: '2026-10-03T10:00:00Z', hand_id: 'hand-2' },
        generated_at: '2026-10-03T10:01:00Z',
      },
      error: null,
    });

    const page = await StatsEvidenceService.list(
      'user-1',
      'chips',
      'club-1',
      { showdown: true, outcome: 'won', handClass: 'AA', cashMetric: 'three_bet' },
      { played_at: '2026-10-03T11:00:00Z', hand_id: 'hand-3' },
      999
    );

    expect(mocks.rpc).toHaveBeenCalledWith('ca_player_stats_hand_evidence', {
      p_user: 'user-1',
      p_club_id: 'club-1',
      p_asset: 'chips',
      p_variant: null,
      p_position: null,
      p_big_blind: null,
      p_from: null,
      p_to: null,
      p_outcome: 'won',
      p_showdown: true,
      p_all_in: null,
      p_big_pots: null,
      p_noted: null,
      p_hand_class: 'AA',
      p_tournament: null,
      p_cash_metric: 'three_bet',
      p_cash_session_id: null,
      p_cursor_played_at: '2026-10-03T11:00:00Z',
      p_cursor_hand_id: 'hand-3',
      p_limit: 100,
    });
    expect(page).toMatchObject({ has_more: true, next_cursor: { hand_id: 'hand-2' } });
  });

  it('uses the dedicated owner-only cash-session evidence contract', async () => {
    mocks.rpc.mockResolvedValue({
      data: { hands: [{ hand_id: 'hand-1' }], has_more: false, next_cursor: null },
      error: null,
    });
    await StatsEvidenceService.listCashSession(
      'user-1',
      '11111111-1111-4111-8111-111111111111',
      { played_at: '2026-10-03T11:00:00Z', hand_id: 'hand-2' },
      500
    );
    expect(mocks.rpc).toHaveBeenCalledWith('ca_player_stats_hand_evidence', {
      p_user: 'user-1',
      p_club_id: null,
      p_asset: 'chips',
      p_variant: null,
      p_position: null,
      p_big_blind: null,
      p_from: null,
      p_to: null,
      p_outcome: null,
      p_showdown: null,
      p_all_in: null,
      p_big_pots: null,
      p_noted: null,
      p_hand_class: null,
      p_tournament: null,
      p_cash_metric: null,
      p_cash_session_id: '11111111-1111-4111-8111-111111111111',
      p_cursor_played_at: '2026-10-03T11:00:00Z',
      p_cursor_hand_id: 'hand-2',
      p_limit: 100,
    });
  });
});
