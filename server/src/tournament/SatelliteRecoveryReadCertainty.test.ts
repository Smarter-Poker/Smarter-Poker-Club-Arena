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
}));

vi.mock('../services/supabase.js', () => ({
  supabase: {
    from(table: string) {
      const chain: Record<string, any> = {};
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
        if (table === 'tournament_players') return state.field;
        if (table === 'hand_history') return state.hand;
        if (table === 'tournament_payouts' || table === 'tournament_obligations')
          return { data: [], error: null };
        throw new Error(`unexpected recovery read: ${table}`);
      };
      for (const method of ['select', 'eq', 'in', 'limit']) chain[method] = () => chain;
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
    vi.clearAllMocks();
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
