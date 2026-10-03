import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, rows } = vi.hoisted(() => ({
  rpc: vi.fn(),
  rows: {} as Record<string, unknown[]>,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc,
    from: (table: string) => ({
      select: () => ({
        order: async () => ({ data: rows[table] ?? [], error: null }),
        maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }),
      }),
    }),
  },
}));

vi.mock('../../src/services/HandNotesService', () => ({
  handNotesService: {
    listFor: vi.fn(
      async () =>
        new Map([
          ['hand-1', { handId: 'hand-1', note: 'Review River', tags: ['study'], updatedAt: null }],
        ])
    ),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { statsWorkspaceService } from '../../src/services/StatsWorkspaceService';

beforeEach(() => {
  rpc.mockReset();
  for (const key of Object.keys(rows)) delete rows[key];
});

describe('StatsWorkspaceService', () => {
  it('loads only RLS-scoped tables and enriches study hands from HandNotesService', async () => {
    rows.ca_stats_workspace_collections = [
      { id: 'collection-1', name: 'River Calls', description: '', updated_at: 'now' },
    ];
    rows.ca_stats_workspace_collection_hands = [
      { collection_id: 'collection-1', hand_id: 'hand-1', added_at: 'now' },
    ];
    rows.ca_stats_workspace_preferences = [
      { dashboard_layout: ['overview'], privacy_presentation_mode: true },
    ];
    const result = await statsWorkspaceService.load();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.collections[0].hands[0].note?.tags).toEqual(['study']);
      expect(result.data.preferences.privacyPresentationMode).toBe(true);
    }
  });

  it('saves immutable-provenance reports without accepting a user id', async () => {
    rpc.mockResolvedValue({ data: 'report-1', error: null });
    const result = await statsWorkspaceService.saveReport({
      idempotencyKey: 'range-30-rules-v1',
      title: 'Opening Review',
      sourceKind: 'rule_derived',
      sourceVersion: 'rules-v1',
      evidence: [{ handId: 'hand-1' }],
    });
    expect(result).toEqual({ ok: true, data: 'report-1' });
    expect(rpc).toHaveBeenCalledWith('fn_ca_stats_workspace_report_save', {
      p_idempotency_key: 'range-30-rules-v1',
      p_title: 'Opening Review',
      p_source_kind: 'rule_derived',
      p_source_version: 'rules-v1',
      p_body: {},
      p_evidence: [{ handId: 'hand-1' }],
      p_club_id: null,
      p_range_days: null,
    });
    expect(JSON.stringify(rpc.mock.calls[0])).not.toMatch(/user[_-]?id/i);
  });

  it('returns an explicit failure instead of optimistic success', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('idempotency_conflict') });
    const result = await statsWorkspaceService.saveReport({
      idempotencyKey: 'same-key',
      title: 'Changed',
      sourceKind: 'player_authored',
      sourceVersion: 'player-v1',
    });
    expect(result).toEqual({ ok: false, error: 'idempotency_conflict' });
  });
});
