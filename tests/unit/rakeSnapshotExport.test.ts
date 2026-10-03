import { describe, expect, it, vi } from 'vitest';
import type {
  RakeAgentRow,
  RakeClubRow,
  RakeDownlineRow,
  RakeScope,
} from '../../src/services/ClubRakeSnapshotService';
import type { ClubDataExportProgress, ClubDataExportRpc } from '../../src/utils/clubDataExport';
import {
  fetchRakeSnapshotExport,
  isRakeExportAuthorizationError,
  isRakeExportBusy,
  isRakeExportEntitlementChanged,
  isRakeExportUnavailable,
  RAKE_EXPORT_SEARCH_MAX_LENGTH,
  rakeSnapshotExportToCsv,
  type RakeExportMetadata,
} from '../../src/utils/rakeSnapshotExport';

const CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const UNION_ID = '5e9b975a-9530-40f6-a67e-36d8a2ef7b9f';
const VIEWER_ID = '2b1b6a4e-3a5c-4f9f-9c07-9d1f2a7c5e11';
const AGENT_ID = 'ee0dcc88-8c1a-4768-a5a7-b8f8a3c934f0';
const EXPORT_ID = '1d6c7fc3-9438-44d1-befe-aa4abc3992f5';
const GENERATED_AT = '2026-09-13T16:00:00.000Z';
const EXPIRES_AT = '2026-09-13T16:15:00.000Z';

function result(data: unknown, error: unknown = null) {
  return Promise.resolve({ data, error });
}

function agentRow(index: number): RakeAgentRow {
  return {
    agent_user_id: `agent-${index}`,
    name: `Agent ${index}`,
    avatar_url: null,
    role: 'agent',
    commission_rate: 0.4,
    direct_players: 1,
    direct_active: 1,
    direct_rake: index,
    direct_hands: index,
    network_players: 1,
    network_rake: index,
    sub_agents: 0,
    is_unassigned: false,
    commission_earned: index,
    commission_outstanding: 0,
    commission_settled: index,
    can_drill: true,
  };
}

function clubRow(index: number): RakeClubRow {
  return {
    club_id: `club-${index}`,
    name: `Club ${index}`,
    code: String(index),
    avatar_url: null,
    fee: index,
    cash_fee: index,
    mtt_fee: 0,
    winnings: index,
    hands: index,
    games: 1,
    can_drill: true,
  };
}

function downlineRow(index: number): RakeDownlineRow {
  return {
    player_id: `player-${index}`,
    name: `Player ${index}`,
    role: 'member',
    depth: 1,
    upline_user_id: AGENT_ID,
    upline_name: 'Agent',
    rake: index,
    hands: index,
    last_hand_at: GENERATED_AT,
    downline_players: 0,
    downline_rake: 0,
  };
}

function metadata(
  scope: RakeScope,
  overrides: Partial<RakeExportMetadata> = {}
): RakeExportMetadata {
  const scopeId = scope === 'union' ? UNION_ID : CLUB_ID;
  return {
    schema_version: 1,
    kind: 'rake',
    scope_type: scope,
    scope_id: scopeId,
    club_id: scope === 'union' ? null : CLUB_ID,
    union_id: scope === 'union' ? UNION_ID : null,
    agent_user_id: scope === 'agent' ? AGENT_ID : null,
    date_from: '2026-09-01',
    date_to: '2026-09-13',
    search: null,
    sort: 'rake',
    generated_at: GENERATED_AT,
    scope_label:
      scope === 'union' ? 'Diamond Union' : scope === 'agent' ? 'Agent Downline' : 'Shark Club',
    breakdown_kind: scope === 'union' ? 'club' : scope === 'club' ? 'agent' : 'downline',
    breakdown_total: 1234,
    commission_total: scope === 'club' ? 200 : null,
    contains_admin_commission: scope === 'club',
    ...overrides,
  };
}

function receipt(scope: RakeScope, totalRows: number, nextMetadata = metadata(scope)) {
  return {
    export_id: EXPORT_ID,
    status: 'ready',
    kind: 'rake',
    total_rows: totalRows,
    total_amount: nextMetadata.breakdown_total,
    expires_at: EXPIRES_AT,
    metadata: nextMetadata,
    metadata_fingerprint: 'fingerprint-1',
  };
}

function page(
  scope: RakeScope,
  rows: unknown[],
  totalRows: number,
  offset: number,
  nextMetadata = metadata(scope)
) {
  return {
    kind: 'rake',
    rows,
    total_rows: totalRows,
    next_offset: offset + rows.length,
    has_more: offset + rows.length < totalRows,
    expires_at: EXPIRES_AT,
    metadata: nextMetadata,
    metadata_fingerprint: 'fingerprint-1',
  };
}

describe('complete immutable Rake exports', () => {
  it('downloads all server rows beyond the interactive browse ceiling', async () => {
    const allRows = Array.from({ length: 1254 }, (_, index) => agentRow(index + 1));
    const progress: ClubDataExportProgress[] = [];
    const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
      if (name === 'ca_rake_export_start') return result(receipt('club', allRows.length));
      if (name === 'ca_club_data_export_page') {
        const offset = Number(args.p_offset);
        return result(
          page('club', allRows.slice(offset, offset + Number(args.p_limit)), 1254, offset)
        );
      }
      return result(true);
    }) as ClubDataExportRpc;

    const exported = await fetchRakeSnapshotExport({
      rpc,
      scope: 'club',
      scopeId: CLUB_ID,
      start: '2026-09-01',
      end: '2026-09-13',
      viewerUserId: VIEWER_ID,
      requestId: 'b0996711-4c20-477d-a5ee-323e5d75ca10',
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value),
    });

    expect(exported.rows).toHaveLength(1254);
    expect(exported.rows[1253]).toMatchObject({ agent_user_id: 'agent-1254' });
    expect(progress).toEqual([
      { stage: 'preparing', loaded: 0, total: null },
      { stage: 'downloading', loaded: 0, total: 1254 },
      { stage: 'downloading', loaded: 1000, total: 1254 },
      { stage: 'downloading', loaded: 1254, total: 1254 },
    ]);
    expect(rpc).toHaveBeenNthCalledWith(1, 'ca_rake_export_start', {
      p_scope_type: 'club',
      p_scope_id: CLUB_ID,
      p_start: '2026-09-01',
      p_end: '2026-09-13',
      p_agent_user_id: null,
      p_search: null,
      p_sort: 'rake',
      p_request_id: 'b0996711-4c20-477d-a5ee-323e5d75ca10',
    });
    expect(rpc).toHaveBeenLastCalledWith('ca_club_data_export_cancel', {
      p_export_id: EXPORT_ID,
    });
  });

  it.each([
    {
      scope: 'union' as const,
      scopeId: UNION_ID,
      agentUserId: null,
      rows: [clubRow(1)],
      expectedTarget: null,
    },
    {
      scope: 'agent' as const,
      scopeId: CLUB_ID,
      agentUserId: AGENT_ID,
      rows: [downlineRow(1)],
      expectedTarget: AGENT_ID,
    },
  ])('uses the exact $scope scope and delegated target arguments', async (entry) => {
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_rake_export_start') return result(receipt(entry.scope, 1));
      if (name === 'ca_club_data_export_page') return result(page(entry.scope, entry.rows, 1, 0));
      return result(true);
    }) as ClubDataExportRpc;

    await fetchRakeSnapshotExport({
      rpc,
      scope: entry.scope,
      scopeId: entry.scopeId,
      start: '2026-09-01',
      end: '2026-09-13',
      agentUserId: entry.agentUserId,
      viewerUserId: VIEWER_ID,
      requestId: '9ef7104b-ce8f-42f3-93d3-60c7b71b7abc',
      signal: new AbortController().signal,
    });

    expect(rpc).toHaveBeenNthCalledWith(
      1,
      'ca_rake_export_start',
      expect.objectContaining({
        p_scope_type: entry.scope,
        p_scope_id: entry.scopeId,
        p_agent_user_id: entry.expectedTarget,
      })
    );
  });

  it('defaults a top-level Downline export to the authenticated viewer identity', async () => {
    const selfMetadata = metadata('agent', { agent_user_id: VIEWER_ID });
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_rake_export_start') return result(receipt('agent', 1, selfMetadata));
      if (name === 'ca_club_data_export_page') {
        return result(page('agent', [downlineRow(1)], 1, 0, selfMetadata));
      }
      return result(true);
    }) as ClubDataExportRpc;

    await expect(
      fetchRakeSnapshotExport({
        rpc,
        scope: 'agent',
        scopeId: CLUB_ID,
        start: '2026-09-01',
        end: '2026-09-13',
        viewerUserId: VIEWER_ID,
        requestId: 'bb49c571-5b90-42f6-9b4e-392598671a96',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ metadata: { agent_user_id: VIEWER_ID } });
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      'ca_rake_export_start',
      expect.objectContaining({ p_agent_user_id: null })
    );
  });

  it('normalizes search and scope-specific sort to the server contract', async () => {
    const normalizedSearch = 'x'.repeat(RAKE_EXPORT_SEARCH_MAX_LENGTH);
    const oversizedSearch = `  ${normalizedSearch}ignored  `;
    const normalizedMetadata = metadata('union', { search: normalizedSearch, sort: 'rake' });
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_rake_export_start') {
        return result(receipt('union', 1, normalizedMetadata));
      }
      if (name === 'ca_club_data_export_page') {
        return result(page('union', [clubRow(1)], 1, 0, normalizedMetadata));
      }
      return result(true);
    }) as ClubDataExportRpc;

    await expect(
      fetchRakeSnapshotExport({
        rpc,
        scope: 'union',
        scopeId: UNION_ID,
        start: '2026-09-01',
        end: '2026-09-13',
        viewerUserId: VIEWER_ID,
        search: oversizedSearch,
        sort: 'cost',
        requestId: '5eefb35f-c330-421a-94bd-1b96cba0bfb5',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ metadata: { search: normalizedSearch, sort: 'rake' } });
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      'ca_rake_export_start',
      expect.objectContaining({ p_search: normalizedSearch, p_sort: 'rake' })
    );
  });

  it('rejects metadata mutation between immutable pages', async () => {
    const rows = [agentRow(1), agentRow(2)];
    const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
      if (name === 'ca_rake_export_start') return result(receipt('club', 2));
      if (name === 'ca_club_data_export_page' && args.p_offset === 0) {
        return result(page('club', [rows[0]], 2, 0));
      }
      if (name === 'ca_club_data_export_page') {
        return result(
          page('club', [rows[1]], 2, 1, metadata('club', { scope_label: 'Mutated Club' }))
        );
      }
      return result(true);
    }) as ClubDataExportRpc;

    await expect(
      fetchRakeSnapshotExport({
        rpc,
        scope: 'club',
        scopeId: CLUB_ID,
        start: '2026-09-01',
        end: '2026-09-13',
        viewerUserId: VIEWER_ID,
        requestId: '8167490d-1597-48b6-8698-6f811a22ce59',
        signal: new AbortController().signal,
        pageSize: 1,
      })
    ).rejects.toThrow('changed while it was being downloaded');
  });

  it('refuses a receipt above the server export ceiling', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_rake_export_start') return result(receipt('club', 20_001));
      return result(true);
    }) as ClubDataExportRpc;

    await expect(
      fetchRakeSnapshotExport({
        rpc,
        scope: 'club',
        scopeId: CLUB_ID,
        start: '2026-09-01',
        end: '2026-09-13',
        viewerUserId: VIEWER_ID,
        requestId: '47d07165-9e45-4f2f-b6ea-67c5cf330b1d',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('invalid preparation receipt');
    expect(rpc).not.toHaveBeenCalledWith('ca_club_data_export_page', expect.anything());
  });

  it.each([
    {
      label: 'duplicate',
      nextPage: { ...page('club', [agentRow(1), agentRow(1)], 2, 0) },
      message: 'duplicate',
      pageSize: 2,
      announced: 2,
    },
    {
      label: 'count',
      nextPage: { ...page('club', [agentRow(1)], 1, 0), total_rows: 2 },
      message: 'changed while it was being downloaded',
      pageSize: 1,
      announced: 1,
    },
    {
      label: 'short',
      nextPage: { ...page('club', [agentRow(1)], 3, 0), next_offset: 1, has_more: true },
      message: 'stopped before every row was delivered',
      pageSize: 2,
      announced: 3,
    },
  ])('rejects $label page corruption', async (testCase) => {
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_rake_export_start') return result(receipt('club', testCase.announced));
      if (name === 'ca_club_data_export_page') return result(testCase.nextPage);
      return result(true);
    }) as ClubDataExportRpc;

    await expect(
      fetchRakeSnapshotExport({
        rpc,
        scope: 'club',
        scopeId: CLUB_ID,
        start: '2026-09-01',
        end: '2026-09-13',
        viewerUserId: VIEWER_ID,
        requestId: 'd96a33de-9b48-45ca-b812-b2ea7d8fe7f1',
        signal: new AbortController().signal,
        pageSize: testCase.pageSize,
      })
    ).rejects.toThrow(testCase.message);
  });

  it('refuses any Rake row or receipt that carries horse identity', async () => {
    const rowWithHorseIdentity = { ...agentRow(1), is_horse: true };
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_rake_export_start') return result(receipt('club', 1));
      if (name === 'ca_club_data_export_page') {
        return result(page('club', [rowWithHorseIdentity], 1, 0));
      }
      return result(true);
    }) as ClubDataExportRpc;

    await expect(
      fetchRakeSnapshotExport({
        rpc,
        scope: 'club',
        scopeId: CLUB_ID,
        start: '2026-09-01',
        end: '2026-09-13',
        viewerUserId: VIEWER_ID,
        requestId: '639e0a3e-2a36-444c-a1d2-e4e8b73a2081',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('malformed row');
  });

  it('serializes receipt metadata and every row as a complete CSV without horse fields', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_rake_export_start') return result(receipt('club', 1));
      if (name === 'ca_club_data_export_page') return result(page('club', [agentRow(1)], 1, 0));
      return result(true);
    }) as ClubDataExportRpc;
    const exported = await fetchRakeSnapshotExport({
      rpc,
      scope: 'club',
      scopeId: CLUB_ID,
      start: '2026-09-01',
      end: '2026-09-13',
      viewerUserId: VIEWER_ID,
      requestId: 'f41de8ce-bf0a-4fe6-a151-29f5696ef77b',
      signal: new AbortController().signal,
    });
    const csv = rakeSnapshotExportToCsv(exported);
    expect(csv.split('\n')[0]).toContain('schema_version');
    expect(csv.split('\n')[0]).toContain('generated_at');
    expect(csv.split('\n')[1]).toContain('Shark Club');
    expect(csv.split('\n')[1].split(',').slice(-5)).toEqual(['1', '1234', '200', 'true', 'true']);
    expect(csv).toContain('agent_user_id,name,avatar_url,role');
    expect(csv).toContain('agent-1,Agent 1,,agent');
    expect(csv.toLowerCase()).not.toContain('horse');
  });

  it.each([
    ['union' as const, 'club_id,name,code,avatar_url,games,hands,fee'],
    ['club' as const, 'agent_user_id,name,avatar_url,role,commission_rate'],
    ['agent' as const, 'player_id,name,role,depth,upline_user_id'],
  ])('emits the $scope row schema when the immutable result has no rows', async (scope, header) => {
    const rpc = vi.fn((name: string) => {
      if (name === 'ca_rake_export_start') return result(receipt(scope, 0));
      return result(true);
    }) as ClubDataExportRpc;

    const exported = await fetchRakeSnapshotExport({
      rpc,
      scope,
      scopeId: scope === 'union' ? UNION_ID : CLUB_ID,
      start: '2026-09-01',
      end: '2026-09-13',
      agentUserId: scope === 'agent' ? AGENT_ID : null,
      viewerUserId: VIEWER_ID,
      requestId: 'bfb4c3da-b032-498f-9847-c7bd04c1954a',
      signal: new AbortController().signal,
    });

    expect(rakeSnapshotExportToCsv(exported)).toContain(`\n\n${header}`);
  });

  it('keeps expiry, authorization, entitlement changes, and busy slots distinct', () => {
    expect(isRakeExportUnavailable({ code: '55000', message: 'export expired' })).toBe(true);
    expect(
      isRakeExportAuthorizationError({ code: '42501', message: 'not authorized for this club' })
    ).toBe(true);
    expect(
      isRakeExportEntitlementChanged({
        code: '55000',
        message: 'permissions changed; prepare a new export',
      })
    ).toBe(true);
    expect(
      isRakeExportBusy({ code: '55000', message: 'Another Club Data export is already active.' })
    ).toBe(true);
    expect(isRakeExportAuthorizationError({ code: '55000', message: 'export expired' })).toBe(
      false
    );
  });
});
