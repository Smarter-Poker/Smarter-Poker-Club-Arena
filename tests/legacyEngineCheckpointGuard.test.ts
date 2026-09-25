import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacyEngineCheckpointGuard } from '../server/scripts/legacy-engine-checkpoint-guard.mjs';
import { F06HandPermit } from '../server/src/services/F06HandPermit';
import { TournamentRetirementCustody } from '../server/src/services/TournamentRetirementCustody';
import { unregisterOwnedTournamentTableEngine } from '../server/src/tournament/TournamentManagerOwnership';
import * as dataActorContext from '../server/src/services/supabase/dataActorContext';

const release = '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5';
const checkpoint758 = '758610f3f844406bbbaee2f5100ced36d84fb943';
const checkpointA0 = 'a0ab287d902879280f0c915e44f5222c5db4d7df';
const checkpoint8825 = '8825af51817f379c4261658ca29ecc9d8d81932d';
const instance = '1-c86a8f37';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pins = [
  'bfcb47c498c34408dd95047e90535c7ddc1ecc5fef14e41e1063ec72a1aad119',
  'f5c8f4f814d7fd5649cea03698443c21c592e7db1ac6c1ac9fc756af5a72c407',
  'f129642e3ce48e26a84f3f7fa60c46d3ceabd67e35f0508c1711319bc95f56ad',
];
const pins758 = [
  'f8a4e646348fbd0209b9afde24658660dca0837f7720e04b47d37cff4fa2bea7',
  'cc715650eca1b6cfbccadcef46a9f07f581549e75df6581cb8c32f3fbfffc0b3',
  'f129642e3ce48e26a84f3f7fa60c46d3ceabd67e35f0508c1711319bc95f56ad',
  '44a7c52ede31dd3a5600d6b648b0d34c9ecabc3e10f14a65830712b432dc62e9',
];
const pinsA0 = [
  ...pins758.slice(0, 3),
  'a15d068c8a43ab0c34a208abf4380815813cf71a703978e334ed5c78ef70788b',
];

const pins8825 = {
  '/app/dist/GameServer.js': 'd87313450daee6035b9ee4945b9ee382d83d71b2ae39f1326a7059fcaa505332',
  '/app/dist/engine/ServerTableEngineBase.js':
    '182cc4a8f3e181154ff586d0dd62506df5eae89f845169e21e7fa39d5e30088b',
  '/app/dist/engine/ServerTableEngineDealing.js':
    '9aff42c79e62ca520b19ad49f5169b346417dabc82c25734b4e40a14a7fb96d1',
  '/app/dist/tournament/TournamentManager.js':
    'b559245800e9f9f69c15a775df3b94f5afe6db926cec7b604c3bc93751bf2e29',
  '/app/dist/tournament/TournamentManagerBase.js':
    '1460070a5fce172faa90c81698d660876535943264b27f6fa9ce89ef0bf10957',
  '/app/dist/tournament/TournamentManagerOwnership.js':
    '0a99e8862c97716ba4435cb477621840f3e48355a018b6457fb6a7f245380fa0',
  '/app/dist/services/F06HandPermit.js':
    'b42c7b954e1ec804b8819996ffe2dc1f1f8e6a74034b84fb17c154f35d9dc956',
  '/app/dist/maintenance/MaintenanceBreak.js':
    'bc61dfe53e3becd3c7bf5cbe72f08b830cc71f68e37c5f06b462dba5588410a6',
  '/app/dist/maintenance/freezeState.js':
    'f8ad56caef98973d535949e14030334ab49b3edbd18a9f6bc711681a469abee8',
  '/app/dist/services/supabase/client.js':
    'f129642e3ce48e26a84f3f7fa60c46d3ceabd67e35f0508c1711319bc95f56ad',
  '/app/dist/services/supabase/dataActorContext.js':
    '07ff29c562d000690437b62c46c87a10adb1fc40beb54e82ad863632b7e18985',
  '/app/dist/services/tableLease.js':
    '123fa3e6a1dbaa11263b42bb09359859eb55f6ed687020f0bbb0c523f72033ba',
  '/app/dist/releaseIdentity.js':
    '3386b6a5740b7f6fa936b4e1f0727199b0d661e134dcb20424e602c1d3db8c89',
  '/app/dist/services/TournamentRetirementCustody.js':
    '9545296b55652a6861069f5b5ad8d5388d6b2fb36073b67c6235e9c1b0925e1e',
};

function fixture(count = 1, predecessor = release) {
  const activeInstance = predecessor === checkpoint8825 ? '1-3846b8bb' : instance;
  const rows = new Map();
  const calls: string[] = [];
  let remaining = 300000;
  let onWrite: ((engine: Table) => Promise<void> | void) | undefined;
  let onRead: ((data: any[]) => any[]) | undefined;
  const snapshotReads: { ids: string[]; since: string }[] = [];
  let onSnapshots: ((ids: string[], since: string) => { data: any; error: any }) | undefined;
  const seatReads: { users: string[] }[] = [];
  // Every open seat row the fixture handed back, so the batched arrivals
  // question can answer per (table, occupancy) exactly as the per-table one.
  const openRows: any[] = [];
  let onSeats: ((users: string[]) => { data: any; error: any }) | undefined;
  const moveReads: { ids: string[] }[] = [];
  let onMoves: ((ids: string[]) => { data: any; error: any }) | undefined;
  const dealtReads: { table: string; since: string; player: string; op: string }[] = [];
  let onDealt:
    | ((table: string, since: string, player: string) => { data: any; error: any })
    | undefined;
  // Has this engine ever dealt the open seat that collided with its residue?
  let onResidueSeatDealt:
    | ((table: string, since: string, player: string) => { data: any; error: any })
    | undefined;
  // Opt-in: model a predecessor whose `unparkedTables()` has no bound, so one
  // unresolved F06 preparation holds `readyForRestart()` false for ever.
  // 8825af51 is exactly that engine and it is what production runs.
  let gateOnPreparations = false;
  let gateReasons: Record<string, number> | null = null;
  class Maintenance {
    unparkedReasonCounts: Record<string, number> = {};
    phase = 'counting_down';
    announcedAt = Date.now() - 120000;
    breakStartedAt = this.announcedAt + 120000;
    breakEndsAt = this.breakStartedAt + 300000;
    reason = 'Scheduled Engine Maintenance';
    ownershipToken = uuid(9000);
    lifecycleGeneration = 1;
    resumeToken = 1;
    durableConfirmed = true;
    ending = false;
    acceptingLifecycleWork = true;
    releaseBoundaryOnly = false;
    recoveryReadPending = false;
    stopOperation = null;
    lastDurableState = {
      phase: this.phase,
      announcedAt: this.announcedAt,
      breakStartedAt: this.breakStartedAt,
      breakEndsAt: this.breakEndsAt,
      reason: this.reason,
      ownershipToken: this.ownershipToken,
    };
    remainingMs() {
      return remaining;
    }
    readyForRestart() {
      if (gateOnPreparations) {
        const blockers = [...server.tableEngines.values()].filter((e: any) =>
          e.hasUnresolvedF06Preparation()
        );
        this.unparkedReasonCounts =
          gateReasons ?? (blockers.length ? { f06_preparation_unresolved: blockers.length } : {});
        if (blockers.length > 0 || gateReasons) return false;
      }
      return [...server.tableEngines.values()].every(
        (e) =>
          // 8825 `unparkedTables` (MaintenanceBreak.ts:1768-1795) asks a STOPPED
          // engine only about an unresolved F06 preparation and then
          // `continue`s past it: `if (!engine.isRunning()) continue;` comes
          // before the durability question, so a dead engine's unwritten park
          // never holds the process's own certificate shut.
          (predecessor === checkpoint8825 && !e.running) ||
          (e.isMaintenanceStateDurable() && (predecessor !== checkpoint8825 || !e.f06CurrentPermit))
      );
    }
  }
  // Tables whose park write the database fences (a lease generation that is
  // no longer current): `savePresenceAtPark` returns false, nothing is
  // written, and `parkedBankSaveComplete` stays false - exactly what
  // `persistPresenceForRestart` does on a refused upsert, with no throw.
  const fenced = new Set<string>();
  class Table {
    static liveEngines = new Map();
    tableId: string;
    running = true;
    terminal = false;
    teardownPromise = null;
    maintenancePaused = true;
    holdBeforeNextHand = true;
    handForHandResolve = () => undefined;
    pauseGateTimer = null;
    handController: object | null = null;
    settlementInFlight = new Set();
    postHandTasksPromise: Promise<void> | null = null;
    actionLock = false;
    tournamentMoveOperations = new Set();
    terminalBoundaryPendingGenerations = new Set();
    terminalBoundaryPersistenceFailed = false;
    handCount = 17;
    seatedPlayers: any[];
    timeBankMeta = new Map();
    timeBankEngine = { playerBanks: new Map() };
    parkedTimeBanks = {};
    parkedBankSaveComplete = false;
    presenceSave = Promise.resolve();
    maintenanceCheckpointGeneration = 1;
    timeBankAccountingPending = new Set<Promise<void>>();
    timeBankAccountingUnconfirmed = false;
    f06CurrentPermit: object | null = null;
    f06RecoveryInFlight = false;
    disconnectEngine = { getFsmStatesForTable: () => ({}) };
    constructor(n: number) {
      this.tableId = uuid(n);
      const userId = uuid(n + 10000);
      this.seatedPlayers = [
        { user_id: userId, occupancy_id: uuid(n + 20000), seat_number: 1, stack: 100 },
      ];
      this.timeBankMeta.set(userId, { initialSeconds: 90, baseSeconds: 30, dbConsumedSeconds: 15 });
      this.timeBankEngine.playerBanks.set(`${this.tableId}:${userId}`, {
        tableId: this.tableId,
        playerId: userId,
        remainingSeconds: 75,
        usesRemaining: 2,
        isActive: false,
        ...(predecessor === checkpoint8825 ? { unlimitedActivations: false } : {}),
      });
    }
    captureParkedTimeBanks() {
      const saved: any = { ...this.parkedTimeBanks };
      for (const seat of this.seatedPlayers) {
        const bank = this.timeBankEngine.playerBanks.get(`${this.tableId}:${seat.user_id}`);
        const meta = this.timeBankMeta.get(seat.user_id);
        if (!bank || !meta || bank.isActive || !seat.occupancy_id) continue;
        saved[seat.user_id] = {
          occupancyId: seat.occupancy_id,
          remainingSeconds: bank.remainingSeconds,
          usesRemaining: bank.usesRemaining,
          ...meta,
          ...(predecessor === checkpoint8825
            ? { unlimitedActivations: bank.unlimitedActivations ?? false }
            : {}),
        };
      }
      return saved;
    }
    maintenanceDurabilityReason() {
      // 8825 `maintenanceDurabilityReason` (ServerTableEngineBase.ts:5573-5585):
      // only a parked bank or a SEATED player's bank needs the park write; a
      // bank a bust left behind for a player the roster no longer holds does
      // not, and the one reason an unwritten park produces is named.
      const hasBanks =
        Object.keys(this.parkedTimeBanks ?? {}).length > 0 ||
        this.seatedPlayers.some((seat) =>
          this.timeBankEngine.playerBanks.has(`${this.tableId}:${seat.user_id}`)
        );
      return hasBanks && !this.parkedBankSaveComplete ? 'bank_park_write_incomplete' : null;
    }
    isMaintenanceStateDurable() {
      return this.maintenanceDurabilityReason() === null;
    }
    hasReleasedProcessOwnership() {
      return !this.running && this.terminal;
    }
    // ServerTableEngineBase.hasUnresolvedF06Preparation, verbatim: `attempted`
    // is deliberately absent from it on every profile.
    hasUnresolvedF06Preparation() {
      const phase = (this.f06CurrentPermit as any)?.recoveryState?.();
      return phase === 'unknown' || phase === 'reserved' || phase === 'terminated';
    }
    async persistPresenceForRestart(when: string) {
      const previous = this.presenceSave;
      let finish!: () => void;
      this.presenceSave = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await previous;
      try {
        calls.push(when);
        await onWrite?.(this);
        if (fenced.has(this.tableId)) return;
        const parkedAt = new Date().toISOString();
        rows.set(this.tableId, {
          table_id: this.tableId,
          engine_instance: `${activeInstance}:parked`,
          parked_at: parkedAt,
          disconnect_states: this.disconnectEngine.getFsmStatesForTable(),
          time_bank_snapshot: {
            version: 1,
            parkedAt,
            handNumber: this.handCount,
            players: this.captureParkedTimeBanks(),
          },
        });
        this.parkedBankSaveComplete = true;
      } finally {
        finish();
      }
    }
  }
  class Server {
    running = true;
    teardownPromise = null;
    lifecycleGeneration = 1;
    tournamentEngines = new Map();
    tournamentOwnedTables = new Set<string>();
    tournamentRetirementCustody = new TournamentRetirementCustody();
    unregisterTournamentTableEngine(id: string, engine: Table) {
      return unregisterOwnedTournamentTableEngine(
        this.tableEngines,
        this.tournamentOwnedTables,
        id,
        engine
      );
    }
    maintenanceBreak = new Maintenance();
    tableEngines = new Map(
      Array.from({ length: count }, (_, i) => {
        const table = new Table(i + 1);
        return [table.tableId, table];
      })
    );
  }
  const server = new Server();
  const modules = {
    dataActorContext,
    gameServer: { GameServer: Server },
    base: { ServerTableEngineBase: Table },
    maintenance: { MaintenanceBreak: Maintenance },
    freezeState: { isMaintenanceFrozen: () => true },
    releaseIdentity: {
      ENGINE_RELEASE_IDENTITY: { releaseSha: predecessor, version: predecessor.slice(0, 8) },
    },
    tableLease: { INSTANCE_ID: activeInstance },
    fs: {
      statSync: () => ({ isFile: () => true, size: 1 }),
      readFileSync: (path: string) => {
        if (predecessor === checkpoint8825)
          return Buffer.from([Object.keys(pins8825).indexOf(path)]);
        return Buffer.from([
          path.endsWith('/GameServer.js')
            ? 0
            : path.endsWith('/ServerTableEngineBase.js')
              ? 1
              : path.endsWith('/ServerTableEngineDealing.js')
                ? 3
                : 2,
        ]);
      },
    },
    crypto: {
      createHash: () => ({
        update: (bytes: Buffer) => ({
          digest: () =>
            (predecessor === checkpoint8825
              ? Object.values(pins8825)
              : predecessor === checkpointA0
                ? pinsA0
                : predecessor === checkpoint758
                  ? pins758
                  : pins)[bytes[0]],
        }),
      }),
    },
    client: {
      supabase: {
        from: (name: string) => {
          if (name === 'hand_state_snapshots') {
            // The in-flight read: incomplete rows written inside the window.
            const filter: any = {
              ids: [] as string[],
              since: '',
              in: (key: string, ids: string[]) => {
                expect(key).toBe('table_id');
                filter.ids = ids;
                return filter;
              },
              eq: (key: string, value: unknown) => {
                expect([key, value]).toEqual(['is_complete', false]);
                return filter;
              },
              gte: (key: string, value: string) => {
                expect(key).toBe('updated_at');
                filter.since = value;
                return filter;
              },
              limit: async (bound: number) => {
                expect(bound).toBe(filter.ids.length + 1);
                snapshotReads.push({ ids: [...filter.ids], since: filter.since });
                return onSnapshots
                  ? onSnapshots(filter.ids, filter.since)
                  : { data: [], error: null };
              },
            };
            return { select: () => filter };
          }
          if (name === 'table_seats') {
            // Every open seat the residue players hold, at any table.
            const filter: any = {
              users: [] as string[],
              in: (key: string, values: string[]) => {
                expect(key).toBe('user_id');
                filter.users = values;
                return filter;
              },
              is: (key: string, value: unknown) => {
                expect([key, value]).toEqual(['left_at', null]);
                return filter;
              },
              limit: async (bound: number) => {
                expect(bound).toBe(901);
                seatReads.push({ users: [...filter.users] });
                const answer = onSeats ? onSeats(filter.users) : { data: [], error: null };
                if (Array.isArray(answer?.data)) openRows.push(...answer.data);
                return answer;
              },
            };
            return {
              select: (columns: string) => {
                expect(columns).toBe('table_id,user_id,occupancy_id,joined_at');
                return filter;
              },
            };
          }
          if (name === 'cash_seat_moves') {
            // When each move out of a residue table executed.
            const filter: any = {
              ids: [] as string[],
              in: (key: string, values: string[]) => {
                expect(key).toBe('id');
                filter.ids = values;
                return filter;
              },
              limit: async (bound: number) => {
                expect(bound).toBe(filter.ids.length + 1);
                moveReads.push({ ids: [...filter.ids] });
                return onMoves ? onMoves(filter.ids) : { data: [], error: null };
              },
            };
            return {
              select: (columns: string) => {
                expect(columns).toBe('id,executed_at');
                return filter;
              },
            };
          }
          if (name === 'hand_history') {
            // Has the destination dealt this player a hand since the move?
            const filter: any = {
              table: '',
              since: '',
              player: '',
              // `gt` is the arrival's "dealt since the move executed"; `gte` is
              // the residue seat's "dealt since this occupancy opened".
              op: '',
              eq: (key: string, value: string) => {
                expect(key).toBe('table_id');
                filter.table = value;
                return filter;
              },
              gt: (key: string, value: string) => {
                expect(key).toBe('created_at');
                filter.since = value;
                filter.op = 'gt';
                return filter;
              },
              gte: (key: string, value: string) => {
                expect(key).toBe('created_at');
                filter.since = value;
                filter.op = 'gte';
                return filter;
              },
              contains: (key: string, value: any) => {
                expect(key).toBe('players');
                // postgrest-js writes an array as a Postgres array literal
                // (`cs.{...}`), which a jsonb column refuses with 22P02. Only
                // a JSON string reaches PostgREST as JSON.
                expect(typeof value).toBe('string');
                const parsed = JSON.parse(value);
                expect(Array.isArray(parsed)).toBe(true);
                expect(Object.keys(parsed[0])).toEqual(['userId']);
                filter.player = parsed[0].userId;
                return filter;
              },
              limit: async (bound: number) => {
                expect(bound).toBe(1);
                dealtReads.push({
                  table: filter.table,
                  since: filter.since,
                  player: filter.player,
                  op: filter.op,
                });
                return filter.op === 'gte'
                  ? onResidueSeatDealt
                    ? onResidueSeatDealt(filter.table, filter.since, filter.player)
                    : { data: [], error: null }
                  : onDealt
                    ? onDealt(filter.table, filter.since, filter.player)
                    : { data: [], error: null };
              },
            };
            return {
              select: (columns: string) => {
                expect(columns).toBe('id');
                return filter;
              },
            };
          }
          expect(name).toBe('engine_presence_parked');
          return {
            select: () => ({
              in: (_key: string, ids: string[]) => ({
                limit: async (bound: number) => {
                  expect(bound).toBe(ids.length + 1);
                  const data = structuredClone(ids.map((id) => rows.get(id)).filter(Boolean));
                  return { data: onRead ? onRead(data) : data, error: null };
                },
              }),
            }),
          };
        },
      },
    },
  };
  const options = {
    expectedReleaseSha: predecessor,
    expectedInstanceId: activeInstance,
    expectedPid: process.pid,
  };
  return {
    Table,
    Server,
    server,
    modules,
    options,
    calls,
    rows,
    snapshotReads,
    seatReads,
    openRows,
    moveReads,
    first: [...server.tableEngines.values()][0],
    run: (discovered = [server]) =>
      legacyEngineCheckpointGuard.call(server, options, discovered, modules),
    onWrite: (hook: typeof onWrite) => {
      onWrite = hook;
    },
    onRead: (hook: typeof onRead) => {
      onRead = hook;
    },
    onSnapshots: (hook: typeof onSnapshots) => {
      onSnapshots = hook;
    },
    onSeats: (hook: typeof onSeats) => {
      onSeats = hook;
    },
    dealtReads,
    onResidueSeatDealt: (hook: typeof onResidueSeatDealt) => {
      onResidueSeatDealt = hook;
    },
    onDealt: (hook: typeof onDealt) => {
      onDealt = hook;
    },
    onMoves: (hook: typeof onMoves) => {
      onMoves = hook;
    },
    fence: (tableId: string) => {
      fenced.add(tableId);
    },
    holdGate: (reasons?: Record<string, number>) => {
      gateOnPreparations = true;
      gateReasons = reasons ?? null;
    },
    remaining: (value: number) => {
      remaining = value;
    },
  };
}

describe('legacy checkpoint admission and exact persisted readback', () => {
  it('checkpoints the exact a0 original owner with its measured compiled bytes', async () => {
    const f = fixture(1, checkpointA0);
    expect(await f.run()).toMatchObject({
      ok: true,
      attemptedTables: 1,
      verifiedTables: 1,
      paidAccountingQualification: 'native_pending_registry_drained',
      restartAuthorized: false,
    });
    expect(f.calls).toEqual(['parked']);
  });

  it.each([
    'pending-accounting',
    'unconfirmed-accounting',
    'retained-permit',
    'recovery-in-flight',
    '758-dealing-bytes',
  ])('refuses exact a0 %s before any native write', async (cause) => {
    const f = fixture(1, checkpointA0);
    if (cause === 'pending-accounting') f.first.timeBankAccountingPending.add(Promise.resolve());
    if (cause === 'unconfirmed-accounting') f.first.timeBankAccountingUnconfirmed = true;
    if (cause === 'retained-permit') f.first.f06CurrentPermit = {};
    if (cause === 'recovery-in-flight') f.first.f06RecoveryInFlight = true;
    if (cause === '758-dealing-bytes')
      f.modules.crypto.createHash = () => ({
        update: (bytes: Buffer) => ({ digest: () => pins758[bytes[0]] }),
      });
    expect(await f.run()).toMatchObject({
      ok: false,
      attemptedTables: 0,
      restartAuthorized: false,
    });
    expect(f.calls).toEqual([]);
  });

  it('holds exactly the 245000ms legacy reserve the transaction accepts after a checkpoint', async () => {
    // Entry demands 285000ms; the ~15 s entry (run 35615604946), the
    // publisher's bounded work (20 s) and cleanup (5 s) are paid out of the
    // candidate-proof budget, so the guard's own floor is 285000 - 40000 =
    // 245000ms, the LEGACY_MIN_BREAK_REMAINING_MS figure
    // engine-release-transaction.sh reads straight after the checkpoint. The
    // 135-second rollback reserve inside it does not move.
    const guard = readFileSync(
      path.resolve(process.cwd(), 'server/scripts/legacy-engine-checkpoint-guard.mjs'),
      'utf8'
    );
    expect(guard).toContain('const reserveMs = 245000;');
    expect(guard).not.toContain('285000;');
    expect(guard).not.toContain('260000;');
    // The guard also charges its own monotonic elapsed time against the
    // reported remaining, so the admitted case sits two seconds above the
    // floor; every value here was a refusal under the old 285000 pin.
    const boundary = fixture(1, checkpointA0);
    boundary.remaining(247000);
    expect(await boundary.run()).toMatchObject({ ok: true, attemptedTables: 1, verifiedTables: 1 });
    const below = fixture(1, checkpointA0);
    below.remaining(244999);
    expect(await below.run()).toMatchObject({ ok: false, reason: 'insufficient_reserve' });
    expect(below.calls).toEqual([]);
    const mixed = mixedFixture();
    mixed.remaining(247000);
    expect(await mixed.run()).toMatchObject({ ok: true, readyForRestart: true });
  });

  it('retains the a0 original checkpoint generation through the announcement join', async () => {
    const f = fixture(1, checkpointA0);
    f.first.presenceSave = Promise.resolve().then(() => {
      f.first.maintenanceCheckpointGeneration++;
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'native_checkpoint_owner_changed',
      attemptedTables: 0,
    });
    expect(f.calls).toEqual([]);
  });
  it('checkpoints the exact758 original owner with tracked accounting already drained', async () => {
    const f = fixture(1, checkpoint758);
    expect(await f.run()).toMatchObject({
      ok: true,
      attemptedTables: 1,
      verifiedTables: 1,
      paidAccountingQualification: 'native_pending_registry_drained',
      restartAuthorized: false,
    });
    expect(f.calls).toEqual(['parked']);
  });

  it.each([
    'missing-accounting',
    'pending-accounting',
    'unconfirmed-accounting',
    'retained-permit',
    'recovery-in-flight',
    'mixed-pins',
  ])('refuses758 %s before any original write', async (cause) => {
    const f = fixture(1, checkpoint758);
    if (cause === 'missing-accounting')
      Object.assign(f.first, { timeBankAccountingPending: undefined });
    if (cause === 'pending-accounting') f.first.timeBankAccountingPending.add(Promise.resolve());
    if (cause === 'unconfirmed-accounting') f.first.timeBankAccountingUnconfirmed = true;
    if (cause === 'retained-permit') f.first.f06CurrentPermit = {};
    if (cause === 'recovery-in-flight') f.first.f06RecoveryInFlight = true;
    if (cause === 'mixed-pins')
      f.modules.crypto.createHash = () => ({
        update: (bytes: Buffer) => ({ digest: () => pins[bytes[0]] }),
      });
    expect(await f.run()).toMatchObject({
      ok: false,
      attemptedTables: 0,
      restartAuthorized: false,
    });
    expect(f.calls).toEqual([]);
  });

  it.each(['accounting-registry', 'checkpoint-generation'])(
    'refuses758 changed %s after joining original announcement and before writing',
    async (cause) => {
      const f = fixture(1, checkpoint758);
      f.first.presenceSave = Promise.resolve().then(() => {
        if (cause === 'accounting-registry') f.first.timeBankAccountingPending = new Set();
        else f.first.maintenanceCheckpointGeneration++;
      });
      expect(await f.run()).toMatchObject({
        ok: false,
        attemptedTables: 0,
        restartAuthorized: false,
      });
      expect(f.calls).toEqual([]);
    }
  );

  const stopEmpty = (f: ReturnType<typeof fixture>) => {
    Object.assign(f.first, {
      running: false,
      terminal: true,
      teardownPromise: Promise.resolve(),
      dealingLoopPromise: null,
      readContinuationTasks: new Set(),
      maintenancePaused: false,
      holdBeforeNextHand: false,
      handForHandResolve: null,
    });
    f.first.timeBankMeta.clear();
    f.first.timeBankEngine.playerBanks.clear();
    f.first.seatedPlayers = [];
  };

  /* ═══ A PERMIT ON AN ENGINE THAT WILL NEVER RUN AGAIN (2026-09-23) ═══

     This case used to refuse outright and for ever, and that refusal is what
     held every engine release on the platform shut: an F06 permit is resolved
     by the process that holds it and by nothing else, so a permit on a STOPPED,
     TERMINAL engine can only be cleared by replacing the process - which is
     exactly what the refusal prevented. Run 35897820986 is the measurement
     (`captureEngine.f06_custody_not_drained`, `retryAllowed:false`,
     `stopped=true terminal=true banks=0 permitPhase=attempted`).

     It is now DEFERRED and proved from rows, by the same predicate, the same
     three outcomes and the same refusal discipline the boundary deferral
     already uses. A hand in the air still refuses. "Could not tell" still
     refuses. A permit on a LIVE engine still refuses. Only the case where
     waiting cannot help is bounded, and it is NAMED when it is stepped over. */
  it('a retained permit on a stopped, terminal engine is proved from rows and named', async () => {
    const f = fixture(2, checkpoint758);
    stopEmpty(f);
    f.first.f06CurrentPermit = { recoveryState: () => 'attempted' };
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: true,
      unresolvableCustody: `tables=1 attempted=1 ${f.first.tableId}:attempted`,
    });
    // It asked the database, per table, with the one predicate this file has.
    expect(f.snapshotReads.map((read) => read.ids)).toContainEqual([f.first.tableId]);
    // And it survives the publisher's carrier, like every other observation.
    expect(result.unresolvableCustody).toMatch(/^[\w .,:/=()+-]+$/);
    expect(result.unresolvableCustody.length).toBeLessThanOrEqual(512);
  });

  it('a fresh incomplete snapshot for that table is a hand in the air, and refuses', async () => {
    const f = fixture(2, checkpoint758);
    stopEmpty(f);
    f.first.f06CurrentPermit = { recoveryState: () => 'attempted' };
    f.onSnapshots((ids) => ({
      data: [
        {
          table_id: ids[0],
          hand_number: 9,
          stage: 'flop',
          updated_at: new Date().toISOString(),
        },
      ],
      error: null,
    }));
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'f06_custody_unresolvable_unproven',
    });
    expect(f.calls).toEqual([]);
  });

  it('a read the guard could not make is not an empty answer, and refuses', async () => {
    const f = fixture(2, checkpoint758);
    stopEmpty(f);
    f.first.f06CurrentPermit = { recoveryState: () => 'reserved' };
    f.onSnapshots(() => ({ data: null, error: { message: 'statement timeout' } }));
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'f06_custody_unresolvable_unproven',
    });
    expect(f.calls).toEqual([]);
  });

  it('a stopped engine that still holds a live bank keeps the original refusal', async () => {
    const f = fixture(2, checkpoint758);
    Object.assign(f.first, {
      running: false,
      terminal: true,
      teardownPromise: Promise.resolve(),
      dealingLoopPromise: null,
      readContinuationTasks: new Set(),
      maintenancePaused: false,
      holdBeforeNextHand: false,
      handForHandResolve: null,
    });
    f.first.f06CurrentPermit = { recoveryState: () => 'attempted' };
    expect(await f.run()).toMatchObject({
      ok: false,
      attemptedTables: 0,
      reason: 'f06_custody_not_drained',
      paidAccountingQualification: 'native_pending_registry_unqualified',
    });
    expect(f.snapshotReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  /* THE SAME TRAP, ONE LEVEL UP (CLAUDE.md 10.86 rule 4). Admitting the permit
     in the capture and then refusing on the same fact at the final readiness
     check would have moved the wedge rather than removed it: on a predecessor
     whose `unparkedTables()` has no bound - 8825af51, which is what production
     runs - one unresolved preparation holds `readyForRestart()` false for ever.
     The fallback is the identical three-witness rule the release transaction
     already applies to the same boolean, and nothing else may satisfy it. */
  it('readiness accepts a gate held shut only by permits the rows proved quiet', async () => {
    const f = fixture(2, checkpoint758);
    stopEmpty(f);
    f.first.f06CurrentPermit = { recoveryState: () => 'reserved' };
    f.holdGate();
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: true,
      unresolvableCustody: `tables=1 reserved=1 ${f.first.tableId}:reserved`,
    });
  });

  it('readiness refuses when the engine names any reason outside the allow-list', async () => {
    const f = fixture(2, checkpoint758);
    stopEmpty(f);
    f.first.f06CurrentPermit = { recoveryState: () => 'reserved' };
    // An ALLOW-list, never a deny-list: cards in the air, every bank-durability
    // class and anything a future engine invents all keep the gate shut. The
    // count here MATCHES the one preparation this guard can identify, so the
    // allow-list is the only thing that can refuse it.
    f.holdGate({ cards_in_air: 1 });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'native_readiness_refused' });
  });

  it('readiness refuses a blocker the guard cannot put a proved table id to', async () => {
    const f = fixture(2, checkpoint758);
    stopEmpty(f);
    f.first.f06CurrentPermit = { recoveryState: () => 'reserved' };
    // The engine counts two; this guard can identify one. The second is COULD
    // NOT TELL, and it refuses rather than assuming it is the same kind.
    f.holdGate({ f06_preparation_unresolved: 2 });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'native_readiness_refused' });
  });

  /* THE SAME THREE OUTCOMES, IN THE OTHER CAPTURE (2026-09-23).
     `physical()` has carried a three-way rule on
     `terminalBoundaryPendingGenerations` since #5020 and #5021. This capture,
     which walks every table `physical()` does not, demanded a flat zero - so
     run 35927313976 cleared the F06 permit refusal and stopped one require
     later, on the same table, with `boundary=1/false, permitPhase=attempted`,
     which is exactly the shape the other path ADMITS. */
  const deadWithBoundary = (f: ReturnType<typeof fixture>, generations: unknown[]) => {
    stopEmpty(f);
    f.first.terminalBoundaryPendingGenerations = new Set(generations);
  };

  it('one boundary generation on a dead engine holding an attempted permit is admitted', async () => {
    const f = fixture(2, checkpoint758);
    deadWithBoundary(f, [7]);
    f.first.f06CurrentPermit = { recoveryState: () => 'attempted' };
    expect(await f.run()).toMatchObject({
      ok: true,
      unresolvableCustody: `tables=1 attempted=1 ${f.first.tableId}:attempted`,
    });
  });

  it('two of them still refuse: the permit argument admits exactly one', async () => {
    const f = fixture(2, checkpoint758);
    deadWithBoundary(f, [7, 8]);
    f.first.f06CurrentPermit = { recoveryState: () => 'attempted' };
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'engine_work_not_drained',
      failedTable: f.first.tableId,
    });
    expect(f.calls).toEqual([]);
  });

  it('a permit in any other phase keeps the flat zero', async () => {
    const f = fixture(2, checkpoint758);
    deadWithBoundary(f, [7]);
    f.first.f06CurrentPermit = { recoveryState: () => 'reserved' };
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_work_not_drained' });
    expect(f.calls).toEqual([]);
  });

  it('with no permit at all it is deferred and proved from rows, never waved through', async () => {
    const f = fixture(2, checkpoint758);
    deadWithBoundary(f, [7, 8, 9]);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: true,
      unresolvableCustody: `tables=1 boundary=1 ${f.first.tableId}:boundary3`,
    });
    expect(f.snapshotReads.map((read) => read.ids)).toContainEqual([f.first.tableId]);
  });

  it('a hand in the air on that table refuses the abandoned boundary too', async () => {
    const f = fixture(2, checkpoint758);
    deadWithBoundary(f, [7]);
    f.onSnapshots((ids) => ({
      data: [
        { table_id: ids[0], hand_number: 3, stage: 'turn', updated_at: new Date().toISOString() },
      ],
      error: null,
    }));
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'f06_custody_unresolvable_unproven',
    });
    expect(f.calls).toEqual([]);
  });

  it('a LIVE engine with a boundary generation keeps the flat zero', async () => {
    const f = fixture(2, checkpoint758);
    f.first.terminalBoundaryPendingGenerations = new Set([7]);
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_work_not_drained' });
    expect(f.snapshotReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('a set holding anything but a positive integer refuses without a row read', async () => {
    const f = fixture(2, checkpoint758);
    deadWithBoundary(f, [0]);
    f.first.f06CurrentPermit = { recoveryState: () => 'attempted' };
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_work_not_drained' });
    expect(f.snapshotReads).toEqual([]);
  });

  it('a failed boundary persistence is never an allowance', async () => {
    const f = fixture(2, checkpoint758);
    deadWithBoundary(f, [7]);
    f.first.terminalBoundaryPersistenceFailed = true;
    f.first.f06CurrentPermit = { recoveryState: () => 'attempted' };
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_work_not_drained' });
    expect(f.snapshotReads).toEqual([]);
  });

  /* A STICKY "DID NOT SUCCEED" ON A PROCESS THAT IS ALREADY DEAD (2026-09-24).
     Run 35956154940 cleared the boundary-count refusal #5155 bounded and
     stopped on the LAST conjunct of the same proof, on table 6557ebd8, with
     `boundary=0/true, permitPhase=attempted`: an EMPTY pending set and a
     `terminalBoundaryPersistenceFailed` that only
     `beginTerminalBoundaryPersistence` clears, which a stopped terminal engine
     can never reach. */
  const deadWithFailedBoundary = (f: ReturnType<typeof fixture>) => {
    stopEmpty(f);
    f.first.terminalBoundaryPersistenceFailed = true;
  };

  it('a resolved-and-failed boundary on a dead engine is deferred and proved from rows', async () => {
    const f = fixture(2, checkpoint758);
    deadWithFailedBoundary(f);
    f.first.f06CurrentPermit = { recoveryState: () => 'attempted' };
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: true,
      unresolvableCustody: `tables=1 failedBoundary:attempted=1 ${f.first.tableId}:failedBoundary:attempted`,
    });
    expect(f.snapshotReads.map((read) => read.ids)).toContainEqual([f.first.tableId]);
  });

  it('with no permit at all it is deferred to the same row proof', async () => {
    const f = fixture(2, checkpoint758);
    deadWithFailedBoundary(f);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: true,
      unresolvableCustody: `tables=1 failedBoundary:none=1 ${f.first.tableId}:failedBoundary:none`,
    });
    expect(f.snapshotReads.map((read) => read.ids)).toContainEqual([f.first.tableId]);
  });

  it('a hand in the air on that table refuses the failed boundary too', async () => {
    const f = fixture(2, checkpoint758);
    deadWithFailedBoundary(f);
    f.onSnapshots((ids: string[]) => ({
      data: [
        { table_id: ids[0], hand_number: 9, stage: 'flop', updated_at: new Date().toISOString() },
      ],
      error: null,
    }));
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'f06_custody_unresolvable_unproven',
    });
    expect(f.calls).toEqual([]);
  });

  it('a LIVE engine with a failed boundary keeps the flat false, and no row is read', async () => {
    const f = fixture(2, checkpoint758);
    // Empty, parked and live: every OTHER conjunct of the deferral is
    // satisfied, so only "this engine can still run again" refuses it.
    f.first.seatedPlayers = [];
    f.first.timeBankMeta.clear();
    f.first.timeBankEngine.playerBanks.clear();
    f.first.terminalBoundaryPersistenceFailed = true;
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'engine_work_not_drained',
      failedTable: f.first.tableId,
    });
    expect(f.snapshotReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('a permit in any other phase keeps the flat false, and no row is read', async () => {
    const f = fixture(2, checkpoint758);
    deadWithFailedBoundary(f);
    f.first.f06CurrentPermit = { recoveryState: () => 'reserved' };
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_work_not_drained' });
    expect(f.snapshotReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('a dead engine STILL carrying a generation refuses on the count, one conjunct earlier', async () => {
    const f = fixture(2, checkpoint758);
    deadWithFailedBoundary(f);
    f.first.terminalBoundaryPendingGenerations = new Set([7]);
    f.first.f06CurrentPermit = { recoveryState: () => 'attempted' };
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_work_not_drained' });
    expect(f.snapshotReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('a dead engine that still holds a live bank refuses, and no row is read', async () => {
    const f = fixture(2, checkpoint758);
    deadWithFailedBoundary(f);
    f.first.timeBankEngine.playerBanks.set('held', { remainingSeconds: 1 });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_work_not_drained' });
    expect(f.snapshotReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('a retained permit on a LIVE engine still refuses, and no row is read for it', async () => {
    const f = fixture(2, checkpoint758);
    f.first.f06CurrentPermit = { recoveryState: () => 'reserved' };
    expect(await f.run()).toMatchObject({
      ok: false,
      attemptedTables: 0,
      reason: 'f06_custody_not_drained',
      failedCheck: 'captureEngine.f06_custody_not_drained',
      failedTable: f.first.tableId,
    });
    expect(f.snapshotReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  /* AN F06 REFUSAL NAMES THE PHASE ITS DISPOSITION TURNS ON (2026-09-23).

     Production run 35724284646 refused `captureEngine.f06_custody_not_drained`
     at 12:05:23Z on 2026-09-22 on one stopped, terminal tournament table, and
     the detail it carried said only `f06=true/false` - a permit exists. All six
     phases produce that same pair, and they do not share a disposition:
     `attempted` is a hand that may have started and must never be restarted
     over, `terminated` and `number_refused` provably never dealt, and `new`,
     `reserved` and `unknown` are a preparation whose fate the database decides.
     The guard already prints `permitPhase` on the mixed-original boundary field
     for exactly this reason; this carries it on the capture refusal too, so one
     refused attempt is enough to design the disposition. Observability only:
     every pin below keeps the code, the order and the empty call list. */
  const refusedPermit = async (permit: unknown) => {
    const f = fixture(2, checkpoint758);
    // A LIVE engine since 2026-09-23: a permit on a stopped, terminal one is
    // now deferred and proved from rows (see the block above), so the phase
    // observability this law was written for is pinned where the refusal that
    // needs it still happens. The refusal, its code, its order and the empty
    // call list are unchanged.
    f.first.f06CurrentPermit = permit as object;
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'f06_custody_not_drained',
      failedCheck: 'captureEngine.f06_custody_not_drained',
      failedTable: f.first.tableId,
    });
    expect(f.calls).toEqual([]);
    return result;
  };

  it.each(['new', 'reserved', 'unknown', 'attempted', 'terminated', 'number_refused'] as const)(
    'names a retained %s permit by its phase on the capture refusal',
    async (phase) => {
      const result = await refusedPermit({ recoveryState: () => phase });
      expect(terms(result)).toEqual(
        expect.arrayContaining(['f06=true/false', `permitPhase=${phase}`])
      );
      carried(result);
    }
  );

  it('says unreadable, not none, when the retained permit cannot state its phase', async () => {
    // "I could not tell" is its own outcome and never folds into `none`, which
    // this guard uses for "there is no permit at all" (CLAUDE.md 10.86 rule 1).
    const result = await refusedPermit({
      recoveryState: () => {
        throw new Error('permit_unreadable');
      },
    });
    expect(terms(result)).toEqual(
      expect.arrayContaining(['f06=true/false', 'permitPhase=unreadable'])
    );
    // One token pays for the throw; the rest of the record still arrives.
    expect(terms(result)).toEqual(expect.arrayContaining(['stopped=false', 'fleet=2']));
    carried(result);
  });

  it('names the recovery that refused without a permit as none', async () => {
    const f = fixture(2, checkpoint758);
    stopEmpty(f);
    f.first.f06RecoveryInFlight = true;
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'f06_custody_not_drained',
      failedCheck: 'captureEngine.f06_custody_not_drained',
    });
    expect(terms(result)).toEqual(expect.arrayContaining(['f06=false/true', 'permitPhase=none']));
    carried(result);
    expect(f.calls).toEqual([]);
  });

  it('does not accept758 readback from an announcement even after the native ready bit changes', async () => {
    const f = fixture(1, checkpoint758);
    f.onRead((rows) => {
      rows[0].time_bank_snapshot = null;
      return rows;
    });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'checkpoint_readback_mismatch' });
    expect(f.calls).toEqual(['parked']);
  });

  it('joins an empty stopped owner and checkpoints the active owner only', async () => {
    const f = fixture(2);
    stopEmpty(f);
    expect(await f.run()).toMatchObject({ ok: true, attemptedTables: 1, verifiedTables: 1 });
    expect(f.calls).toEqual(['parked']);
  });

  it('refuses a failed teardown before starting any active checkpoint', async () => {
    const f = fixture(2);
    stopEmpty(f);
    Object.assign(f.first, { teardownPromise: Promise.reject(new Error('teardown failed')) });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'previous_native_work_unconfirmed' });
    expect(f.calls).toEqual([]);
  });

  /* A JOIN THAT DID NOT COME BACK NAMES NOTHING (2026-09-24). Run 36008454881
     was the first release since 2026-09-18 whose capture walk refused nothing,
     and it stopped here with no `failedCheck`, no `failedTable` and no detail:
     two different promises across four hundred engines, and not one word about
     which. */
  it('names which join did not come back, on which table, and why', async () => {
    const f = fixture(3);
    stopEmpty(f);
    Object.assign(f.first, {
      teardownPromise: Promise.reject(new Error('retained an unresolved seat-move 4f21e0c2')),
    });
    const other: any = [...f.server.tableEngines.values()][1];
    other.presenceSave = Promise.reject(new Error('park write refused'));
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'previous_native_work_unconfirmed',
      // The stopped owner's two joins come first, in capture order.
      failedCheck: 'previousNativeWork.teardown',
      failedTable: f.first.tableId,
    });
    expect(result.observedDetail).toContain('unfulfilled=2');
    expect(result.observedDetail).toContain('presenceSave=1');
    expect(result.observedDetail).toContain('teardown=1');
    expect(result.observedDetail).toContain(`${other.tableId.slice(0, 8)}:presenceSave`);
    expect(result.observedDetail).toContain(`${f.first.tableId.slice(0, 8)}:teardown`);
    // The engine writes the message, so only letters, spaces and underscores
    // travel: no id, hand number or amount can reach a log through it.
    expect(result.observedDetail).toContain('reason=retained an unresolved seat move');
    expect(result.observedDetail).not.toContain('4f21e0c2');
    expect(result.observedDetail).toMatch(/^[\w .,:/=()+-]+$/);
    expect(result.observedDetail.length).toBeLessThanOrEqual(512);
    expect(f.calls).toEqual([]);
  });

  /* A TEARDOWN A DEAD PROCESS CAN NEVER FINISH is answered from rows on 8825
     ONLY. A later predecessor's `performStop` also records a failure to
     capture a stopped table's time banks in the same AggregateError, so on it
     the exact 8825 sentence can hide an uncaptured bank: it still refuses. */
  it('a later predecessor with the same failed teardown still refuses the join', async () => {
    const f = fixture(2, checkpoint758);
    stopEmpty(f);
    const failure = new AggregateError(
      [new Error('Stopped time bank has no original occupancy')],
      `Table engine ${f.first.tableId} teardown failed in 1 operation(s)`
    );
    const teardownPromise = Promise.reject(failure);
    teardownPromise.catch(() => undefined);
    Object.assign(f.first, { teardownPromise, terminalTeardownComplete: false });
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'previous_native_work_unconfirmed',
      failedCheck: 'previousNativeWork.teardown',
      failedTable: f.first.tableId,
    });
    expect(f.snapshotReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('adds no detail when every join comes back', async () => {
    const f = fixture(2);
    stopEmpty(f);
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: true });
    expect(result.failedCheck).toBeUndefined();
    expect(result.observedDetail).toBeUndefined();
  });

  it('does not drop bank custody from a stopped engine', async () => {
    const f = fixture(2);
    Object.assign(f.first, {
      running: false,
      terminal: true,
      teardownPromise: Promise.resolve(),
      dealingLoopPromise: null,
      readContinuationTasks: new Set(),
    });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'stopped_engine_retains_custody' });
    expect(f.calls).toEqual([]);
  });

  /* A BANK REFUSAL NAMES ITS TABLE, AND THE FLEET THAT HOLDS THE SAME SHAPE
     (2026-09-22). Observability only: every test below pins that the refusal,
     its code and its order are unchanged and nothing is written, and that the
     refusal now names the table, a player-free shape of it, and a census of
     every engine the capture walks. Production run 35620115786 refused
     `bank_metadata_without_bank` at 15:43:34Z on 2026-09-21 naming nothing. */
  const terms = (result: any) => String(result.observedDetail).split(',');
  const carried = (result: any) => {
    // It must survive the publisher's carrier: its character class and cap.
    expect(result.observedDetail).toMatch(/^[\w .,:/=()+-]+$/);
    expect(result.observedDetail.length).toBeLessThanOrEqual(512);
  };

  it('names the table when a stopped engine kept the metadata of the banks its stop disposed', async () => {
    const f = fixture(2);
    // 8825 `stop()` disposes every live bank (`timeBankEngine.disposeAll()`)
    // and keeps `seatedPlayers` and `timeBankMeta`.
    Object.assign(f.first, {
      running: false,
      terminal: true,
      teardownPromise: Promise.resolve(),
      dealingLoopPromise: null,
      readContinuationTasks: new Set(),
    });
    const seated = f.first.seatedPlayers[0].user_id;
    f.first.timeBankEngine.playerBanks.clear();
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_metadata_without_bank',
      failedCheck: 'captureEngine.bank_metadata_without_bank',
      failedTable: f.first.tableId,
    });
    expect(terms(result)).toEqual(
      expect.arrayContaining([
        'stopped=true',
        'seats=1',
        'banks=0',
        'meta=1',
        'metaUnseated=0',
        'metaSeatedWithoutBank=1',
        'bankUnseated=0',
        'fleet=2',
        'fleetStopped=1',
        'fleetStoppedSeatedMeta=1',
        'fleetDepartedMeta=0',
      ])
    );
    carried(result);
    // No player identity leaves the guard.
    expect(JSON.stringify(result)).not.toContain(seated);
    expect(f.calls).toEqual([]);
  });

  it('names the table when a departed player left metadata behind on a parked engine', async () => {
    const f = fixture(2);
    // A voluntary cashout, a seat move or a sit-out eviction removes the seat
    // and the bank and keeps the metadata: 8825 deletes it only in the cash
    // branch of adoptSeatRoster, for a player that branch still sees.
    const departed = f.first.seatedPlayers[0].user_id;
    f.first.seatedPlayers = [];
    f.first.timeBankEngine.playerBanks.clear();
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_metadata_without_bank',
      failedCheck: 'captureEngine.bank_metadata_without_bank',
      failedTable: f.first.tableId,
    });
    expect(terms(result)).toEqual(
      expect.arrayContaining([
        'stopped=false',
        'seats=0',
        'banks=0',
        'metaUnseated=1',
        'metaSeatedWithoutBank=0',
        'fleet=2',
        'fleetStopped=0',
        'fleetDepartedMeta=1',
        'fleetOrphanBank=0',
        'stoppedEvents=none',
      ])
    );
    carried(result);
    expect(JSON.stringify(result)).not.toContain(departed);
    expect(f.calls).toEqual([]);
  });

  it('counts the whole fleet by shape from the first refusal, naming stopped tournaments by prefix only', async () => {
    const f = fixture(3);
    const [stopped, departedAt, bustedAt] = [...f.server.tableEngines.values()];
    // A quarantined manager's stopped engine: its teardown never reached
    // `unregisterTournamentTableEngine`, so it is still in the fleet map with
    // its roster and metadata and none of the banks its stop disposed.
    const authority = { tournamentId: uuid(71001), leaseGeneration: uuid(71002) };
    Object.assign(stopped, {
      running: false,
      terminal: true,
      teardownPromise: Promise.resolve(),
      dealingLoopPromise: null,
      readContinuationTasks: new Set(),
      engineLeaseScope: 'tournament',
      engineLeaseVerified: true,
      engineLeaseTournamentId: authority.tournamentId,
      engineLeaseGeneration: authority.leaseGeneration,
    });
    dataActorContext.bindTournamentDataAuthorityMethods(authority, stopped);
    stopped.timeBankEngine.playerBanks.clear();
    // A cashout: seat and bank gone, metadata kept.
    departedAt.seatedPlayers = [];
    departedAt.timeBankEngine.playerBanks.clear();
    // A tournament bust: the seat is absent from the next roster, and the
    // cash-only teardown never removed the bank or the metadata.
    bustedAt.seatedPlayers = [];
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_metadata_without_bank',
      failedCheck: 'captureEngine.bank_metadata_without_bank',
      failedTable: stopped.tableId,
    });
    expect(terms(result)).toEqual(
      expect.arrayContaining([
        `tournament=${authority.tournamentId}`,
        'scope=tournament',
        'fleet=3',
        'fleetStopped=1',
        'fleetStoppedSeatedMeta=1',
        'fleetLiveSeatedMeta=0',
        'fleetDepartedMeta=2',
        'fleetOrphanBank=1',
        'fleetF06=0',
        'fleetBoundary=0',
        'f06=false/false',
        'settling=0',
        'postTasks=false',
        'moves=0',
        'boundary=0/false',
        `stoppedEvents=${authority.tournamentId.slice(0, 8)}`,
      ])
    );
    carried(result);
    for (const engine of [stopped, departedAt, bustedAt])
      for (const userId of engine.timeBankMeta.keys())
        expect(JSON.stringify(result)).not.toContain(userId);
    expect(f.calls).toEqual([]);
  });

  it('names nothing extra on a refusal that is not a per-engine one', async () => {
    const f = fixture(2);
    f.remaining(1000);
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'insufficient_reserve' });
    expect(String(result.failedCheck ?? '')).not.toMatch(/^captureEngine\./);
    expect(result.observedDetail ?? '').not.toContain('fleet=');
  });

  const bindTournament = (f: ReturnType<typeof fixture>) => {
    const authority = { tournamentId: uuid(70001), leaseGeneration: uuid(70002) };
    Object.assign(f.first, {
      engineLeaseScope: 'tournament',
      engineLeaseVerified: true,
      engineLeaseTournamentId: authority.tournamentId,
      engineLeaseGeneration: authority.leaseGeneration,
    });
    dataActorContext.bindTournamentDataAuthorityMethods(authority, f.first);
    return authority;
  };

  it('preserves the real tournament authority wrappers while saving and reading back', async () => {
    const f = fixture();
    const authority = bindTournament(f);
    const original = f.first.persistPresenceForRestart;
    f.onWrite(() => {
      expect(dataActorContext.currentTournamentDataAuthority()).toMatchObject(authority);
    });
    expect(await f.run()).toMatchObject({ ok: true, verifiedTables: 1 });
    expect(f.first.persistPresenceForRestart).toBe(original);
    expect(dataActorContext.currentTournamentDataAuthority()).toBeNull();
  });

  it('refuses a different tournament generation before saving', async () => {
    const f = fixture();
    bindTournament(f);
    Object.assign(f.first, { engineLeaseGeneration: uuid(77777) });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_authority_invalid' });
    expect(f.calls).toEqual([]);
  });

  it('refuses a replaced tournament method before saving', async () => {
    const f = fixture();
    bindTournament(f);
    f.first.persistPresenceForRestart = async () => undefined;
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_method_mismatch' });
    expect(f.calls).toEqual([]);
  });

  it('refuses to inherit another tournament authority into the fleet operation', async () => {
    const f = fixture();
    const authority = bindTournament(f);
    const result = await dataActorContext.runWithTournamentDataAuthority(authority, () => f.run());
    expect(result).toMatchObject({ ok: false, reason: 'unexpected_tournament_context' });
    expect(f.calls).toEqual([]);
  });

  it('refuses replacement by another valid bound wrapper during the write', async () => {
    const f = fixture();
    const authority = bindTournament(f);
    const native = Object.getPrototypeOf(f.first).persistPresenceForRestart;
    f.onWrite(() => {
      f.first.persistPresenceForRestart = dataActorContext.bindTournamentDataAuthority(
        authority,
        native
      );
    });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'engine_method_changed' });
    expect(f.calls).toHaveLength(1);
  });

  it('joins the native announcement before a parked write and verifies every saved field', async () => {
    const f = fixture();
    f.first.presenceSave = Promise.resolve().then(() => {
      f.rows.set(f.first.tableId, { time_bank_snapshot: null });
    });
    const result = await f.run();
    expect(result).toMatchObject({
      ok: true,
      attemptedTables: 1,
      completedCalls: 1,
      verifiedTables: 1,
      bankCount: 1,
      restartAuthorized: false,
      paidAccountingQualification: 'legacy_untracked',
    });
    expect(f.calls).toEqual(['parked']);
    expect(f.rows.get(f.first.tableId).time_bank_snapshot.players[uuid(10001)]).toEqual({
      occupancyId: uuid(20001),
      remainingSeconds: 75,
      usesRemaining: 2,
      initialSeconds: 90,
      baseSeconds: 30,
      dbConsumedSeconds: 15,
    });
  });

  it.each([
    [
      'active hand',
      (f: ReturnType<typeof fixture>) => {
        f.first.handController = {};
      },
    ],
    [
      'settlement',
      (f: ReturnType<typeof fixture>) => {
        f.first.settlementInFlight.add(Promise.resolve());
      },
    ],
    [
      'unheld pause',
      (f: ReturnType<typeof fixture>) => {
        f.first.handForHandResolve = null as any;
      },
    ],
    [
      'active bank',
      (f: ReturnType<typeof fixture>) => {
        [...f.first.timeBankEngine.playerBanks.values()][0].isActive = true;
      },
    ],
    [
      'missing metadata',
      (f: ReturnType<typeof fixture>) => {
        f.first.timeBankMeta.clear();
      },
    ],
    [
      'invalid occupancy',
      (f: ReturnType<typeof fixture>) => {
        f.first.seatedPlayers[0].occupancy_id = null;
      },
    ],
    [
      'insufficient reserve',
      (f: ReturnType<typeof fixture>) => {
        f.remaining(244999);
      },
    ],
    [
      'wrong source',
      (f: ReturnType<typeof fixture>) => {
        f.options.expectedReleaseSha = 'f'.repeat(40);
      },
    ],
    [
      'unconfirmed freeze',
      (f: ReturnType<typeof fixture>) => {
        f.server.maintenanceBreak.durableConfirmed = false;
      },
    ],
    [
      'changed compiled bytes',
      (f: ReturnType<typeof fixture>) => {
        f.modules.fs.readFileSync = () => Buffer.from([9]);
      },
    ],
  ])('refuses %s before invoking a native write', async (_label, change) => {
    const f = fixture();
    change(f);
    expect(await f.run()).toMatchObject({
      ok: false,
      attemptedTables: 0,
      restartAuthorized: false,
    });
    expect(f.calls).toEqual([]);
  });

  it('refuses zero or ambiguous server discovery', async () => {
    for (const count of [0, 2]) {
      const f = fixture();
      expect(await f.run(Array(count).fill(f.server))).toMatchObject({
        ok: false,
        reason: 'server_not_unique',
      });
      expect(f.calls).toEqual([]);
    }
  });

  it.each([
    [
      'announcement overwrite',
      (data: any[]) => {
        data[0].time_bank_snapshot = null;
        return data;
      },
    ],
    ['incomplete readback', () => []],
    [
      'wrong occupancy',
      (data: any[]) => {
        data[0].time_bank_snapshot.players[uuid(10001)].occupancyId = uuid(999);
        return data;
      },
    ],
    [
      'wrong bank amount',
      (data: any[]) => {
        data[0].time_bank_snapshot.players[uuid(10001)].remainingSeconds++;
        return data;
      },
    ],
    [
      'wrong instance',
      (data: any[]) => {
        data[0].engine_instance = '1-deadbeef:parked';
        return data;
      },
    ],
  ])('refuses %s even when the native ready bit is true', async (_label, mutate) => {
    const f = fixture();
    f.onRead(mutate);
    const result = await f.run();
    expect(f.first.parkedBankSaveComplete).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      checkpointOutcome: 'unconfirmed',
      restartAuthorized: false,
    });
    expect(f.calls).toHaveLength(1);
  });

  it('refuses a changed presence writer without assigning readiness or retrying', async () => {
    const f = fixture();
    f.onWrite((engine) => {
      engine.presenceSave = Promise.resolve();
    });
    expect(await f.run()).toMatchObject({ ok: false, reason: 'presence_writer_changed' });
    expect(f.calls).toEqual(['parked']);
  });

  it('stops new work when time is exhausted and joins already started writes', async () => {
    const f = fixture(40);
    let finished = 0;
    f.onWrite(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      finished++;
      f.remaining(244999);
    });
    const result = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'insufficient_reserve' });
    expect(f.calls.length).toBe(32);
    expect(finished).toBe(32);
    expect(result.completedCalls).toBe(32);
  });

  it('does not invent a bank for a player who has never been dealt in', async () => {
    const f = fixture();
    f.first.timeBankMeta.clear();
    f.first.timeBankEngine.playerBanks.clear();
    expect(await f.run()).toMatchObject({
      ok: true,
      attemptedTables: 0,
      bankCount: 0,
      uninitializedSeats: 1,
    });
    expect(f.calls).toEqual([]);
  });
});

// The old-image branch runs the same guard and actual synchronous ownership CAS.
// No inspector, database or production game is attached by these fixtures.
function mixedFixture() {
  const f = fixture(1, checkpoint8825);
  const events = ['5a387a75-754a-416e-8fee-b85b15fc2702', '615783bf-15e3-40b7-9368-75f21b6ac53b'];
  const receipts = new Map();
  /* `rpcCalls` is the custody TRANSFER traffic: every prepare (observe and
     commit) and the readback that follows a commit. Since 2026-09-25 the guard
     asks the rows FIRST, per retained manager and before any prepare, whether
     it already sealed that manager's transfer in an earlier run; those
     `fn_f06_find_mixed_manager_custody` lookups are reads, write nothing, and
     are kept apart in `probes` so "transfers nothing, retires nothing" keeps
     meaning exactly that. A find for a tournament nothing has prepared is a
     probe; a find after a prepare for it is the readback, as before. */
  const rpcCalls: string[] = [];
  const probes: string[] = [];
  const prepared = new Set<string>();
  let onRpc: ((name: string, input: any) => void) | undefined;
  let onProbe: ((tournamentId: string) => void) | undefined;
  let changeResponse: ((name: string, data: any) => any) | undefined;
  // `changeResponse` can only reshape a SUCCESSFUL answer. A refusal the
  // database raises arrives as `{ data: null, error }`, which is the shape the
  // live run met, so the whole response has to be replaceable to model it.
  let onRpcResponse:
    | ((name: string, answer: { data: any; error: any }) => { data: any; error: any } | undefined)
    | undefined;
  class Manager {
    gameServer = f.server;
    tournamentId: string;
    tournamentLeaseGeneration: string;
    tournamentMoveBoundaryOwner: string;
    managerLifecycleDiagnostics: any;
    tableEngines = new Map();
    drainedF06Originals: any[];
    tournamentSeatMoveSerialTail = Promise.resolve();
    tournamentSeatMoveAuthorityRevision = 1;
    pendingTableBreakRetirement = null;
    retainedTournamentBreakSources = new Map();
    activeStoppedOriginalCustody = new Set();
    pendingNoStartContinuations = new Map();
    stoppedOriginalBreaks = new Map();
    tournamentBreakArrivalWakes = new Map();
    tableEngineRecoveryTimers = new Map();
    durableTournamentBreaks = new Map();
    pendingTournamentSeatMoveOutcomes = new Map();
    pendingTournamentParkRequests = new Map();
    pendingTournamentBreakBegins = new Map();
    pendingTournamentBreakAmendments = new Map();
    rejectedTournamentBreakBegins = new Map();
    resolvedTournamentBreakProposals = new Map();
    pendingTournamentBreakCustodyIds = new Map();
    pendingTournamentCleanupKinds = new Map();
    lifecycleJobs = new Set();
    tableEngineStartJobs = new Set();
    tableEngineRunJobs = new Set();
    eliminationSchedulerJobs = new Set();
    lifecycleTimeouts = new Set();
    lifecycleIntervals = new Set();
    constructor(event: string, n: number, engine: any) {
      this.tournamentId = event;
      this.tournamentLeaseGeneration = uuid(80000 + n);
      this.tournamentMoveBoundaryOwner = uuid(81000 + n);
      this.managerLifecycleDiagnostics = { instanceId: uuid(82000 + n) };
      this.tableEngines.set(engine.tableId, engine);
      this.drainedF06Originals = [[engine.tableId, engine]];
      this.retainedTournamentBreakSources.set(engine.tableId, { breakId: uuid(83000 + n), engine });
      this.pendingTournamentSeatMoveOutcomes.set(uuid(84000 + n), {
        input: { requestId: uuid(84000 + n) },
        move: { chips: 10 },
      });
    }
    /* How the live 8825 manager answers under its stop-retry loop: `shared`
       is the one frozen array; `fresh` is a NEW equal-content array per call
       (each `stopTournamentManagerIfOwned` retry rebuilds it); `stopping` is
       the null it returns while a retry's `teardownPromise` is set. */
    captureMode: 'shared' | 'fresh' | 'stopping' = 'shared';
    captureDrainedF06Originals() {
      if (this.captureMode === 'stopping') return null;
      if (this.captureMode === 'fresh')
        return Object.freeze(this.drainedF06Originals.map((pair) => [...pair]));
      return this.drainedF06Originals;
    }
  }
  const originals = events.map((event, n) => {
    const e: any = new f.Table(100 + n);
    e.running = false;
    e.terminal = true;
    e.terminalTeardownComplete = true;
    e.teardownPromise = Promise.resolve();
    e.dealingLoopPromise = null;
    e.seatBoundaryTail = Promise.resolve();
    e.snapshotFlushPromise = null;
    e.readContinuationTasks = new Set();
    e.tournamentMoveOperationByOwner = new Map();
    e.entryHoldWriteChains = new Map();
    e.f06HandPreparation = null;
    e.f06AllocationEpoch = null;
    e.lifecycleDiagnostics = { instanceId: uuid(85000 + n) };
    e.engineLeaseScope = 'tournament';
    e.engineLeaseVerified = true;
    e.engineLeaseTournamentId = event;
    e.engineLeaseGeneration = uuid(80000 + n);
    e.hasOnlyDrainedTournamentMoveOwner = () => true;
    e.timeBankEngine.playerBanks.clear();
    e.timeBankMeta.clear();
    e.f06CurrentPermit = new F06HandPermit(
      {
        tournament_id: event,
        lease_generation: e.engineLeaseGeneration,
        table_id: e.tableId,
        lifecycle: '1',
        permit_id: uuid(86000 + n),
        custody_id: uuid(87000 + n),
        hand_number: '17',
      },
      async () => {
        throw new Error('permit must never be actuated');
      },
      () => false
    );
    e.f06CurrentPermit.phase = 'reserved';
    const manager = new Manager(event, n, e);
    dataActorContext.bindTournamentDataAuthorityMethods(
      { tournamentId: event, leaseGeneration: e.engineLeaseGeneration },
      e
    );
    dataActorContext.bindTournamentDataAuthorityMethods(
      { tournamentId: event, leaseGeneration: e.engineLeaseGeneration },
      manager
    );
    f.server.tournamentEngines.set(event, manager);
    f.server.tableEngines.set(e.tableId, e);
    f.server.tournamentOwnedTables.add(e.tableId);
    return { engine: e, manager };
  });
  Object.assign(f.modules, {
    manager: { TournamentManager: Manager },
    managerBase: { TournamentManagerBase: Manager },
    permit: { F06HandPermit },
    retirement: { TournamentRetirementCustody },
  });
  const intent = {
    source: checkpoint8825,
    instance: '1-3846b8bb',
    container: 'c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66',
    startedAt: '2026-09-18T21:55:50.88305198Z',
    hostPid: 1231816,
    runId: '123-1',
    controlSha: 'a'.repeat(40),
    retryAllowed: false,
    custody: events.map((tournament_id, n) => ({
      tournament_id,
      transfer_id: uuid(88000 + n),
      successor_generation: uuid(89000 + n),
    })),
  };
  Object.assign(f.options, { custodyIntent: intent });
  const arrivalReads: { table: string; occupancies: string[] }[] = [];
  const arrivalPlayerReads: { players: string[] }[] = [];
  const perTableArrivalReads: { table: string; occupancies: string[] }[] = [];
  // 'perPlayer' is production once migration 20260924190214 is applied;
  // 'missing' is the box before it, where PostgREST answers PGRST202 and the
  // guard asks the per-table question exactly as before.
  let batchArrivals: 'perPlayer' | 'missing' = 'perPlayer';
  let onArrivals: ((table: string, occupancies: string[]) => { data: any; error: any }) | undefined;
  let onArrivalsForPlayers: ((players: string[]) => { data: any; error: any }) | undefined;
  let lifecycleWitness: 'permits' | 'never_reserved' | 'unmarked' = 'never_reserved';
  Object.assign(f.modules.client.supabase, {
    rpc: async (name: string, input: any) => {
      if (name === 'fn_cash_seat_move_arrivals_for_players') {
        expect(Object.keys(input)).toEqual(['p_player_ids']);
        expect(input.p_player_ids.length).toBeLessThanOrEqual(500);
        arrivalPlayerReads.push({ players: [...input.p_player_ids] });
        if (batchArrivals === 'missing')
          return { data: null, error: { code: 'PGRST202', message: 'function not found' } };
        if (onArrivalsForPlayers) return onArrivalsForPlayers(input.p_player_ids);
        // The union of the per-table answers for every open seat these
        // players hold, which is what the batched function returns.
        const data: any[] = [];
        for (const row of f.openRows) {
          if (!input.p_player_ids.includes(row.user_id)) continue;
          arrivalReads.push({ table: row.table_id, occupancies: [row.occupancy_id] });
          const answer = onArrivals ? onArrivals(row.table_id, [row.occupancy_id]) : { data: [] };
          if (answer?.error) return answer;
          data.push(...(answer.data ?? []));
        }
        return { data, error: null };
      }
      if (name === 'fn_cash_seat_move_arrivals') {
        expect(Object.keys(input).sort()).toEqual(['p_occupancy_ids', 'p_table_id']);
        arrivalReads.push({ table: input.p_table_id, occupancies: [...input.p_occupancy_ids] });
        perTableArrivalReads.push({
          table: input.p_table_id,
          occupancies: [...input.p_occupancy_ids],
        });
        return onArrivals
          ? onArrivals(input.p_table_id, input.p_occupancy_ids)
          : { data: [], error: null };
      }
      // `onRpc` models something moving DURING a custody transfer call, after
      // the originals were captured; a probe precedes that capture and is
      // hooked by `onProbe` instead.
      const probe =
        name === 'fn_f06_find_mixed_manager_custody' && !prepared.has(input.p_tournament_id);
      if (probe) probes.push(input.p_tournament_id);
      else rpcCalls.push(name);
      if (name === 'fn_f06_prepare_mixed_manager_custody') prepared.add(input.p_tournament_id);
      if (probe) onProbe?.(input.p_tournament_id);
      else onRpc?.(name, input);
      let data: any;
      if (name === 'fn_f06_prepare_mixed_manager_custody') {
        const canonical = {
          // smarter_private.f06_mixed_custody_snapshot (migration
          // 20260924225647): every allocation-backed engine is witnessed, from
          // its permit rows when it reserved, by their absence when it never did.
          engine_lifecycles: input.p_local.engines
            .filter((e: any) => e.permit === null && e.allocation_epoch !== null)
            .map((e: any) =>
              lifecycleWitness === 'permits'
                ? {
                    table_id: e.table_id,
                    allocation_epoch: e.allocation_epoch,
                    lifecycle: '1',
                    witness: 'permits',
                    permits: [
                      {
                        permit_id: uuid(91000),
                        tournament_id: input.p_tournament_id,
                        generation: input.p_origin_generation,
                        table_id: e.table_id,
                        custody_id: e.allocation_epoch,
                        lifecycle: 1,
                        state: 'accepted',
                      },
                    ],
                  }
                : lifecycleWitness === 'never_reserved'
                  ? {
                      table_id: e.table_id,
                      allocation_epoch: e.allocation_epoch,
                      lifecycle: '1',
                      witness: 'never_reserved',
                      permits: [],
                    }
                  : {
                      // The database before migration 20260924225647 could not
                      // answer this shape at all; a receipt naming neither
                      // witness is what an old body would look like if it did.
                      table_id: e.table_id,
                      allocation_epoch: e.allocation_epoch,
                      lifecycle: '1',
                      permits: [],
                    }
            ),
          pending_original_tables: [],
          original_evidence: input.p_local.engines
            .filter((e: any) => e.permit)
            .map((e: any) => ({
              binding: e.permit.binding,
              permit: { ...e.permit.binding, state: 'aborted_unsettled', evidence_id: uuid(90000) },
              evidence: {
                hand: { receipt_id: uuid(90000), permit_id: e.permit.binding.permit_id },
                receipt: {
                  receipt_id: uuid(90000),
                  outcome: 'aborted_unsettled',
                  expected: {
                    kind: 'retained_mtt_interruption_v1',
                    physical: {
                      manager_id: input.p_local.manager_id,
                      engine_id: e.engine_id,
                      container_id: intent.container,
                    },
                  },
                },
              },
            })),
        };
        const receipt = input.p_expected
          ? {
              transfer_id: input.p_transfer_id,
              tournament_id: input.p_tournament_id,
              origin_generation: input.p_origin_generation,
              successor_generation: input.p_successor_generation,
              local_proof: structuredClone(input.p_local),
              canonical_proof: canonical,
            }
          : null;
        if (receipt) receipts.set(input.p_tournament_id, receipt);
        data = {
          ok: true,
          transfer_id: input.p_transfer_id,
          tournament_id: input.p_tournament_id,
          origin_generation: input.p_origin_generation,
          successor_generation: input.p_successor_generation,
          local: input.p_local,
          canonical,
          receipt,
        };
      } else {
        expect(name).toBe('fn_f06_find_mixed_manager_custody');
        data = {
          ok: true,
          tournament_id: input.p_tournament_id,
          receipt: receipts.get(input.p_tournament_id),
        };
      }
      const changed = changeResponse ? changeResponse(name, data) : data;
      // From #5218: a PostgREST refusal travels as `error.message` with no data.
      const answer =
        changed && changed.__rpcError
          ? { error: changed.__rpcError, data: null }
          : { error: null, data: changed };
      return onRpcResponse ? (onRpcResponse(name, answer) ?? answer) : answer;
    },
  });
  /* A SECOND original on one manager holding NO permit at all - the shape the
     rows actually show for the derelict table. Its hand resolved and cleared
     `f06CurrentPermit`, while `terminalBoundaryPendingGenerations` kept the
     integer that nothing downstream of HAND_COMPLETE can ever resolve. The
     manager keeps its interrupted sibling, so `originalDispositions === 1` -
     which this profile has required since long before #5011 - still holds.
     With no permit to carry it, the lifecycle witness is the retained break. */
  const abandonedOriginal = (managerIndex = 0) => {
    const { manager } = originals[managerIndex];
    const e: any = new f.Table(300 + managerIndex);
    e.running = false;
    e.terminal = true;
    e.terminalTeardownComplete = true;
    e.teardownPromise = Promise.resolve();
    e.dealingLoopPromise = null;
    e.seatBoundaryTail = Promise.resolve();
    e.snapshotFlushPromise = null;
    e.readContinuationTasks = new Set();
    e.tournamentMoveOperationByOwner = new Map();
    e.entryHoldWriteChains = new Map();
    e.f06HandPreparation = null;
    e.f06AllocationEpoch = null;
    e.f06CurrentPermit = null;
    e.lifecycleDiagnostics = { instanceId: uuid(85500 + managerIndex) };
    e.engineLeaseScope = 'tournament';
    e.engineLeaseVerified = true;
    e.engineLeaseTournamentId = manager.tournamentId;
    e.engineLeaseGeneration = manager.tournamentLeaseGeneration;
    e.hasOnlyDrainedTournamentMoveOwner = () => true;
    e.timeBankEngine.playerBanks.clear();
    e.timeBankMeta.clear();
    const breakId = uuid(83500 + managerIndex);
    manager.retainedTournamentBreakSources.set(e.tableId, { breakId, engine: e });
    manager.durableTournamentBreaks.set(breakId, { lifecycle: '1' });
    manager.tableEngines.set(e.tableId, e);
    manager.drainedF06Originals.push([e.tableId, e]);
    dataActorContext.bindTournamentDataAuthorityMethods(
      { tournamentId: manager.tournamentId, leaseGeneration: manager.tournamentLeaseGeneration },
      e
    );
    f.server.tableEngines.set(e.tableId, e);
    f.server.tournamentOwnedTables.add(e.tableId);
    return e;
  };
  /* A WAITING TABLE: admitted under this generation (allocator installed, so
     it holds an epoch), stopped before it ever dealt, so no permit was ever
     reserved under that epoch and no witness for its lifecycle exists in
     memory. Tournament 5a387a75 holds seven of these (run 36068474418). */
  const waitingOriginal = (managerIndex = 0, n = 0) => {
    const { manager } = originals[managerIndex];
    const e: any = new f.Table(400 + managerIndex * 10 + n);
    e.running = false;
    e.terminal = true;
    e.terminalTeardownComplete = true;
    e.teardownPromise = Promise.resolve();
    e.dealingLoopPromise = null;
    e.seatBoundaryTail = Promise.resolve();
    e.snapshotFlushPromise = null;
    e.readContinuationTasks = new Set();
    e.tournamentMoveOperationByOwner = new Map();
    e.entryHoldWriteChains = new Map();
    e.f06HandPreparation = null;
    e.f06AllocationEpoch = uuid(92000 + managerIndex * 10 + n);
    e.f06Allocator = async () => 1;
    e.f06AllocationCurrent = () => false;
    e.f06PermitFactory = async () => {
      throw new Error('never dealt');
    };
    e.f06CurrentPermit = null;
    e.lifecycleDiagnostics = { instanceId: uuid(85600 + managerIndex * 10 + n) };
    e.engineLeaseScope = 'tournament';
    e.engineLeaseVerified = true;
    e.engineLeaseTournamentId = manager.tournamentId;
    e.engineLeaseGeneration = manager.tournamentLeaseGeneration;
    e.hasOnlyDrainedTournamentMoveOwner = () => true;
    e.timeBankEngine.playerBanks.clear();
    e.timeBankMeta.clear();
    manager.tableEngines.set(e.tableId, e);
    manager.drainedF06Originals.push([e.tableId, e]);
    dataActorContext.bindTournamentDataAuthorityMethods(
      { tournamentId: manager.tournamentId, leaseGeneration: manager.tournamentLeaseGeneration },
      e
    );
    f.server.tableEngines.set(e.tableId, e);
    f.server.tournamentOwnedTables.add(e.tableId);
    return e;
  };
  /* Take the interrupted permit off a manager's FIRST original, leaving it the
     lifecycle witness a permit used to carry - so the run reaches the custody
     proof rather than stopping at `mixed_original_lifecycle_unproven` and
     telling us nothing about the disposition. */
  const clearInterruptedPermit = (managerIndex = 0) => {
    const { engine, manager } = originals[managerIndex];
    engine.f06CurrentPermit = null;
    manager.durableTournamentBreaks.set(uuid(83000 + managerIndex), { lifecycle: '1' });
    return engine;
  };
  return {
    ...f,
    // Each guard run classifies its own finds: a run that prepares nothing
    // makes probes only.
    run: (discovered?: any[]) => {
      prepared.clear();
      return f.run(discovered);
    },
    Manager,
    intent,
    originals,
    abandonedOriginal,
    waitingOriginal,
    clearInterruptedPermit,
    lifecycleWitness: (mode: typeof lifecycleWitness) => {
      lifecycleWitness = mode;
    },
    receipts,
    rpcCalls,
    probes,
    events,
    arrivalReads,
    arrivalPlayerReads,
    perTableArrivalReads,
    batchArrivals: (mode: typeof batchArrivals) => {
      batchArrivals = mode;
    },
    onArrivalsForPlayers: (cb: typeof onArrivalsForPlayers) => {
      onArrivalsForPlayers = cb;
    },
    onArrivals: (cb: typeof onArrivals) => {
      onArrivals = cb;
    },
    onRpc: (cb: typeof onRpc) => {
      onRpc = cb;
    },
    onProbe: (cb: typeof onProbe) => {
      onProbe = cb;
    },
    changeResponse: (cb: typeof changeResponse) => {
      changeResponse = cb;
    },
    onRpcResponse: (cb: typeof onRpcResponse) => {
      onRpcResponse = cb;
    },
  };
}

describe('exact 8825 retained original custody retirement', () => {
  it('keeps native readiness false until durable zero-credit custody and exact native CAS', async () => {
    const f = mixedFixture();
    expect(f.server.maintenanceBreak.readyForRestart()).toBe(false);
    const identities = f.originals.map(({ engine, manager }) => [
      engine.f06CurrentPermit,
      manager.pendingTournamentSeatMoveOutcomes,
    ]);
    expect(await f.run()).toMatchObject({
      ok: true,
      restartAuthorized: false,
      readyForRestart: true,
    });
    expect(f.receipts.size).toBe(2);
    expect(f.server.maintenanceBreak.readyForRestart()).toBe(true);
    f.originals.forEach(({ engine, manager }, i) => {
      expect(f.server.tableEngines.has(engine.tableId)).toBe(false);
      expect(manager.tableEngines.get(engine.tableId)).toBe(engine);
      expect(engine.f06CurrentPermit).toBe(identities[i][0]);
      expect(engine.f06CurrentPermit.recoveryState()).toBe('reserved');
      expect(manager.pendingTournamentSeatMoveOutcomes).toBe(identities[i][1]);
      expect(manager.pendingTournamentSeatMoveOutcomes.size).toBe(1);
    });
  });
  it.each([
    [
      'replaced global original',
      (f: any) => f.server.tableEngines.set(f.originals[0].engine.tableId, new f.Table(500)),
    ],
    [
      'pending read continuation',
      (f: any) => f.originals[0].engine.readContinuationTasks.add(Promise.resolve()),
    ],
    [
      'unknown accounting',
      (f: any) => (f.originals[0].engine.timeBankAccountingUnconfirmed = true),
    ],
    [
      'in-flight permit',
      (f: any) => (f.originals[0].engine.f06CurrentPermit.reserveInFlight = true),
    ],
    [
      'in-flight manager work',
      (f: any) => f.originals[0].manager.lifecycleJobs.add(Promise.resolve()),
    ],
    [
      'missing pending map',
      (f: any) => (f.originals[0].manager.pendingTournamentParkRequests = undefined),
    ],
    ['insufficient reserve', (f: any) => f.remaining(244999)],
    [
      'unrestorable prior bank',
      (f: any) =>
        f.originals[0].engine.timeBankMeta.set(uuid(10100), {
          initialSeconds: 90,
          baseSeconds: 30,
          dbConsumedSeconds: 0,
        }),
    ],
    ['changed process', (f: any) => (f.intent.container = 'b'.repeat(64))],
  ])('refuses %s without any retirement', async (_label, alter) => {
    const f = mixedFixture();
    alter(f);
    expect((await f.run()).ok).toBe(false);
    expect(f.server.tableEngines.size).toBe(3);
    expect(f.rpcCalls).toEqual([]);
  });
  // The live 8825 lease-loss pass re-runs `stopTournamentManagerIfOwned` every
  // ~5 s for the retained managers. Each retry bumps the seat move authority
  // revision and replaces the serial tail without moving any custody, so
  // neither is pinned any more: a bump during either RPC passes.
  it.each(['fn_f06_prepare_mixed_manager_custody', 'fn_f06_find_mixed_manager_custody'])(
    'tolerates a seat move revision bump and a replaced serial tail across %s',
    async (name) => {
      const f = mixedFixture();
      f.onRpc((called) => {
        if (called !== name) return;
        for (const { manager } of f.originals) {
          manager.tournamentSeatMoveAuthorityRevision++;
          manager.tournamentSeatMoveSerialTail = Promise.resolve();
        }
      });
      expect(await f.run()).toMatchObject({ ok: true, readyForRestart: true });
      expect(f.receipts.size).toBe(2);
      expect(f.server.tableEngines.size).toBe(1);
    }
  );
  /* A RAISED REFUSAL IS NOT AN ANSWER OF "NO" (2026-09-24). Run 36068474418
     attempted 62 tables, completed 62 and read back and verified all 62, then
     refused `mixed_custody_rpc_unknown` naming nothing at all. The whole
     diagnosis - `POST fn_f06_prepare_mixed_manager_custody` answering 400 with
     SQLSTATE P0001 - lived in the Supabase edge log, outside the run, and the
     Postgres log that held the refusal token itself had aged out before anyone
     read it. The three facts that one code collapsed are now told apart and the
     database's own SQLSTATE and token travel with the refusal. The reason
     string, the stage and the outcome do not move. */
  const raised = (code: string, message: string) => () => ({
    data: null,
    error: { code, message },
  });
  it.each([
    [
      'a refusal the database raised',
      raised('P0001', 'F06_MIXED_OLD_LEASE_CHANGED'),
      'rpc.transport',
      'sqlstate=P0001,refusal=F06_MIXED_OLD_LEASE_CHANGED',
    ],
    /* Half the SQLSTATEs this function can raise begin with a digit -
       `F06_RETRY_MAINTENANCE_LANE` is 40001 - and a digit is exactly what an
       identifier-shaped reader throws away. The code is the half of the answer
       that says whether a refusal is a retry, a permission or a rule. */
    [
      'a refusal whose SQLSTATE begins with a digit',
      raised('40001', 'F06_RETRY_MAINTENANCE_LANE'),
      'rpc.transport',
      'sqlstate=40001,refusal=F06_RETRY_MAINTENANCE_LANE',
    ],
    ['a body that is not a record', () => ({ data: [], error: null }), 'rpc.body', 'body=Array(0)'],
    [
      'a body that says no',
      (_name: string, answer: any) => ({ ...answer, data: { ...answer.data, ok: false } }),
      'rpc.ok',
      'ok=false',
    ],
  ])(
    'names which fact the mixed custody RPC lacked: %s',
    async (_label, respond, failedCheck, detail) => {
      const f = mixedFixture();
      f.onRpcResponse((name: string, answer: any) =>
        name === 'fn_f06_prepare_mixed_manager_custody' ? (respond as any)(name, answer) : undefined
      );
      const result: any = await f.run();
      expect(result).toMatchObject({
        ok: false,
        reason: 'mixed_custody_rpc_unknown',
        stage: 'mixed_custody',
        checkpointOutcome: 'unconfirmed',
        restartAuthorized: false,
        failedCheck,
        failedField: 'fn_f06_prepare_mixed_manager_custody',
      });
      expect(result.observedDetail).toContain(detail);
    }
  );
  /* The token is carried because it NAMES the refusal, not because a message is
     safe. Anything that is not a bare upper-case refusal token is reduced to its
     length, so a message that carried a hand, a player or a credential could not
     export it through the receipt. */
  it('carries a refusal token that names its key (2026-09-25)', async () => {
    // Run 36095932476, the 04:55 recovery window: the second retained manager
    // refused `F06_RETIRED_CANONICAL_CHANGED: registrations` and the receipt
    // said `refusal=string(44)`. The key is the finding.
    const f = mixedFixture();
    f.onRpcResponse((name: string) =>
      name === 'fn_f06_prepare_mixed_manager_custody'
        ? raised('P0001', 'F06_RETIRED_CANONICAL_CHANGED: registrations')()
        : undefined
    );
    const result: any = await f.run();
    expect(result.reason).toBe('mixed_custody_rpc_unknown');
    expect(result.observedDetail).toContain('refusal=F06_RETIRED_CANONICAL_CHANGED: registrations');
  });

  it('reduces a refusal message that is not a bare token to its length', async () => {
    const f = mixedFixture();
    f.onRpcResponse((name: string) =>
      name === 'fn_f06_prepare_mixed_manager_custody'
        ? raised('P0001', 'As Kd for user 046718c5')()
        : undefined
    );
    const result: any = await f.run();
    expect(result.reason).toBe('mixed_custody_rpc_unknown');
    expect(result.observedDetail).toContain('refusal=string(23)');
    expect(result.observedDetail).not.toContain('Kd');
    expect(result.observedDetail).not.toContain('046718c5');
  });
  // A preflight refusal used to name only its code. These conjunctions are wide
  // and run against live state, so the code alone cost a deploy to interpret.
  // Each sub-condition now reports itself, and the fixture proves it. What is
  // pinned is the custody the RPC names: the tournament, its lease generation
  // and the manager that owns them.
  it.each([
    [
      'lease generation',
      (f: any) => (f.originals[0].manager.tournamentLeaseGeneration = uuid(99000)),
      'manager.tournamentLeaseGeneration',
    ],
    [
      'manager swap',
      (f: any) =>
        f.server.tournamentEngines.set(
          f.originals[0].manager.tournamentId,
          new f.Manager(f.originals[0].manager.tournamentId, 7, f.originals[0].engine)
        ),
      'managerMap.get(tournamentId)',
    ],
    [
      'tournament id',
      (f: any) => (f.originals[0].manager.tournamentId = uuid(99001)),
      'manager.tournamentId',
    ],
  ])(
    'names the sub-condition when the manager vector moves: %s',
    async (_label, alter, failedCheck) => {
      const f = mixedFixture();
      const tournamentId = f.originals[0].manager.tournamentId;
      // It has to move DURING the run: a change before `run()` is simply the
      // baseline the capture takes.
      f.onRpc(() => alter(f));
      const result = await f.run();
      expect(result).toMatchObject({
        ok: false,
        reason: 'mixed_owner_changed',
        failedCheck,
      });
      // The carried key names the captured tournament, the lease generation
      // and every drain condition, because an unlisted key never survives
      // `legacy-engine-checkpoint.mjs` (#5034).
      expect(result.observedDetail).toContain(`capturedTournament=${tournamentId}`);
      expect(result.observedDetail).toContain(`tournament=${f.originals[0].manager.tournamentId}`);
      expect(result.observedDetail).toMatch(/lease=/);
      expect(result.observedDetail).toMatch(/drain=/);
      // And it must survive that carrier's own character class and length cap.
      expect(result.observedDetail.length).toBeLessThanOrEqual(512);
      expect(result.observedDetail).toMatch(/^[\w .,:/=()+-]+$/);
      // Nothing was retired: the refusal precedes every irreversible step.
      expect(f.server.tableEngines.size).toBe(3);
    }
  );
  // The live 8825 engine re-admits and kills a foreign cash table every ~5 s.
  // Its arrival or departure touches no custody this checkpoint retires, so
  // the fleet witness pins the tables the checkpoint touches, not the fleet.
  it('tolerates a foreign cash table arriving during an RPC', async () => {
    const f = mixedFixture();
    // A freshly admitted cash table has dealt nothing: no live bank, so the
    // native readiness gate (which is NOT this guard's) is already durable.
    const foreign = new f.Table(999);
    foreign.timeBankEngine.playerBanks.clear();
    f.onRpc(() => f.server.tableEngines.set(uuid(999), foreign));
    expect(await f.run()).toMatchObject({ ok: true, readyForRestart: true });
    expect(f.receipts.size).toBe(2);
    expect(f.server.tableEngines.has(uuid(999))).toBe(true);
    for (const { engine } of f.originals)
      expect(f.server.tableEngines.has(engine.tableId)).toBe(false);
  });
  it('tolerates a foreign cash table arriving and then leaving during the RPCs', async () => {
    const f = mixedFixture();
    let calls = 0;
    f.onRpc(() => {
      if (calls++ === 0) f.server.tableEngines.set(uuid(999), new f.Table(999));
      else f.server.tableEngines.delete(uuid(999));
    });
    expect(await f.run()).toMatchObject({ ok: true, readyForRestart: true });
    expect(f.receipts.size).toBe(2);
    expect(f.server.tableEngines.has(uuid(999))).toBe(false);
    expect(f.server.tableEngines.size).toBe(1);
  });
  /* ═══ AN ENGINE THAT NEVER STARTED HOLDS NOTHING TO CHECKPOINT (2026-09-21) ═══
     The live 8825 engine installs the cash table 3c00d4d0 in `tableEngines`
     BEFORE `start()`, start() fails in `start_load_table`
     (`retained_hand_submission_pending`), `killForRestart` fences it
     (`terminal = true`, `running = false`), `recoverDirectTableEngine` stops
     it and deletes it, and discovery re-admits it a second or two later. The
     snapshot caught that object on most attempts and its scheduled departure
     refused the checkpoint. This is exactly the shape the log shows: seeded
     `handCount` (#13062928), "Dealt 0 hands", no seat, no bank. */
  const unstartedCashEngine = (f: ReturnType<typeof mixedFixture>, n: number) => {
    const e: any = new f.Table(n);
    e.seatedPlayers = [];
    e.timeBankEngine.playerBanks.clear();
    e.timeBankMeta.clear();
    e.parkedTimeBanks = {};
    e.engineLeaseScope = 'cash';
    e.engineLeaseVerified = true;
    e.engineLeaseGeneration = uuid(70000 + n);
    e.f06MovementAdmission = null;
    e.loopPhase = 'start_load_table';
    e.dealingLoopPromise = null;
    e.handsDealtThisSession = 0;
    e.handCount = 13062928;
    e.running = true;
    e.terminal = false;
    e.teardownPromise = null;
    return e;
  };
  // killForRestart('start_failed:start_load_table') then the recovery's stop()
  // and map delete, in that order.
  const killAndRemove = (f: ReturnType<typeof mixedFixture>, e: any) => {
    e.terminal = true;
    e.running = false;
    e.handController = null;
    e.teardownPromise = Promise.resolve();
    f.server.tableEngines.delete(e.tableId);
  };
  it('does not checkpoint an unstarted cash engine and tolerates its kill and removal during an RPC', async () => {
    const f = mixedFixture();
    const churning = unstartedCashEngine(f, 999);
    f.server.tableEngines.set(churning.tableId, churning);
    let calls = 0;
    f.onRpc(() => {
      if (calls++ === 1) killAndRemove(f, churning);
    });
    const result = await f.run();
    expect(result).toMatchObject({
      ok: true,
      readyForRestart: true,
      skippedUnstarted: 1,
      unstartedDepartures: 1,
      unstartedReplacements: 0,
    });
    expect(f.receipts.size).toBe(2);
    expect(f.calls).not.toContain('parked_' + churning.tableId);
    expect(f.rows.has(churning.tableId)).toBe(false);
    expect(f.server.tableEngines.has(churning.tableId)).toBe(false);
    expect(f.server.tableEngines.size).toBe(1);
  });
  it('does not checkpoint an unstarted cash engine that is still present at the end', async () => {
    const f = mixedFixture();
    const churning = unstartedCashEngine(f, 999);
    f.server.tableEngines.set(churning.tableId, churning);
    const result = await f.run();
    expect(result).toMatchObject({
      ok: true,
      readyForRestart: true,
      skippedUnstarted: 1,
      unstartedDepartures: 0,
      unstartedReplacements: 0,
    });
    expect(f.receipts.size).toBe(2);
    expect(f.rows.has(churning.tableId)).toBe(false);
    expect(f.server.tableEngines.get(churning.tableId)).toBe(churning);
    // The engine's own fields were only read.
    expect(churning.running).toBe(true);
    expect(churning.terminal).toBe(false);
  });
  it('follows the churn: a fenced unstarted engine replaced by another unstarted generation', async () => {
    const f = mixedFixture();
    const first = unstartedCashEngine(f, 999);
    f.server.tableEngines.set(first.tableId, first);
    const second = unstartedCashEngine(f, 999);
    let calls = 0;
    f.onRpc(() => {
      const call = calls++;
      if (call === 0) killAndRemove(f, first);
      if (call === 1) f.server.tableEngines.set(second.tableId, second);
      if (call === 2) killAndRemove(f, second);
    });
    const result = await f.run();
    expect(result).toMatchObject({
      ok: true,
      skippedUnstarted: 1,
      unstartedReplacements: 1,
      unstartedDepartures: 2,
    });
    expect(f.receipts.size).toBe(2);
    expect(f.server.tableEngines.size).toBe(1);
  });
  it('refuses an unstarted engine that leaves the map without the fence and stop that precede the delete', async () => {
    const f = mixedFixture();
    const churning = unstartedCashEngine(f, 999);
    f.server.tableEngines.set(churning.tableId, churning);
    f.onRpc(() => f.server.tableEngines.delete(churning.tableId));
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'engine_identity_changed',
      failedCheck: 'unstarted.departed_fenced',
      failedTable: `unstarted_departed_unfenced:${churning.tableId}`,
      skippedUnstarted: 1,
    });
    expect(f.receipts.size).toBe(0);
    expect(f.server.tableEngines.size).toBe(3);
  });
  it('refuses a skipped engine that acquires a seat and a bank during an RPC', async () => {
    const f = mixedFixture();
    const churning = unstartedCashEngine(f, 999);
    f.server.tableEngines.set(churning.tableId, churning);
    const started = new f.Table(999);
    f.onRpc(() => {
      churning.loopPhase = 'start_wait_for_players';
      churning.seatedPlayers = started.seatedPlayers;
      churning.timeBankMeta = started.timeBankMeta;
      churning.timeBankEngine = started.timeBankEngine;
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'engine_state_changed',
      failedCheck: 'unstarted.still_unstarted',
      failedTable: `unstarted_acquired_custody:${churning.tableId}`,
    });
    expect(f.receipts.size).toBe(0);
  });
  it('refuses the successor when the churn re-admits a started engine behind a skipped table id', async () => {
    const f = mixedFixture();
    const first = unstartedCashEngine(f, 999);
    f.server.tableEngines.set(first.tableId, first);
    let calls = 0;
    f.onRpc(() => {
      const call = calls++;
      if (call === 0) killAndRemove(f, first);
      if (call === 1) f.server.tableEngines.set(first.tableId, new f.Table(999));
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'engine_identity_changed',
      failedCheck: 'unstarted.successor_unstarted',
      failedTable: `unstarted_replaced:${first.tableId}`,
    });
    // The refusal precedes every irreversible step: nothing was retired.
    for (const { engine } of f.originals)
      expect(f.server.tableEngines.get(engine.tableId)).toBe(engine);
  });
  it('still captures and refuses a STARTED cash engine that is removed during an RPC', async () => {
    // Running, parked, holding a seat and a bank: the fixture default.
    const f = mixedFixture();
    const started = new f.Table(999);
    f.server.tableEngines.set(started.tableId, started);
    f.onRpc(() => killAndRemove(f, started));
    const result = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'fleet_identity_changed',
      failedTable: `table_departed:${started.tableId}`,
      skippedUnstarted: 0,
    });
    expect(f.receipts.size).toBe(0);
  });
  it('still captures and refuses an engine that dealt a hand this session, even with no seat left', async () => {
    const f = mixedFixture();
    const dealt = unstartedCashEngine(f, 999);
    dealt.handsDealtThisSession = 1;
    dealt.loopPhase = 'between_hands';
    f.server.tableEngines.set(dealt.tableId, dealt);
    f.onRpc(() => killAndRemove(f, dealt));
    const result = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'fleet_identity_changed',
      failedTable: `table_departed:${dealt.tableId}`,
      skippedUnstarted: 0,
    });
    expect(f.receipts.size).toBe(0);
  });
  it('never skips a retained original, even one carrying every unstarted flag', async () => {
    const f = mixedFixture();
    const { engine } = f.originals[0];
    engine.loopPhase = 'start_load_table';
    engine.handsDealtThisSession = 0;
    engine.dealingLoopPromise = null;
    engine.seatedPlayers = [];
    engine.parkedTimeBanks = {};
    engine.f06MovementAdmission = null;
    f.onRpc(() => f.server.tableEngines.delete(engine.tableId));
    const result = await f.run();
    expect(result).toMatchObject({ ok: false, skippedUnstarted: 0 });
    expect(String(result.failedTable ?? '')).toContain(engine.tableId);
    expect(f.receipts.size).toBe(0);
    expect(f.server.tableEngines.size).toBe(2);
  });
  it('never skips an unstarted-looking engine outside the direct cash lane', async () => {
    const f = mixedFixture();
    const owned = unstartedCashEngine(f, 999);
    f.server.tableEngines.set(owned.tableId, owned);
    f.server.tournamentOwnedTables.add(owned.tableId);
    f.onRpc(() => killAndRemove(f, owned));
    const result = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'fleet_identity_changed',
      failedTable: `table_departed:${owned.tableId}`,
      skippedUnstarted: 0,
    });
  });
  // Each stop retry rebuilds a NEW frozen `drainedF06Originals` array holding
  // the same engines, and answers null while its teardown promise is set. The
  // engines' identities are what custody retires, so both pass; a different
  // engine behind the same table id still refuses.
  it('tolerates a fresh equal-content originals array on every capture', async () => {
    const f = mixedFixture();
    for (const { manager } of f.originals) manager.captureMode = 'fresh';
    expect(await f.run()).toMatchObject({ ok: true, readyForRestart: true });
    expect(f.receipts.size).toBe(2);
    expect(f.server.tableEngines.size).toBe(1);
  });
  it('tolerates a null originals capture while a stop retry is in flight', async () => {
    const f = mixedFixture();
    let calls = 0;
    f.onRpc(() => {
      const mode = calls++ === 0 ? 'stopping' : 'fresh';
      for (const { manager } of f.originals) manager.captureMode = mode;
    });
    expect(await f.run()).toMatchObject({ ok: true, readyForRestart: true });
    expect(f.receipts.size).toBe(2);
    expect(f.server.tableEngines.size).toBe(1);
  });
  it('refuses a different engine identity behind a captured original', async () => {
    const f = mixedFixture();
    const { manager, engine } = f.originals[0];
    f.onRpc(() => {
      manager.drainedF06Originals = [[engine.tableId, new f.Table(600)]];
    });
    const result = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'mixed_owner_changed',
      failedCheck: 'manager.captureDrainedF06Originals()',
    });
    // `failedTournament` is not a carried key; the tournament travels in
    // `observedDetail` (#5034).
    expect(result.observedDetail).toContain(`tournament=${manager.tournamentId}`);
    expect(f.server.tableEngines.size).toBe(3);
    expect(f.server.tableEngines.get(engine.tableId)).toBe(engine);
  });
  it('names the drain condition that sent captureDrainedF06Originals to null', async () => {
    const f = mixedFixture();
    // `captureDrainedF06Originals()` is all-or-nothing, so the identity compare
    // can only say THAT it flipped. A lifecycle job arriving mid-checkpoint is
    // one of the thirteen conditions that sends it to null; the witness has to
    // name that one rather than leave the next release guessing.
    f.onRpc(() => f.originals[0].manager.lifecycleJobs.add(Promise.resolve()));
    const result = await f.run();
    expect(result.ok).toBe(false);
    expect(String(result.observedDetail ?? '')).toContain('lifecycleJobs');
    expect(f.server.tableEngines.size).toBe(3);
  });
  it('names the table when one leaves the fleet mid-checkpoint', async () => {
    const f = mixedFixture();
    const departing = f.originals[0].engine.tableId;
    f.onRpc(() => f.server.tableEngines.delete(departing));
    const result = await f.run();
    expect(result).toMatchObject({ ok: false });
    expect(String(result.failedTable ?? '')).toContain(departing);
  });
  it('names the sub-condition when the server identity moves', async () => {
    const f = mixedFixture();
    f.onRpc(() => {
      f.server.lifecycleGeneration += 1;
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'server_changed',
      failedCheck: 'server.lifecycleGeneration',
    });
  });
  /* The capture and all seven registry terms below it run in ONE synchronous
     turn - no await separates `captureDrainedF06Originals()` from the reads
     that pin each original - so a term that is false is a standing
     disagreement between the manager's own map and the process registries,
     never a capture that went stale. Run 36144951750 refused on exactly this
     conjunction at stage preflight with attemptedTables 0 and named nothing
     else, so each term now names itself and says which registry moved. */
  it('names the fleet registry when a captured original left it', async () => {
    const f = mixedFixture();
    const { engine, manager } = f.originals[0];
    f.server.tableEngines.delete(engine.tableId);
    const result = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'mixed_original_registry_disagreement',
      failedCheck: 'fleet.tableEngines',
      failedTable: engine.tableId,
      failedField: 'drainedF06Originals',
    });
    expect(result.observedDetail).toContain(`tournament=${manager.tournamentId}`);
    expect(result.observedDetail).toContain('fleetSlot=absent');
    // The manager still holds it, which is why the capture above said nothing
    // was wrong: the two registries disagree, and the receipt says which.
    expect(result.observedDetail).toContain('managerSlot=same');
    expect(result.observedDetail).toContain('owned=true');
    // How many of this manager's originals are out of step, so the next
    // release can tell one reaped table from a whole custody handoff.
    expect(result.observedDetail).toContain('fleetDisagree=1/1');
    expect(f.receipts.size).toBe(0);
  });
  it('refuses and names the fleet registry when another engine holds the slot', async () => {
    const f = mixedFixture();
    const { engine } = f.originals[0];
    const usurper: any = new f.Table(700);
    f.server.tableEngines.set(engine.tableId, usurper);
    const result = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'mixed_original_registry_disagreement',
      failedCheck: 'fleet.tableEngines',
      failedTable: engine.tableId,
      observed: 'fleet:other',
      expected: 'fleet:same',
    });
    expect(result.observedDetail).toContain('fleetSlot=other');
    // Nothing is retired on the way out: the usurper keeps the slot and no
    // custody receipt was written for either tournament.
    expect(f.server.tableEngines.get(engine.tableId)).toBe(usurper);
    expect(f.receipts.size).toBe(0);
  });
  it('names the ownership set when the fleet slot is right and ownership is not', async () => {
    const f = mixedFixture();
    const { engine } = f.originals[0];
    f.server.tournamentOwnedTables.delete(engine.tableId);
    const result = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'mixed_original_registry_disagreement',
      failedCheck: 'fleet.tournamentOwnedTables',
      failedTable: engine.tableId,
    });
    expect(result.observedDetail).toContain('fleetSlot=same');
    expect(result.observedDetail).toContain('owned=false');
    expect(f.receipts.size).toBe(0);
  });
  it('names the duplicate when two managers capture the same original', async () => {
    const f = mixedFixture();
    const first = f.originals[0].engine;
    const second = f.originals[1].manager;
    second.tableEngines = new Map([[first.tableId, first]]);
    second.drainedF06Originals = [[first.tableId, first]];
    const result = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'mixed_original_registry_disagreement',
      failedCheck: 'original.distinctEngine',
      failedTable: first.tableId,
    });
    expect(result.observedDetail).toContain(`tournament=${second.tournamentId}`);
    expect(result.observedDetail).toContain('duplicate=true');
    expect(f.receipts.size).toBe(0);
  });
  it.each(['original', 'canonical', 'readback', 'healthy'])(
    'refuses %s evidence loss without hiding originals',
    async (fault) => {
      const f = mixedFixture();
      f.changeResponse((name, data) => {
        if (fault === 'original' && data.canonical)
          data.canonical.pending_original_tables.push(uuid(100));
        if (fault === 'canonical' && data.receipt?.canonical_proof)
          data.receipt.canonical_proof = {};
        if (fault === 'readback' && name === 'fn_f06_find_mixed_manager_custody')
          data.receipt = null;
        if (fault === 'healthy') f.first.handController = {};
        return data;
      });
      expect((await f.run()).ok).toBe(false);
      expect(f.server.tableEngines.size).toBe(3);
    }
  );
  // 8825 originals were interrupted mid-hand. `beginTerminalBoundaryPersistence`
  // reserved an integer immediately before HandController.start, and the only
  // site that removes it runs inside that hand's settlement - unreachable once
  // the engine is stopped, because `lifecycleCanMutate()` gates the step that
  // calls it. The entry is the interruption being handed over, not live work.
  // `beginTerminalBoundaryPersistence` runs inside `F06HandPermit.start`, one
  // line after it sets `phase = 'attempted'`. The phase and the integer are one
  // event, so a fixture that adds the integer must move the phase with it or it
  // is modelling a state the engine cannot reach.
  const interruptMidHand = (f: any) => {
    f.originals[0].engine.f06CurrentPermit.phase = 'attempted';
    f.originals[0].engine.terminalBoundaryPendingGenerations.add(7);
  };
  it('admits the reserved terminal boundary of an interrupted original and still retires it', async () => {
    const f = mixedFixture();
    interruptMidHand(f);
    expect(await f.run()).toMatchObject({ ok: true, readyForRestart: true });
    expect(f.receipts.size).toBe(2);
    expect(f.server.tableEngines.has(f.originals[0].engine.tableId)).toBe(false);
    // Admitted, never discarded: the guard still mutates no engine state.
    expect(f.originals[0].engine.terminalBoundaryPendingGenerations.size).toBe(1);
  });
  it.each(['new', 'reserved', 'unknown', 'number_refused'] as const)(
    'refuses a terminal boundary a %s permit could never have reserved',
    async (phase) => {
      const f = mixedFixture();
      // `beginTerminalBoundaryPersistence` runs strictly after the phase becomes
      // `attempted`, so an integer under any earlier phase is not the handed-over
      // interruption - it is state this engine has no account of.
      f.originals[0].engine.f06CurrentPermit.phase = phase;
      f.originals[0].engine.terminalBoundaryPendingGenerations.add(7);
      expect(await f.run()).toMatchObject({
        ok: false,
        reason: 'mixed_original_work_not_drained',
        failedCheck: 'engineCollection.size',
        failedField: 'terminalBoundaryPendingGenerations',
        observedDetail: `permitPhase=${phase}`,
        expected: '0',
      });
      expect(f.rpcCalls).toEqual([]);
      expect(f.server.tableEngines.size).toBe(3);
    }
  );
  // The admission above rests on one ordering in code the guard cannot see:
  // `F06HandPermit.start` must mark the permit `attempted` BEFORE it actuates
  // the block that reserves the boundary integer. Pin it on the real class, and
  // pin the single call site that relies on it, so a reordering of either fails
  // here rather than stranding the next release behind an unexplained refusal.
  const attemptedPermit = () => {
    const p = newPermit();
    (p as any).phase = 'reserved';
    p.start(() => undefined);
    return p;
  };
  const newPermit = () =>
    new F06HandPermit(
      {
        tournament_id: uuid(1),
        lease_generation: uuid(2),
        table_id: uuid(3),
        lifecycle: '1',
        permit_id: uuid(4),
        custody_id: uuid(5),
        hand_number: '17',
      },
      async () => {
        throw new Error('permit rpc must never be reached');
      },
      () => true
    );
  it('marks the permit attempted before the boundary integer is reserved', () => {
    const permit = newPermit();
    (permit as any).phase = 'reserved';
    let phaseInsideActuation: string | null = null;
    permit.start(() => {
      // This is where `beginTerminalBoundaryPersistence` runs.
      phaseInsideActuation = permit.recoveryState();
    });
    expect(phaseInsideActuation).toBe('attempted');
    expect(permit.recoveryState()).toBe('attempted');
  });
  it('cannot leave the attempted phase once the hand has started', async () => {
    const permit = attemptedPermit();
    // The two sites that would move it on refuse it, so on a stopped engine -
    // where the settle path is closed by `lifecycleCanMutate()` - `attempted`
    // is terminal, and the boundary integer it reserved stays reserved.
    await expect(
      permit.terminateUnstarted(
        async () => undefined,
        () => true,
        {
          evidence_id: uuid(6),
          process_boot_id: uuid(7),
          engine_generation: uuid(8),
          key_id: uuid(9),
          key: new Uint8Array(32),
        }
      )
    ).rejects.toThrow('f06_hand_may_have_started');
    await expect(permit.cancelPreparedHand()).rejects.toThrow('f06_prepared_cancellation_unproven');
    expect(permit.recoveryState()).toBe('attempted');
  });
  it('reserves the boundary integer only inside the permit start block', () => {
    const dealing = readFileSync(
      path.join(__dirname, '..', 'server/src/engine/ServerTableEngineDealing.ts'),
      'utf8'
    );
    const calls = dealing.match(/this\.beginTerminalBoundaryPersistence\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    // The one call site sits in `startExactController`, and on an engine holding
    // a permit that function is reached only through `f06CurrentPermit.start`.
    expect(dealing).toMatch(
      /const startExactController = \(\) => \{\s*persistenceGeneration = this\.beginTerminalBoundaryPersistence\(\);/
    );
    expect(dealing).toMatch(
      /if \(this\.f06CurrentPermit\) this\.f06CurrentPermit\.start\(startExactController\);/
    );
  });
  it('refuses a terminal boundary on an engine holding no permit at all', async () => {
    const f = mixedFixture();
    f.originals[0].engine.f06CurrentPermit = null;
    f.originals[0].engine.terminalBoundaryPendingGenerations.add(7);
    const result = await f.run();
    expect(result.ok).toBe(false);
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(3);
  });
  it('refuses more pending boundaries than one interrupted hand can explain', async () => {
    const f = mixedFixture();
    interruptMidHand(f);
    f.originals[0].engine.terminalBoundaryPendingGenerations.add(8);
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'mixed_original_work_not_drained',
      failedCheck: 'engineCollection.size',
      failedField: 'terminalBoundaryPendingGenerations',
      expected: '1',
    });
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(3);
  });
  it.each([
    ['settlementInFlight', (e: any) => e.settlementInFlight.add(Promise.resolve())],
    ['tournamentMoveOperations', (e: any) => e.tournamentMoveOperations.add(Promise.resolve())],
    ['readContinuationTasks', (e: any) => e.readContinuationTasks.add(Promise.resolve())],
    ['timeBankAccountingPending', (e: any) => e.timeBankAccountingPending.add(Promise.resolve())],
    ['tournamentMoveOperationByOwner', (e: any) => e.tournamentMoveOperationByOwner.set('a', 1)],
    ['entryHoldWriteChains', (e: any) => e.entryHoldWriteChains.set('a', 1)],
  ])('still refuses undrained %s on an interrupted original', async (field, fill) => {
    const f = mixedFixture();
    interruptMidHand(f);
    fill(f.originals[0].engine);
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'mixed_original_work_not_drained',
      failedCheck: 'engineCollection.size',
      failedField: field,
      expected: '0',
    });
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(3);
  });
  it('still refuses a failed terminal boundary on an interrupted original', async () => {
    const f = mixedFixture();
    interruptMidHand(f);
    f.originals[0].engine.terminalBoundaryPersistenceFailed = true;
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'mixed_original_work_not_drained',
      failedCheck: 'engine.terminalBoundaryPersistenceFailed',
    });
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(3);
  });
});

describe('an 8825 bank refusal names its table and counts the fleet the capture walked', () => {
  // Observability only (2026-09-22): the production profile, with its two
  // retained originals. The census walks exactly what the capture walks.
  it('counts a live seated player who kept metadata and no bank, and leaves the retained originals out', async () => {
    const f: any = mixedFixture();
    // A live, parked table whose seated player holds metadata but no bank, and
    // a STOPPED one that kept a bank, which still refuses. The census counts
    // the live shape either way; the two retained originals are never walked
    // by the capture, so it does not count them.
    const live: any = new f.Table(600);
    live.timeBankEngine.playerBanks.clear();
    f.server.tableEngines.set(live.tableId, live);
    // A stopped engine that kept one of its banks: its seated player's
    // metadata is not explained by a stop that disposed everything.
    const e: any = new f.Table(601);
    Object.assign(e, {
      running: false,
      terminal: true,
      teardownPromise: Promise.resolve(),
      dealingLoopPromise: null,
      readContinuationTasks: new Set(),
      maintenancePaused: false,
      holdBeforeNextHand: false,
      handForHandResolve: null,
    });
    // Its seated player's bank is gone but the metadata remains, and the
    // engine still holds a bank for someone the roster no longer seats.
    const seated601 = e.seatedPlayers[0].user_id;
    e.timeBankEngine.playerBanks.clear();
    e.timeBankEngine.playerBanks.set(`${e.tableId}:${uuid(74601)}`, {
      tableId: e.tableId,
      playerId: uuid(74601),
      remainingSeconds: 75,
      usesRemaining: 2,
      isActive: false,
      unlimitedActivations: false,
    });
    expect(e.timeBankMeta.has(seated601)).toBe(true);
    f.server.tableEngines.set(e.tableId, e);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_metadata_without_bank',
      failedCheck: 'captureEngine.bank_metadata_without_bank',
      failedTable: e.tableId,
    });
    expect(String(result.observedDetail).split(',')).toEqual(
      expect.arrayContaining(['fleet=3', 'fleetStopped=1', 'fleetLiveSeatedMeta=1'])
    );
    expect(result.observedDetail).toMatch(/^[\w .,:/=()+-]+$/);
    expect(f.calls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(5);
  });

  it('names a table that still holds an F06 permit outside retained custody, and counts it', async () => {
    const f: any = mixedFixture();
    const e: any = new f.Table(640);
    e.f06CurrentPermit = { phase: 'reserved' };
    f.server.tableEngines.set(e.tableId, e);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'f06_custody_not_drained',
      failedCheck: 'captureEngine.f06_custody_not_drained',
      failedTable: e.tableId,
    });
    expect(String(result.observedDetail).split(',')).toEqual(
      expect.arrayContaining(['f06=true/false', 'fleet=2', 'fleetF06=1', 'fleetBoundary=0'])
    );
    expect(result.observedDetail.length).toBeLessThanOrEqual(512);
    expect(f.calls).toEqual([]);
  });
});

describe('a bank the engine no longer holds is proved from rows, never assumed', () => {
  // A parked cash table whose player cashed out: seat and bank gone, metadata
  // kept (8825 ServerTableEngineBase.ts:3679).
  const cashedOut = (f: any, n: number) => {
    const e: any = new f.Table(n);
    const departed = e.seatedPlayers[0].user_id;
    e.seatedPlayers = [];
    e.timeBankEngine.playerBanks.clear();
    f.server.tableEngines.set(e.tableId, e);
    return { e, departed };
  };
  // A tournament table after a bust: the seat is absent from the next roster
  // and the cash-only teardown removed neither the bank nor the metadata.
  const busted = (f: any, n: number) => {
    const e: any = new f.Table(n);
    const departed = e.seatedPlayers[0].user_id;
    e.seatedPlayers = [];
    f.server.tableEngines.set(e.tableId, e);
    return { e, departed };
  };
  // A quarantined manager's stopped engine: its teardown throws before it
  // unregisters, so it stays in the fleet map with its roster and metadata and
  // none of the banks its stop() disposed.
  const quarantined = (f: any, n: number) => {
    const e: any = new f.Table(n);
    const authority = { tournamentId: uuid(72000 + n), leaseGeneration: uuid(73000 + n) };
    Object.assign(e, {
      running: false,
      terminal: true,
      teardownPromise: Promise.resolve(),
      dealingLoopPromise: null,
      readContinuationTasks: new Set(),
      engineLeaseScope: 'tournament',
      engineLeaseVerified: true,
      engineLeaseTournamentId: authority.tournamentId,
      engineLeaseGeneration: authority.leaseGeneration,
    });
    dataActorContext.bindTournamentDataAuthorityMethods(authority, e);
    e.timeBankEngine.playerBanks.clear();
    f.server.tableEngines.set(e.tableId, e);
    return { e, authority, seated: e.seatedPlayers[0].user_id };
  };
  // The destination of a cash seat move: a parked table that seats the mover
  // under the move's destination occupancy, with or without the carried bank.
  const destination = (
    f: any,
    n: number,
    userId: string,
    occupancyId: string,
    adopted: boolean
  ) => {
    const e: any = new f.Table(n);
    e.seatedPlayers = [{ user_id: userId, occupancy_id: occupancyId, seat_number: 1, stack: 100 }];
    e.timeBankMeta.clear();
    e.timeBankEngine.playerBanks.clear();
    if (adopted) {
      e.timeBankMeta.set(userId, { initialSeconds: 90, baseSeconds: 30, dbConsumedSeconds: 15 });
      e.timeBankEngine.playerBanks.set(`${e.tableId}:${userId}`, {
        tableId: e.tableId,
        playerId: userId,
        remainingSeconds: 60,
        usesRemaining: 2,
        isActive: false,
        unlimitedActivations: false,
      });
    }
    f.server.tableEngines.set(e.tableId, e);
    return e;
  };

  it('reads no row at all when every bank is where its seat is', async () => {
    const f: any = mixedFixture();
    const result: any = await f.run();
    expect(result.ok).toBe(true);
    expect(f.seatReads).toEqual([]);
    expect(f.moveReads).toEqual([]);
    expect(f.snapshotReads).toEqual([]);
    expect(result.bankDisposition).toBeUndefined();
  });

  it('proves a cashed-out player departed from rows, before any write, and writes nothing for it', async () => {
    const f: any = mixedFixture();
    const { e, departed } = cashedOut(f, 600);
    let writesAtRead = -1;
    f.onSeats((users: string[]) => {
      writesAtRead = f.calls.length;
      expect(users).toEqual([departed]);
      return { data: [], error: null };
    });
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, readyForRestart: true });
    // The proof ran first: not one presence or bank row had been written.
    expect(writesAtRead).toBe(0);
    expect(f.seatReads).toHaveLength(1);
    // No open seat anywhere, so there is no move to follow.
    expect(f.moveReads).toEqual([]);
    expect(result.bankDisposition).toContain('residueTables=1');
    expect(result.bankDisposition).toContain('residuePlayers=1');
    expect(result.bankDisposition).not.toContain(departed);
    // Nothing is written for the residue, and the metadata is left as found.
    expect(f.rows.has(e.tableId)).toBe(false);
    expect([...e.timeBankMeta.keys()]).toEqual([departed]);
  });

  /* A SEAT THIS ENGINE NEVER DEALT HOLDS NONE OF ITS BANKS (2026-09-25).
     Run 36098984451 refused on a86077f2 for one open seat, out of 2178, that
     sat at a table whose engine also held residue for that player; the runs
     either side of it found no collision at all. The roster cannot forget an
     occupancy the database still holds open, so an open row the roster does
     not hold is a LATER occupancy - and a later occupancy owns a bank of this
     engine's only if this engine dealt it a hand. That is the question now,
     and it is asked from rows. */
  const seatedHere = (f: any, table: string, user: string, joinedAt?: string) =>
    f.onSeats(() => ({
      data: [
        {
          table_id: table,
          user_id: user,
          occupancy_id: uuid(65000),
          ...(joinedAt === undefined ? {} : { joined_at: joinedAt }),
        },
      ],
      error: null,
    }));
  const seatOpened = new Date(Date.now() - 4 * 60000).toISOString();

  it('refuses a residue player whose open seat at that table this engine has dealt, names it, and writes nothing', async () => {
    const f: any = mixedFixture();
    const { e, departed } = cashedOut(f, 600);
    seatedHere(f, e.tableId, departed, seatOpened);
    f.onResidueSeatDealt((table: string, since: string, player: string) => {
      expect([table, since, player]).toEqual([e.tableId, seatOpened, departed]);
      return { data: [{ id: uuid(71000) }], error: null };
    });
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_residue_unproven',
      checkpointOutcome: 'not_started',
      failedCheck: 'proveBanksHeldNothing.openSeatAtResidueTable',
      failedTable: e.tableId,
    });
    expect(JSON.stringify(result)).not.toContain(departed);
    expect(f.calls).toEqual([]);
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(4);
  });

  it('refuses a tournament bust whose bank and metadata both outlived a seat this engine dealt', async () => {
    const f: any = mixedFixture();
    const { e, departed } = busted(f, 600);
    seatedHere(f, e.tableId, departed, seatOpened);
    f.onResidueSeatDealt(() => ({ data: [{ id: uuid(71000) }], error: null }));
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_residue_unproven',
      failedCheck: 'proveBanksHeldNothing.openSeatAtResidueTable',
      failedTable: e.tableId,
    });
    expect(f.calls).toEqual([]);
  });

  it('admits an open seat at a residue table that this engine has never dealt', async () => {
    const f: any = mixedFixture();
    const { e, departed } = busted(f, 600);
    seatedHere(f, e.tableId, departed, seatOpened);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    // Exactly one question, at or after the seat opened, about that player.
    expect(f.dealtReads.filter((r: any) => r.op === 'gte')).toEqual([
      { table: e.tableId, since: seatOpened, player: departed, op: 'gte' },
    ]);
    expect(result.bankDisposition).toContain('residueSeatsHere=1');
    expect(result.bankDisposition).toContain('residueSeatsNeverDealt=1');
    // Nothing is written for the residue, and the metadata is left as found.
    expect(e.timeBankMeta.has(departed)).toBe(true);
  });

  it.each([
    ['no readable joined_at', undefined, () => ({ data: [], error: null })],
    ['an unreadable answer', seatOpened, () => ({ data: null, error: { code: '57014' } })],
    ['a body that is not a list', seatOpened, () => ({ data: { id: 'x' }, error: null })],
    ['a page that filled', seatOpened, () => ({ data: [{ id: 'a' }, { id: 'b' }], error: null })],
  ])(
    'keeps the refusal when the seat it collided with answers %s',
    async (_label, joinedAt: any, answer: any) => {
      const f: any = mixedFixture();
      const { e, departed } = busted(f, 600);
      seatedHere(f, e.tableId, departed, joinedAt);
      f.onResidueSeatDealt(answer);
      const result: any = await f.run();
      expect(result).toMatchObject({ ok: false, reason: 'bank_residue_unproven' });
      expect(f.calls).toEqual([]);
      expect(f.rpcCalls).toEqual([]);
    }
  );

  it('asks nothing at all when no open seat is at a residue table', async () => {
    const f: any = mixedFixture();
    const { departed } = busted(f, 600);
    f.onSeats(() => ({
      data: [{ table_id: uuid(66000), user_id: departed, occupancy_id: uuid(66001) }],
      error: null,
    }));
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.dealtReads.filter((r: any) => r.op === 'gte')).toEqual([]);
    expect(result.bankDisposition).toContain('residueSeatsHere=0');
    expect(result.bankDisposition).toContain('residueSeatsNeverDealt=0');
  });

  it('refuses without asking when more than a page of open seats sit at residue tables', async () => {
    const f: any = mixedFixture();
    const { e, departed } = busted(f, 600);
    f.onSeats(() => ({
      data: Array.from({ length: 101 }, (_, i) => ({
        table_id: e.tableId,
        user_id: departed,
        occupancy_id: uuid(65000 + i),
        joined_at: seatOpened,
      })),
      error: null,
    }));
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_residue_unproven',
      failedCheck: 'proveBanksHeldNothing.openSeatAtResidueTable',
      failedTable: e.tableId,
    });
    expect(f.dealtReads.filter((r: any) => r.op === 'gte')).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it.each([
    ['an unreadable answer', () => ({ data: null, error: { message: 'PGRST002' } })],
    ['a body that is not a list', () => ({ data: { table_id: 'x' }, error: null })],
    [
      'a page that filled',
      () => ({
        data: Array.from({ length: 901 }, (_, i) => ({
          table_id: uuid(50000 + i),
          user_id: uuid(52000 + i),
          occupancy_id: uuid(54000 + i),
        })),
        error: null,
      }),
    ],
    [
      'a row it cannot read',
      () => ({ data: [{ table_id: 'x', user_id: 'y', occupancy_id: 'z' }], error: null }),
    ],
  ])('refuses on %s, and writes nothing', async (_label, answer) => {
    const f: any = mixedFixture();
    cashedOut(f, 600);
    f.onSeats(answer as any);
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'bank_residue_unproven' });
    expect(f.calls).toEqual([]);
    expect(f.rpcCalls).toEqual([]);
  });

  it('a residue player seated elsewhere with no move out of here is not in transit', async () => {
    const f: any = mixedFixture();
    const { departed } = cashedOut(f, 600);
    // A horse that cashed out here and holds a frozen tournament seat elsewhere.
    f.onSeats(() => ({
      data: [{ table_id: uuid(66000), user_id: departed, occupancy_id: uuid(66001) }],
      error: null,
    }));
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    // No capture holds a bank for that seat, so the engine's arrivals function
    // is asked, and it names no move into it.
    expect(f.arrivalReads).toEqual([{ table: uuid(66000), occupancies: [uuid(66001)] }]);
    expect(f.moveReads).toEqual([]);
    expect(result.bankDisposition).toContain('residueOpenSeatsElsewhere=1');
    expect(result.bankDisposition).toContain('arrivalTablesAsked=1');
    expect(result.bankDisposition).toContain('arrivalsInWindowChecked=0');
  });

  /* ONE QUESTION FOR EVERY ARRIVAL (2026-09-24). Run 36042895085 asked the
     per-table arrivals function 767 times in thirteen seconds and lost its
     outcome to the publisher's 20 s budget. The same question is asked once
     per fleet through fn_cash_seat_move_arrivals_for_players (migration
     20260924190214), and the per-table question survives only as the
     fallback for a box that does not have the function yet. */
  it('asks the arrivals question once for every residue player, never per table', async () => {
    const f: any = mixedFixture();
    const a = cashedOut(f, 600);
    const b = cashedOut(f, 602);
    f.onSeats(() => ({
      data: [
        { table_id: uuid(66000), user_id: a.departed, occupancy_id: uuid(66001) },
        { table_id: uuid(66010), user_id: a.departed, occupancy_id: uuid(66011) },
        { table_id: uuid(66020), user_id: b.departed, occupancy_id: uuid(66021) },
      ],
      error: null,
    }));
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.arrivalPlayerReads).toEqual([{ players: [a.departed, b.departed].sort() }]);
    expect(f.perTableArrivalReads).toEqual([]);
    expect(result.bankDisposition).toContain('arrivalTablesAsked=3');
    expect(result.bankDisposition).toContain('arrivalQuestion=perPlayer');
    expect(result.bankDisposition).toContain('arrivalPlayersAsked=2');
  });

  it('an arrival outside the seats it asked about is not an arrival it counts', async () => {
    const f: any = mixedFixture();
    const from = cashedOut(f, 600);
    f.onSeats(() => ({
      data: [{ table_id: uuid(67000), user_id: from.departed, occupancy_id: uuid(68000) }],
      error: null,
    }));
    // The batched function answers for the PLAYER; a receipt into a seat the
    // guard did not ask about (a seat whose capture holds the bank, or one
    // long closed) is exactly what the per-table question never saw.
    f.onArrivalsForPlayers(() => ({
      data: [
        {
          move_id: uuid(69000),
          player_id: from.departed,
          from_table_id: from.e.tableId,
          to_table_id: uuid(67000),
          source_occupancy_id: uuid(69001),
          destination_occupancy_id: uuid(68999),
        },
      ],
      error: null,
    }));
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.moveReads).toEqual([]);
    expect(result.bankDisposition).toContain('arrivalsInWindowChecked=0');
  });

  it('a box without the batched function is asked per table, exactly as before', async () => {
    const f: any = mixedFixture();
    f.batchArrivals('missing');
    const from = cashedOut(f, 600);
    landed(f, from, uuid(67000), new Date(Date.now() - 60000).toISOString());
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_residue_unproven',
      failedCheck: 'proveBanksHeldNothing.seatMoveInTransit',
      failedTable: uuid(67000),
    });
    expect(f.arrivalPlayerReads).toHaveLength(1);
    expect(f.perTableArrivalReads).toEqual([{ table: uuid(67000), occupancies: [uuid(68000)] }]);
    expect(f.calls).toEqual([]);
  });

  it('a batched answer that fills its page, or errors, still refuses and names the read', async () => {
    const f: any = mixedFixture();
    const from = cashedOut(f, 600);
    landed(f, from, uuid(67000), new Date(Date.now() - 2 * 3600000).toISOString());
    f.onArrivalsForPlayers(() => ({ data: null, error: { code: '42501' } }));
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_residue_unproven',
      failedCheck: 'proveBanksHeldNothing.arrivalsRead',
    });
    expect(result.observedDetail).toContain('error=42501');
    expect(f.calls).toEqual([]);
  });

  it('accepts a player who moved away once the destination capture holds a bank for that occupancy', async () => {
    const f: any = mixedFixture();
    const from = cashedOut(f, 600);
    const to = destination(f, 601, from.departed, uuid(68000), true);
    f.onSeats(() => ({
      data: [{ table_id: to.tableId, user_id: from.departed, occupancy_id: uuid(68000) }],
      error: null,
    }));
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    // Nothing to ask: the claim (or a first deal) already made that bank.
    expect(f.arrivalReads).toEqual([]);
    // The destination is ordinary custody and is written as such.
    expect(f.rows.has(to.tableId)).toBe(true);
  });

  const landed = (f: any, from: any, toTable: string, executedAt: string | null) => {
    f.onSeats(() => ({
      data: [{ table_id: toTable, user_id: from.departed, occupancy_id: uuid(68000) }],
      error: null,
    }));
    f.onArrivals(() => ({
      data: [
        {
          move_id: uuid(69000),
          player_id: from.departed,
          from_table_id: from.e.tableId,
          to_table_id: toTable,
          source_occupancy_id: uuid(69001),
          destination_occupancy_id: uuid(68000),
        },
      ],
      error: null,
    }));
    f.onMoves(() => ({ data: [{ id: uuid(69000), executed_at: executedAt }], error: null }));
  };

  it.each([
    ['the destination seats the player without the carried bank', true],
    ['the destination engine is not in this process at all', false],
  ])('refuses a cash seat move still in transit: %s', async (_label, present) => {
    const f: any = mixedFixture();
    const from = cashedOut(f, 600);
    const toTable = present
      ? destination(f, 601, from.departed, uuid(68000), false).tableId
      : uuid(67000);
    landed(f, from, toTable, new Date(Date.now() - 60000).toISOString());
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_residue_unproven',
      failedCheck: 'proveBanksHeldNothing.seatMoveInTransit',
      failedTable: toTable,
    });
    expect(f.arrivalReads).toEqual([{ table: toTable, occupancies: [uuid(68000)] }]);
    expect(f.moveReads).toEqual([{ ids: [uuid(69000)] }]);
    expect(f.calls).toEqual([]);
    expect(f.rpcCalls).toEqual([]);
  });

  /* A MOVE THE DESTINATION HAS ALREADY DEALT IS NOT IN TRANSIT (2026-09-24).
     Run 36050875490 refused on a move twenty-one minutes old into a seat that
     had since been dealt thirty-three hands. */
  it('accepts a move inside the hour once the destination has dealt that player a hand after it', async () => {
    const f: any = mixedFixture();
    const from = cashedOut(f, 600);
    const executed = new Date(Date.now() - 21 * 60000).toISOString();
    landed(f, from, uuid(67000), executed);
    f.onDealt((table: string, since: string, player: string) => {
      expect([table, since, player]).toEqual([uuid(67000), executed, from.departed]);
      return { data: [{ id: uuid(70000) }], error: null };
    });
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.dealtReads).toHaveLength(1);
    expect(result.bankDisposition).toContain('arrivalsInWindowChecked=1');
    expect(result.bankDisposition).toContain('arrivalsDealtSince=1');
  });

  it.each([
    ['no hand since', () => ({ data: [], error: null })],
    ['an unreadable answer', () => ({ data: null, error: { code: '57014' } })],
    ['a row it cannot read', () => ({ data: [{ id: 'x' }], error: null })],
  ])('still refuses a move inside the hour with %s', async (_label, answer: any) => {
    const f: any = mixedFixture();
    const from = cashedOut(f, 600);
    landed(f, from, uuid(67000), new Date(Date.now() - 21 * 60000).toISOString());
    f.onDealt(answer);
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'bank_residue_unproven' });
    expect(f.calls).toEqual([]);
  });

  it('asks nothing about a move that executed over an hour ago', async () => {
    const f: any = mixedFixture();
    const from = cashedOut(f, 600);
    landed(f, from, uuid(67000), new Date(Date.now() - 2 * 3600000).toISOString());
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.dealtReads).toEqual([]);
  });

  it('accepts a move out of a residue table that executed over an hour ago: its handoff can no longer be claimed', async () => {
    const f: any = mixedFixture();
    const from = cashedOut(f, 600);
    landed(f, from, uuid(67000), new Date(Date.now() - 2 * 3600000).toISOString());
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.bankDisposition).toContain('arrivalsInWindowChecked=1');
  });

  it('refuses a recent arrival whose source shows no residue, such as a swap partner', async () => {
    const f: any = mixedFixture();
    const { departed } = cashedOut(f, 600);
    f.onSeats(() => ({
      data: [{ table_id: uuid(67000), user_id: departed, occupancy_id: uuid(68000) }],
      error: null,
    }));
    f.onArrivals(() => ({
      data: [
        {
          move_id: uuid(69000),
          player_id: departed,
          from_table_id: uuid(69500),
          to_table_id: uuid(67000),
          source_occupancy_id: uuid(69001),
          destination_occupancy_id: uuid(68000),
        },
      ],
      error: null,
    }));
    f.onMoves(() => ({
      data: [{ id: uuid(69000), executed_at: new Date(Date.now() - 60000).toISOString() }],
      error: null,
    }));
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_residue_unproven',
      failedCheck: 'proveBanksHeldNothing.seatMoveInTransit',
      failedTable: uuid(67000),
    });
    expect(f.calls).toEqual([]);
  });

  it.each([
    [
      'openSeatsRead',
      'PGRST002',
      (f: any) => f.onSeats(() => ({ data: null, error: { code: 'PGRST002' } })),
    ],
    [
      'arrivalsRead',
      '42501',
      (f: any) => f.onArrivals(() => ({ data: null, error: { code: '42501' } })),
    ],
    ['movesRead', '57014', (f: any) => f.onMoves(() => ({ data: null, error: { code: '57014' } }))],
  ])('names the read that failed: %s', async (check, code, fault) => {
    const f: any = mixedFixture();
    const from = cashedOut(f, 600);
    landed(f, from, uuid(67000), new Date(Date.now() - 2 * 3600000).toISOString());
    fault(f);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_residue_unproven',
      failedCheck: `proveBanksHeldNothing.${check}`,
    });
    expect(result.observedDetail).toContain(`error=${code}`);
    expect(result.observedDetail).toMatch(/^[\w .,:/=()+-]+$/);
  });

  it.each([
    [
      'an unreadable arrivals answer',
      (f: any) => f.onArrivals(() => ({ data: null, error: { message: 'ENGINE_ONLY' } })),
    ],
    [
      'an arrival it cannot read',
      (f: any) => f.onArrivals(() => ({ data: [{ move_id: 'x' }], error: null })),
    ],
    [
      'an unreadable move answer',
      (f: any) => f.onMoves(() => ({ data: null, error: { message: 'PGRST002' } })),
    ],
    ['a move row that is missing', (f: any) => f.onMoves(() => ({ data: [], error: null }))],
    [
      'a move with no execution time',
      (f: any) =>
        f.onMoves(() => ({ data: [{ id: uuid(69000), executed_at: null }], error: null })),
    ],
  ])('refuses on %s', async (_label, fault) => {
    const f: any = mixedFixture();
    const from = cashedOut(f, 600);
    landed(f, from, uuid(67000), new Date(Date.now() - 2 * 3600000).toISOString());
    fault(f);
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'bank_residue_unproven' });
    expect(f.calls).toEqual([]);
  });

  it('proves a busted player departed, and never writes the bank the bust left behind', async () => {
    const f: any = mixedFixture();
    const { e, departed } = busted(f, 610);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.seatReads).toEqual([{ users: [departed] }]);
    expect(f.rows.has(e.tableId)).toBe(false);
    expect(e.timeBankEngine.playerBanks.size).toBe(1);
  });

  it('refuses an unseated bank whose timer is running', async () => {
    const f: any = mixedFixture();
    const { e } = busted(f, 610);
    for (const bank of e.timeBankEngine.playerBanks.values()) bank.isActive = true;
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'bank_occupancy_mismatch' });
    expect(f.seatReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('proves a quarantined stopped engine quiet from rows, and writes nothing for its disposed banks', async () => {
    const f: any = mixedFixture();
    const { e, authority, seated } = quarantined(f, 620);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, readyForRestart: true });
    expect(f.snapshotReads).toHaveLength(1);
    expect(f.snapshotReads[0].ids).toEqual([e.tableId]);
    expect(f.seatReads).toEqual([]);
    expect(result.bankDisposition).toContain('disposedTables=1');
    expect(result.bankDisposition).toContain('disposedSeats=1');
    expect(result.bankDisposition).toContain(
      `disposedEvents=${authority.tournamentId.slice(0, 8)}`
    );
    expect(result.bankDisposition).not.toContain(seated);
    expect(f.rows.has(e.tableId)).toBe(false);
    // The guard proves, it never edits: the roster and metadata are as found.
    expect([...e.timeBankMeta.keys()]).toEqual([seated]);
  });

  it('refuses a quarantined stopped engine with a hand in the air, and names the table', async () => {
    const f: any = mixedFixture();
    const { e } = quarantined(f, 620);
    f.onSnapshots(() => ({ data: [{ table_id: e.tableId, hand_number: 1 }], error: null }));
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'stopped_disposed_banks_unproven',
      failedCheck: 'proveBanksHeldNothing.handInTheAir',
      failedTable: e.tableId,
    });
    expect(f.calls).toEqual([]);
    expect(f.rpcCalls).toEqual([]);
  });

  it('refuses a quarantined stopped engine on an unreadable snapshot, and writes nothing', async () => {
    const f: any = mixedFixture();
    quarantined(f, 620);
    f.onSnapshots(() => ({ data: null, error: { message: 'PGRST002' } }) as any);
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'stopped_disposed_banks_unproven' });
    expect(f.calls).toEqual([]);
  });

  it('still refuses a stopped engine that holds a bank', async () => {
    const f: any = mixedFixture();
    const { e } = quarantined(f, 620);
    const userId = e.seatedPlayers[0].user_id;
    e.timeBankEngine.playerBanks.set(`${e.tableId}:${userId}`, {
      tableId: e.tableId,
      playerId: userId,
      remainingSeconds: 75,
      usesRemaining: 2,
      isActive: false,
      unlimitedActivations: false,
    });
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'stopped_engine_retains_custody' });
    expect(f.calls).toEqual([]);
  });

  /* A LIVE SEAT BETWEEN ITS BANKS IS NOT CUSTODY (2026-09-24).

     Run 36026978112 refused `bank_metadata_without_bank` on 3a294223, ONE live
     cash table out of 439 walked, whose seated player held metadata and no
     bank (`fleetLiveSeatedMeta=1`). 8825 creates a seat's bank and metadata
     together at deal time (ServerTableEngineDealing.ts:2955) and deletes the
     metadata only for a user the next roster no longer holds
     (ServerTableEngineBase.ts:4283), so a player removed and re-seated at the
     same table keeps the metadata, loses the bank, and gets both back at the
     next deal. `captureParkedTimeBanks` skips a seat with no bank, so the row
     written is identical either way: the refusal protected no value and made
     the release a lottery on fleet churn. */
  it('a live seated player between its banks is proved from rows, not refused', async () => {
    const f: any = mixedFixture();
    const e: any = new f.Table(630);
    e.timeBankEngine.playerBanks.clear();
    f.server.tableEngines.set(e.tableId, e);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    // It joins `disposed` and the felt of its table is proved quiet from rows.
    expect(result.bankDisposition).toContain('disposedTables=1');
    expect(result.bankDisposition).toContain('disposedSeats=1');
    expect(f.snapshotReads.map((read: any) => read.ids)).toContainEqual([e.tableId]);
    // Nothing is persisted for that seat, exactly as the engine itself would.
    expect(f.rows.has(e.tableId)).toBe(false);
  });

  it('a hand in the air on that live table still refuses the whole checkpoint', async () => {
    const f: any = mixedFixture();
    const e: any = new f.Table(631);
    e.timeBankEngine.playerBanks.clear();
    f.server.tableEngines.set(e.tableId, e);
    f.onSnapshots((ids: string[]) => ({
      data: ids.includes(e.tableId)
        ? [
            {
              table_id: e.tableId,
              hand_number: 9,
              stage: 'flop',
              updated_at: new Date().toISOString(),
            },
          ]
        : [],
      error: null,
    }));
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'stopped_disposed_banks_unproven',
    });
    expect(f.calls).toEqual([]);
  });

  it('a STOPPED engine that kept a bank still refuses on the same require', async () => {
    const f: any = mixedFixture();
    const { e } = quarantined(f, 632);
    // `quarantined` keeps the roster and the metadata and clears the banks.
    // Give it back a bank for someone the roster no longer seats, so its
    // seated player's metadata is no longer explained by a stop that disposed
    // everything.
    e.timeBankEngine.playerBanks.set(`${e.tableId}:${uuid(74632)}`, {
      tableId: e.tableId,
      playerId: uuid(74632),
      remainingSeconds: 75,
      usesRemaining: 2,
      isActive: false,
      unlimitedActivations: false,
    });
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'bank_metadata_without_bank',
      failedTable: e.tableId,
    });
    expect(f.seatReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  /* A RESTORED BANK NO ROSTER WILL EVER CLAIM (2026-09-24).

     Run 36000655625 refused `captureEngine.parked_bank_invalid` on b027e4cf
     with `stopped=true terminal=true seats=0 banks=0 meta=0 parked=2`: an
     engine that started, read its two parked banks from
     `engine_presence_parked`, and was stopped before the wait-for-players loop
     ever adopted a roster. `applyParkedTimeBanks` is the only thing that
     empties that map and `adoptSeatRoster` is its only caller, so a stopped
     terminal engine holds those banks for ever. */
  const restoredBank = (n: number) => ({
    occupancyId: uuid(77000 + n),
    remainingSeconds: 75,
    usesRemaining: 2,
    initialSeconds: 90,
    baseSeconds: 30,
    dbConsumedSeconds: 15,
    unlimitedActivations: false,
  });
  const parkedNoRoster = (f: any, n: number, banks = 1) => {
    const { e } = quarantined(f, n);
    e.seatedPlayers = [];
    e.timeBankMeta.clear();
    e.timeBankEngine.playerBanks.clear();
    e.parkedTimeBanks = Object.fromEntries(
      Array.from({ length: banks }, (_, i) => [uuid(76000 + n + i), restoredBank(n + i)])
    );
    return e;
  };

  /* A DEAD GENERATION PROVES ITS PARK FROM THE ROW IT READ (2026-09-24).

     Run 36061780372 (the 21:36 recovery window) cleared every capture
     refusal and every row proof, wrote 83 tables, and refused
     `native_checkpoint_unconfirmed`: 22 of those writes came back `403
     TOURNAMENT_MANAGER_FENCED: lease generation is no longer current` - the
     eleven `parkedNoRoster` tables, each written once and retried once. A
     stopped tournament engine on a dead lease generation cannot write
     tournament data, and the database is right to refuse it. It does not
     need to: the row it would write is the row it read at `start()`, at the
     same hand, so the guard proves THAT row instead of writing it, and holds
     it to the standard the write would have been. */
  const rowTheEngineRead = (f: any, e: any, overrides: Record<string, unknown> = {}) => {
    const parkedAt = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const row = {
      table_id: e.tableId,
      // Written by whichever process parked this table last; not this one.
      engine_instance: '1-e662d4b1:parked',
      parked_at: parkedAt,
      disconnect_states: { [uuid(90001)]: { state: 'disconnected' } },
      time_bank_snapshot: {
        version: 1,
        parkedAt,
        handNumber: e.handCount,
        players: structuredClone(e.parkedTimeBanks),
      },
      ...overrides,
    };
    f.rows.set(e.tableId, row);
    return structuredClone(row);
  };

  it('a restored bank no roster will ever claim is deferred, proved from rows, and its row is proved rather than written', async () => {
    const f: any = mixedFixture();
    const e = parkedNoRoster(f, 640, 2);
    // The write the database would fence. It is never attempted.
    f.fence(e.tableId);
    const before = rowTheEngineRead(f, e);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.unresolvableCustody).toContain(`${e.tableId}:parkedNoRoster:2`);
    // It asked the database, per table, with the one predicate this file has.
    expect(f.snapshotReads.map((read: any) => read.ids)).toContainEqual([e.tableId]);
    // The row it read is the row that stands: untouched, same banks, same hand.
    expect(f.rows.get(e.tableId)).toEqual(before);
    // It was never written: the one park call is the mixed original's.
    expect(f.calls).toEqual(['parked']);
    expect(result.attemptedTables).toBe(1);
    expect(result.verifiedTables).toBe(1);
    expect(result.provedRows).toContain('tables=1/1 tournament=1');
    expect(result.provedRows).toContain(
      `${e.tableId.slice(0, 8)}:tournament:banks=2:extra=0:states=1`
    );
    // And the engine's own unwritten-park reason did not hold the release.
    expect(e.parkedBankSaveComplete).toBe(false);
    expect(e.isMaintenanceStateDurable()).toBe(false);
  });

  it('a row the loader would have skipped an entry of is still the row it read', async () => {
    const f: any = mixedFixture();
    const e = parkedNoRoster(f, 650, 1);
    f.fence(e.tableId);
    const row = rowTheEngineRead(f, e);
    // An unrestorable entry: `loadTimeBanksFromPark` skipped it, so the engine
    // never held it, and the successor skips it again.
    row.time_bank_snapshot.players[uuid(76999)] = { ...restoredBank(650), remainingSeconds: 900 };
    f.rows.set(e.tableId, row);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.provedRows).toContain(`${e.tableId.slice(0, 8)}:tournament:banks=1:extra=1`);
  });

  /* A row that does not say what the engine holds is not a proof, and the
     capture stays on the write path it always had. On a dead generation that
     write is fenced and the refusal names the table, the deferral and the
     check the row failed; on a live one it is written and read back inside
     its own write window, exactly as before. */
  const unprovenRow = async (
    n: number,
    alter: (row: any, e: any) => void,
    fence: boolean
  ): Promise<{ result: any; e: any; f: any }> => {
    const f: any = mixedFixture();
    const e = parkedNoRoster(f, n, 2);
    if (fence) f.fence(e.tableId);
    const row = rowTheEngineRead(f, e);
    alter(row, e);
    f.rows.set(e.tableId, row);
    return { result: await f.run(), e, f };
  };
  const unprovenShapes: [string, string, (row: any, e: any) => void, string][] = [
    [
      'a restorable bank the engine does not hold',
      'snapshot.extraPlayers',
      (row) => {
        row.time_bank_snapshot.players[uuid(76998)] = restoredBank(651);
      },
      '',
    ],
    [
      'a bank that does not match the one the engine holds',
      'snapshot.players',
      (row, e) => {
        row.time_bank_snapshot.players[Object.keys(e.parkedTimeBanks)[0]].remainingSeconds = 10;
      },
      '',
    ],
    [
      'another hand',
      'snapshot.handNumber',
      (row, e) => {
        row.time_bank_snapshot.handNumber = e.handCount + 1;
      },
      '',
    ],
    [
      'an announcement that nulled the snapshot',
      'snapshot.shape',
      (row) => {
        row.time_bank_snapshot = null;
      },
      '',
    ],
    [
      'a presence the successor would still read',
      'row.presence',
      (row) => {
        const parkedAt = new Date(Date.now() - 60000).toISOString();
        row.parked_at = parkedAt;
        row.time_bank_snapshot.parkedAt = parkedAt;
      },
      '',
    ],
  ];

  it.each(unprovenShapes)(
    'a row holding %s is not a proof: on a dead generation the fenced write refuses, naming the check (%s)',
    async (_shape, check, alter) => {
      const { result, e } = await unprovenRow(651, alter, true);
      expect(result).toMatchObject({
        ok: false,
        reason: 'native_checkpoint_unconfirmed',
        failedCheck: 'engine.parkedBankSaveComplete',
        failedTable: e.tableId,
      });
      expect(result.observedDetail).toContain(`rowProof=${check}`);
      expect(result.observedDetail).toContain('deferred=parkedNoRoster:2');
      expect(result.provedRows).toContain(`tables=0/1`);
      expect(result.provedRows).toContain(`${e.tableId.slice(0, 8)}:unproven=${check}`);
    }
  );

  it.each(unprovenShapes)(
    'a row holding %s is not a proof: on a live generation the row is written and read back (%s)',
    async (_shape, check, alter) => {
      const { result, e, f } = await unprovenRow(652, alter, false);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, attemptedTables: 2 });
      expect(result.provedRows).toContain(`${e.tableId.slice(0, 8)}:unproven=${check}`);
      // The row it writes is the row it read: the same banks, same hand, fresh.
      const row = f.rows.get(e.tableId);
      expect(row.engine_instance).toBe('1-3846b8bb:parked');
      expect(row.time_bank_snapshot.players).toEqual(e.parkedTimeBanks);
      expect(row.time_bank_snapshot.handNumber).toBe(e.handCount);
      expect(row.disconnect_states).toEqual({});
    }
  );

  it('a row that is gone is not a proof either: nothing is invented, the write path answers', async () => {
    const f: any = mixedFixture();
    const e = parkedNoRoster(f, 654, 1);
    f.fence(e.tableId);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'native_checkpoint_unconfirmed',
      failedTable: e.tableId,
    });
    expect(result.observedDetail).toContain('rowProof=row.present');
    expect(f.rows.has(e.tableId)).toBe(false);
  });

  it('a row read that errors is not a proof: the write path answers', async () => {
    const f: any = mixedFixture();
    const e = parkedNoRoster(f, 656, 1);
    rowTheEngineRead(f, e);
    let reads = 0;
    f.onRead(() => {
      reads += 1;
      throw new Error('synthetic read failure');
    });
    const result: any = await f.run();
    // The read threw inside the client call; the guard cannot use it as a
    // proof, and refuses on the throw exactly as any other failed read does.
    expect(result.ok).toBe(false);
    expect(reads).toBe(1);
  });

  it('a fenced write on a table that is NOT a dead generation still refuses, and now names the table', async () => {
    const f: any = mixedFixture();
    // The mixed original's own seated player: it writes, and the write is refused.
    const first = f.first;
    f.fence(first.tableId);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'native_checkpoint_unconfirmed',
      failedCheck: 'engine.parkedBankSaveComplete',
      failedTable: first.tableId,
    });
    expect(result.observedDetail).toContain('deferred=none');
    expect(f.calls).toEqual(['parked']);
  });

  it('a table the engine will not call durable for any other reason still refuses, naming it', async () => {
    const f: any = mixedFixture();
    const e = parkedNoRoster(f, 655, 1);
    f.fence(e.tableId);
    rowTheEngineRead(f, e);
    // 8825's own reason for this shape is `bank_park_write_incomplete`; any
    // other reason on the same table is an engine this guard does not
    // understand, and it refuses exactly as the process-wide require did.
    e.maintenanceDurabilityReason = () => 'accounting_pending';
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'native_readiness_refused',
      failedCheck: 'engine.isMaintenanceStateDurable',
      failedTable: e.tableId,
    });
    expect(result.observedDetail).toContain('durability=accounting_pending');
    expect(result.observedDetail).toContain('rowProved=true');
  });

  it('a hand in the air on that table refuses the restored bank too', async () => {
    const f: any = mixedFixture();
    parkedNoRoster(f, 641);
    f.onSnapshots((ids: string[]) => ({
      data: [
        { table_id: ids[0], hand_number: 9, stage: 'flop', updated_at: new Date().toISOString() },
      ],
      error: null,
    }));
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'f06_custody_unresolvable_unproven',
    });
    expect(f.calls).toEqual([]);
  });

  it('a LIVE engine with a restored bank keeps the flat occupancy equality', async () => {
    const f: any = mixedFixture();
    const e: any = new f.Table(642);
    // Empty, parked and live: every OTHER conjunct of the deferral holds, so
    // only "this engine can still adopt a roster" refuses it.
    e.seatedPlayers = [];
    e.timeBankMeta.clear();
    e.timeBankEngine.playerBanks.clear();
    e.parkedTimeBanks = { [uuid(76642)]: restoredBank(642) };
    f.server.tableEngines.set(e.tableId, e);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'parked_bank_invalid',
      failedTable: e.tableId,
    });
    expect(result.observedDetail).toContain('parkedFault=unseated');
    expect(f.calls).toEqual([]);
  });

  it('a dead engine that still seats the player keeps the flat occupancy equality', async () => {
    const f: any = mixedFixture();
    const { e, seated } = quarantined(f, 643);
    e.timeBankMeta.clear();
    e.parkedTimeBanks = { [seated]: { ...restoredBank(643), occupancyId: uuid(79643) } };
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'parked_bank_invalid',
      failedTable: e.tableId,
    });
    expect(result.observedDetail).toContain('parkedFault=occupancy_mismatch');
    expect(f.calls).toEqual([]);
  });

  it('a dead engine that still holds a live bank refuses the restored bank', async () => {
    const f: any = mixedFixture();
    const e = parkedNoRoster(f, 644);
    const orphan = uuid(78644);
    e.timeBankEngine.playerBanks.set(`${e.tableId}:${orphan}`, {
      tableId: e.tableId,
      playerId: orphan,
      remainingSeconds: 75,
      usesRemaining: 2,
      isActive: false,
      unlimitedActivations: false,
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'parked_bank_invalid',
      failedTable: e.tableId,
    });
    expect(f.calls).toEqual([]);
  });

  it('a dead engine that still holds bank metadata refuses the restored bank', async () => {
    const f: any = mixedFixture();
    const e = parkedNoRoster(f, 645);
    e.timeBankMeta.set(uuid(78645), {
      initialSeconds: 90,
      baseSeconds: 30,
      dbConsumedSeconds: 15,
    });
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'parked_bank_invalid',
      failedTable: e.tableId,
    });
    expect(f.calls).toEqual([]);
  });

  it('an unrestorable restored bank refuses on every engine, dead or not', async () => {
    const f: any = mixedFixture();
    const e = parkedNoRoster(f, 646);
    e.parkedTimeBanks = { [uuid(76646)]: { ...restoredBank(646), remainingSeconds: 900 } };
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'parked_bank_invalid',
      failedTable: e.tableId,
    });
    expect(result.observedDetail).toContain('parkedFault=bank_not_restorable');
    expect(f.calls).toEqual([]);
  });

  /* A TEARDOWN A DEAD PROCESS CAN NEVER FINISH (2026-09-24).

     Run 36015361207 cleared every capture refusal and stopped on the join,
     verbatim:

       failedCheck previousNativeWork.teardown
       failedTable 6557ebd8-b75e-4ad6-a9b6-80948ebc5f4e
       unfulfilled=8,joined=738,presenceSave=0,teardown=8,stopped=true,
       scope=tournament,tournament=056e5fc8-08e0-4308-a8fb-9f09e5fc182e,
       reason=Table engine ... teardown failed in operation,
       tables=6557ebd8:teardown/0af45012:teardown/d6d591fb:teardown/
         c021b81c:teardown/345fc387:teardown/2e389f6e:teardown/
         c1024195:teardown/6862a6e5:teardown

     Eight stopped engines of one tournament whose lease the process lost.
     8825 `stop()` memoizes the rejected teardown, so it is rejected for ever. */
  const observedTournament = '056e5fc8-08e0-4308-a8fb-9f09e5fc182e';
  const observedTables = [
    '6557ebd8-b75e-4ad6-a9b6-80948ebc5f4e',
    '0af45012-0000-4000-8000-000000000002',
    'd6d591fb-0000-4000-8000-000000000003',
    'c021b81c-0000-4000-8000-000000000004',
    '345fc387-0000-4000-8000-000000000005',
    '2e389f6e-0000-4000-8000-000000000006',
    'c1024195-0000-4000-8000-000000000007',
    '6862a6e5-0000-4000-8000-000000000008',
  ];
  // The exact rejection 8825 `performStop` raises at its end
  // (ServerTableEngineBase.ts:3613), after every cleanup step has run.
  const failedTeardown = (
    tableId: string,
    failures: unknown[] = [new Error('snapshot write failed')]
  ) =>
    new AggregateError(
      failures,
      `Table engine ${tableId} teardown failed in ${failures.length} operation(s)`
    );
  const rejected = (reason: unknown) => {
    const promise = Promise.reject(reason);
    promise.catch(() => undefined);
    return promise;
  };
  const deadTeardown = (
    f: any,
    n: number,
    tableId: string,
    reason: unknown = failedTeardown(tableId)
  ) => {
    // `quarantined` above, on the observed table and tournament.
    const e: any = new f.Table(n);
    const authority = { tournamentId: observedTournament, leaseGeneration: uuid(73000 + n) };
    Object.assign(e, {
      tableId,
      running: false,
      terminal: true,
      dealingLoopPromise: null,
      readContinuationTasks: new Set(),
      engineLeaseScope: 'tournament',
      engineLeaseVerified: true,
      engineLeaseTournamentId: authority.tournamentId,
      engineLeaseGeneration: authority.leaseGeneration,
    });
    dataActorContext.bindTournamentDataAuthorityMethods(authority, e);
    e.seatedPlayers = [];
    e.timeBankMeta.clear();
    e.timeBankEngine.playerBanks.clear();
    e.terminalTeardownComplete = false;
    e.handController = null;
    e.teardownPromise = rejected(reason);
    f.server.tableEngines.set(e.tableId, e);
    return e;
  };
  const observedFleet = (f: any) =>
    observedTables.map((tableId, i) => deadTeardown(f, 660 + i, tableId));

  it('the observed eight dead teardowns are deferred and proved from rows', async () => {
    const f: any = mixedFixture();
    observedFleet(f);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    for (const tableId of observedTables)
      expect(result.unresolvableCustody).toContain(`${tableId}:failedTeardown:1`);
    // It asked the database for every one of them, with the one predicate.
    const asked = f.snapshotReads.flatMap((read: any) => read.ids);
    for (const tableId of observedTables) expect(asked).toContain(tableId);
    // Nothing is written for an engine that holds nothing.
    for (const tableId of observedTables) expect(f.rows.has(tableId)).toBe(false);
  });

  /* A JOIN THAT NEVER COMES BACK IS NOT WAITED FOR (2026-09-24). Run
     36041108119 outlived the publisher's 20000ms work budget with every
     capture admitted or deferred, and the only unbounded wait on that path
     was the previous-work join. It is bounded now, and a promise still
     pending at the budget is named like a rejection. */
  const pendingForever = () => new Promise<void>(() => undefined);

  it('a stopped engine whose teardown never settles is dead work: deferred, proved from rows', async () => {
    const f: any = mixedFixture();
    const e = deadTeardown(f, 680, observedTables[0], undefined);
    e.teardownPromise = pendingForever();
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.unresolvableCustody).toContain(`${e.tableId}:pendingTeardown`);
    expect(f.snapshotReads.flatMap((read: any) => read.ids)).toContain(e.tableId);
    expect(f.rows.has(e.tableId)).toBe(false);
  }, 20_000);

  it('a park write that never settles refuses, and names its table and its join', async () => {
    const f: any = mixedFixture();
    f.first.presenceSave = pendingForever();
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'previous_native_work_unconfirmed',
      failedCheck: 'previousNativeWork.presenceSave',
      failedTable: f.first.tableId,
    });
    expect(result.nativeWorkMembers).toContain('r.PendingJoin(none)=1');
    expect(f.calls).toEqual([]);
  }, 20_000);

  it('the guard leaves its progress on the global object, for the client to read when the outcome is lost', async () => {
    const f: any = mixedFixture();
    const result: any = await f.run();
    expect(result.ok).toBe(true);
    const progress = (globalThis as any).__legacyEngineCheckpointProgress;
    expect(progress).toMatchObject({
      schema: 'legacy-engine-checkpoint-progress/v1',
      stage: 'complete',
      note: 'complete',
      reason: null,
    });
    expect(progress.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(progress.verifiedTables).toBe(result.verifiedTables);
  });

  it('a teardown that failed in several operations is the same dead teardown', async () => {
    const f: any = mixedFixture();
    const e = deadTeardown(
      f,
      670,
      observedTables[0],
      failedTeardown(observedTables[0], [new Error('settlement'), new Error('dispose')])
    );
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.unresolvableCustody).toContain(`${e.tableId}:failedTeardown:2`);
  });

  it('a hand in the air on one of those tables still refuses, from rows', async () => {
    const f: any = mixedFixture();
    observedFleet(f);
    f.onSnapshots((ids: string[]) => ({
      data: ids.includes(observedTables[3])
        ? [
            {
              table_id: observedTables[3],
              hand_number: 9,
              stage: 'flop',
              updated_at: new Date().toISOString(),
            },
          ]
        : [],
      error: null,
    }));
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'f06_custody_unresolvable_unproven',
    });
    expect(f.calls).toEqual([]);
  });

  it('a row proof that cannot tell still refuses', async () => {
    const f: any = mixedFixture();
    observedFleet(f);
    f.onSnapshots(() => ({ data: null, error: { message: 'timeout' } }));
    expect(await f.run()).toMatchObject({
      ok: false,
      reason: 'f06_custody_unresolvable_unproven',
    });
    expect(f.calls).toEqual([]);
  });

  it.each([
    [
      'a rejection that is not the 8825 sentence (a cashout on the seat boundary)',
      (id: string) => new Error(`cash out failed for ${id}`),
    ],
    ['the 8825 sentence for another table', () => failedTeardown(observedTables[1])],
    [
      'a count that does not match its errors',
      (id: string) =>
        new AggregateError(
          [new Error('x')],
          `Table engine ${id} teardown failed in 2 operation(s)`
        ),
    ],
    [
      'an AggregateError with no errors',
      (id: string) =>
        new AggregateError([], `Table engine ${id} teardown failed in 0 operation(s)`),
    ],
  ])('%s still refuses the join, and no row is read', async (_label, reason) => {
    const f: any = mixedFixture();
    deadTeardown(f, 671, observedTables[0], reason(observedTables[0]));
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'previous_native_work_unconfirmed',
      failedCheck: 'previousNativeWork.teardown',
      failedTable: observedTables[0],
    });
    expect(result.observedDetail).toContain('teardownDeferred=0');
    expect(f.snapshotReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it.each([
    ['a teardown the engine says completed', (e: any) => (e.terminalTeardownComplete = true)],
    [
      'an engine that does not carry the completion field',
      (e: any) => delete e.terminalTeardownComplete,
    ],
  ])('%s still refuses the join with the same code', async (_label, mutate) => {
    const f: any = mixedFixture();
    const e = deadTeardown(f, 672, observedTables[0]);
    mutate(e);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'previous_native_work_unconfirmed',
      failedCheck: 'previousNativeWork.teardown',
      failedTable: observedTables[0],
      restartAuthorized: false,
    });
    expect(f.snapshotReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('a stopped engine with a recovery in flight is not dead and refuses as before', async () => {
    const f: any = mixedFixture();
    const e = deadTeardown(f, 673, observedTables[0]);
    e.f06RecoveryInFlight = true;
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'f06_custody_not_drained' });
    expect(f.snapshotReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('only the dead teardowns are deferred: one failed presence write still refuses the release', async () => {
    const f: any = mixedFixture();
    observedFleet(f);
    const live: any = new f.Table(679);
    live.presenceSave = rejected(failedTeardown(live.tableId));
    f.server.tableEngines.set(live.tableId, live);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'previous_native_work_unconfirmed',
      failedCheck: 'previousNativeWork.presenceSave',
      failedTable: live.tableId,
    });
    expect(result.observedDetail).toContain('unfulfilled=1');
    expect(result.observedDetail).toContain('teardownDeferred=8');
    expect(f.calls).toEqual([]);
  });

  /* WHAT IS ACTUALLY INSIDE THE REJECTION (2026-09-24). The deferral above is
     argued from `performStop`'s source: the AggregateError it throws collects
     from three places and none of them can hide an unwritten money fact on
     8825. Nothing in the record said what the members of those eight
     aggregates actually were, so nothing confirmed that from the running
     fleet, and a release that steps over a rejection left no account of what
     it stepped over. */
  const member = (name: string, code: unknown, message: string) =>
    Object.assign(new Error(message), { name, ...(code === undefined ? {} : { code }) });

  /* A DEFERRAL RECORD NOBODY CAN READ IS NOT A RECORD (2026-09-24). Run
     36022429840 deferred 47 tables and the 512-character carrier left the
     first nine, alphabetically, so the kinds behind the other 38 were gone. */
  it('the kinds survive the carrier when the table list does not', async () => {
    const f: any = mixedFixture();
    for (let i = 0; i < 40; i++)
      deadTeardown(f, 700 + i, `aaaa${1000 + i}-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.unresolvableCustody).toContain('tables=40');
    // The count of each kind is readable even though the list is not.
    expect(result.unresolvableCustody).toContain('failedTeardown=40');
    expect(result.unresolvableCustody.length).toBeLessThanOrEqual(512);
    expect(result.unresolvableCustody).toMatch(/^[\w .,:/=()+-]+$/);
  });

  it('accounts for every teardown it stepped over, on the path that proceeds', async () => {
    const f: any = mixedFixture();
    observedFleet(f);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    // Eight rejections, all of them deferred, none of them still refusing.
    expect(result.nativeWorkMembers).toContain('joins=8');
    expect(result.nativeWorkMembers).toContain('deferredJoins=8');
    expect(result.nativeWorkMembers).toContain('refusingJoins=0');
    expect(result.nativeWorkMembers).toContain('members=8');
    // `d.` is a rejection the release stepped over, with its type and code.
    expect(result.nativeWorkMembers).toContain('d.Error(none)=8');
    // Eight copies of one failure cost one sentence.
    expect(result.nativeWorkMembers).toContain('words=snapshot write failed');
    expect(result.nativeWorkMembers).toMatch(/^[\w .,:/=()+-]+$/);
    expect(result.nativeWorkMembers.length).toBeLessThanOrEqual(512);
  });

  it('names the type and the structured code of each member it stepped over', async () => {
    const f: any = mixedFixture();
    deadTeardown(
      f,
      680,
      observedTables[0],
      failedTeardown(observedTables[0], [
        member('PostgrestError', '23505', 'settlement insert 9421 rejected for hand 8412773'),
        member('Error', undefined, 'terminal snapshot flush failed'),
      ])
    );
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.nativeWorkMembers).toContain('members=2');
    expect(result.nativeWorkMembers).toContain('d.PostgrestError(23505)=1');
    expect(result.nativeWorkMembers).toContain('d.Error(none)=1');
    expect(result.nativeWorkMembers).toContain('settlement insert rejected for hand');
    expect(result.nativeWorkMembers).toContain('terminal snapshot flush failed');
    // No id, hand number or amount travels through a member's message.
    expect(result.nativeWorkMembers).not.toContain('9421');
    expect(result.nativeWorkMembers).not.toContain('8412773');
    expect(result.nativeWorkMembers).toMatch(/^[\w .,:/=()+-]+$/);
  });

  it('separates a join that still refuses from the ones it stepped over', async () => {
    const f: any = mixedFixture();
    observedFleet(f);
    const live: any = new f.Table(681);
    live.presenceSave = rejected(member('PostgrestError', 'PGRST116', 'park write refused'));
    f.server.tableEngines.set(live.tableId, live);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'previous_native_work_unconfirmed',
      failedCheck: 'previousNativeWork.presenceSave',
    });
    expect(result.nativeWorkMembers).toContain('joins=9');
    expect(result.nativeWorkMembers).toContain('deferredJoins=8');
    expect(result.nativeWorkMembers).toContain('refusingJoins=1');
    // `r.` is the one still refusing; `d.` are the ones stepped over.
    expect(result.nativeWorkMembers).toContain('r.PostgrestError(PGRST116)=1');
    expect(result.nativeWorkMembers).toContain('d.Error(none)=8');
    // The named table says how deep its own rejection was.
    expect(result.observedDetail).toContain('members=1');
    expect(f.calls).toEqual([]);
  });

  it('refuses a type or a code that is not identifier-shaped rather than carrying it', async () => {
    const f: any = mixedFixture();
    deadTeardown(
      f,
      682,
      observedTables[0],
      failedTeardown(observedTables[0], [
        member('Error', 'user 6f1e2a33-0000-4000-8000-000000000001', 'write refused'),
        member('seat 8a02bd41-0000-4000-8000-000000000002 failed', 'PGRST116', 'read refused'),
      ])
    );
    const result: any = await f.run();
    // A code-shaped value is carried; anything else becomes `none`.
    expect(result.nativeWorkMembers).toContain('d.Error(none)=1');
    // A type that is not a type name becomes `unknown`, with its code kept.
    expect(result.nativeWorkMembers).toContain('d.unknown(PGRST116)=1');
    expect(result.nativeWorkMembers).not.toContain('6f1e2a33');
    expect(result.nativeWorkMembers).not.toContain('8a02bd41');
    expect(result.nativeWorkMembers).toMatch(/^[\w .,:/=()+-]+$/);
  });

  it('reports a rejection that carries no members as one member', async () => {
    const f: any = mixedFixture();
    deadTeardown(f, 683, observedTables[0], new Error('retained an unresolved seat-move 4f21e0c2'));
    const result: any = await f.run();
    // Not the 8825 sentence, so it still refuses, and it still says what it is.
    expect(result).toMatchObject({ ok: false, reason: 'previous_native_work_unconfirmed' });
    expect(result.nativeWorkMembers).toContain('joins=1');
    expect(result.nativeWorkMembers).toContain('deferredJoins=0');
    expect(result.nativeWorkMembers).toContain('members=1');
    expect(result.nativeWorkMembers).toContain('r.Error(none)=1');
    expect(result.nativeWorkMembers).toContain('retained an unresolved seat move');
    expect(result.nativeWorkMembers).not.toContain('4f21e0c2');
    expect(result.observedDetail).toContain('members=1');
  });

  it('adds no member record when every join comes back', async () => {
    const f: any = mixedFixture();
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.nativeWorkMembers).toBeUndefined();
  });

  /* ONE REFUSED RELEASE, THE WHOLE BLOCKING SET. The release only ever named
     the table that refused FIRST, so a fleet holding several shapes cost one
     maintenance break per shape to read. The walk now finishes and counts. */
  it('names every table the capture would refuse, not only the first', async () => {
    const f: any = mixedFixture();
    const first = parkedNoRoster(f, 647);
    const second: any = new f.Table(648);
    second.seatedPlayers = [];
    second.timeBankMeta.clear();
    second.timeBankEngine.playerBanks.clear();
    second.parkedTimeBanks = { [uuid(76648)]: restoredBank(648) };
    f.server.tableEngines.set(second.tableId, second);
    const third: any = new f.Table(649);
    third.actionLock = true;
    f.server.tableEngines.set(third.tableId, third);
    const result: any = await f.run();
    // The first refusal still decides the outcome and still carries the detail.
    expect(result).toMatchObject({ ok: false, failedTable: second.tableId });
    expect(result.reason).toBe('parked_bank_invalid');
    // And the census names the other one, with a count per code.
    expect(result.refusalCensus).toContain('refusedTables=2');
    expect(result.refusalCensus).toContain('parked_bank_invalid=1');
    expect(result.refusalCensus).toContain('engine_work_not_drained=1');
    expect(result.refusalCensus).toContain(second.tableId.slice(0, 8));
    expect(result.refusalCensus).toContain(third.tableId.slice(0, 8));
    // It survives the publisher's carrier, like every other observation.
    expect(result.refusalCensus).toMatch(/^[\w .,:/=()+-]+$/);
    expect(result.refusalCensus.length).toBeLessThanOrEqual(512);
    // Nothing is captured, proved or written after the first refusal.
    expect(result).toMatchObject({ attemptedTables: 0, checkpointOutcome: 'not_started' });
    expect(f.calls).toEqual([]);
    expect(f.snapshotReads).toEqual([]);
    expect(first.tableId).not.toBe(second.tableId);
  });

  it('refuses residue that moves between observations', async () => {
    const f: any = mixedFixture();
    const { e } = cashedOut(f, 600);
    // The live fleet write happens after the proof; residue that grows there is
    // not the residue the rows proved.
    f.onWrite(() => {
      e.timeBankMeta.set(uuid(64000), {
        initialSeconds: 90,
        baseSeconds: 30,
        dbConsumedSeconds: 0,
      });
    });
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'engine_state_changed',
      failedCheck: 'custody',
      failedTable: e.tableId,
    });
    expect(result.observedDetail).toBe('moved=residue');
  });

  /* PRESENCE IS OBSERVED; CUSTODY IS HELD (2026-09-24). Run 36056765988
     wrote 79 park rows and refused engine_state_changed on the
     re-verification, naming nothing. The only part of the signature the
     break does not freeze is the disconnect FSM. */
  it('a presence value that moves between the capture and the write is adopted, and the row is read against it', async () => {
    const f: any = mixedFixture();
    const e: any = f.first;
    const userId = e.seatedPlayers[0].user_id;
    let state: any = { [userId]: { status: 'connected', since: 1 } };
    e.disconnectEngine = { getFsmStatesForTable: () => structuredClone(state) };
    f.onWrite((engine: any) => {
      if (engine === e) state = { [userId]: { status: 'disconnected', since: 2 } };
    });
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.rows.get(e.tableId).disconnect_states).toEqual({
      [userId]: { status: 'disconnected', since: 2 },
    });
  });

  it('a presence registry that changes between observations still refuses, and names it', async () => {
    const f: any = mixedFixture();
    const e: any = f.first;
    const userId = e.seatedPlayers[0].user_id;
    let state: any = { [userId]: { status: 'connected' } };
    e.disconnectEngine = { getFsmStatesForTable: () => structuredClone(state) };
    f.onWrite((engine: any) => {
      if (engine === e) state = {};
    });
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'engine_state_changed',
      failedCheck: 'presence.registry',
      failedTable: e.tableId,
    });
    expect(result.observedDetail).toBe('presenceRegistry=0/1');
  });

  it('a readback whose presence names a different set of players still refuses', async () => {
    const f: any = mixedFixture();
    const e: any = f.first;
    const userId = e.seatedPlayers[0].user_id;
    e.disconnectEngine = { getFsmStatesForTable: () => ({ [userId]: { status: 'connected' } }) };
    f.onRead((data: any[]) =>
      data.map((row: any) =>
        row.table_id === e.tableId
          ? { ...row, disconnect_states: { [uuid(64001)]: { status: 'connected' } } }
          : row
      )
    );
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'checkpoint_readback_mismatch' });
  });

  it('leaves every other profile exactly as strict as before', async () => {
    const f = fixture(2);
    f.first.seatedPlayers = [];
    f.first.timeBankEngine.playerBanks.clear();
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'bank_metadata_without_bank' });
    expect(f.seatReads).toEqual([]);
    expect(f.moveReads).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});

describe('an abandoned boundary generation is proved from rows, never assumed', () => {
  it('reads no row at all when no generation is open', async () => {
    const f = mixedFixture();
    expect((await f.run()).ok).toBe(true);
    expect(f.snapshotReads).toEqual([]);
  });

  it('defers the unreachable generation and retires only after the felt is proved quiet', async () => {
    const f = mixedFixture();
    const stuck = f.abandonedOriginal();
    stuck.terminalBoundaryPendingGenerations.add(7);
    const before = Date.now();
    const result: any = await f.run();
    expect(result.ok).toBe(true);
    // The proof ran, named the exact table, and ran BEFORE any custody RPC.
    expect(f.snapshotReads).toHaveLength(1);
    expect(f.snapshotReads[0].ids).toEqual([stuck.tableId]);
    const since = Date.parse(f.snapshotReads[0].since);
    expect(since).toBeGreaterThanOrEqual(before - 120000);
    expect(since).toBeLessThanOrEqual(Date.now() - 119000);
    expect(f.rpcCalls.length).toBeGreaterThan(0);
    expect(result.abandonedBoundaries).toContain(`${stuck.tableId}:1`);
    expect(f.server.tableEngines.has(stuck.tableId)).toBe(false);
    // The engine's own fields are untouched: the guard proves, it never edits.
    expect([...stuck.terminalBoundaryPendingGenerations]).toEqual([7]);
    expect(stuck.terminalBoundaryPersistenceFailed).toBe(false);
  });

  it.each([
    ['a hand in the air', () => ({ data: [{ table_id: 'x', hand_number: 1 }], error: null })],
    ['an unreadable answer', () => ({ data: null, error: { message: 'PGRST002' } })],
    ['a body that is not a list', () => ({ data: { table_id: 'x' }, error: null })],
  ])('refuses on %s, and retires nothing', async (_label, answer) => {
    const f = mixedFixture();
    f.abandonedOriginal().terminalBoundaryPendingGenerations.add(7);
    f.onSnapshots(answer as any);
    const result: any = await f.run();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('mixed_abandoned_generation_unproven');
    expect(result.abandonedBoundaries).toBeUndefined();
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(4);
  });

  it.each([
    ['a generation that is not a positive integer', (e: any) => e.add('7')],
    [
      'more generations than a table can hold',
      (e: any) => {
        for (let n = 1; n <= 65; n += 1) e.add(n);
      },
    ],
  ])('refuses %s without consulting the database', async (_label, alter) => {
    const f = mixedFixture();
    alter(f.abandonedOriginal().terminalBoundaryPendingGenerations);
    const result: any = await f.run();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('mixed_original_work_not_drained');
    expect(result.failedCheck).toBe('engineCollection.abandonedShape');
    expect(f.snapshotReads).toEqual([]);
    expect(f.server.tableEngines.size).toBe(4);
  });

  it('refuses a boundary that moves between observations', async () => {
    const f = mixedFixture();
    const stuck = f.abandonedOriginal();
    stuck.terminalBoundaryPendingGenerations.add(7);
    // The live fleet write happens after capture; a boundary that grows there
    // is a moving one, not the abandoned one that was observed.
    f.onWrite(() => {
      stuck.terminalBoundaryPendingGenerations.add(8);
    });
    const result: any = await f.run();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('mixed_original_work_not_drained');
    expect(result.failedCheck).toBe('engineCollection.abandonedChanged');
    expect(f.server.tableEngines.size).toBe(4);
  });

  it('still refuses a fenced engine whose boundary is recorded as failed', async () => {
    const f = mixedFixture();
    const stuck = f.abandonedOriginal();
    stuck.terminalBoundaryPendingGenerations.add(7);
    stuck.terminalBoundaryPersistenceFailed = true;
    const result: any = await f.run();
    expect(result.ok).toBe(false);
    expect(result.failedCheck).toBe('engine.terminalBoundaryPersistenceFailed');
    expect(f.snapshotReads).toEqual([]);
  });

  /* THE DEFERRAL IS NOT A ROUTE PAST THE DISPOSITION PROOF. Proving the felt
     quiet says a hand is not in the air; it says nothing about who holds
     custody of the interruption this checkpoint exists to hand over. That is
     still `sealAndRetireOriginals`' job, and this profile has required exactly
     one interrupted original per manager since long before #5011. A manager
     whose only originals have no permit at all is refused after the row proof
     and before the committing RPC - nothing retired, no custody transferred. */
  it('refuses a deferred manager that holds no interrupted original at all', async () => {
    const f = mixedFixture();
    const stuck = f.abandonedOriginal();
    stuck.terminalBoundaryPendingGenerations.add(7);
    f.clearInterruptedPermit();
    const result: any = await f.run();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('mixed_original_disposition_set_changed');
    // The row proof still ran first, and still refused nothing on its own.
    expect(f.snapshotReads).toHaveLength(1);
    expect(f.receipts.size).toBe(0);
    expect(f.server.tableEngines.has(stuck.tableId)).toBe(true);
  });
});

describe('an epoch that never reserved a hand is witnessed by its absence (2026-09-24)', () => {
  /* Run 36068474418, the first release to reach fn_f06_prepare_mixed_manager
     _custody: `mixed_custody_rpc_unknown`, named nothing; the Postgres log said
     F06_MIXED_ALLOCATION_WITNESS_UNPROVEN at f06_mixed_custody_snapshot line
     42. The retained $100 Freeroll manager holds seven waiting single-seat
     tables admitted under its generation that never dealt. */
  it('a waiting original is witnessed never_reserved and the transfer proceeds', async () => {
    const f = mixedFixture();
    const waiting = [f.waitingOriginal(0, 0), f.waitingOriginal(0, 1)];
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.rpcCalls.length).toBeGreaterThan(0);
    for (const e of waiting) expect(f.server.tableEngines.has(e.tableId)).toBe(false);
    // The engine's own fields are untouched: the guard proves, it never edits.
    for (const e of waiting) expect(e.f06CurrentPermit).toBeNull();
  });

  it('an epoch that did reserve is still witnessed from its permits, exactly as before', async () => {
    const f = mixedFixture();
    f.lifecycleWitness('permits');
    f.waitingOriginal(0, 0);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });

  it('a receipt that names neither witness refuses, and nothing is committed', async () => {
    const f = mixedFixture();
    f.lifecycleWitness('unmarked');
    f.waitingOriginal(0, 0);
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'mixed_original_lifecycle_evidence_invalid',
    });
    expect(f.receipts.size).toBe(0);
  });

  it('a never_reserved witness for an epoch the guard can itself place refuses', async () => {
    const f = mixedFixture();
    const e = f.waitingOriginal(0, 0);
    // A lifecycle witness in memory means the epoch is not unplaceable; the
    // absence witness is only for the engine nobody can place.
    const breakId = uuid(83900);
    f.originals[0].manager.retainedTournamentBreakSources.set(e.tableId, { breakId, engine: e });
    f.originals[0].manager.durableTournamentBreaks.set(breakId, { lifecycle: '1' });
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'mixed_original_lifecycle_evidence_invalid',
    });
    expect(f.receipts.size).toBe(0);
  });

  it('a refusal on the second manager commits nothing for the first (2026-09-24)', async () => {
    const f = mixedFixture();
    const second = f.originals[1].manager.tournamentId;
    let observations = 0;
    f.changeResponse((name: string, data: any) => {
      if (name !== 'fn_f06_prepare_mixed_manager_custody') return data;
      if (data.receipt !== null) return data;
      observations += 1;
      return data.tournament_id === second
        ? { __rpcError: { code: 'P0001', message: 'F06_RETIRED_CANONICAL_CHANGED: registrations' } }
        : data;
    });
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'mixed_custody_rpc_unknown',
      failedTable: second,
    });
    expect(result.observedDetail).toContain('commit=no');
    // Both managers were observed, and the first was NOT committed: no
    // immutable transfer row exists for the next attempt to refuse against.
    expect(observations).toBe(2);
    expect(f.receipts.size).toBe(0);
    // And nothing was retired: every original is still in the map.
    for (const { engine } of f.originals)
      expect(f.server.tableEngines.has(engine.tableId)).toBe(true);
  });

  it('a refused custody RPC names the manager, the RPC, the message and the map', async () => {
    const f = mixedFixture();
    const e = f.waitingOriginal(0, 0);
    f.changeResponse((name: string, data: any) =>
      name === 'fn_f06_prepare_mixed_manager_custody'
        ? { __rpcError: { code: 'P0001', message: 'F06_MIXED_ALLOCATION_WITNESS_UNPROVEN' } }
        : data
    );
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'mixed_custody_rpc_unknown',
      failedCheck: 'rpc.transport',
      failedField: 'fn_f06_prepare_mixed_manager_custody',
      failedTable: f.originals[0].manager.tournamentId,
    });
    expect(result.observedDetail).toContain('commit=no');
    expect(result.observedDetail).toContain('sqlstate=P0001');
    expect(result.observedDetail).toContain('refusal=F06_MIXED_ALLOCATION_WITNESS_UNPROVEN');
    expect(result.observedDetail).toContain('allocationBacked=1');
    expect(result.observedDetail).toContain(
      `backed=${e.tableId.slice(0, 8)}:${e.f06AllocationEpoch.slice(0, 8)}:null:hand=17:seats=1`
    );
    expect(f.receipts.size).toBe(0);
  });
});

/* ═══ A SEALED CUSTODY TRANSFER IS NOT TRANSFERRED TWICE (2026-09-25) ═══

   Run 36144233010 (target c3e8d3fe, the 14:05Z recovery window): the
   publisher reported `inspector operation outcome unknown` at stage
   `mixed_custody` with 65 tables verified, while the guard went on inside the
   engine and finished - both `f06_manager_custody_transfers` rows committed
   (Noon 5a387a75 at 14:05:23Z, Afternoon 615783bf at 14:05:29Z) and both
   originals retired through the CAS, so `/health.maintenance` now says
   `unparkedTables: 0`. The transaction requires the checkpoint again on every
   release while the sealed predecessor is 8825, with a fresh intent each
   time. These are the shapes the next run meets. */
describe('a sealed custody transfer is not transferred twice', () => {
  // The second release: a fresh intent per RUN_ID, new ids for every manager.
  const nextRelease = (f: any) => {
    f.intent.runId = '124-1';
    f.intent.custody.forEach((c: any, n: number) => {
      c.transfer_id = uuid(88100 + n);
      c.successor_generation = uuid(89100 + n);
    });
    f.rpcCalls.length = 0;
    f.probes.length = 0;
  };
  const sealBoth = async (f: any) => {
    expect(await f.run()).toMatchObject({ ok: true, readyForRestart: true, sealedManagers: 0 });
    expect(f.receipts.size).toBe(2);
    expect(f.probes).toEqual(f.events);
    // THE POST-RETIREMENT SHAPE, as 8825 leaves it. `unregisterTournamentTableEngine`
    // deletes from the global map and the owned set only; the manager's own
    // maps are untouched because its stop retry throws before it reaches
    // them, and `captureDrainedF06Originals()` still answers the same engines.
    for (const { engine, manager } of f.originals) {
      expect(f.server.tableEngines.has(engine.tableId)).toBe(false);
      expect(f.server.tournamentOwnedTables.has(engine.tableId)).toBe(false);
      expect(manager.tableEngines.get(engine.tableId)).toBe(engine);
      expect(manager.retainedTournamentBreakSources.has(engine.tableId)).toBe(true);
      expect(manager.captureDrainedF06Originals()).toEqual([[engine.tableId, engine]]);
      expect(f.server.tournamentEngines.get(manager.tournamentId)).toBe(manager);
    }
    return [...f.receipts.values()].map((r: any) => structuredClone(r));
  };

  it.each([
    ['as 8825 leaves them: manager maps still holding the retired originals', () => undefined],
    [
      'with the manager maps emptied and the drain capture answering null',
      (f: any) => {
        for (const { manager } of f.originals) {
          manager.tableEngines.clear();
          manager.retainedTournamentBreakSources.clear();
          manager.drainedF06Originals = [];
          manager.captureMode = 'stopping';
        }
      },
    ],
  ])(
    'both managers already sealed, %s: no prepare, nothing written, readiness certified',
    async (_label, shape) => {
      const f = mixedFixture();
      const rows = await sealBoth(f);
      nextRelease(f);
      shape(f);
      const writes = f.calls.length;
      const result: any = await f.run();
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        readyForRestart: true,
        restartAuthorized: false,
        stage: 'complete',
        sealedManagers: 2,
      });
      // The rows were asked first, once per manager, and nothing was prepared,
      // committed or read back: the fresh intent ids are simply unused.
      expect(f.probes).toEqual(f.events);
      expect(f.rpcCalls).toEqual([]);
      expect(result.sealedLookup).toBe(
        f.events.map((e: string) => `${e.slice(0, 8)}:sealed`).join(' ')
      );
      expect([...f.receipts.values()]).toEqual(rows);
      // The bank checkpoint stage still ran for the live cash fleet.
      expect(f.calls.length).toBeGreaterThanOrEqual(writes);
      expect(f.server.tableEngines.size).toBe(1);
      expect(f.server.maintenanceBreak.readyForRestart()).toBe(true);
    }
  );

  it('one sealed, one not: the unsealed manager still goes observe, commit, readback, CAS', async () => {
    const f = mixedFixture();
    await sealBoth(f);
    nextRelease(f);
    // Manager 1 was never sealed: no row for it, and its original is still in
    // the global registry exactly as before any checkpoint.
    const { engine, manager } = f.originals[1];
    f.receipts.delete(manager.tournamentId);
    f.server.tableEngines.set(engine.tableId, engine);
    f.server.tournamentOwnedTables.add(engine.tableId);
    const seen: { name: string; tournament: string; commit: boolean }[] = [];
    f.onRpc((name: string, input: any) =>
      seen.push({ name, tournament: input.p_tournament_id, commit: input.p_expected != null })
    );
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sealedManagers: 1 });
    expect(f.probes).toEqual(f.events);
    expect(f.rpcCalls).toEqual([
      'fn_f06_prepare_mixed_manager_custody',
      'fn_f06_prepare_mixed_manager_custody',
      'fn_f06_find_mixed_manager_custody',
    ]);
    // Every transfer call named the unsealed manager and the NEW ids; the
    // sealed one was never prepared.
    for (const call of seen.filter((c) => c.name === 'fn_f06_prepare_mixed_manager_custody'))
      expect(call.tournament).toBe(manager.tournamentId);
    expect(f.receipts.get(manager.tournamentId)).toMatchObject({
      transfer_id: uuid(88101),
      successor_generation: uuid(89101),
      origin_generation: manager.tournamentLeaseGeneration,
    });
    expect(f.receipts.get(f.originals[0].manager.tournamentId).transfer_id).toBe(uuid(88000));
    expect(f.server.tableEngines.has(engine.tableId)).toBe(false);
    expect(f.server.tableEngines.size).toBe(1);
  });

  it("a row for a DIFFERENT origin generation is not this manager's seal: the full path, and the database's refusal", async () => {
    const f = mixedFixture();
    const { manager } = f.originals[0];
    f.receipts.set(manager.tournamentId, {
      transfer_id: uuid(70000),
      tournament_id: manager.tournamentId,
      origin_generation: uuid(70001),
      successor_generation: uuid(70002),
      local_proof: {
        release_checkpoint: {
          kind: 'legacy_engine_checkpoint_8825_v1',
          source: checkpoint8825,
          instance_id: f.intent.instance,
          container_id: f.intent.container,
          process_id: process.pid,
        },
        manager_id: manager.managerLifecycleDiagnostics.instanceId,
        engines: [],
      },
      canonical_proof: {},
    });
    // What the live function does to an observe whose prior row disagrees
    // (migration 20260921155216 L181-182).
    f.onRpcResponse((name: string) =>
      name === 'fn_f06_prepare_mixed_manager_custody'
        ? { data: null, error: { code: 'P0001', message: 'F06_MIXED_TRANSFER_CHANGED' } }
        : undefined
    );
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'mixed_custody_rpc_unknown',
      failedField: 'fn_f06_prepare_mixed_manager_custody',
      sealedManagers: 0,
    });
    expect(result.observedDetail).toContain('refusal=F06_MIXED_TRANSFER_CHANGED');
    expect(result.observedDetail).toContain('commit=no');
    expect(result.sealedLookup).toContain(`${manager.tournamentId.slice(0, 8)}:other_generation`);
    expect(f.probes).toEqual(f.events);
    expect(f.rpcCalls).toEqual(['fn_f06_prepare_mixed_manager_custody']);
    expect(f.server.tableEngines.size).toBe(3);
  });

  it.each([
    [
      'another container',
      (r: any) => (r.local_proof.release_checkpoint.container_id = 'b'.repeat(64)),
      'release_checkpoint.container_id',
    ],
    [
      'another instance',
      (r: any) => (r.local_proof.release_checkpoint.instance_id = '2-deadbeef'),
      'release_checkpoint.instance_id',
    ],
    [
      'another manager',
      (r: any) => (r.local_proof.manager_id = uuid(70009)),
      'local_proof.manager_id',
    ],
    [
      'a proof with no checkpoint at all',
      (r: any) => delete r.local_proof.release_checkpoint,
      'receipt.local_proof',
    ],
  ])(
    'a row for THIS generation that names %s refuses, named, before any prepare',
    async (_label, alter, failedCheck) => {
      const f = mixedFixture();
      const rows = await sealBoth(f);
      nextRelease(f);
      alter(f.receipts.get(f.originals[0].manager.tournamentId));
      const result: any = await f.run();
      expect(result).toMatchObject({
        ok: false,
        reason: 'mixed_sealed_transfer_foreign',
        failedCheck,
        failedTable: f.originals[0].manager.tournamentId,
        sealedManagers: 0,
      });
      expect(f.rpcCalls).toEqual([]);
      expect(f.receipts.get(f.originals[1].manager.tournamentId)).toEqual(rows[1]);
    }
  );

  /* THE LOOKUP NEVER REFUSES AN UNSEALED MANAGER. `EngineLifecycleDiagnostics
     .test.ts` runs this guard against fixtures that never answer the find at
     all, and every drain refusal it names is on the path the lookup precedes.
     A lookup that did not come back, came back malformed, or found nothing
     decides nothing: the manager takes the exact existing path, whose
     refusals are unchanged and whose observe call still meets the database's
     own `F06_MIXED_TRANSFER_CHANGED` against a transfer this run did not
     make. Only the readback AFTER a commit is a find the guard refuses on. */
  it.each([
    [
      'an error',
      () => ({ data: null, error: { code: 'PGRST002', message: 'schema cache' } }),
      'unanswered',
    ],
    [
      'a throw',
      () => {
        throw new Error('socket hang up');
      },
      'unanswered',
    ],
    ['a body that is not a record', () => ({ data: 'synthetic', error: null }), 'malformed'],
    ['a body saying no', () => ({ data: { ok: false }, error: null }), 'malformed'],
    [
      'a receipt that is not a record',
      () => ({ data: { ok: true, receipt: 'x' }, error: null }),
      'malformed',
    ],
  ])(
    'a seal lookup that meets %s decides nothing: the full path, unchanged',
    async (_label, answer, outcome) => {
      const f = mixedFixture();
      f.onRpcResponse((name: string) =>
        name === 'fn_f06_find_mixed_manager_custody' && f.rpcCalls.length === 0
          ? answer()
          : undefined
      );
      const result: any = await f.run();
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        readyForRestart: true,
        sealedManagers: 0,
      });
      expect(result.sealedLookup).toBe(
        f.events.map((e: string) => `${e.slice(0, 8)}:${outcome}`).join(' ')
      );
      expect(f.probes).toEqual(f.events);
      expect(f.rpcCalls).toEqual([
        // Both observations, then each commit with its readback.
        'fn_f06_prepare_mixed_manager_custody',
        'fn_f06_prepare_mixed_manager_custody',
        'fn_f06_prepare_mixed_manager_custody',
        'fn_f06_find_mixed_manager_custody',
        'fn_f06_prepare_mixed_manager_custody',
        'fn_f06_find_mixed_manager_custody',
      ]);
      expect(f.receipts.size).toBe(2);
      expect(f.server.tableEngines.size).toBe(1);
    }
  );

  it('an unanswered lookup does not hide a drain refusal on the existing path', async () => {
    const f = mixedFixture();
    f.onRpcResponse((name: string) =>
      name === 'fn_f06_find_mixed_manager_custody' && f.rpcCalls.length === 0
        ? { data: null, error: { code: 'PGRST002', message: 'schema cache' } }
        : undefined
    );
    f.originals[0].engine.readContinuationTasks.add(Promise.resolve());
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'mixed_original_work_not_drained' });
    expect(result.sealedLookup).toContain(':unanswered');
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(3);
  });

  /* THE ONE STEP THE SEALING RUN HAD LEFT. The commit row is immutable and the
     rows already hold the custody; the CAS that retires the original from the
     global map is what a run cut off between commit and retirement would not
     have reached. Retiring it here is finishing that run's own work with the
     same synchronous identity CAS, on the exact engine the row names, and
     nothing else: refusing instead would hold `readyForRestart()` false for
     ever on a table whose custody is already gone (8825 `unparkedTables`
     counts an unresolved preparation before it asks whether the engine runs). */
  it('a sealed manager whose original is still registered under the exact engine the row names is retired by the same CAS', async () => {
    const f = mixedFixture();
    // 8825's own gate: one unresolved preparation in the global map holds
    // `readyForRestart()` false for ever, however the engine holding it stopped.
    f.holdGate();
    await sealBoth(f);
    nextRelease(f);
    const { engine, manager } = f.originals[0];
    f.server.tableEngines.set(engine.tableId, engine);
    f.server.tournamentOwnedTables.add(engine.tableId);
    expect(f.server.maintenanceBreak.readyForRestart()).toBe(false);
    const result: any = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sealedManagers: 2 });
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.has(engine.tableId)).toBe(false);
    expect(f.server.tournamentOwnedTables.has(engine.tableId)).toBe(false);
    expect(manager.tableEngines.get(engine.tableId)).toBe(engine);
    expect(f.server.maintenanceBreak.readyForRestart()).toBe(true);
  });

  it.each([
    [
      'a different engine behind the same table id',
      (f: any) => {
        const other: any = new f.Table(500);
        other.tableId = f.originals[0].engine.tableId;
        other.lifecycleDiagnostics = { instanceId: uuid(85900) };
        other.running = false;
        other.terminal = true;
        f.server.tableEngines.set(other.tableId, other);
        f.server.tournamentOwnedTables.add(other.tableId);
      },
    ],
    [
      'the exact engine, no longer stopped',
      (f: any) => {
        const { engine } = f.originals[0];
        engine.running = true;
        f.server.tableEngines.set(engine.tableId, engine);
        f.server.tournamentOwnedTables.add(engine.tableId);
      },
    ],
    [
      'a table gone from the map but still marked owned',
      (f: any) => f.server.tournamentOwnedTables.add(f.originals[0].engine.tableId),
    ],
  ])('a sealed manager with %s refuses, and retires nothing', async (_label, alter) => {
    const f = mixedFixture();
    await sealBoth(f);
    nextRelease(f);
    alter(f);
    const size = f.server.tableEngines.size;
    const result: any = await f.run();
    expect(result).toMatchObject({
      ok: false,
      reason: 'mixed_sealed_original_registry_disagreement',
      sealedManagers: 0,
    });
    expect(f.rpcCalls).toEqual([]);
    expect(f.server.tableEngines.size).toBe(size);
  });

  it('a sealed manager still holding an engine the row never named refuses', async () => {
    const f = mixedFixture();
    await sealBoth(f);
    nextRelease(f);
    const stray: any = new f.Table(501);
    stray.lifecycleDiagnostics = { instanceId: uuid(85901) };
    f.originals[0].manager.tableEngines.set(stray.tableId, stray);
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'mixed_sealed_original_unnamed' });
    expect(f.rpcCalls).toEqual([]);
  });

  it('a sealed manager whose owner moved before the CAS refuses there', async () => {
    const f = mixedFixture();
    await sealBoth(f);
    nextRelease(f);
    const { manager } = f.originals[0];
    // The lease generation moves after the capture and before the CAS phase:
    // the seal was proved for the generation that was captured, not this one.
    f.onWrite(() => {
      manager.tournamentLeaseGeneration = uuid(80099);
    });
    const result: any = await f.run();
    expect(result).toMatchObject({ ok: false, reason: 'mixed_sealed_owner_changed' });
    expect(f.rpcCalls).toEqual([]);
  });
});
