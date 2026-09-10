import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  reportError: vi.fn(),
  alert: vi.fn(),
  frozen: false,
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  maintenanceSupabase: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: mocks.reportError }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: mocks.alert }));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => mocks.frozen }));
vi.stubGlobal(
  'fetch',
  vi.fn(() => {
    throw new Error('Network forbidden in qualification fixture');
  })
);
import {
  verifySatelliteQualificationReceipt,
  verifySatelliteSettlementReceipt,
} from './satelliteSettlementReceipt.js';
import {
  prepareSatelliteQualification,
  requestSatelliteQualificationReceipt,
  SatelliteSettlementOutcomeUnknownError,
  SatelliteSettlementRefusedError,
} from './satelliteSettlementRpc.js';
const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const T = id(1),
  TARGET = id(2),
  A = id(3),
  B = id(4),
  TABLE = id(9);
const users = [A, B],
  LEASE = id(51);
function receipt(): any {
  return {
    receipt_version: 3,
    completion_kind: 'equal_qualifiers',
    ok: true,
    fully_settled: true,
    status: 'COMPLETED',
    tournament_id: T,
    target_id: TARGET,
    winner_id: null,
    winner_amount: null,
    field_size: 4,
    pool: 400,
    ticket_cost: 200,
    ticket_award_count: 2,
    seat_count: 0,
    cash_ticket_count: 2,
    entry_ticket_count: 0,
    awards: users.map((user_id, i) => ({
      user_id,
      position: i + 1,
      amount: 200,
      delivery_kind: 'cash',
      payout_id: id(20 + i),
      registration_id: null,
      ticket_id: null,
    })),
    seats: [],
    remainder: null,
    qualifiers: users.map((user_id, i) => ({
      user_id,
      registration_id: id(30 + i),
      award_ordinal: i + 1,
      qualified_chips: 100 + i * 100,
      qualified_at: '2026-09-10T06:00:00.000Z',
    })),
    source_table_count: 1,
    source_seat_count: 2,
    released_seat_count: 2,
    source_closeout: {
      source_table_count: 1,
      source_table_ids: [TABLE],
      source_seat_count: 2,
      source_seat_ids: [id(10), id(11)],
      released_seat_count: 2,
      released_seat_ids: [id(10), id(11)],
      closed_at: '2026-09-10T06:01:00.000Z',
    },
    settled_at: '2026-09-10T06:01:00.000Z',
  };
}
const noWait = async () => undefined;
function prepared() {
  return {
    ok: true,
    qualification_prepared: true,
    tournament_id: T,
    completion_kind: 'equal_qualifiers',
    qualified_user_ids: users,
    lease_generation: LEASE,
  };
}
function outcome(committed = true) {
  return {
    ok: true,
    tournament_id: T,
    completion_kind: 'equal_qualifiers',
    qualified_user_ids: users,
    satellite_committed: committed,
    definitively_not_committed: !committed,
    status: committed ? 'COMPLETED' : 'COMPLETING',
    receipt: committed ? receipt() : null,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockReset();
  mocks.from.mockReset();
  mocks.frozen = false;
  mocks.alert.mockResolvedValue({ persisted: true, alertId: id(99) });
});
describe('equal satellite qualification proof', () => {
  it('accepts two differently sized live stacks without a winner or a finishing rank', () => {
    const verified = verifySatelliteQualificationReceipt(receipt(), T, [B, A]);
    expect(verified).toMatchObject({
      receiptVersion: 3,
      completionKind: 'equal_qualifiers',
      winnerId: null,
      winnerAmount: null,
      qualifiers: [
        { userId: A, awardOrdinal: 1, qualifiedChips: 100 },
        { userId: B, awardOrdinal: 2, qualifiedChips: 200 },
      ],
    });
    expect(verifySatelliteSettlementReceipt(receipt(), T, A)).toBeNull();
  });
  it.each([
    [
      'invented winner',
      (r: any) => {
        r.winner_id = A;
      },
    ],
    [
      'invented winner amount',
      (r: any) => {
        r.winner_amount = 200;
      },
    ],
    [
      'legacy version',
      (r: any) => {
        r.receipt_version = 2;
      },
    ],
    [
      'wrong kind',
      (r: any) => {
        r.completion_kind = 'single_winner';
      },
    ],
    [
      'duplicate qualifier',
      (r: any) => {
        r.qualifiers[1] = r.qualifiers[0];
      },
    ],
    [
      'wrong participant',
      (r: any) => {
        r.qualifiers[1].user_id = id(98);
      },
    ],
    [
      'wrong award ordinal',
      (r: any) => {
        r.qualifiers[1].award_ordinal = 1;
      },
    ],
    [
      'duplicate registration',
      (r: any) => {
        r.qualifiers[1].registration_id = r.qualifiers[0].registration_id;
      },
    ],
    [
      'zero stack',
      (r: any) => {
        r.qualifiers[1].qualified_chips = 0;
      },
    ],
    [
      'invalid stack',
      (r: any) => {
        r.qualifiers[1].qualified_chips = 'NaN';
      },
    ],
    [
      'future qualification',
      (r: any) => {
        r.qualifiers[1].qualified_at = '2026-09-11T06:00:00Z';
      },
    ],
    [
      'different award',
      (r: any) => {
        r.awards[1].amount = 199;
      },
    ],
    [
      'wrong pool',
      (r: any) => {
        r.pool = 401;
      },
    ],
    [
      'fractional cent',
      (r: any) => {
        r.ticket_cost = 200.001;
      },
    ],
    [
      'missing closeout',
      (r: any) => {
        r.source_closeout.released_seat_ids = [];
      },
    ],
  ] as const)('refuses %s', (_name, mutate) => {
    const r = receipt();
    mutate(r);
    expect(verifySatelliteQualificationReceipt(r, T, users)).toBeNull();
  });
  it.each([{ expected: [A] }, { expected: [A, A] }, { expected: [A, id(99)] }])(
    'refuses a different requested cohort $expected',
    ({ expected }) => {
      expect(verifySatelliteQualificationReceipt(receipt(), T, expected)).toBeNull();
    }
  );
});
describe('exact cohort transport', () => {
  it('replays one sorted cohort after an ambiguous response', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ error: { message: 'lost response' } })
      .mockResolvedValueOnce({ data: receipt(), error: null });
    const result = await requestSatelliteQualificationReceipt(T, [B, A], {
      attempts: 2,
      wait: noWait,
    });
    expect(result.winnerId).toBeNull();
    expect(mocks.rpc.mock.calls[0]).toEqual(mocks.rpc.mock.calls[1]);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_complete_satellite_qualification', {
      p_tournament_id: T,
      p_qualified_user_ids: users,
    });
  });
  it('accepts only the exact serialized committed receipt after direct response loss', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ error: { message: 'lost response' } })
      .mockResolvedValueOnce({ data: outcome(), error: null });
    await expect(
      requestSatelliteQualificationReceipt(T, users, { attempts: 1, wait: noWait })
    ).resolves.toMatchObject({ receiptVersion: 3, winnerId: null });
  });
  it('keeps a mismatched resolver identity unknown', async () => {
    mocks.rpc.mockResolvedValueOnce({ error: { message: 'lost response' } }).mockResolvedValueOnce({
      data: { ...outcome(), qualified_user_ids: [A, id(99)] },
      error: null,
    });
    await expect(
      requestSatelliteQualificationReceipt(T, users, { attempts: 1, wait: noWait })
    ).rejects.toBeInstanceOf(SatelliteSettlementOutcomeUnknownError);
  });
  it('distinguishes a serialized uncommitted result from network failure', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ error: { message: 'refused' } })
      .mockResolvedValueOnce({ data: outcome(false), error: null });
    await expect(
      requestSatelliteQualificationReceipt(T, users, { attempts: 1, wait: noWait })
    ).rejects.toBeInstanceOf(SatelliteSettlementRefusedError);
  });
  it('prepares the exact identity and rejects a generic successful response', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true }, error: null });
    await expect(prepareSatelliteQualification(T, users, LEASE)).rejects.toBeInstanceOf(
      SatelliteSettlementOutcomeUnknownError
    );
    mocks.rpc.mockResolvedValueOnce({ data: prepared(), error: null });
    await expect(prepareSatelliteQualification(T, [B, A], LEASE)).resolves.toBeUndefined();
  });
});
function manager(
  options: {
    depth?: number;
    pool?: number;
    players?: any[];
    park?: () => Promise<boolean>;
    afterRoster?: () => void;
    prepareError?: boolean;
    settleError?: boolean;
  } = {}
) {
  const engine = {
    isRunning: vi.fn(() => true),
    parkForTerminalCloseout: vi.fn(options.park ?? (async () => true)),
    releaseTerminalCloseoutPause: vi.fn(),
  };
  let current: any = engine;
  const m = Object.create(TournamentManagerEliminations.prototype) as any;
  Object.assign(m, {
    tournamentId: T,
    tournamentCache: { variant: 'satellite', tournament_type: 'SATELLITE' },
    running: true,
    tournamentLeaseGeneration: LEASE,
    prizePoolFinalized: true,
    tableEngines: new Map([[TABLE, engine]]),
    gameServer: { getTableEngine: () => current },
    requestUrgentEliminationSweepAfter: vi.fn(),
    cleanupCommittedSatellite: vi.fn(async () => true),
  });
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'fn_get_tournament_satellite_entitlement_depth')
      return {
        error: null,
        data: {
          ok: true,
          ready: true,
          is_satellite: true,
          award_depth: options.depth ?? 2,
          ticket_value: 200,
          source_pool: options.pool ?? 400,
        },
      };
    if (name === 'fn_prepare_satellite_qualification')
      return options.prepareError
        ? { error: { message: 'preparation response lost' } }
        : { data: prepared(), error: null };
    if (name === 'fn_complete_satellite_qualification')
      return options.settleError
        ? { error: { message: 'settlement refused' } }
        : { data: receipt(), error: null };
    if (name === 'fn_resolve_satellite_qualification_outcome')
      return { data: outcome(false), error: null };
    throw new Error('Unexpected RPC ' + name);
  });
  mocks.from.mockImplementation((table: string) => {
    const q: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      then: (resolve: any, reject: any) => {
        if (table === 'tournament_players') options.afterRoster?.();
        return Promise.resolve({
          error: null,
          data:
            table === 'tables'
              ? [{ id: TABLE }]
              : (options.players ?? [
                  { user_id: A, chips: 100 },
                  { user_id: B, chips: 200 },
                ]),
        }).then(resolve, reject);
      },
    };
    return q;
  });
  return {
    m,
    engine,
    replaceEngine: () => {
      current = {};
    },
  };
}
describe('actual manager settled qualification boundary', () => {
  it('parks first, durably prepares, then settles the same cohort once', async () => {
    const { m, engine } = manager();
    await expect(m.checkEqualSatelliteQualification(2)).resolves.toBe(true);
    expect(engine.parkForTerminalCloseout).toHaveBeenCalledOnce();
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_get_tournament_satellite_entitlement_depth',
      'fn_prepare_satellite_qualification',
      'fn_complete_satellite_qualification',
    ]);
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(m.cleanupCommittedSatellite).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptVersion: 3,
        winnerId: null,
        qualifiers: expect.any(Array),
      })
    );
    expect(m.pendingSatelliteQualification).toBeNull();
  });
  it.each([
    { depth: 3, pool: 600 },
    { depth: 2, pool: 401 },
  ])(
    'leaves unsupported threshold or remainder contracts to their own authority %j',
    async (options) => {
      const { m, engine } = manager(options);
      await expect(m.checkEqualSatelliteQualification(2)).resolves.toBe(false);
      expect(engine.parkForTerminalCloseout).not.toHaveBeenCalled();
    }
  );
  it('releases preadmission parking when a dealt hand has not settled', async () => {
    const { m, engine } = manager({ park: async () => false });
    await m.checkEqualSatelliteQualification(2);
    expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      'fn_prepare_satellite_qualification',
      expect.anything()
    );
  });
  it('rechecks ownership after the roster read, before durable admission', async () => {
    let change = () => {};
    const { m, engine, replaceEngine } = manager({ afterRoster: () => change() });
    change = replaceEngine;
    await m.checkEqualSatelliteQualification(2);
    expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      'fn_prepare_satellite_qualification',
      expect.anything()
    );
  });
  it('rejects a field that changed while all source tables were parked', async () => {
    const { m, engine } = manager({
      players: [
        { user_id: A, chips: 100 },
        { user_id: B, chips: 0 },
      ],
    });
    await m.checkEqualSatelliteQualification(2);
    expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
    expect(m.pendingSatelliteQualification).toBeUndefined();
  });
  it('retains an ambiguous prepared cohort and alerts management before retrying', async () => {
    const { m, engine } = manager({ prepareError: true });
    await m.checkEqualSatelliteQualification(2);
    expect(m.pendingSatelliteQualification).toEqual({ userIds: users, prepared: false });
    expect(engine.releaseTerminalCloseoutPause).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith(
      'critical',
      'Tournament.satellite_qualification_pending',
      expect.any(String),
      { tournamentId: T, qualifiedUserIds: users, prepared: false }
    );
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalledOnce();
  });
  it('does not admit a cohort after authority changes during parking', async () => {
    let change = () => {};
    const { m, engine, replaceEngine } = manager({
      park: async () => {
        change();
        return true;
      },
    });
    change = replaceEngine;
    await m.checkEqualSatelliteQualification(2);
    expect(engine.releaseTerminalCloseoutPause).toHaveBeenCalledOnce();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      'fn_prepare_satellite_qualification',
      expect.anything()
    );
  });
  it('stops the old manager after a preparation response crosses its shutdown', async () => {
    const { m } = manager();
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, ...args: any[]) => {
      const result = await original(name, ...args);
      if (name === 'fn_prepare_satellite_qualification') m.running = false;
      return result;
    });
    await m.checkEqualSatelliteQualification(2);
    expect(m.pendingSatelliteQualification).toEqual({ userIds: users, prepared: true });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      'fn_complete_satellite_qualification',
      expect.anything()
    );
  });
  it('retains the causal retry if management alert delivery fails', async () => {
    const { m } = manager({ prepareError: true });
    mocks.alert.mockRejectedValueOnce(new Error('alert transport failed'));
    await expect(m.checkEqualSatelliteQualification(2)).resolves.toBe(true);
    expect(m.pendingSatelliteQualification).toEqual({ userIds: users, prepared: false });
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalledOnce();
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.satellite_qualification_alert_unavailable'
    );
  });
});
