/** A recovered satellite may read evidence and request one atomic receipt. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const SATELLITE = '00000000-0000-4000-8000-000000000101';
const WINNER = '00000000-0000-4000-8000-000000000102';

const state = vi.hoisted(() => ({
  field: { data: [] as unknown, error: null as { message: string } | null },
  hand: { data: { id: 'hand-1' } as unknown, error: null as { message: string } | null },
  mutations: [] as string[],
  plain: false,
  status: 'COMPLETING',
  failAfterCursor: false,
  fieldCursors: [] as (string | null)[],
}));

vi.mock('../services/supabase.js', () => ({
  supabase: {
    from(table: string) {
      const chain: Record<string, any> = {};
      let cursor: string | null = null;
      let limit = 1000;
      const answer = () => {
        if (table === 'tournaments') {
          return {
            data: [
              {
                id: SATELLITE,
                name: 'Daily Satellite',
                status: state.status,
                format_contract: null,
                variant: state.plain ? 'spin' : 'satellite',
                tournament_type: state.plain ? 'MTT' : 'SATELLITE',
                satellite_target_id: state.plain ? null : '00000000-0000-4000-8000-000000000103',
                started_at: new Date().toISOString(),
                payout_structure: [{ place: 1, percentage: 100 }],
              },
            ],
            error: null,
          };
        }
        if (table === 'tournament_players') {
          state.fieldCursors.push(cursor);
          if (cursor && state.failAfterCursor)
            return { data: null, error: { message: 'later page unavailable' } };
          if (!Array.isArray(state.field.data)) return state.field;
          return {
            ...state.field,
            data: state.field.data
              .filter((row: any) => cursor === null || row.id > cursor)
              .sort((a: any, b: any) => a.id.localeCompare(b.id))
              .slice(0, Math.min(limit, 1000)),
          };
        }
        if (table === 'hand_history') return state.hand;
        if (table === 'tournament_payouts' || table === 'tournament_obligations')
          return { data: [], error: null };
        throw new Error(`unexpected recovery read: ${table}`);
      };
      for (const method of ['select', 'eq', 'in', 'order']) chain[method] = () => chain;
      chain.limit = (value: number) => {
        limit = value;
        return chain;
      };
      chain.gt = (_key: string, value: string) => {
        cursor = value;
        return chain;
      };
      for (const method of ['insert', 'update', 'delete']) {
        chain[method] = () => {
          state.mutations.push(`${table}.${method}`);
          return chain;
        };
      }
      chain.maybeSingle = async () => answer();
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject);
      return chain;
    },
  },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn(async () => {}) }));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: vi.fn(() => false) }));
vi.mock('./satelliteSettlementRpc.js', () => ({
  SatelliteSettlementRefusedError: class SatelliteSettlementRefusedError extends Error {},
  requestSatelliteSettlementReceipt: vi.fn(async () => ({
    ticketAwardCount: 1,
    entryTicketCount: 0,
    remainder: { amount: 0 },
  })),
}));
vi.mock('./terminalSettlementRpc.js', () => ({
  TerminalSettlementRefusedError: class TerminalSettlementRefusedError extends Error {},
  requestTournamentTerminalReceipt: vi.fn(async () => ({
    settlementMode: 'places',
    cashPayoutTotal: 1,
    bountyPayoutTotal: 0,
    tableClosure: { closedTableCount: 1 },
  })),
}));

import { reportError } from '../services/errorReporter.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { requestTournamentTerminalReceipt } from './terminalSettlementRpc.js';
import { requestSatelliteSettlementReceipt } from './satelliteSettlementRpc.js';
import { recoverStuckCompletingTournaments } from './tournamentRecovery.js';

const playingWinner = () => [
  {
    id: '00000000-0000-4000-8000-000000000104',
    user_id: WINNER,
    status: 'playing',
    position: null,
    chips: 10_000,
    eliminated_at: null,
    elimination_sequence: null,
  },
];

describe('satellite recovery requires readable result authority', () => {
  beforeEach(() => {
    state.field = { data: playingWinner(), error: null };
    state.hand = { data: { id: 'hand-1' }, error: null };
    state.mutations = [];
    state.plain = false;
    state.status = 'COMPLETING';
    state.failAfterCursor = false;
    state.fieldCursors = [];
    vi.clearAllMocks();
  });

  const field = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `00000000-0000-4000-8000-${(i + 1000).toString(16).padStart(12, '0')}`,
      user_id: `00000000-0000-4000-8000-${(i + 10000).toString(16).padStart(12, '0')}`,
      status: 'eliminated',
      position: count - i,
      chips: 0,
      eliminated_at: '2026-10-29T00:00:00Z',
      elimination_sequence: i + 1,
    }));

  it.each([false, true])(
    'reads the true last winner beyond the first 1000 entrants (ordinary=%s)',
    async (plain) => {
      state.plain = plain;
      const rows = field(1001);
      state.field.data = rows;
      await recoverStuckCompletingTournaments('complete-field');
      const request = plain ? requestTournamentTerminalReceipt : requestSatelliteSettlementReceipt;
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        ...(plain ? [SATELLITE, 'places', rows[1000].user_id] : [SATELLITE, rows[1000].user_id])
      );
      expect(state.fieldCursors).toEqual([null, rows[999].id]);
      expect(state.mutations).toEqual([]);
    }
  );

  it.each([false, true])(
    'does not settle when a second live entrant is on page two (ordinary=%s)',
    async (plain) => {
      state.plain = plain;
      const rows = field(1001);
      rows[0].status = rows[1000].status = 'playing';
      rows[0].chips = rows[1000].chips = 100;
      state.field.data = rows;
      await recoverStuckCompletingTournaments('complete-field');
      expect(requestSatelliteSettlementReceipt).not.toHaveBeenCalled();
      expect(requestTournamentTerminalReceipt).not.toHaveBeenCalled();
      expect(state.mutations).toEqual([]);
    }
  );

  it.each([false, true])(
    'rejects an incomplete later page before settlement (ordinary=%s)',
    async (plain) => {
      state.plain = plain;
      state.field.data = field(1001);
      state.failAfterCursor = true;
      await recoverStuckCompletingTournaments('complete-field');
      expect(requestSatelliteSettlementReceipt).not.toHaveBeenCalled();
      expect(requestTournamentTerminalReceipt).not.toHaveBeenCalled();
      expect(state.mutations).toEqual([]);
    }
  );

  it('proves an exactly full page ends before choosing its winner', async () => {
    const rows = field(1000);
    state.field.data = rows;
    await recoverStuckCompletingTournaments('complete-field');
    expect(requestSatelliteSettlementReceipt).toHaveBeenCalledWith(SATELLITE, rows[999].user_id);
    expect(state.fieldCursors).toEqual([null, rows[999].id]);
  });

  it('continues a historical NULL-format COMPLETING receipt using stored places only', async () => {
    state.plain = true;
    await recoverStuckCompletingTournaments('format-preparation');
    expect(requestTournamentTerminalReceipt).toHaveBeenCalledWith(SATELLITE, 'places', WINNER);
    expect(state.mutations).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });
  it('does not extend that historical result path to an unknown active format', async () => {
    state.plain = true;
    state.status = 'RUNNING';
    await recoverStuckCompletingTournaments('format-preparation');
    expect(requestTournamentTerminalReceipt).not.toHaveBeenCalled();
    expect(state.mutations).toEqual([]);
  });

  it.each([
    { data: null, error: null },
    { data: null, error: { message: 'survivor read timeout' } },
  ])('does not settle when the roster is unreadable: %j', async (field) => {
    state.field = field;
    await recoverStuckCompletingTournaments('audit');

    expect(requestSatelliteSettlementReceipt).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      'GameServer.recoverStuckCompleting_satellite_field_unreadable'
    );
  });

  it('preserves an undecided field without any lifecycle or money call', async () => {
    state.field = {
      data: [...playingWinner(), { ...playingWinner()[0], id: 'p2', user_id: 'player-2' }],
      error: null,
    };
    await recoverStuckCompletingTournaments('audit');

    expect(requestSatelliteSettlementReceipt).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      'GameServer.recoverStuckCompleting_satellite_live_field_conflict'
    );
    expect(state.mutations).toEqual([]);
  });

  it('requires durable hand evidence before requesting the receipt', async () => {
    state.hand = { data: null, error: null };
    await recoverStuckCompletingTournaments('audit');
    expect(requestSatelliteSettlementReceipt).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      'GameServer.recoverStuckCompleting_satellite_no_hand_ever_dealt'
    );
  });

  it('hands one proven survivor to the single immutable receipt authority', async () => {
    await recoverStuckCompletingTournaments('audit');
    expect(requestSatelliteSettlementReceipt).toHaveBeenCalledTimes(1);
    expect(requestSatelliteSettlementReceipt).toHaveBeenCalledWith(SATELLITE, WINNER);
    expect(state.mutations).toEqual([]);
  });

  it('raises a critical alert when the serialized settlement outcome stays unknown', async () => {
    vi.mocked(requestSatelliteSettlementReceipt).mockRejectedValueOnce(new Error('network split'));
    await recoverStuckCompletingTournaments('audit');
    expect(raiseFinancialAlert).toHaveBeenCalledWith(
      'critical',
      'Satellite.recovery_settlement_outcome_unknown',
      expect.any(String),
      expect.objectContaining({ tournament_id: SATELLITE, winner_id: WINNER })
    );
  });
});

describe('satellite recovery is structurally read-only', () => {
  const source = blankNonCode(
    sliceMethod(
      readFileSync('src/tournament/tournamentRecovery.ts', 'utf8'),
      'export async function recoverStuckCompletingTournaments('
    )
  );

  it('contains no direct write or fragment settlement fallback', () => {
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(source).not.toMatch(
      /claimTournamentFinish|fn_settle_satellite_finish_atomic|settleTournamentObligation/
    );
    expect(source.match(/requestSatelliteSettlementReceipt\(/g)).toHaveLength(1);
  });
});
