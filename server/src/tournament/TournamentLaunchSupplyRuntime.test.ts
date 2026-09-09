import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import type { TournamentLifecycleToken } from './TournamentLifecycleEpoch.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';

const TOURNAMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const LEASE_GENERATION = 'bbbbbbbb-0000-4000-8000-000000000001';
const LAUNCH_ID = 'cccccccc-0000-4000-8000-000000000001';
const STARTED_AT = '2026-09-09T04:00:00.000Z';
const USER_IDS = ['dddddddd-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001'];
const TABLE_ID = 'ffffffff-0000-4000-8000-000000000001';

class LaunchSupplyHarness extends TournamentManagerBase {
  constructor() {
    super(TOURNAMENT_ID, {} as GameServer, LEASE_GENERATION, Number.MAX_SAFE_INTEGER);
  }

  activate(): TournamentLifecycleToken {
    this.running = true;
    return (
      this as unknown as { lifecycleEpoch: { begin(): TournamentLifecycleToken } }
    ).lifecycleEpoch.begin();
  }

  claim(lifecycle: TournamentLifecycleToken) {
    return (
      this as unknown as {
        beginTournamentLaunch(
          token: TournamentLifecycleToken,
          launchId: string,
          startedAt: string
        ): Promise<{
          launchId: string;
          startedAtIso: string;
          completed: boolean;
          supplyVersion: 0 | 1;
        } | null>;
      }
    ).beginTournamentLaunch(lifecycle, LAUNCH_ID, STARTED_AT);
  }

  issue(lifecycle: TournamentLifecycleToken) {
    return (
      this as unknown as {
        issueTournamentLaunchStacks(
          token: TournamentLifecycleToken,
          launchId: string,
          userIds: string[]
        ): Promise<boolean>;
      }
    ).issueTournamentLaunchStacks(lifecycle, LAUNCH_ID, USER_IDS);
  }

  materialize(lifecycle: TournamentLifecycleToken, stacksDeferred: boolean) {
    return (
      this as unknown as {
        materializeTournamentLaunchSeats(
          token: TournamentLifecycleToken,
          launchId: string,
          userIds: string[],
          assignments: Array<{ user_id: string; table_id: string; seat_number: number }>,
          deferred: boolean
        ): Promise<boolean>;
      }
    ).materializeTournamentLaunchSeats(
      lifecycle,
      LAUNCH_ID,
      USER_IDS,
      USER_IDS.map((user_id, index) => ({
        user_id,
        table_id: TABLE_ID,
        seat_number: index + 1,
      })),
      stacksDeferred
    );
  }

  project(lifecycle: TournamentLifecycleToken) {
    return (
      this as unknown as {
        projectTournamentLaunchSeatStacks(
          token: TournamentLifecycleToken,
          launchId: string,
          userIds: string[]
        ): Promise<number | null>;
      }
    ).projectTournamentLaunchSeatStacks(lifecycle, LAUNCH_ID, USER_IDS);
  }

  complete(lifecycle: TournamentLifecycleToken, supplyVersion: 0 | 1) {
    return (
      this as unknown as {
        completeTournamentLaunch(
          token: TournamentLifecycleToken,
          launchId: string,
          startedAt: string,
          version: 0 | 1
        ): Promise<boolean>;
      }
    ).completeTournamentLaunch(lifecycle, LAUNCH_ID, STARTED_AT, supplyVersion);
  }

  readSupplyVersion(lifecycle: TournamentLifecycleToken) {
    return (
      this as unknown as {
        readTournamentLaunchSupplyVersion(
          token: TournamentLifecycleToken,
          launchId: string
        ): Promise<0 | 1 | null>;
      }
    ).readTournamentLaunchSupplyVersion(lifecycle, LAUNCH_ID);
  }

  protected override startEliminationChecker(): void {}

  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

function rpcResult(data: Record<string, unknown>) {
  vi.spyOn(supabase, 'rpc').mockResolvedValue({ data, error: null } as never);
}

function supplyVersionResult(
  data: { supply_version: number | string } | null,
  error: {
    code?: string;
    message: string;
    details?: string;
    hint?: string;
  } | null = null
) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => ({ data, error }));
  return vi.spyOn(supabase, 'from').mockReturnValue(builder as never);
}

function commonResult() {
  return {
    ok: true,
    tournament_id: TOURNAMENT_ID,
    launch_id: LAUNCH_ID,
    lease_generation: LEASE_GENERATION,
    supply_version: 1,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the launch supply caller accepts only exact database receipts', () => {
  it.each([0, 1] as const)(
    'carries explicit supply version %s from the launch claim',
    async (version) => {
      rpcResult({
        ...commonResult(),
        supply_version: version,
        claimed: true,
        replay: false,
        completed: false,
        started_at: STARTED_AT,
      });
      const manager = new LaunchSupplyHarness();
      const lifecycle = manager.activate();

      await expect(manager.claim(lifecycle)).resolves.toMatchObject({
        launchId: LAUNCH_ID,
        completed: false,
        supplyVersion: version,
      });
    }
  );

  it('refuses an unknown supply version instead of guessing a compatibility path', async () => {
    rpcResult({
      ...commonResult(),
      supply_version: 2,
      claimed: true,
      replay: false,
      completed: false,
      started_at: STARTED_AT,
    });
    const manager = new LaunchSupplyHarness();

    await expect(manager.claim(manager.activate())).resolves.toBeNull();
  });

  it('reads an explicit receipt version when an intermediate RPC wrapper omits it', async () => {
    const begin = commonResult();
    delete (begin as { supply_version?: number }).supply_version;
    rpcResult({
      ...begin,
      claimed: true,
      replay: false,
      completed: false,
      started_at: STARTED_AT,
    });
    supplyVersionResult({ supply_version: 1 });
    const manager = new LaunchSupplyHarness();

    await expect(manager.claim(manager.activate())).resolves.toMatchObject({ supplyVersion: 1 });
  });

  it('recognizes only PostgreSQL undefined-column as the pre-ledger version-0 capability', async () => {
    supplyVersionResult(null, {
      code: '42703',
      message: 'column tournament_launch_receipts.supply_version does not exist',
    });
    const manager = new LaunchSupplyHarness();

    await expect(manager.readSupplyVersion(manager.activate())).resolves.toBe(0);
  });

  it.each([
    {
      code: 'PGRST204',
      message: "Could not find the 'supply_version' column in the schema cache",
    },
    { code: '57014', message: 'statement timeout while reading supply_version' },
    { code: '42703', message: 'column some_other_column does not exist' },
  ])('fails closed for every other unreadable capability state ($code)', async (error) => {
    supplyVersionResult(null, error);
    const manager = new LaunchSupplyHarness();

    await expect(manager.readSupplyVersion(manager.activate())).resolves.toBeNull();
  });

  it('proves the exact player set and total before accepting issuance', async () => {
    rpcResult({
      ...commonResult(),
      expected_player_count: 2,
      credited_player_count: 2,
      created_event_count: 2,
      issued_chips: 2000,
      roster_chips: 2000,
      players: USER_IDS.map((user_id) => ({ user_id, chips: 1000 })),
    });
    const manager = new LaunchSupplyHarness();

    await expect(manager.issue(manager.activate())).resolves.toBe(true);
  });

  it('refuses a deferred materialization that leaks supply onto the felt', async () => {
    rpcResult({
      ...commonResult(),
      stacks_deferred: true,
      materialized_player_count: 2,
      issued_chips: 2000,
      roster_chips: 2000,
      felt_chips: 2000,
      players: USER_IDS.map((user_id, index) => ({
        user_id,
        table_id: TABLE_ID,
        seat_number: index + 1,
        chips: 1000,
      })),
      tables: [{ table_id: TABLE_ID, current_players: 2 }],
    });
    const manager = new LaunchSupplyHarness();

    await expect(manager.materialize(manager.activate(), true)).resolves.toBe(false);
  });

  it('accepts projection replay only when roster, felt, and issued supply are equal', async () => {
    rpcResult({
      ...commonResult(),
      stacks_deferred: false,
      projected_player_count: 2,
      created_projection_count: 0,
      issued_chips: 2000,
      roster_chips: 2000,
      felt_chips: 2000,
      players: USER_IDS.map((user_id, index) => ({
        user_id,
        table_id: TABLE_ID,
        seat_number: index + 1,
        chips: 1000,
      })),
    });
    const manager = new LaunchSupplyHarness();

    await expect(manager.project(manager.activate())).resolves.toBe(2);
  });

  it('requires exact conservation only for version 1 completion', async () => {
    rpcResult({
      ...commonResult(),
      completed: true,
      status: 'RUNNING',
      started_at: STARTED_AT,
      completed_at: '2026-09-09T04:00:15.000Z',
      issued_chips: null,
      roster_chips: null,
      felt_chips: null,
      supply_version: 0,
    });
    const legacy = new LaunchSupplyHarness();
    await expect(legacy.complete(legacy.activate(), 0)).resolves.toBe(true);

    vi.restoreAllMocks();
    rpcResult({
      ...commonResult(),
      completed: true,
      status: 'RUNNING',
      started_at: STARTED_AT,
      completed_at: '2026-09-09T04:00:15.000Z',
      issued_chips: 2000,
      roster_chips: 1999,
      felt_chips: 2000,
    });
    const ledgered = new LaunchSupplyHarness();
    await expect(ledgered.complete(ledgered.activate(), 1)).resolves.toBe(false);
  });

  it('completes a pre-ledger version-0 claim when the old RPC and schema omit the version', async () => {
    const completion = commonResult();
    delete (completion as { supply_version?: number }).supply_version;
    rpcResult({
      ...completion,
      completed: true,
      status: 'RUNNING',
      started_at: STARTED_AT,
      completed_at: '2026-09-09T04:00:15.000Z',
      issued_chips: null,
      roster_chips: null,
      felt_chips: null,
    });
    supplyVersionResult(null, {
      code: '42703',
      message: 'column tournament_launch_receipts.supply_version does not exist',
    });
    const manager = new LaunchSupplyHarness();

    await expect(manager.complete(manager.activate(), 0)).resolves.toBe(true);
  });

  it('never lets the pre-ledger capability impersonate a version-1 completion', async () => {
    const completion = commonResult();
    delete (completion as { supply_version?: number }).supply_version;
    rpcResult({
      ...completion,
      completed: true,
      status: 'RUNNING',
      started_at: STARTED_AT,
      completed_at: '2026-09-09T04:00:15.000Z',
      issued_chips: 2000,
      roster_chips: 2000,
      felt_chips: 2000,
    });
    supplyVersionResult(null, {
      code: '42703',
      message: 'column tournament_launch_receipts.supply_version does not exist',
    });
    const manager = new LaunchSupplyHarness();

    await expect(manager.complete(manager.activate(), 1)).resolves.toBe(false);
  });
});
