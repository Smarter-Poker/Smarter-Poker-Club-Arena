/**
 * GameServer — server-side game orchestration.
 *
 * Extracted from `server/src/index.ts` in Phase U3.4b (2026-04-23) — the
 * final step of the index-monolith split per platform plan 2.3. On 2026-07-28
 * TournamentManager moved out to `./tournament/` (engine audit D21); it is
 * re-exported here so existing importers keep working.
 */

import { randomUUID } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';

import { ServerTableEngine } from './engine/ServerTableEngine.js';
import { equityGovernor } from './engine/EquityLoadGovernor.js';
import {
  HorseDecisionAbortedError,
  liveHorseDecisionWorkerStatus,
  startLiveHorseDecisionWorker,
  stopLiveHorseDecisionWorker,
} from './engine/horseDecision/client.js';
import {
  EquityWorkerPoolAbortedError,
  equityWorkerPoolStatus,
  startEquityWorkerPool,
  stopEquityWorkerPool,
} from './engine/equity/EquityWorkerPool.js';
import { nextHandGap } from './engine/nextHandGapRecorder.js';
import { EngineTelemetry } from './engine/EngineTelemetry.js';
import { evaluateEngineLiveness } from './engine/EngineLivenessVerdict.js';
import {
  settlementHealthSnapshot,
  settlementPrometheusLines,
} from './observability/SettlementHealth.js';
import {
  supabase,
  startHandProjectionWorker,
  stopHandProjectionWorker,
} from './services/supabase.js';
import { HorseFleetManager } from './services/HorseFleetManager.js';
import { ClusterController } from './cluster/ClusterController.js';
import { clusterMetrics } from './cluster/ClusterMetrics.js';
import {
  TournamentRecurringService,
  mttPrestartHorseTarget,
  MTT_PRESTART_RAMP_MS,
  seatFirstStartStalled,
  SEAT_FIRST_START_STALL_MS,
} from './services/TournamentRecurringService.js';
import { ScheduledTournamentService } from './services/ScheduledTournamentService.js';
import { TournamentMetrics } from './services/TournamentMetrics.js';
import { seatFirstPrecheckPrometheusLines } from './services/seatFirstPrecheckMetrics.js';
import { SpinMetrics } from './services/SpinMetrics.js';
import { ReplicationMetrics } from './services/ReplicationMetrics.js';
import { HandOutboxListener } from './services/supabase/handOutboxListener.js';
import { HandOutboxMetrics } from './services/supabase/handOutboxMetrics.js';
import { handProjectionWakesToPrometheus } from './services/supabase/handProjection.js';
import {
  wsAuthRefusalPrometheusLines,
  wsProtocolRefusalPrometheusLines,
  wsTrustLimitPrometheusLines,
} from './transport/wsHelpers.js';
import {
  alwaysOnPrometheusLines,
  bountyRecoveryPending,
  bountyRecoveryRealtimeConnected,
  bountyRecoverySweepInflight,
  bountyRecoverySweepMs,
  bountyRecoverySweepRunsTotal,
  tournamentManagerWakeRealtimeConnected,
  equityGovernorScale,
  equityGovernorSamplerLateMs,
  eventLoopDelayP50,
  eventLoopDelayP99,
  horseDecisionWorkerActiveJobAgeMs,
  horseDecisionWorkerEventLoopDelayP50,
  horseDecisionWorkerEventLoopDelayP99,
  horseDecisionWorkerLastCompletionAgeMs,
  horseDecisionWorkerLastComputeMs,
  horseDecisionWorkerOldestQueuedAgeMs,
  horseDecisionWorkerQueueDepth,
  horseDecisionWorkerReady,
  equityWorkerPoolReady,
  equityWorkerPoolConfiguredWorkers,
  equityWorkerPoolReadyWorkers,
  equityWorkerPoolBusyWorkers,
  equityWorkerPoolQueueDepth,
  equityWorkerPoolOldestQueuedAgeMs,
  equityWorkerPoolLastCompletionAgeMs,
  mainEventLoopGovernorSamplerLateMs,
  mainEventLoopGovernorScale,
} from './observability/engineInstruments.js';
import { clientConnectionPrometheusLines } from './observability/ClientConnectionEvents.js';
import {
  planTableReopens,
  freshHumanWindowMs,
  type LiveTournamentRow,
  type TournamentTableRow,
} from './services/liveTournamentTableRecovery.js';
import { HorseLifecycleManager } from './services/HorseLifecycleManager.js';
import { DealRateVerifier } from './services/DealRateVerifier.js';
import {
  renewLeadership,
  LEADERSHIP_STALE_SECONDS,
  startLeadershipRenewal,
  stopLeadershipRenewal,
  releaseLeadership,
  isLeader,
  leadershipDiagnostics,
  markBootedAsStandby,
} from './services/leadership.js';
import {
  claimTournamentLease,
  heartbeatTournaments,
  releaseTournaments,
  TOURNAMENT_LEASE_PROOF_WINDOW_MS,
  tournamentLeaseDiagnostics,
} from './services/tournamentLease.js';
import {
  bindTournamentDataAuthorityMethods,
  currentTournamentDataAuthority,
} from './services/supabase/dataActorContext.js';
// BUG 008 FIX: Periodic rakeback settler - flushes per-hand rake_records into rakeback_periods.
import { RakebackSettlerService } from './services/RakebackSettlerService.js';
import {
  reconcilePendingFees,
  auditBBJDrift,
  repairUnbankedBBJFees,
  auditRakeAttributionDrift,
  auditSatelliteConservation,
  auditPrizeDisbursement,
  auditDoublePaidObligations,
  requeueUnbankedCashRake,
  auditGuaranteesKept,
} from './services/FeeReconciler.js';
import { reportError, initSentry, flushSentry } from './services/errorReporter.js';
import { startRakeSpecGuard, stopRakeSpecGuard } from './services/rakeSpecGuard.js';
import { rakeSpecDriftState } from './config/rakeSpec.js';
import {
  admitOwnedTableEngine,
  replaceOwnedTableEngine,
  stopOwnedTournamentManager,
  unregisterOwnedTournamentTableEngine,
} from './tournament/TournamentManagerOwnership.js';
// Phase 1.1 PR-2: native WebSocket transport for authoritative state
import { tableStateHub } from './transport/TableStateHub.js';

// GameServer owns no tournament-cancellation path. It fills, resumes, or asks
// the database terminal authority to settle completed play; operator-managed
// cancellation enters through the authenticated database command authority.
import { recoverStuckCompletingTournaments } from './tournament/tournamentRecovery.js';
import { spinLaunchParks } from './tournament/spinLaunchParking.js';
import { managerHasOverstayed, selectCompletingDue } from './tournament/completingDwell.js';
import { fieldIsStillLive } from './tournament/recoveryFieldGuard.js';
import { resolvePayoutStructure } from './tournament/payoutStructure.js';
import { TournamentManager } from './tournament/TournamentManager.js';
import {
  chunkTournamentManagerWakeReceipts,
  type TournamentManagerWakeDatabaseState,
  type TournamentManagerWakeReceipt,
} from './tournament/TournamentManagerWakeProtocol.js';
import { isMaintenanceFrozen } from './maintenance/freezeState.js';
import { raiseEngineAlert, resolveEngineAlert } from './services/engineAlerts.js';
import { MaintenanceBreak } from './maintenance/MaintenanceBreak.js';
import { createSupabaseMaintenanceBreakStore } from './maintenance/maintenanceBreakStore.js';
import { StatsHealthMonitor } from './observability/StatsHealthMonitor.js';
import { runThawInstallments } from './maintenance/thawInstallments.js';
import { ENGINE_START_BUDGET_MAX, nextEngineStartBudget } from './engineStartBudget.js';
import { isWakeableCashTable } from './services/onDemandTableWake.js';
// 2026-08-16: single-owner table leases + per-process identity. See
// services/tableLease.ts for the dual-container incident that motivated them.
import {
  INSTANCE_ID,
  claimTableLease,
  heartbeatTables,
  releaseTables,
  leaseDiagnostics,
  TABLE_LEASE_PROOF_WINDOW_MS,
} from './services/tableLease.js';

export { TournamentManager };

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const TABLE_DISCOVERY_INTERVAL = 5000; // Check for new tables every 5 seconds
const TOURNAMENT_DISCOVERY_INTERVAL = 5000; // Check for tournaments every 5 seconds
/**
 * Ownership renewal is a primary lifecycle, not part of table discovery.
 * Start each pass at least four times inside the shorter conservative proof
 * window. A slow pass subtracts its own elapsed time before sleeping, so a 15s
 * PostgREST timeout is followed immediately rather than turning 15s + 5s into
 * an accidental expiry at the exact 20s local boundary.
 */
const OWNERSHIP_LEASE_RENEWAL_CADENCE_MS = Math.floor(
  Math.min(TABLE_LEASE_PROOF_WINDOW_MS, TOURNAMENT_LEASE_PROOF_WINDOW_MS) / 4
);

/**
 * The four materially different answers to a direct table admission attempt.
 * A boolean erased the distinction between "this table was closed", "another
 * live process owns it", and "the database/start path blipped". The first two
 * are terminal for this process; the last one must retain the exact causal
 * recovery obligation instead of waiting for fleet discovery to notice it.
 */
type DirectTableAdmission = 'ready' | 'not_wakeable' | 'owned_elsewhere' | 'retryable_failure';
type TournamentManagerStartMode = 'start' | 'resume';
type DealerPrerequisiteGate = {
  generation: number;
  promise: Promise<boolean>;
  resolve: (ready: boolean) => void;
  settled: boolean;
};
type ExternalShutdownOwnershipResult =
  | { status: 'fulfilled' }
  | { status: 'rejected'; reason: unknown };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SEAT-FIRST START LANE RUNS AT ONE SECOND (Dan 2026-08-30, round 16)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "THE MOMENT THE 3RD SEAT IS BOUGHT AND PAID FOR THE SPIN
 * ANIMATION MUST START 1 SECOND LATER!"
 *
 * That is a hard number, and on a 5-second sleep it is unreachable by
 * construction. Measured against production over six hours, 524 spins, from
 * the third paid seat to `started_at`:
 *
 *     p50 5.4s   p90 7.7s   max 73.8s   299 of 524 over five seconds
 *
 * Dan's own game on 2026-08-30 took 39.6s (paid 07:33:41.4, started
 * 07:34:21.0) because the engine happened to be restarting in that minute.
 *
 * A whole second of it was just this sleep. The lane is deliberately the
 * cheapest loop in the process — two bounded reads per pass, `tables` and
 * `table_seats`, both keyed by ids it already holds — and the per-game fill
 * throttle (12s) and the start's own synchronous engine-map check mean a
 * faster cadence adds no work per GAME, only the two reads per second. That
 * is a trivial load next to the ~200 hands a minute this database already
 * takes, and it buys the difference between Dan's rule and a shrug.
 *
 * It stays a POLL rather than a LISTEN on purpose: the engine holds no direct
 * Postgres connection (supabase-js only, see server/package.json), so
 * NOTIFY would mean a new dependency and a new failure mode on the one path
 * that must never silently stop. A one-second poll cannot miss an edge.
 */
const SEAT_FIRST_START_INTERVAL = 1000;

/**
 * Lease reaping. An hour is 120x the 30-second staleness window, so a row this
 * old has already lost every claim it could ever win and deleting it cannot
 * race a live engine. The server-side function refuses anything under 600s.
 */
const LEASE_REAP_STALE_SECONDS = 3600;
const LEASE_REAP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How often the bomb-pot award ledger is repaired, and how many hands one pass
 * will rebuild. Hourly because the gap it closes is a WRITE LOSS, not a design
 * gap: `bomb_pot_award_units` is written fire-and-forget from settlement, so a
 * Supabase blip that outlasts three retries loses rows that nothing was ever
 * going to come back for. 500 hands is far above the observed loss rate
 * (~17/day) and the repair is idempotent, so an over-large budget costs a
 * no-op rather than a duplicate.
 */
const BOMB_LEDGER_REPAIR_INTERVAL_MS = 60 * 60 * 1000;
const BOMB_LEDGER_REPAIR_BATCH = 500;

/**
 * ── PRE-SEAT LEAD (Dan 2026-08-30, binding) ──
 *
 * Dan, verbatim: "when a player is registered, they should be 'sat down' one
 * minute before the event starts (doesn't happen yet)."
 *
 * Until now a timed MTT was discovered at `start_time <= now` and everything —
 * building the tables, claiming the seats, stamping every roster row — happened
 * AFTER the advertised start. The 20K GTD on 2026-08-30 is the shape of it: it
 * was found at 17:00:00, the first table row appeared at 17:01:19 and the row
 * did not read RUNNING until 17:02:10. For 130 seconds every registered player
 * sat on a lobby card that said STARTS IN 0:00 and TABLES 0, with no seat to go
 * to and nothing to press. A real poker room seats the field BEFORE the clock
 * starts, and so does this one now.
 *
 * The lead is the discovery lead, not a new state: `TournamentManager.start()`
 * does exactly what it always did, in the same order, one minute earlier — and
 * then HOLDS every table's dealing until the advertised `start_time` (the same
 * `holdDealingUntil` deadline the spin wheel uses) and arms the level clock at
 * that instant rather than at seating. So the cards still fly at the time on
 * the tin; only the seating moved.
 *
 * Seat-first formats (spin, heads-up) are untouched: their gate is bought
 * seats, never the clock, and this constant never reaches that branch.
 *
 * IDENTICAL FOR HORSES (section 10.5). Nothing here reads `is_horse` — a horse
 * is seated by the same createTablesAndSeatPlayers pass, at the same instant,
 * and watches the same held felt for the same minute a human does.
 */
const TOURNAMENT_PRESEAT_LEAD_MS = 60_000;

// ═══════════════════════════════════════════════════════════════════════════════
// GAME SERVER — Main Orchestrator
// ═══════════════════════════════════════════════════════════════════════════════

export class GameServer {
  private tableEngines: Map<string, ServerTableEngine> = new Map();
  /** One shared, classified readiness promise per on-demand engine start. */
  private tableEngineStartPromises: Map<string, Promise<DirectTableAdmission>> = new Map();
  /** Serialize lookup/claim/terminal release for one direct table. */
  private directTableAdmissionOperations = new Map<string, Promise<DirectTableAdmission>>();
  /**
   * Exact-generation teardown promises. A second signal for the same dead
   * object joins its teardown; a successor is a different WeakMap key and can
   * never be suppressed by an older continuation.
   */
  private directTableEngineRecoveries = new WeakMap<ServerTableEngine, Promise<void>>();
  /** Enumerable companions to the identity WeakMap so shutdown can join them. */
  private directTableEngineRecoveryJobs = new Set<Promise<void>>();
  /** One causal retry timer per table after a classified transient failure. */
  private directTableRecoveryTimers: Map<string, NodeJS.Timeout> = new Map();
  private directTableRecoveryAttempts: Map<string, number> = new Map();
  /** One caller-selected protocol-2 generation reused by one causal admission retry. */
  private directTableAdmissionLeaseGenerations = new Map<string, string>();
  /** Exact acquired generations whose local proof expired before admission. */
  private directTablePendingLeaseReleases = new Map<string, string>();
  /** Fences admissions that were awaiting I/O when this server generation stopped. */
  private lifecycleGeneration = 0;
  /**
   * A process can answer HTTP while leader election, worker hydration and stale
   * cleanup are still running. Direct WebSocket admission must wait for the
   * entire dealer boot contract instead of treating `running` as `ready`.
   */
  private dealerPrerequisitesReady = false;
  private dealerPrerequisiteGate: DealerPrerequisiteGate | null = null;
  /**
   * Infinite discovery loops and the exact asynchronous work they launch.
   * Shutdown drains this set to a fixed point before taking its final dealer
   * snapshot or releasing a distributed lease.
   */
  private discoveryJobs = new Set<Promise<void>>();
  /** Non-discovery async work launched by timers, subscriptions, or boot. */
  private serverLifecycleJobs = new Set<Promise<void>>();
  /** Keeps exact table/tournament authority alive only through shutdown drain. */
  private ownershipLeaseRenewalOperation: Promise<void> | null = null;
  private shutdownOwnershipLeaseRenewalActive = false;
  private shutdownOwnershipLeaseRenewalOperation: Promise<void> | null = null;
  /** One distributed claim + manager publication operation per tournament id. */
  private tournamentManagerAdmissionOperations = new Map<string, Promise<void>>();
  /** Exact causal lease/start retries; never a tournament-board reconciliation scan. */
  private tournamentManagerAdmissionRetryTimers = new Map<string, NodeJS.Timeout>();
  private tournamentManagerAdmissionRetryAttempts = new Map<string, number>();
  /** One caller-selected database generation reused across this causal retry. */
  private tournamentManagerAdmissionLeaseGenerations = new Map<string, string>();
  /**
   * Exact release is part of retiring a protocol-2 manager. A successor waits
   * for this barrier before choosing a new generation, so a same-process
   * admission cannot race the old manager's final teardown/release.
   */
  private tournamentManagerLeaseReleaseOperations = new Map<string, Promise<boolean>>();
  /** Exact stopped-manager generations whose PostgREST release is still unproved. */
  private tournamentManagerPendingLeaseReleases = new Map<string, string>();
  /** Multiple failure signals join one exact manager retirement. */
  private tournamentManagerRetirementOperations = new WeakMap<
    TournamentManager,
    Promise<boolean>
  >();

  private launchDiscoveryJob(
    operation: Promise<unknown>,
    errorContext: string,
    metadata?: Record<string, unknown>
  ): void {
    const tracked = operation
      .then(() => undefined)
      .catch((error) => reportError(error, errorContext, metadata))
      .finally(() => this.discoveryJobs.delete(tracked));
    this.discoveryJobs.add(tracked);
  }

  private launchServerLifecycleJob(
    operation: Promise<unknown>,
    errorContext: string,
    metadata?: Record<string, unknown>
  ): void {
    const tracked = operation
      .then(() => undefined)
      .catch((error) => reportError(error, errorContext, metadata))
      .finally(() => this.serverLifecycleJobs.delete(tracked));
    this.serverLifecycleJobs.add(tracked);
  }

  private async drainServerLifecycleJobs(): Promise<void> {
    while (this.serverLifecycleJobs.size > 0) {
      await Promise.allSettled([...this.serverLifecycleJobs]);
    }
  }

  /** A completed job can enqueue another exact job, so drain to a fixed point. */
  private async drainDiscoveryJobs(): Promise<void> {
    while (this.discoveryJobs.size > 0) {
      await Promise.allSettled([...this.discoveryJobs]);
    }
  }

  /** HTTP/WS admission is not necessarily launched by discovery, but owns leases too. */
  private async drainDirectTableAdmissions(): Promise<void> {
    while (
      this.directTableAdmissionOperations.size > 0 ||
      this.directTableEngineRecoveryJobs.size > 0
    ) {
      await Promise.allSettled([
        ...this.directTableAdmissionOperations.values(),
        ...this.directTableEngineRecoveryJobs,
      ]);
    }
  }

  private async drainTournamentManagerAdmissions(): Promise<void> {
    while (
      this.tournamentManagerAdmissionOperations.size > 0 ||
      this.tournamentManagerLeaseReleaseOperations.size > 0
    ) {
      await Promise.allSettled([
        ...this.tournamentManagerAdmissionOperations.values(),
        ...this.tournamentManagerLeaseReleaseOperations.values(),
      ]);
    }
  }

  /**
   * Observe every server-owned async registry together. Draining them one at a
   * time was not a shutdown barrier: a later tournament admission could enqueue
   * a direct recovery after that earlier registry had already looked empty.
   * Producer sources are stopped first, then this union is drained until one
   * stable microtask boundary sees no work anywhere.
   */
  private async drainOwnedLifecycleJobs(): Promise<void> {
    for (;;) {
      await Promise.resolve();
      const pending = [
        ...this.serverLifecycleJobs,
        ...this.discoveryJobs,
        ...this.directTableAdmissionOperations.values(),
        ...this.directTableEngineRecoveryJobs,
        ...this.tournamentManagerAdmissionOperations.values(),
        ...this.tournamentManagerLeaseReleaseOperations.values(),
      ];
      if (pending.length === 0) {
        // A settled promise's finally-handler may publish the next exact job.
        // Require the union to remain empty across a second microtask turn.
        await Promise.resolve();
        if (
          this.serverLifecycleJobs.size === 0 &&
          this.discoveryJobs.size === 0 &&
          this.directTableAdmissionOperations.size === 0 &&
          this.directTableEngineRecoveryJobs.size === 0 &&
          this.tournamentManagerAdmissionOperations.size === 0 &&
          this.tournamentManagerLeaseReleaseOperations.size === 0
        ) {
          return;
        }
        continue;
      }
      await Promise.allSettled(pending);
    }
  }
  /**
   * Table ids whose engine is owned and rebuilt by a TournamentManager rather
   * than by discoverCashTables. Discovery's RPC is cash-only, so without this
   * set the reaper treated every tournament table as "not supposed to be
   * dealing" and silently skipped its freeze recovery.
   */
  private tournamentOwnedTables: Set<string> = new Set();
  /**
   * IT ONLY EVER GREW (2026-09-01). `registerTableEngine` adds to the set above
   * and nothing has ever removed from it, so on a board creating roughly 7,000
   * tournament tables a day it grew without bound for the life of the process.
   * The memory is the least of it: a table id that is in this set is treated as
   * "should be dealing" by the zombie reaper and is skipped by
   * `tableStateHub.dropTable`, so every long-dead table kept a hub room alive
   * and kept lying to the reaper about what a healthy board looks like.
   *
   * Pruned once per discovery pass against what is genuinely still owned: the
   * engines this process holds, plus every table its live TournamentManagers
   * hold. Pruning against `tableEngines` alone would be wrong - the comment at
   * the hub-drop site says exactly why: a tournament table can be briefly
   * without an engine while its manager rebuilds it, and dropping the room
   * there costs the seated players a sequence reset.
   */
  private pruneTournamentOwnedTables(): void {
    if (this.tournamentOwnedTables.size === 0) return;
    const stillOwned = new Set<string>(this.tableEngines.keys());
    for (const tm of this.tournamentEngines.values()) {
      for (const id of tm.getTableIds()) stillOwned.add(id);
    }
    for (const id of [...this.tournamentOwnedTables]) {
      if (!stillOwned.has(id)) this.tournamentOwnedTables.delete(id);
    }
  }

  /**
   * Renew only cash dealers with a verified table lease. Tournament dealers
   * inherit the parent tournament generation and are renewed by that manager.
   */
  private async renewVerifiedCashTableLeaseProofs(
    candidateTableIds: Iterable<string> = this.tableEngines.keys()
  ): Promise<Map<string, ServerTableEngine>> {
    const candidates: Array<[string, ServerTableEngine]> = [];
    const lostEngines = new Map<string, ServerTableEngine>();
    for (const tableId of candidateTableIds) {
      const engine = this.tableEngines.get(tableId);
      if (!engine) continue;
      const authority = engine.getEngineLeaseAuthority();
      if (authority?.scope === 'cash' && authority.verified) {
        /* A paused callback must not resurrect authority after its conservative
           local proof already expired. Test the old proof before asking the DB
           to move heartbeat_at; expiry is a loss, never a renewal attempt. */
        if (!engine.hasCurrentEngineLeaseAuthority()) {
          lostEngines.set(tableId, engine);
          continue;
        }
        candidates.push([tableId, engine]);
      }
    }

    const heartbeat = await heartbeatTables(
      candidates.map(([tableId, engine]) => {
        const authority = engine.getEngineLeaseAuthority();
        if (!authority || authority.scope !== 'cash' || !authority.verified) {
          throw new Error(`Cash lease authority disappeared before heartbeat for ${tableId}`);
        }
        return { tableId, leaseGeneration: authority.generation };
      })
    );
    if (heartbeat.status === 'answered') {
      for (const proof of heartbeat.proofs) {
        const captured = candidates.find(([tableId]) => tableId === proof.tableId)?.[1];
        if (!captured || this.tableEngines.get(proof.tableId) !== captured) continue;
        const authority = captured.getEngineLeaseAuthority();
        if (
          !authority ||
          authority.scope !== 'cash' ||
          !authority.verified ||
          !captured.renewEngineLeaseProof({
            ...authority,
            proofDeadlineMonotonicMs: proof.proofDeadlineMonotonicMs,
          })
        ) {
          lostEngines.set(proof.tableId, captured);
        }
      }
      for (const tableId of heartbeat.lostTableIds) {
        const captured = candidates.find(([id]) => id === tableId)?.[1];
        if (captured && this.tableEngines.get(tableId) === captured) {
          lostEngines.set(tableId, captured);
        }
      }
    }

    /* UNKNOWN extends nothing. Re-read every exact captured engine so an
       event-loop stall that crossed its deadline before the timer callback
       ran becomes a synchronous loss in this sweep. */
    for (const [tableId, engine] of candidates) {
      if (this.tableEngines.get(tableId) === engine && !engine.hasCurrentEngineLeaseAuthority()) {
        lostEngines.set(tableId, engine);
      }
    }
    return lostEngines;
  }

  /**
   * Renew the exact manager generations captured at the start of this pass.
   * A manager admitted while the RPC is in flight is never judged using its
   * predecessor's answer.
   */
  private async renewVerifiedTournamentManagerLeaseProofs(): Promise<
    Map<string, TournamentManager>
  > {
    const candidates = new Map<string, { manager: TournamentManager; leaseGeneration: string }>();
    const lostManagers = new Map<string, TournamentManager>();
    for (const [tournamentId, manager] of this.tournamentEngines) {
      const leaseGeneration = manager.getTournamentLeaseGeneration();
      if (leaseGeneration) {
        if (!manager.hasCurrentTournamentLeaseAuthority()) {
          lostManagers.set(tournamentId, manager);
          continue;
        }
        candidates.set(tournamentId, { manager, leaseGeneration });
      } else {
        // Production admission may never publish a generation-less manager.
        lostManagers.set(tournamentId, manager);
      }
    }

    const heartbeat = await heartbeatTournaments(
      [...candidates].map(([tournamentId, candidate]) => ({
        tournamentId,
        leaseGeneration: candidate.leaseGeneration,
      }))
    );
    if (heartbeat.status === 'answered') {
      for (const proof of heartbeat.proofs) {
        const captured = candidates.get(proof.tournamentId);
        if (!captured || this.tournamentEngines.get(proof.tournamentId) !== captured.manager) {
          continue;
        }
        if (
          !captured.manager.renewTournamentLeaseProof(
            proof.leaseGeneration,
            proof.proofDeadlineMonotonicMs
          )
        ) {
          lostManagers.set(proof.tournamentId, captured.manager);
        }
      }
      for (const tournamentId of heartbeat.lostTournamentIds) {
        const captured = candidates.get(tournamentId);
        if (captured && this.tournamentEngines.get(tournamentId) === captured.manager) {
          lostManagers.set(tournamentId, captured.manager);
        }
      }
    }

    /* UNKNOWN extends nothing. Check only the exact objects captured before the
       RPC; a new manager may have been admitted with a fresh proof meanwhile. */
    for (const [tournamentId, captured] of candidates) {
      if (
        this.tournamentEngines.get(tournamentId) === captured.manager &&
        !captured.manager.hasCurrentTournamentLeaseAuthority()
      ) {
        lostManagers.set(tournamentId, captured.manager);
      }
    }
    return lostManagers;
  }

  /**
   * One serialized ownership pass for both lease scopes. Heartbeats run in
   * parallel so the cash RPC cannot consume the tournament proof window (or
   * vice versa). Every proven loss is fenced synchronously before any physical
   * teardown awaits; teardown/release remains in its exact causal registry so
   * this primary renewal lifecycle can begin its next pass on time.
   */
  private renewOwnedEngineLeaseProofs(): Promise<void> {
    const existing = this.ownershipLeaseRenewalOperation;
    if (existing) return existing;
    const operation = this.performOwnedEngineLeaseProofRenewal();
    let tracked!: Promise<void>;
    tracked = operation.finally(() => {
      if (this.ownershipLeaseRenewalOperation === tracked) {
        this.ownershipLeaseRenewalOperation = null;
      }
    });
    this.ownershipLeaseRenewalOperation = tracked;
    return tracked;
  }

  private async performOwnedEngineLeaseProofRenewal(): Promise<void> {
    const [cashResult, tournamentResult] = await Promise.allSettled([
      this.renewVerifiedCashTableLeaseProofs(),
      this.renewVerifiedTournamentManagerLeaseProofs(),
    ]);

    const lostTables =
      cashResult.status === 'fulfilled' ? cashResult.value : new Map<string, ServerTableEngine>();
    if (cashResult.status === 'rejected') {
      reportError(cashResult.reason, 'GameServer.cash_lease_renewal_pass_failed');
    }
    const lostTournamentIds =
      tournamentResult.status === 'fulfilled'
        ? tournamentResult.value
        : new Map<string, TournamentManager>();
    if (tournamentResult.status === 'rejected') {
      reportError(tournamentResult.reason, 'GameServer.tournament_lease_renewal_pass_failed');
    }

    const lostCashEngines: Array<[string, ServerTableEngine]> = [];
    for (const [tableId, engine] of lostTables) {
      if (this.tableEngines.get(tableId) !== engine || this.tournamentOwnedTables.has(tableId)) {
        continue;
      }
      reportError(
        new Error(`Lost the deal-lease on table ${tableId} to another engine instance`),
        'GameServer.table_lease_lost'
      );
      engine.fenceForEngineLeaseLoss('cash_table_lease_lost', false);
      lostCashEngines.push([tableId, engine]);
    }

    const lostManagers: Array<[string, TournamentManager]> = [];
    for (const [tournamentId, manager] of lostTournamentIds) {
      if (this.tournamentEngines.get(tournamentId) !== manager) continue;
      reportError(
        new Error(`Lost the tournament lease on ${tournamentId} to another engine instance`),
        'GameServer.tournament_lease_lost'
      );
      manager.fenceForTournamentLeaseLoss();
      lostManagers.push([tournamentId, manager]);
    }

    for (const [tableId, engine] of lostCashEngines) {
      void this.recoverDirectTableEngine(tableId, engine, 'cash_table_lease_lost').catch((error) =>
        reportError(error, 'GameServer.table_lease_lost_recovery_failed', { tableId })
      );
    }
    for (const [tournamentId, manager] of lostManagers) {
      this.launchServerLifecycleJob(
        this.stopTournamentManagerIfOwned(
          tournamentId,
          manager,
          'GameServer.tournament_lease_lost_stop_failed'
        ),
        'GameServer.tournament_lease_lost_retirement_failed',
        { tournamentId }
      );
    }
  }

  /**
   * Primary, serialized lease lifecycle. Discovery may spend its full timeout
   * adopting or inspecting tables without delaying this loop. Cadence is based
   * on pass start, not pass completion, so slow RPC time is charged against the
   * next sleep rather than silently added to the authority gap.
   */
  private async runOwnershipLeaseRenewalLoop(generation: number): Promise<void> {
    while (this.directAdmissionIsCurrent(generation)) {
      const passStartedAt = performance.now();
      try {
        await this.renewOwnedEngineLeaseProofs();
      } catch (error) {
        // A programming or transport surprise cannot permanently remove the
        // platform's primary ownership lifecycle. Existing local deadlines stay
        // authoritative and the next serialized pass still runs.
        reportError(error, 'GameServer.ownership_lease_renewal_pass_threw');
      }
      if (!this.directAdmissionIsCurrent(generation)) return;
      const elapsedMs = Math.max(0, performance.now() - passStartedAt);
      await this.sleep(Math.max(0, OWNERSHIP_LEASE_RENEWAL_CADENCE_MS - elapsedMs));
    }
  }

  private startShutdownOwnershipLeaseRenewal(): void {
    if (this.shutdownOwnershipLeaseRenewalOperation) return;
    this.shutdownOwnershipLeaseRenewalActive = true;
    let tracked!: Promise<void>;
    tracked = this.runShutdownOwnershipLeaseRenewalLoop().finally(() => {
      if (this.shutdownOwnershipLeaseRenewalOperation === tracked) {
        this.shutdownOwnershipLeaseRenewalOperation = null;
      }
    });
    this.shutdownOwnershipLeaseRenewalOperation = tracked;
  }

  private async runShutdownOwnershipLeaseRenewalLoop(): Promise<void> {
    while (this.shutdownOwnershipLeaseRenewalActive) {
      const passStartedAt = performance.now();
      await this.renewOwnedEngineLeaseProofs().catch((error) =>
        reportError(error, 'GameServer.shutdown_lease_renewal_pass_threw')
      );
      if (!this.shutdownOwnershipLeaseRenewalActive) return;
      const elapsedMs = Math.max(0, performance.now() - passStartedAt);
      await this.sleep(Math.max(0, OWNERSHIP_LEASE_RENEWAL_CADENCE_MS - elapsedMs));
    }
  }

  private async stopShutdownOwnershipLeaseRenewal(): Promise<void> {
    this.shutdownOwnershipLeaseRenewalActive = false;
    const operation = this.shutdownOwnershipLeaseRenewalOperation;
    if (operation) await operation;
  }
  /** Last orphaned-seat repair pass. See tournament/orphanedSeatRepair.ts. */
  private lastOrphanSeatSweepAt = 0;
  /**
   * First time each COMPLETING row was seen by this process. See
   * `tournament/completingDwell.ts`: the five-minute rule the scan has always
   * claimed cannot be read off the row, because nothing maintains
   * `tournaments.updated_at` on that path.
   */
  private completingFirstSeenAt: Map<string, number> = new Map();
  /**
   * Last time the cash-table discovery RPC completed successfully. Discovery is
   * the only thing that starts engines AND the only thing that reaps zombies —
   * if it stalls, the whole platform is frozen with nothing to notice.
   */
  private lastDiscoveryOkAt: number = Date.now();
  /**
   * When the discovery loop last RAN, as opposed to last succeeded.
   *
   * These are different questions and conflating them restarted healthy
   * engines. `lastDiscoveryOkAt` only advances when the RPC comes back clean,
   * so a minute of database trouble made it look like the loop had stopped —
   * when the loop was in fact running perfectly and being told "no" each time.
   */
  private lastDiscoveryAttemptAt: number = Date.now();

  /**
   * C20 FIX (2026-08-23): bound how many engines may be adopted per sweep, and
   * back off when the database says it is struggling.
   *
   * C19 staggered engine starts by 40ms, which spread the initiation of each
   * start but capped nothing: on a restart every table in the discovery result
   * still had its start() issued inside one sweep, and because those starts are
   * fired and not awaited, ~180 engines were loading seats and table config
   * concurrently against a database already absorbing the reconnect storm.
   *
   * Measured nine minutes after a restart: 686 statement timeouts in three
   * minutes, 35 hand-history insert failures, 21 lost table leases, discovery
   * stalled 108 seconds, and health reporting liveness dead while the process
   * was in fact fine. Hand throughput fell from ~250/min to 24/min. Zero lock
   * waits throughout - this was never contention, it was concurrency.
   *
   * The amplifier is that failure was free to repeat. A start that times out
   * deletes itself from tableEngines (see the .catch below), so the very next
   * sweep retried the same volume into the same overloaded database. Load
   * caused failure, failure recreated the load.
   *
   * The control law lives in engineStartBudget.ts, pure and tested there.
   */
  private engineStartBudget: number = ENGINE_START_BUDGET_MAX;
  /**
   * Set by the async .catch on engine.start(), read and cleared once per sweep.
   * A start failure is the earliest honest signal that adoption is outrunning
   * what the database can serve - earlier than the discovery RPC failing,
   * because that RPC is one cheap indexed read and a start is many.
   */
  private engineStartFailures: number = 0;

  /** Applies the C20 control law to this instance. Returns the new budget. */
  private adjustEngineStartBudget(distressed: boolean): number {
    this.engineStartBudget = nextEngineStartBudget(this.engineStartBudget, distressed);
    return this.engineStartBudget;
  }

  private clearDirectTableRecovery(tableId: string): void {
    const timer = this.directTableRecoveryTimers.get(tableId);
    if (timer) clearTimeout(timer);
    this.directTableRecoveryTimers.delete(tableId);
    this.directTableRecoveryAttempts.delete(tableId);
    this.directTableAdmissionLeaseGenerations.delete(tableId);
  }

  /**
   * Preserve one exact table's recovery obligation after a transient admission
   * failure. This is not a fleet scan: it is armed only by the failed causal
   * operation, names one durable table id, and disarms on success, closure, a
   * proven foreign owner, or process shutdown.
   */
  private scheduleDirectTableRecovery(tableId: string, reason: string): void {
    if (!this.running || this.tournamentOwnedTables.has(tableId)) {
      this.clearDirectTableRecovery(tableId);
      return;
    }
    if (this.directTableRecoveryTimers.has(tableId)) return;

    const attempt = (this.directTableRecoveryAttempts.get(tableId) ?? 0) + 1;
    this.directTableRecoveryAttempts.set(tableId, attempt);
    const delayMs = Math.min(250 * 2 ** Math.min(attempt - 1, 6), 15_000);
    const timer = setTimeout(() => {
      if (this.directTableRecoveryTimers.get(tableId) !== timer) return;
      this.directTableRecoveryTimers.delete(tableId);
      void this.ensureCashTableEngineAdmission(tableId)
        .then((outcome) => {
          if (outcome === 'retryable_failure') {
            this.scheduleDirectTableRecovery(tableId, reason);
            return;
          }
          this.clearDirectTableRecovery(tableId);
        })
        .catch((error) => {
          reportError(error, 'GameServer.direct_table_recovery_admission_threw', {
            tableId,
            reason,
            attempt,
          });
          this.scheduleDirectTableRecovery(tableId, reason);
        });
    }, delayMs);
    timer.unref?.();
    this.directTableRecoveryTimers.set(tableId, timer);
  }

  private finishDirectTableAdmission(
    tableId: string,
    reason: string,
    outcome: DirectTableAdmission
  ): void {
    if (outcome === 'retryable_failure') {
      this.scheduleDirectTableRecovery(tableId, reason);
      return;
    }
    this.clearDirectTableRecovery(tableId);
  }

  /**
   * Publish the readiness of every direct engine generation before start can
   * yield. Discovery used to publish only the engine map entry, so an arriving
   * viewer saw `running=true` and was admitted while table configuration and
   * the first authoritative snapshot were still loading.
   */
  private trackDirectTableEngineReadiness(
    tableId: string,
    engine: ServerTableEngine
  ): Promise<DirectTableAdmission> {
    const outcome = engine.ready.then<DirectTableAdmission>((ready) =>
      ready ? 'ready' : 'retryable_failure'
    );
    const tracked = outcome.finally(() => {
      if (this.tableEngineStartPromises.get(tableId) === tracked) {
        this.tableEngineStartPromises.delete(tableId);
      }
    });
    this.tableEngineStartPromises.set(tableId, tracked);
    return tracked;
  }

  /**
   * A detached dealing-loop/watchdog failure cannot reject engine.start(): by
   * then start has already handed control to the loop. Bind that exact engine
   * generation back to this map owner so terminal state initiates teardown
   * immediately instead of waiting for the five-second discovery scanner.
   */
  private wireDirectTableEngineRecovery(tableId: string, engine: ServerTableEngine): void {
    engine.onRestartRequired((reason) => {
      void this.recoverDirectTableEngine(tableId, engine, reason).catch((error) => {
        reportError(error, 'GameServer.direct_table_engine_recovery_threw', {
          tableId,
          reason,
        });
        this.scheduleDirectTableRecovery(tableId, reason);
      });
    });
  }

  private async recoverDirectTableEngine(
    tableId: string,
    engine: ServerTableEngine,
    reason: string,
    deferReadmission = false
  ): Promise<void> {
    const existingRecovery = this.directTableEngineRecoveries.get(engine);
    if (existingRecovery) return existingRecovery;

    const operation = this.performDirectTableEngineRecovery(
      tableId,
      engine,
      reason,
      deferReadmission
    );
    const tracked = operation.finally(() => {
      // De-duplicate only while this exact recovery is live. Retaining a
      // rejected promise here made every later causal retry join the same old
      // rejection forever, so a transient teardown failure permanently
      // quarantined the table even though its per-table retry kept firing.
      if (this.directTableEngineRecoveries.get(engine) === tracked) {
        this.directTableEngineRecoveries.delete(engine);
      }
      this.directTableEngineRecoveryJobs.delete(tracked);
    });
    this.directTableEngineRecoveries.set(engine, tracked);
    this.directTableEngineRecoveryJobs.add(tracked);
    return tracked;
  }

  private async performDirectTableEngineRecovery(
    tableId: string,
    engine: ServerTableEngine,
    reason: string,
    deferReadmission: boolean
  ): Promise<void> {
    if (!this.running || this.tableEngines.get(tableId) !== engine) return;
    // TournamentManager owns tournament replacement and installs its own
    // generation callback. Never race that authority from the cash lane.
    if (this.tournamentOwnedTables.has(tableId)) return;

    const leaseAuthority = engine.getEngineLeaseAuthority();
    try {
      await engine.stop();
    } catch (error) {
      reportError(error, 'GameServer.direct_table_engine_recovery_teardown_failed', {
        tableId,
        reason,
      });
      // Cleanup diagnostics may reject after process ownership was released;
      // that generation is safe to retire. An earlier teardown failure is
      // different: hiding the still-owning object from the final shutdown
      // snapshot would let GameServer release its distributed lease while a
      // scheduler/timer owner remained alive. Keep it quarantined and fail
      // closed so shutdown can prove (or refuse) ownership release.
      if (!engine.hasReleasedProcessOwnership()) throw error;
    }
    if (this.tableEngines.get(tableId) !== engine) return;

    /* Keep the terminal object published until its exact database generation
       is released. A concurrent admission therefore joins this recovery
       instead of choosing a new UUID while the old same-instance row is still
       live. Exact release cannot erase a later generation. */
    if (leaseAuthority?.scope === 'cash' && leaseAuthority.verified) {
      const release = await releaseTables([
        { tableId, leaseGeneration: leaseAuthority.generation },
      ]);
      if (release.status !== 'confirmed') {
        throw new Error(
          `Cash lease release was not confirmed for ${tableId}/${leaseAuthority.generation}: ` +
            `${release.reason} after ${release.attempts} attempt(s): ${release.detail}`
        );
      }
    }
    if (this.tableEngines.get(tableId) !== engine) return;

    this.tableEngines.delete(tableId);
    tableStateHub.dropTable(tableId);
    if (!this.running) return;

    // A start that exhausted its own transient retries gets a causal backoff;
    // a detached runtime death is replaced immediately. Both remain exact to
    // this table and neither waits for the five-second discovery scanner.
    if (deferReadmission) {
      this.scheduleDirectTableRecovery(tableId, reason);
      return;
    }
    const outcome = await this.ensureCashTableEngineAdmission(tableId);
    this.finishDirectTableAdmission(tableId, reason, outcome);
  }

  /**
   * Close an acquired-but-never-published cash generation before any new claim.
   * This is a causal release barrier, not a delayed reconciliation scan: the
   * exact table admission that observes it must prove deletion or fail closed.
   */
  private async awaitDirectTableLeaseRelease(tableId: string): Promise<void> {
    for (;;) {
      const leaseGeneration = this.directTablePendingLeaseReleases.get(tableId);
      if (!leaseGeneration) return;
      const outcome = await releaseTables([{ tableId, leaseGeneration }]);
      if (outcome.status !== 'confirmed') {
        throw new Error(
          `Pending cash lease release remains unconfirmed for ${tableId}/${leaseGeneration}: ` +
            `${outcome.reason} after ${outcome.attempts} attempt(s): ${outcome.detail}`
        );
      }
      if (this.directTablePendingLeaseReleases.get(tableId) === leaseGeneration) {
        this.directTablePendingLeaseReleases.delete(tableId);
      }
      if (this.directTableAdmissionLeaseGenerations.get(tableId) === leaseGeneration) {
        this.directTableAdmissionLeaseGenerations.delete(tableId);
      }
    }
  }
  /**
   * When this process started. Used to keep boot from looking like death --
   * see the startup grace in getStatus().
   */
  private readonly processStartedAt: number = Date.now();
  private tournamentEngines: Map<string, TournamentManager> = new Map();
  /** Re-entrancy guard for the event-driven managerless bounty-outbox drain. */
  private bountyRecoverySweepInFlight = false;
  /** A committed outbox event arrived while the current bounded drain was active. */
  private bountyRecoveryRequested = false;
  /** One causal timer for the database-reported relative retry delay, never a polling interval. */
  private bountyRecoveryDueTimer: NodeJS.Timeout | null = null;
  private bountyRecoveryDueAt = 0;
  private bountyRecoveryTransportBackoffMs = 1_000;
  private bountyRecoveryContentionBackoffMs = 50;
  /**
   * One process-wide durable browser-action bridge. Realtime is the primary
   * delivery path; rows are acknowledged only after a live manager accepts
   * the wake, so subscribe-then-drain also closes the boot/reconnect gap.
   */
  private tournamentManagerWakeChannel: ReturnType<typeof supabase.channel> | null = null;
  private tournamentManagerWakeDrainInFlight = false;
  /** A global drain signal arrived while the final snapshot page was in flight. */
  private tournamentManagerWakeDrainRequested = false;
  /** Retry only a failed durable-wake read; this is a causal backoff, never a scan interval. */
  private tournamentManagerWakeDrainRetryTimer: NodeJS.Timeout | null = null;
  private tournamentManagerWakeDrainRetryBackoffMs = 250;
  /** Invalidates a scheduled read retry across shutdown/restart lifecycle changes. */
  private tournamentManagerWakeDrainRetryGeneration = 0;
  private tournamentManagerWakeReconnectTimer: NodeJS.Timeout | null = null;
  private tournamentManagerWakeReconnectBackoffMs = 1_000;
  /** Subscribe-first delivery for durable bounty obligations. */
  private tournamentBountyObligationChannel: ReturnType<typeof supabase.channel> | null = null;
  private tournamentBountyReconnectTimer: NodeJS.Timeout | null = null;
  private tournamentBountyReconnectBackoffMs = 1_000;

  /** Compare-and-delete: an old async continuation never owns a new slot. */
  private ownsTournamentManager(tournamentId: string, manager: TournamentManager): boolean {
    return this.tournamentEngines.get(tournamentId) === manager;
  }

  /**
   * Stop one exact manager generation and release its slot only after every
   * table engine has completed teardown. A replacement installed while the
   * await is in flight wins the CAS and is never deleted by this continuation.
   */
  private async stopTournamentManagerIfOwned(
    tournamentId: string,
    manager: TournamentManager,
    errorContext: string,
    releaseLease = true
  ): Promise<boolean> {
    const existing = this.tournamentManagerRetirementOperations.get(manager);
    if (existing) return existing;

    const leaseGeneration = releaseLease ? manager.getTournamentLeaseGeneration() : null;
    let resolveReleaseBarrier: (confirmed: boolean) => void = () => undefined;
    const releaseBarrier = leaseGeneration
      ? new Promise<boolean>((resolve) => {
          resolveReleaseBarrier = resolve;
        })
      : null;
    if (releaseBarrier) {
      /* Publish the barrier before stop() reaches its first await. The manager
         may disappear from the local map during teardown, but no successor is
         allowed to claim a distinct generation until exact release finishes. */
      this.tournamentManagerLeaseReleaseOperations.set(tournamentId, releaseBarrier);
    }

    const operation = (async (): Promise<boolean> => {
      let releaseConfirmed = leaseGeneration === null;
      try {
        const stopped = await stopOwnedTournamentManager(
          this.tournamentEngines,
          tournamentId,
          manager,
          (error) => reportError(error, errorContext)
        );
        if (stopped && leaseGeneration) {
          this.tournamentManagerPendingLeaseReleases.set(tournamentId, leaseGeneration);
          const release = await releaseTournaments([{ tournamentId, leaseGeneration }]);
          if (release.status !== 'confirmed') {
            throw new Error(
              `Tournament lease release was not confirmed for ${tournamentId}/${leaseGeneration}: ` +
                `${release.reason} after ${release.attempts} attempt(s): ${release.detail}`
            );
          }
          releaseConfirmed = true;
          if (this.tournamentManagerPendingLeaseReleases.get(tournamentId) === leaseGeneration) {
            this.tournamentManagerPendingLeaseReleases.delete(tournamentId);
          }
        }
        return stopped;
      } finally {
        if (
          releaseBarrier &&
          this.tournamentManagerLeaseReleaseOperations.get(tournamentId) === releaseBarrier
        ) {
          this.tournamentManagerLeaseReleaseOperations.delete(tournamentId);
        }
        if (releaseBarrier) resolveReleaseBarrier(releaseConfirmed);
        this.tournamentManagerRetirementOperations.delete(manager);
      }
    })();
    this.tournamentManagerRetirementOperations.set(manager, operation);
    return operation;
  }

  private async awaitTournamentManagerLeaseRelease(tournamentId: string): Promise<void> {
    for (;;) {
      const release = this.tournamentManagerLeaseReleaseOperations.get(tournamentId);
      if (release) {
        await release;
        continue;
      }
      const leaseGeneration = this.tournamentManagerPendingLeaseReleases.get(tournamentId);
      if (!leaseGeneration) return;
      const outcome = await releaseTournaments([{ tournamentId, leaseGeneration }]);
      if (outcome.status !== 'confirmed') {
        throw new Error(
          `Pending tournament lease release remains unconfirmed for ${tournamentId}/${leaseGeneration}: ` +
            `${outcome.reason} after ${outcome.attempts} attempt(s): ${outcome.detail}`
        );
      }
      if (this.tournamentManagerPendingLeaseReleases.get(tournamentId) === leaseGeneration) {
        this.tournamentManagerPendingLeaseReleases.delete(tournamentId);
      }
      if (this.tournamentManagerAdmissionLeaseGenerations.get(tournamentId) === leaseGeneration) {
        this.tournamentManagerAdmissionLeaseGenerations.delete(tournamentId);
      }
    }
  }

  private clearTournamentManagerAdmissionRetry(tournamentId: string): void {
    const timer = this.tournamentManagerAdmissionRetryTimers.get(tournamentId);
    if (timer) clearTimeout(timer);
    this.tournamentManagerAdmissionRetryTimers.delete(tournamentId);
    this.tournamentManagerAdmissionRetryAttempts.delete(tournamentId);
    this.tournamentManagerAdmissionLeaseGenerations.delete(tournamentId);
  }

  private scheduleTournamentManagerAdmissionRetry(
    tournamentId: string,
    mode: TournamentManagerStartMode,
    description: string,
    generation: number
  ): void {
    if (!this.directAdmissionIsCurrent(generation) || this.tournamentEngines.has(tournamentId)) {
      this.clearTournamentManagerAdmissionRetry(tournamentId);
      return;
    }
    if (this.tournamentManagerAdmissionRetryTimers.has(tournamentId)) return;

    const attempt = (this.tournamentManagerAdmissionRetryAttempts.get(tournamentId) ?? 0) + 1;
    this.tournamentManagerAdmissionRetryAttempts.set(tournamentId, attempt);
    const delayMs = Math.min(250 * 2 ** Math.min(attempt - 1, 6), 15_000);
    const timer = setTimeout(() => {
      if (this.tournamentManagerAdmissionRetryTimers.get(tournamentId) !== timer) return;
      this.tournamentManagerAdmissionRetryTimers.delete(tournamentId);
      void this.ensureTournamentManagerAdmission(tournamentId, mode, description, generation).catch(
        (error) => {
          reportError(error, 'GameServer.tournament_admission_retry_failed', {
            tournamentId,
            attempt,
          });
          this.scheduleTournamentManagerAdmissionRetry(tournamentId, mode, description, generation);
        }
      );
    }, delayMs);
    timer.unref?.();
    this.tournamentManagerAdmissionRetryTimers.set(tournamentId, timer);
  }

  /**
   * Serialize the distributed claim, publication and initial lifecycle for one
   * tournament. REGISTERING and RUNNING discovery used to use different
   * admission paths; the seat-first path did not claim a lease at all, while a
   * RUNNING claim could resume after shutdown and publish a manager outside the
   * final snapshot. One primitive now owns every construction site.
   */
  private ensureTournamentManagerAdmission(
    tournamentId: string,
    mode: TournamentManagerStartMode,
    description: string,
    generation: number
  ): Promise<void> {
    if (!this.directAdmissionIsCurrent(generation)) {
      return Promise.resolve();
    }
    if (this.tournamentEngines.has(tournamentId)) {
      this.clearTournamentManagerAdmissionRetry(tournamentId);
      return Promise.resolve();
    }
    /* The one front door every start passes through, so the park holds for
       the main discovery loop and the fully-paid stall watchdog as well as
       the fast lane. Only 'start' is gated: a RUNNING game being resumed was
       never parked by the draw path, and the registry only ever holds ids the
       draw path put there. */
    if (mode === 'start' && spinLaunchParks.isParked(tournamentId)) {
      return Promise.resolve();
    }
    const existing = this.tournamentManagerAdmissionOperations.get(tournamentId);
    if (existing) return existing;

    const operation = this.performTournamentManagerAdmission(
      tournamentId,
      mode,
      description,
      generation
    );
    const tracked = operation.finally(() => {
      if (this.tournamentManagerAdmissionOperations.get(tournamentId) === tracked) {
        this.tournamentManagerAdmissionOperations.delete(tournamentId);
      }
    });
    this.tournamentManagerAdmissionOperations.set(tournamentId, tracked);
    return tracked;
  }

  private async performTournamentManagerAdmission(
    tournamentId: string,
    mode: TournamentManagerStartMode,
    description: string,
    generation: number
  ): Promise<void> {
    await this.awaitTournamentManagerLeaseRelease(tournamentId);
    if (!this.directAdmissionIsCurrent(generation) || this.tournamentEngines.has(tournamentId)) {
      return;
    }

    const requestedLeaseGeneration =
      this.tournamentManagerAdmissionLeaseGenerations.get(tournamentId) ?? randomUUID();
    this.tournamentManagerAdmissionLeaseGenerations.set(tournamentId, requestedLeaseGeneration);
    const lease = await claimTournamentLease(tournamentId, requestedLeaseGeneration);
    const uncertainLeaseGeneration =
      lease.status === 'acquired_but_proof_expired'
        ? lease.leaseGeneration
        : lease.status === 'retryable_failure' && lease.mayHaveCommitted
          ? lease.requestedGeneration
          : null;
    if (uncertainLeaseGeneration) {
      /* An RPC error/throw is not proof the transaction rolled back. Publish
         the exact requested generation before any lifecycle test or retry, and
         synchronously attempt its CAS release. Shutdown drains this admission
         and retains the pending claim if the release remains uncertain. */
      this.tournamentManagerPendingLeaseReleases.set(tournamentId, uncertainLeaseGeneration);
      try {
        await this.awaitTournamentManagerLeaseRelease(tournamentId);
      } catch (releaseError) {
        reportError(releaseError, 'GameServer.uncertain_tournament_claim_release_unconfirmed', {
          tournamentId,
          leaseGeneration: uncertainLeaseGeneration,
        });
      }
      if (this.directAdmissionIsCurrent(generation)) {
        this.scheduleTournamentManagerAdmissionRetry(tournamentId, mode, description, generation);
      }
      return;
    }
    if (!this.directAdmissionIsCurrent(generation)) {
      // This exact operation acquired the lease after shutdown had fenced the
      // generation. Return it before the admission promise settles so a deploy
      // never leaves a post-snapshot ownership grant behind.
      if (lease.status === 'granted') {
        const staleGeneration = lease.leaseGeneration;
        this.tournamentManagerPendingLeaseReleases.set(tournamentId, staleGeneration);
        try {
          await this.awaitTournamentManagerLeaseRelease(tournamentId);
        } catch (releaseError) {
          reportError(releaseError, 'GameServer.stale_tournament_admission_release_unconfirmed', {
            tournamentId,
            leaseGeneration: staleGeneration,
          });
        }
      }
      return;
    }
    if (lease.status === 'retryable_failure') {
      this.scheduleTournamentManagerAdmissionRetry(tournamentId, mode, description, generation);
      return;
    }
    if (lease.status !== 'granted') {
      this.clearTournamentManagerAdmissionRetry(tournamentId);
      return;
    }
    if (this.tournamentEngines.has(tournamentId)) {
      this.clearTournamentManagerAdmissionRetry(tournamentId);
      return;
    }
    this.clearTournamentManagerAdmissionRetry(tournamentId);

    console.log(`[GameServer] ${description}`);
    const manager = new TournamentManager(
      tournamentId,
      this,
      lease.leaseGeneration,
      lease.proofDeadlineMonotonicMs
    );
    bindTournamentDataAuthorityMethods(
      { tournamentId, leaseGeneration: lease.leaseGeneration },
      manager
    );
    this.tournamentEngines.set(tournamentId, manager);
    try {
      if (mode === 'resume') await manager.resume();
      else await manager.start();

      if (!this.directAdmissionIsCurrent(generation)) {
        await this.stopTournamentManagerIfOwned(
          tournamentId,
          manager,
          'GameServer.stale_tournament_admission_cleanup_failed'
        );
        return;
      }
      await this.finishTournamentManagerAdmission(tournamentId, manager, generation);
    } catch (error) {
      await this.stopTournamentManagerIfOwned(
        tournamentId,
        manager,
        'GameServer.tournament_admission_cleanup_failed'
      );
      this.scheduleTournamentManagerAdmissionRetry(tournamentId, mode, description, generation);
      throw error;
    }
  }

  /** Only a still-owned, still-running generation may execute post-start work. */
  private async finishTournamentManagerAdmission(
    tournamentId: string,
    manager: TournamentManager,
    generation: number
  ): Promise<void> {
    if (
      !this.directAdmissionIsCurrent(generation) ||
      !this.ownsTournamentManager(tournamentId, manager) ||
      !manager.isRunning()
    ) {
      await this.stopTournamentManagerIfOwned(
        tournamentId,
        manager,
        'GameServer.tournament_standdown_stop_failed'
      );
      return;
    }
    await this.holdIfBreakIsRunning(manager);
    if (
      !this.directAdmissionIsCurrent(generation) ||
      !this.ownsTournamentManager(tournamentId, manager) ||
      !manager.isRunning()
    ) {
      await this.stopTournamentManagerIfOwned(
        tournamentId,
        manager,
        'GameServer.tournament_post_break_standdown_stop_failed'
      );
      return;
    }
    await this.drainTournamentManagerWakes(tournamentId);
  }
  /**
   * Dan 2026-08-23: last time the MTT pre-start horse ramp ran per tournament.
   *
   * discoverTournaments runs every 5 seconds. The ramp costs several queries
   * per tournament, and with ~30 events on the board that is a needless six
   * queries a second forever to conclude that a quadratic curve has barely
   * moved. Once every 45s is far finer-grained than the curve, and the lobby
   * is polling on its own clock anyway.
   */
  private lastMttRampAt: Map<string, number> = new Map();
  /**
   * When each seat-first game was FIRST seen holding every seat it sells.
   *
   * The clock for the fully-paid-but-never-started watchdog (2026-08-24 audit
   * P2-7). Held in memory on purpose: a restart re-arms it, so a fresh process
   * spends one stall window observing the board before it force-starts
   * anything on it.
   */
  private seatFirstFullSince: Map<string, number> = new Map();
  /** One seat-first finish sweep per minute - see the call site for why. */
  private lastSeatFirstFinishSweepAt = 0;
  /** One reopen sweep per minute for tables closed under a live tournament. */
  private lastClosedTableReopenSweepAt = 0;
  /** Last fn_tournament_money_conservation pass (2026-08-27 phase 3). */
  private lastConservationAt = 0;
  /** Last fn_detect_results_without_a_hand pass (2026-09-01 phase 7). */
  private lastNoHandResultCheckAt = 0;
  /** Last fn_charge_place_overpays pass (2026-08-28 duplicate-place overpay). */
  private lastPlaceOverpayChargeAt = 0;
  /** Last fn_spin_expire_unfilled pass (2026-08-31 phase 2 review). */
  private lastSpinExpireAt = 0;
  /** Last fn_requeue_unbanked_fees pass (2026-08-28 rake re-drive). */
  private lastFeeRequeueAt = 0;
  private running: boolean = false;
  /** One boot and one teardown per orchestrator instance; neither may outrun the other. */
  private startOperation: Promise<void> | null = null;
  private teardownPromise: Promise<void> | null = null;
  private leaderBootComplete = false;
  /**
   * Process-level writers started by index.ts are outside this orchestrator's
   * service graph, but they share the same distributed leadership. Their stop
   * fence is invoked synchronously with ours and its completion is part of the
   * same fail-closed ownership proof before any lease can be released.
   */
  private externalShutdownOwnershipBarrier: (() => Promise<void>) | null = null;
  private startTime: number = Date.now();

  // Server-side services (replaces browser-based DealerPage services)
  private horseFleet = new HorseFleetManager();
  /** Operation Table Stakes, Slice 6: the tables of a must-move game open,
   *  feed, break and sleep on their own. Leader-only, like the fleet. */
  private clusterController = new ClusterController({
    eligibleHorseCount: (tableId) => this.horseFleet.eligibleHorseCount(tableId),
    eligibleCounts: () => this.horseFleet.eligibleCounts(),
    ensureEngine: (tableId) => this.ensureCashTableEngine(tableId),
    hasEngine: (tableId) => this.tableEngines.has(tableId),
    seatedCount: async (tableId) => {
      const { count, error } = await supabase
        .from('table_seats')
        .select('id', { count: 'exact', head: true })
        .eq('table_id', tableId)
        .is('left_at', null);
      if (error) throw error;
      return count ?? 0;
    },
  });
  private tournamentRecurring = new TournamentRecurringService();
  // Data-driven recurring schedules (tournament_schedules) - runs alongside the
  // hardcoded recurring blocks, acting only on rows written into the database.
  private scheduledTournaments = new ScheduledTournamentService();
  /**
   * TOURNAMENT OBSERVABILITY (2026-08-31). Until this existed, /metrics carried
   * 895 poker_* series and not one mentioned a tournament, so no tournament
   * alert rule could be written — which is why every tournament defect in the
   * 2026-08-30/31 audit was found by a human running SQL by hand.
   */
  private tournamentMetrics = new TournamentMetrics();
  private spinMetrics = new SpinMetrics();
  private replicationMetrics = new ReplicationMetrics();
  /**
   * LISTEN hand_projection_outbox (2026-09-10). Wakes the projection worker
   * from the insert trigger's NOTIFY instead of Realtime WAL decoding. Disabled
   * (warns once) when ENGINE_PG_LISTEN_URL is unset; the worker's poll and the
   * local commit wakes still run. See services/supabase/handOutboxListener.ts.
   */
  private handOutboxListener = new HandOutboxListener();
  /**
   * Outbox depth and oldest-row age, one cheap query a minute, so the
   * projection backlog is on /metrics (2026-09-10: it was 100k rows deep and
   * nothing said so). See services/supabase/handOutboxMetrics.ts.
   */
  private handOutboxMetrics = new HandOutboxMetrics();
  private lifecycle = new HorseLifecycleManager();

  /**
   * Liveness the engine cannot fake — see services/DealRateVerifier.ts.
   *
   * Every other freeze detector in this process is this process judging
   * itself. This one asks the DATABASE whether the tables it claims should be
   * dealing are actually producing hands.
   */
  /**
   * The maintenance-break suppression lives INSIDE the verifier now (see
   * DealRateVerifier.check), not here. The first attempt fed it an empty
   * table list during the break, and an empty list IS the below-floor
   * condition - it primed the critical ClubArenaFleetFloorLost to fire on
   * the third minute of every break. The verifier skips the whole check and
   * resets its counters instead, which is the truthful statement: during a
   * freeze there is nothing to verify, not a fleet of zero.
   */
  private dealRateVerifier = new DealRateVerifier(() =>
    this.tableLivenessSnapshot()
      .filter((t) => t.dealable >= 2 && !t.paused)
      .map((t) => t.tableId)
  );
  // BUG 008 FIX: settler reads rake_records (durable per-hand log) every 30 min and
  // upserts per-player rakeback_periods rows. Without this the in-memory accumulator
  // inside RakebackEngine never flushes (zero callers of settleRakeback before fix).
  private rakebackSettler = new RakebackSettlerService();

  // Synchronized break timer — last hand announced at :55, break runs 5 min after it lands
  private breakTimer: NodeJS.Timeout | null = null;
  /**
   * The maintenance break that hides the engine restart (Dan 2026-09-01).
   *
   * Distinct from the synchronized tournament break above and deliberately
   * layered on top of it. That one stops TOURNAMENTS at :55 and suspends their
   * blind clocks. This one stops EVERY table, cash included, at the same :55 -
   * announcing the last hand two minutes earlier - and persists the break so
   * the engine that replaces this one honours the rest of it.
   *
   * Both run hourly, which is what lets a restart land in any hour it is
   * needed (Dan 2026-09-01) instead of waiting for one of five daily windows
   * while merged fixes sit unshipped. See maintenance/MaintenanceBreak.ts.
   */
  /**
   * Engine-vs-database clock skew, ms, measured by startClockSkewMonitor.
   * Positive = the engine's clock is ahead of Postgres. Three clocks now
   * cooperate on the maintenance freeze (engine writes break_ends_at,
   * fn_platform_frozen compares it to the DB's NOW(), the browser counts
   * down), and drift between them must be VISIBLE before it is a bug: at
   * ~15s of skew, players get PLATFORM_FROZEN refusals after play has
   * visibly resumed, or money moves in the final seconds of the overlay.
   * null until the first successful measurement.
   */
  private lastDbSkewMs: number | null = null;

  private readonly maintenanceBreak = new MaintenanceBreak({
    engines: () => this.tableEngines.entries(),
    isRunning: () => this.running,
    emit: (tableId, payload) => tableStateHub.emitEvent(tableId, payload),
    store: createSupabaseMaintenanceBreakStore(
      process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.ENGINE_VERSION || 'local'
    ),
    // Whoever paused a table is responsible for resuming it. A tournament
    // add-on break runs up to ten minutes, so one starting near :55 outlives
    // the five-minute maintenance break - resuming its tables here would deal
    // that event back into play while its own clock still has it away.
    shouldStayPaused: (tableId) => {
      if (!this.tournamentOwnedTables.has(tableId)) return false;
      for (const tm of this.tournamentEngines.values()) {
        try {
          if (tm.isOnBreak() && tm.getTableIds().includes(tableId)) return true;
        } catch {
          /* a manager we cannot interrogate does not get to hold a table */
        }
      }
      return false;
    },
    // The thaw: before the first table resumes, every in-flight absolute
    // deadline (sit-out clocks, seat holds, add-on windows, Spin level
    // clocks, the cashier claim-back window) is shifted forward by the frozen
    // duration, so "picks back up exactly as it was" is true of the CLOCKS
    // and not only of the chips. fn_thaw_platform is idempotent per freeze -
    // two engines racing at :00 cannot shift the clocks twice.
    // PHASE 2 (2026-09-02): the break's own measurements, one row per break,
    // so ca_break_scorecards can show what the GATE saw (unparked at
    // countdown, peak, when readyForRestart first opened) and not only what
    // hand_history reveals from outside. Insert-only; a failure is reported
    // by MaintenanceBreak and never delays the resume.
    recordOutcome: async (o) => {
      try {
        const { error } = await supabase.from('engine_maintenance_break_log').insert({
          break_started_at: new Date(o.breakStartedAtMs).toISOString(),
          break_ended_at: new Date(o.breakEndedAtMs).toISOString(),
          unparked_at_countdown: o.unparkedAtCountdown,
          peak_unparked: o.peakUnparked,
          ready_for_restart_at:
            o.readyForRestartAtMs === null ? null : new Date(o.readyForRestartAtMs).toISOString(),
          tables_resumed: o.tablesResumed,
          thaw_ok: o.thawOk,
          engine_version:
            process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.ENGINE_VERSION || 'local',
        });
        if (error) throw new Error(error.message);
      } finally {
        // A committed obligation received during the freeze deliberately did
        // not move money.  Thaw is the causal event that makes it runnable;
        // re-drive the durable queue now instead of polling throughout the
        // break or waiting for an unrelated tournament discovery pass.
        this.requestPendingTournamentBountyRecovery();
      }
    },
    // WHY A BREAK DID NOT RUN (2026-09-10): the 00:00 and 07:00 breaks were
    // cancelled by a :53 save that timed out, and the reason lived only in a
    // container log the next deploy deleted. One row per fault, read by
    // fn_ca_record_break_scorecard so the page names the cause. Best-effort:
    // MaintenanceBreak has already acted before this is called.
    recordFault: async (fault) => {
      const { error } = await supabase.from('engine_maintenance_break_faults').insert({
        announced_at: new Date(fault.announcedAtMs).toISOString(),
        stage: fault.stage,
        outcome: fault.outcome,
        error: fault.error,
        engine_version:
          process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.ENGINE_VERSION || 'local',
      });
      if (error) throw new Error(error.message);
    },
    // PHASE 4 (2026-09-02): the thaw runs in INSTALLMENTS. fn_thaw_platform
    // checkpoints each completed step in engine_maintenance_thaws.shifted and
    // returns complete:false when it has used its own ~4s budget, so no single
    // call can hit PostgREST's 8s cap the way the one-statement thaw did
    // (19.9s before the #2703 indexes; a timeout still at 20:00 after them).
    // runThawInstallments calls again until complete, and retries a call that
    // died - a timed-out call committed nothing, so the retry is exactly
    // right. Idempotent per freeze and per step on the database side.
    thaw: async (freezeStartedAtMs, frozenSeconds) => {
      const args = {
        p_freeze_started: new Date(freezeStartedAtMs).toISOString(),
        p_frozen_seconds: frozenSeconds,
        p_thawed_by:
          process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.ENGINE_VERSION || 'local',
      };
      const summary = await runThawInstallments(
        async () => {
          const { data, error } = await supabase.rpc('fn_thaw_platform', args);
          if (error) throw new Error(error.message);
          return (data ?? {}) as Record<string, unknown>;
        },
        { log: (line) => console.log(line) }
      );
      console.log(
        `[MaintenanceBreak] thaw: complete in ${summary.calls} call(s), ${summary.errors} error(s):`,
        JSON.stringify(summary.last?.shifted ?? null)
      );

      /* fn_thaw_platform has just moved every open add-on deadline. Managers
         armed their timers from the pre-break value and clients are counting
         down that same absolute instant, so both must adopt the committed row
         before any table resumes. Managers without an active window return
         without I/O; failures are isolated per event and their live timer
         keeps re-reading the durable deadline. */
      await Promise.all(
        [...this.tournamentEngines.values()].map(async (manager) => {
          try {
            await manager.resyncAddOnPeriodAfterMaintenanceThaw();
          } catch (error) {
            reportError(error, 'GameServer.addon_period_thaw_resync_failed');
          }
        })
      );
    },
  });

  /**
   * The stats pipeline's pulse (Stats Page Programme phase 1, 2026-09-04):
   * one ca_stats_health() read a minute, published on /health as `stats`
   * and on /metrics as poker_stats_*, raising through the same alert path as
   * clock skew when the hand index lags 30 minutes, the live stat trigger
   * misses a hand, or the witness audit finds the engine's recorded button or
   * showdown roster disagreeing with the action log. Declared after the
   * maintenance break because it asks it whether a break is on.
   */
  private readonly statsHealth = new StatsHealthMonitor({
    read: async () => {
      const { data, error } = await supabase.rpc('ca_stats_health');
      if (error) throw new Error(error.message);
      return data;
    },
    raise: (a) => raiseEngineAlert(a),
    resolve: (name, component, note) => resolveEngineAlert(name, component, note),
    paused: () => this.maintenanceBreak.isActive(),
  });
  /**
   * A5: drains `pending_fee_distributions` — rake / BBJ fees that left a pot but
   * whose banking RPC failed — and runs the independent BBJ ledger-drift alarm.
   */
  private feeReconcileTimer: NodeJS.Timeout | null = null;
  private leaseReapTimer: NodeJS.Timeout | null = null;
  private bombLedgerRepairTimer: NodeJS.Timeout | null = null;
  private clockSkewTimer: NodeJS.Timeout | null = null;
  private breakResumeTimer: NodeJS.Timeout | null = null;
  /**
   * When the platform-wide break is expected to end, as epoch ms; 0 when no
   * break is running.
   *
   * A TOURNAMENT THAT STARTS DURING A BREAK USED TO DEAL STRAIGHT THROUGH IT
   * (2026-08-23). triggerSynchronizedBreak snapshots the running MTTs at :55
   * and pauses that list. A tournament that reached its start time at :56 was
   * not in the snapshot, so nothing paused it and nothing resumed it: it ran
   * its opening levels alone while every other event on the platform sat on
   * the break screen. MTTs start on a schedule, so this is not a rare corner —
   * any event scheduled in the last five minutes of an hour hit it every time.
   *
   * Kept as a deadline rather than a boolean so a late joiner is paused for
   * exactly the remainder rather than for a fresh five minutes.
   */
  private breakEndsAt = 0;
  private static readonly BREAK_DURATION_MS = 5 * 60 * 1000; // 5 minutes
  /**
   * Dan 2026-08-19: breaks start at the :55 mark of every hour and last five
   * minutes, so play resumes exactly on the hour.
   */
  private static readonly BREAK_START_MINUTE = 55;
  /**
   * Longest a table may sit paused ON PURPOSE before the reapers stop believing
   * it. Comfortably above the worst legitimate case (5 min break + 2 min
   * last-hand grace), so a real break is never disturbed, while a table wedged
   * in a pause still gets rebuilt instead of freezing forever.
   */
  static readonly MAX_HEALTHY_PAUSE_MS = 10 * 60 * 1000;

  start(): Promise<void> {
    if (this.teardownPromise) {
      return Promise.reject(new Error('A stopped GameServer instance cannot be restarted'));
    }
    if (this.startOperation) return this.startOperation;
    const generation = this.lifecycleGeneration + 1;
    this.lifecycleGeneration = generation;
    this.running = true;
    this.leaderBootComplete = false;
    this.resetDealerPrerequisiteGate(generation);
    const operation = this.performStart(generation);
    this.startOperation = operation;
    void operation
      .then(
        () => this.settleDealerPrerequisiteGate(generation, false),
        () => this.settleDealerPrerequisiteGate(generation, false)
      )
      .catch(() => undefined);
    return operation;
  }

  private async performStart(generation: number): Promise<void> {
    const maintenanceMode = process.env.MAINTENANCE_MODE === 'true';
    // E2E test mode — when set, MAINTENANCE_MODE still applies (no auto-spawn,
    // no recurring tournaments, no horse fleet) but a single table engine is
    // booted for this exact tableId so a tester can sit down and play hands
    // without the rest of the platform churning. Discovery loops stay off so
    // no other tables get picked up. Lifecycle / auto-rebuy stay off.
    const testTableId = process.env.TEST_TABLE_ID || '';

    // Initialize Sentry FIRST so all subsequent errors are captured
    initSentry();

    /* THE CORE IS MEASURED FROM BOOT (2026-09-06). The governor used to take
       a reading only when a horse computed equity, so a loop saturated by
       anything else - settlement, broadcasts, a boot adopting 195 tables -
       was never sampled, which is exactly when it should be shedding load.
       Unref'd, so it can never hold the process open. */
    equityGovernor.startSampling();

    console.log('═══════════════════════════════════════════════════════════════');
    console.log(' SMARTER POKER GAME SERVER - Starting...');
    if (testTableId) {
      console.log(` 🧪 E2E TEST MODE - single test table ${testTableId.slice(0, 8)} only`);
    } else if (maintenanceMode) {
      console.log(' ⚠️  MAINTENANCE MODE - No tables, tournaments, or horses will be created');
    } else {
      console.log(' All game logic runs HERE - no browser needed');
    }
    console.log('═══════════════════════════════════════════════════════════════');

    /**
     * LEADER OR STANDBY — RESOLVED FIRST, BEFORE ANYTHING ELSE.
     *
     * This was originally placed after cleanupStaleData(), and running it for
     * real showed why that is wrong. A standby booted, spent nine seconds
     * hydrating 20,000 HorseMind pairs, and -- far worse -- ran the cleanup:
     *
     *     [GameServer] Closed 10 orphaned tournament tables and released their seats
     *
     * A standby had mutated shared state while another instance was live. It
     * then discovered it was a standby and returned, having already done the
     * one thing it must never do. It also took so long to get there that it
     * failed its healthcheck and autoheal restarted it, which started the whole
     * sequence again.
     *
     * cleanupStaleData closes tables, releases seats and resets horses. It is
     * recovery work that belongs to exactly one process: the one that owns the
     * fleet. So leadership is now the FIRST thing start() decides, before any
     * read, any write and any hydration.
     *
     * Fail-open on error, and a standby retains standby -- see
     * services/leadership.ts for why that asymmetry matters.
     */
    let role = await renewLeadership();
    if (!this.directAdmissionIsCurrent(generation)) return;
    startLeadershipRenewal();
    /**
     * THE BOOT CLAIM RETRIES THROUGH ONE STALENESS WINDOW (2026-08-30).
     *
     * A single boot-time claim decided leader-or-standby, and on 2026-08-30
     * that one answer was wrong five containers in a row: the claim either
     * timed out against a degraded database, or lost to the fresh lease the
     * process's own DEAD predecessor had written seconds before exiting.
     * Either way the process booted standby, was promoted a window later,
     * and exited to "restart as a real leader" — whose own boot claim then
     * met the lease ITS predecessor just wrote. A full container restart per
     * staleness window, dealing nothing, for as long as the trouble lasted.
     *
     * So the boot claim now retries for one staleness window plus margin.
     * A dead predecessor's lease goes stale INSIDE that window and the claim
     * is granted in-boot — no restart, no promotion dance. A REAL live
     * leader keeps its heartbeat fresh the whole way through, the deadline
     * expires, and this process stands down exactly as before. A database
     * that stays unreachable exhausts the deadline the same way, and the
     * PROMOTE_AFTER_UNKNOWN path in leadership.ts remains the fallback.
     */
    if (role === 'standby') {
      const bootClaimDeadline = Date.now() + (LEADERSHIP_STALE_SECONDS + 15) * 1000;
      while (role === 'standby' && Date.now() < bootClaimDeadline) {
        await new Promise((r) => setTimeout(r, 5000));
        if (!this.directAdmissionIsCurrent(generation)) return;
        role = await renewLeadership();
        if (!this.directAdmissionIsCurrent(generation)) return;
      }
      if (role === 'leader') {
        console.log(
          '[GameServer] Boot claim granted on retry - the previous lease went stale inside the window. Booting as leader.'
        );
      }
    }
    if (role === 'standby') {
      /**
       * Tell leadership.ts that this process never started the fleet, so that
       * if it is later promoted it restarts into the full leader boot instead
       * of becoming a leader that does nothing. See markBootedAsStandby().
       */
      markBootedAsStandby();
      const d = leadershipDiagnostics();
      console.log(
        `[GameServer] STANDBY - ${d.holder} holds leadership. Claiming nothing, ` +
          'cleaning nothing, hydrating nothing. Will take the fleet if that lease goes stale.'
      );
      // Nothing below runs. The renewal interval is the only thing alive, and
      // /health answers 503 so Caddy keeps traffic on the leader.
      return;
    }

    /**
     * LIVE HORSE COMPUTE HAS ONE OWNER (2026-09-08).
     *
     * HorseLogic, its RNG, learned opponent memory and solver lookup stores
     * live together in one FIFO worker. READY is a boot prerequisite: table
     * discovery cannot admit a live horse turn until that authority exists.
     * A standby returns above and therefore never starts a competing copy.
     * Unexpected worker loss is process-fatal because silently replacing it
     * would reset RNG and learned-memory ordering inside active hands.
     */
    try {
      await startLiveHorseDecisionWorker({
        onFatal: (error) => {
          this.revokeDealerPrerequisites(generation);
          throw error;
        },
      });
    } catch (error) {
      // stop() can intentionally cancel a worker that has not reached READY.
      // That is a successful boot cancellation, not a fatal startup failure.
      if (
        error instanceof HorseDecisionAbortedError &&
        !this.directAdmissionIsCurrent(generation)
      ) {
        return;
      }
      throw error;
    }
    if (!this.directAdmissionIsCurrent(generation)) return;

    /**
     * All-in equity and insurance are also hard realtime dependencies. Every
     * configured worker must author a READY handshake before table discovery
     * can route a hand here; degraded capacity removes this process from
     * routing instead of moving calculator work back onto the table thread.
     */
    try {
      await startEquityWorkerPool();
    } catch (error) {
      if (
        error instanceof EquityWorkerPoolAbortedError &&
        !this.directAdmissionIsCurrent(generation)
      ) {
        return;
      }
      throw error;
    }
    if (!this.directAdmissionIsCurrent(generation)) return;

    // Step 1: Clean up stale data from previous runs.
    // Test mode passes the protected id so cleanup spares it.
    await this.cleanupStaleData(testTableId);
    if (!this.directAdmissionIsCurrent(generation)) return;

    /**
     * ONE RAKE SPEC (Chip Accounting Standard R7, 2026-09-02). Before any
     * table engine boots, compare the database's rake spec checksum with the
     * one this build was compiled with. A mismatch raises a CRITICAL
     * `RakeSpec.drift` alert (once per boot, both checksums and both
     * canonical texts) and is published on /health; dealing CONTINUES on the
     * compiled-in spec. Dan's risk ruling: nothing high risk for live play
     * is enforced, so this never holds a table, never throws and never stops
     * the boot. See services/rakeSpecGuard.ts.
     */
    await startRakeSpecGuard();
    if (!this.directAdmissionIsCurrent(generation)) return;

    if (!maintenanceMode && !testTableId) {
      /**
       * DISCOVERY GOES FIRST (2026-08-24). It used to be Step 6, behind
       * `await this.horseFleet.start()`.
       *
       * The discovery loops are the only thing that attaches an engine to a
       * table, which is to say they are the only reason the platform deals a
       * hand. Everything they used to sit behind is housekeeping: seeding the
       * horse fleet, scheduling recurring tournaments, lifecycle sweeps, rebuy
       * funding, rakeback settlement.
       *
       * ensureAllTablesExist() inside the fleet bootstrap reads the whole table
       * list, and under load that read times out and retries. While it did,
       * `await` held the boot at Step 2 and Step 6 was simply never reached, so
       * the process ran as a leader with no discovery loop at all:
       *
       *   [HorseFleet.table_lookup_failed] Error: supabase_timeout
       *     at HorseFleetManager.ensureAllTablesExist
       *     at HorseFleetManager.start
       *     at GameServer.start
       *
       * The observable signature is discoveryLoopStalledMs climbing in exact
       * lockstep with uptime, activeTables pinned at 0, and liveness flipping to
       * 'dead' once past the startup grace - at which point the healthcheck kills
       * a container that was, by its own lights, booting normally. That is the
       * restart loop that kept the fleet at zero tables on 2026-08-24, and it is
       * why neither the adoption budget nor the leadership fixes cured it: they
       * govern a loop that was never running.
       *
       * cleanupStaleData() above stays awaited and stays first. That one IS a
       * prerequisite - it deletes stale seats and resets table state, and
       * adopting a table before it runs would hand an engine a half-torn-down
       * table. Nothing from here on is a prerequisite for dealing.
       *
       * These are infinite while-loops: fire-and-forget with error handling.
       */
      /**
       * Step 0b - THE BREAK IS ADOPTED BEFORE ANYTHING THAT CAN SEAT A PLAYER
       * (THE FREEZE IS TOTAL (Dan 2026-09-03)). This used to be Step 7b, after discovery,
       * the horse fleet, the recurring launcher and the scheduler had all
       * started - and every one of those fires an immediate first pass on
       * start(). On the 23:55 restart the new engine booted at 23:55:23 and
       * adopted the break at 23:55:26; in between, and in the seconds after,
       * those first passes seated 68 horses at cash tables and registered
       * 160 into tournaments while every screen on the platform said the
       * break was on. The flag those services check (isMaintenanceFrozen) is
       * set HERE, by restoreFromStore, so this must run first. Engines
       * adopted later are parked by maintenanceBreak.adopt().
       */
      await this.maintenanceBreak.start();
      if (!this.directAdmissionIsCurrent(generation)) return;

      // Subscribe before tournament discovery starts. Any action committed
      // while managers are being adopted remains an unconsumed durable row;
      // each manager start/resume drains its own rows once it can accept work.
      this.startTournamentManagerWakeSubscription();
      // Bounty payout recovery follows the same subscribe-then-drain rule.
      // New eliminations normally settle in their own atomic path; this lane
      // exists only for a committed outbox row whose process/response died.
      this.startTournamentBountyObligationSubscription();

      /* Ownership renewal is a primary lifecycle, independent of the much
         heavier discovery/adoption/reaper loops. A blocked discovery RPC must
         never consume the 20-second local authority proof of a healthy dealer. */
      this.launchServerLifecycleJob(
        this.runOwnershipLeaseRenewalLoop(generation),
        'GameServer.ownership_lease_renewal_fatal_err'
      );

      this.launchDiscoveryJob(
        this.discoverCashTables(),
        'GameServer.Cash_table_discovery_fatal_err'
      );
      this.launchDiscoveryJob(
        this.discoverTournaments(),
        'GameServer.Tournament_discovery_fatal_err'
      );
      /**
       * The seat-first fast lane (Dan 2026-08-21: the wheel spins the MOMENT
       * the 3rd seat is paid). discoverTournaments still carries the same
       * start gate as a backstop; this loop just refuses to make a paid-up
       * spin wait out the big loop's pass time. See discoverSeatFirstStarts.
       */
      this.launchDiscoveryJob(
        this.discoverSeatFirstStarts(),
        'GameServer.seat_first_fast_start_fatal_err'
      );

      /**
       * The fleet bootstrap is no longer awaited, for the same reason it no
       * longer runs first: a housekeeping step that can retry a timing-out
       * query must not be able to hold up the rest of the boot. Everything
       * below is a `.start()` that returns immediately, so awaiting this was
       * the single point at which a slow database could stop the whole boot
       * sequence.
       *
       * Nothing below needs the fleet to be seeded already. The recurring
       * tournament service and the lifecycle sweeps are pollers; they pick the
       * fleet up on their next tick. Discovery likewise re-runs every
       * TABLE_DISCOVERY_INTERVAL, so tables the fleet creates late are adopted
       * on the next sweep rather than missed.
       */
      this.launchServerLifecycleJob(this.horseFleet.start(), 'GameServer.horse_fleet_start_failed');

      // Slice 6: the cluster lifecycle, beside the fleet, on the leader only.
      this.clusterController.start();

      // Step 3: Start tournament recurring service (creates MTTs, SNGs, Spins)
      this.tournamentRecurring.start();

      // Step 3b: Start the data-driven scheduler (tournament_schedules rows)
      this.scheduledTournaments.start();

      // Step 3c: Start the tournament metrics collector so /metrics can carry
      // tournament gauges. Refreshes once immediately, then every 60s, and a
      // failed read keeps the last good snapshot while
      // poker_tournament_metrics_stale_seconds climbs — a blind collector must
      // never read as a healthy platform.
      this.tournamentMetrics.start();

      // Step 3d: Spin gauges. Spin charges no rake — the 8% IS the multiplier
      // distribution — so E[multiplier] = 2.7638 is the only evidence the house
      // takes what it advertises, and until this collector shipped nothing had
      // ever checked it except a human typing SQL. Same fail-loud contract.
      this.spinMetrics.start();

      // Step 3e: Replication gauges. The realtime slot was 136 MB behind on
      // 2026-09-04 and nothing on the platform could see it - logical decoding
      // degrades as a spiral, not a cliff, because a slot that falls behind
      // must read WAL from disk rather than memory, which is slower. Its own
      // collector, deliberately: a catalog read must never be able to blind
      // the spin fairness gauges, or be blinded by them.
      this.replicationMetrics.start();

      // Step 4: Start lifecycle manager (stuck horse detection, cleanup)
      this.lifecycle.start();

      // Step 5: Start server-side auto-rebuy wallet funder

      // Step 5a: the only liveness check that does not ask this process
      // whether it is alive. See services/DealRateVerifier.ts.
      this.dealRateVerifier.start();

      // Step 5b (BUG 008 FIX): Start periodic rakeback settler (30-min interval).
      // Reads rake_records → upserts rakeback_periods so players see accumulated
      // rakeback in the UI and weekly settlement has rows to pay out.
      this.rakebackSettler.start();

      // Step 7: Start synchronized break timer (last hand at :55, then 5 min break)
      this.scheduleSynchronizedBreaks();

      // Step 7b (Dan 2026-09-01): the maintenance break that carries the
      // engine restart. Announces the last hand at :53 of a restart hour,
      // parks every table - cash and tournament - for :55 to :00, and re-adopts
      // a break the PREVIOUS engine declared before it was killed. That last
      // part is why it is awaited here, ahead of any dealing: this process is
      // usually booting *because* of the restart the break was declared for,
      // and it must not deal a hand into a break players are still watching.
      // (the break is adopted at Step 0b now - see above)

      // Step 8 (A5): Start the fee reconciler. Rake and the BBJ contribution are
      // taken out of the pot inside the hand; if the banking RPC fails the chips
      // exist nowhere. The engine now queues those failures durably — this drains
      // that queue, and independently compares what rake_records booked as BBJ
      // contribution against what the jackpot pool actually received, because a
      // failure the engine never noticed would otherwise stay invisible (it did,
      // for a week).
      this.startFeeReconciler();
      this.startLeaseReaper();
      this.startClockSkewMonitor();
      this.statsHealth.start();
      this.startBombLedgerRepairSweep();

      // Step 8b: accepted-hand settlement stores history and projection work in
      // one database transaction. The projection worker drains that durable
      // outbox; there is no process-local hand-history recovery owner.
      startHandProjectionWorker();
      this.handOutboxMetrics.start();
      // Step 8c: LISTEN hand_projection_outbox. Started after the worker so
      // its first (re)connect resync wake lands on a live worker. Disabled
      // (warns once) while ENGINE_PG_LISTEN_URL is unset on the engine host;
      // the local commit wake and the worker's 5 s poll carry every hand.
      this.handOutboxListener.start();

      if (!this.publishDealerPrerequisitesReady(generation)) return;
      this.leaderBootComplete = true;
      console.log('[GameServer] Running. All services started.');
    } else if (testTableId) {
      // E2E test mode: boot a single table engine for the designated test id.
      // No other services run — no horse seeding, no tournament expansion,
      // no discovery sweeps, no break timer. Just one table for hand testing.
      try {
        if (!this.publishDealerPrerequisitesReady(generation)) return;
        await this.startTableEngineForTesting(testTableId);
        if (!this.directAdmissionIsCurrent(generation)) return;
        console.log(`[GameServer] E2E test table ${testTableId.slice(0, 8)} engine started.`);
      } catch (err) {
        reportError(err, 'GameServer.E2E_test_table_start_failed');
      }
    } else {
      console.log(
        '[GameServer] Running in MAINTENANCE MODE - only /health and /action endpoints active.'
      );
    }
  }

  /**
   * E2E test mode boot path: starts an engine for one specific table id.
   * Mirrors the relevant portion of discoverCashTables but skips the loop +
   * filter logic. Caller (start()) ensures we only get here when TEST_TABLE_ID
   * is set so this stays out of the normal-operation hot path.
   */
  private async startTableEngineForTesting(tableId: string): Promise<void> {
    const outcome = await this.ensureCashTableEngineAdmission(tableId);
    this.finishDirectTableAdmission(tableId, 'test_table_admission_failed', outcome);
    if (outcome !== 'ready') {
      throw new Error(`E2E test table ${tableId} admission ended as ${outcome}`);
    }
  }

  /** Index-owned mutators may start only after the leader boot is fully committed. */
  isLeaderBooted(): boolean {
    return this.running && this.leaderBootComplete && isLeader();
  }

  registerExternalShutdownOwnershipBarrier(barrier: () => Promise<void>): void {
    if (this.teardownPromise) {
      throw new Error('Cannot register a shutdown ownership barrier after teardown begins');
    }
    if (
      this.externalShutdownOwnershipBarrier &&
      this.externalShutdownOwnershipBarrier !== barrier
    ) {
      throw new Error('A shutdown ownership barrier is already registered');
    }
    this.externalShutdownOwnershipBarrier = barrier;
  }

  private beginExternalShutdownOwnershipBarrier(): Promise<ExternalShutdownOwnershipResult> {
    const barrier = this.externalShutdownOwnershipBarrier;
    if (!barrier) return Promise.resolve({ status: 'fulfilled' });
    try {
      // Calling the provider, rather than deferring it through Promise.then,
      // applies every external generation fence before stop() can yield.
      return Promise.resolve(barrier()).then(
        () => ({ status: 'fulfilled' }) as const,
        (reason) => ({ status: 'rejected', reason }) as const
      );
    } catch (reason) {
      return Promise.resolve({ status: 'rejected', reason });
    }
  }

  stop(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;
    // The governor's sampler is unref'd, so this is tidiness rather than a
    // leak - but a stopped engine should not keep reading a loop it no
    // longer drives.
    equityGovernor.stopSampling();
    const stoppingGeneration = this.lifecycleGeneration;
    this.running = false;
    this.leaderBootComplete = false;
    this.revokeDealerPrerequisites(stoppingGeneration);
    this.lifecycleGeneration += 1;
    console.log('[GameServer] Shutting down...');

    // Revoke every manager callback before the first shutdown await, but retain
    // and renew its exact lease generation for hands already in progress. The
    // final authority fence lands only after the bounded between-hands drain.
    const tournamentManagersAtFence = [...this.tournamentEngines.entries()];
    for (const [, manager] of tournamentManagersAtFence) manager.beginServerShutdownDrain();
    this.startShutdownOwnershipLeaseRenewal();
    const externalOwnership = this.beginExternalShutdownOwnershipBarrier();

    const teardown = this.performStop(tournamentManagersAtFence, externalOwnership).finally(() =>
      this.stopShutdownOwnershipLeaseRenewal()
    );
    this.teardownPromise = teardown;
    return teardown;
  }

  private async performStop(
    tournamentManagersAtFence: Array<[string, TournamentManager]>,
    externalOwnership?: Promise<ExternalShutdownOwnershipResult>
  ): Promise<void> {
    const ownershipFailures: unknown[] = [];
    type OwnedStopResult =
      | { service: string; status: 'fulfilled' }
      | { service: string; status: 'rejected'; reason: unknown };
    const beginOwnedStop = (
      service: string,
      stop: () => Promise<void> | void
    ): Promise<OwnedStopResult> => {
      try {
        // Attach both outcomes immediately. A stop rejection must remain part
        // of the ownership certificate without becoming an unhandled
        // rejection while another producer or boot generation is draining.
        return Promise.resolve(stop()).then<OwnedStopResult, OwnedStopResult>(
          () => ({ service, status: 'fulfilled' }),
          (reason) => ({ service, status: 'rejected', reason })
        );
      } catch (reason) {
        return Promise.resolve({ service, status: 'rejected', reason });
      }
    };
    const beginOwnedProducerStops = (): Array<Promise<OwnedStopResult>> => {
      const stops: Array<[service: string, stop: () => Promise<void>]> = [
        ['HorseFleetManager', () => this.horseFleet.stop()],
        ['ClusterController', () => this.clusterController.stop()],
        ['TournamentRecurringService', () => this.tournamentRecurring.stop()],
        ['ScheduledTournamentService', () => this.scheduledTournaments.stop()],
        ['HorseLifecycleManager', () => this.lifecycle.stop()],
        ['DealRateVerifier', () => this.dealRateVerifier.stop()],
        ['RakebackSettlerService', () => this.rakebackSettler.stop()],
        ['StatsHealthMonitor', () => this.statsHealth.stop()],
      ];
      return stops.map(([service, stop]) => beginOwnedStop(service, stop));
    };
    const externalOwnershipCompletion =
      externalOwnership ??
      Promise.resolve<ExternalShutdownOwnershipResult>({ status: 'fulfilled' });
    for (const timer of this.directTableRecoveryTimers.values()) clearTimeout(timer);
    this.directTableRecoveryTimers.clear();
    this.directTableRecoveryAttempts.clear();
    for (const timer of this.tournamentManagerAdmissionRetryTimers.values()) clearTimeout(timer);
    this.tournamentManagerAdmissionRetryTimers.clear();
    this.tournamentManagerAdmissionRetryAttempts.clear();
    /* Admission UUIDs are potential committed authority, not disposable retry
       bookkeeping. Keep them through the fixed-point admission drain; each
       uncertain result publishes an exact pending release, and the final
       shutdown certificate includes both maps. */

    // Stop services. Every shared-state producer is invoked before the first
    // await, so all lifecycle generations are fenced as one boundary. Their
    // promises are retained and checked before distributed ownership release.
    const firstProducerStops = beginOwnedProducerStops();
    const firstSupportingStops = [
      beginOwnedStop('RakeSpecGuard', stopRakeSpecGuard),
      beginOwnedStop('MaintenanceBreak', () => this.maintenanceBreak.stop()),
    ];
    // If shutdown lands while the worker is still hydrating, begin its
    // cancellation before joining performStart(). No dealer can have been
    // admitted before worker READY, so this cannot interrupt a live hand. A
    // ready worker remains alive until every admitted dealer has drained below.
    const startingHorseDecisionStop =
      liveHorseDecisionWorkerStatus().phase === 'starting'
        ? beginOwnedStop('LiveHorseDecisionWorker', stopLiveHorseDecisionWorker)
        : null;
    const startingEquityWorkerStop =
      equityWorkerPoolStatus().phase === 'starting'
        ? beginOwnedStop('EquityWorkerPool', stopEquityWorkerPool)
        : null;
    this.tournamentMetrics.stop();
    this.spinMetrics.stop();
    this.replicationMetrics.stop();
    if (this.breakTimer) {
      clearTimeout(this.breakTimer);
      this.breakTimer = null;
    }
    /**
     * Drop the maintenance break's TIMERS but deliberately NOT its row.
     *
     * This shutdown is, on the intended path, the restart the break exists to
     * cover. Clearing the row here would delete the break on the way out and
     * the engine that replaces us would deal instantly into a countdown that
     * is still running on every screen - the precise failure the persistence
     * was added to prevent. The row is cleared by whoever ends the break:
     * either the next engine when it reaches :00, or fn_maintenance_break_state
     * expiring it if no engine ever comes back.
     */
    if (this.feeReconcileTimer) {
      clearInterval(this.feeReconcileTimer);
      this.feeReconcileTimer = null;
    }
    if (this.leaseReapTimer) {
      clearInterval(this.leaseReapTimer);
      this.leaseReapTimer = null;
    }
    if (this.bombLedgerRepairTimer) {
      clearInterval(this.bombLedgerRepairTimer);
      this.bombLedgerRepairTimer = null;
    }
    if (this.clockSkewTimer) {
      clearInterval(this.clockSkewTimer);
      this.clockSkewTimer = null;
    }

    // A signal may arrive while boot is suspended in leadership, cleanup,
    // rake verification, break restoration, or test-table readiness. The boot
    // generation checks after each await and returns without publishing new
    // services; joining it here makes that fact part of the ownership proof.
    if (this.startOperation) {
      await this.startOperation.catch((error) =>
        reportError(error, 'GameServer.start_failed_during_shutdown')
      );
    }
    // Async starters may have crossed their own final await immediately before
    // observing the generation fence. Stop their timers again after the joined
    // boot so no boot continuation can re-arm a source behind shutdown.
    const supportingStopResults = await Promise.all([
      ...firstSupportingStops,
      beginOwnedStop('MaintenanceBreak', () => this.maintenanceBreak.stop()),
      beginOwnedStop('RakeSpecGuard', stopRakeSpecGuard),
    ]);
    for (const result of supportingStopResults) {
      if (result.status !== 'rejected') continue;
      const error = new AggregateError(
        [result.reason],
        `${result.service} did not certify shutdown ownership`
      );
      reportError(error, 'GameServer.supporting_shutdown_failed', { service: result.service });
      ownershipFailures.push(error);
    }

    // A starter may have reached its last synchronous start call immediately
    // before observing GameServer's generation fence. Re-fence after the boot
    // promise is joined, and require both stop rounds to settle successfully.
    const producerStopResults = await Promise.all([
      ...firstProducerStops,
      ...beginOwnedProducerStops(),
    ]);
    for (const result of producerStopResults) {
      if (result.status !== 'rejected') continue;
      const error = new AggregateError(
        [result.reason],
        `${result.service} did not certify shutdown ownership`
      );
      reportError(error, 'GameServer.producer_shutdown_failed', { service: result.service });
      ownershipFailures.push(error);
    }
    const externalOwnershipResult = await externalOwnershipCompletion;
    if (externalOwnershipResult.status === 'rejected') {
      ownershipFailures.push(externalOwnershipResult.reason);
    }

    if (this.tournamentManagerWakeChannel) {
      const wakeChannel = this.tournamentManagerWakeChannel;
      this.tournamentManagerWakeChannel = null;
      await Promise.resolve(supabase.removeChannel(wakeChannel)).catch((err) =>
        reportError(err, 'GameServer.tournament_manager_wake_channel_remove_failed')
      );
    }
    tournamentManagerWakeRealtimeConnected.set(0);
    if (this.tournamentBountyObligationChannel) {
      const bountyChannel = this.tournamentBountyObligationChannel;
      this.tournamentBountyObligationChannel = null;
      await Promise.resolve(supabase.removeChannel(bountyChannel)).catch((err) =>
        reportError(err, 'GameServer.tournament_bounty_channel_remove_failed')
      );
    }
    bountyRecoveryRealtimeConnected.set(0);
    if (this.bountyRecoveryDueTimer) {
      clearTimeout(this.bountyRecoveryDueTimer);
      this.bountyRecoveryDueTimer = null;
    }
    if (this.tournamentBountyReconnectTimer) {
      clearTimeout(this.tournamentBountyReconnectTimer);
      this.tournamentBountyReconnectTimer = null;
    }
    if (this.tournamentManagerWakeReconnectTimer) {
      clearTimeout(this.tournamentManagerWakeReconnectTimer);
      this.tournamentManagerWakeReconnectTimer = null;
    }
    if (this.tournamentManagerWakeDrainRetryTimer) {
      clearTimeout(this.tournamentManagerWakeDrainRetryTimer);
      this.tournamentManagerWakeDrainRetryTimer = null;
    }
    this.tournamentManagerWakeDrainRetryGeneration++;
    this.tournamentManagerWakeDrainRetryBackoffMs = 250;
    this.bountyRecoveryDueAt = 0;
    this.bountyRecoveryRequested = false;
    this.tournamentManagerWakeDrainRequested = false;

    if (this.breakResumeTimer) {
      clearTimeout(this.breakResumeTimer);
      this.breakResumeTimer = null;
    }

    // The three infinite discovery loops and every detached admission/repair
    // they launched are joined before the final dealer snapshot. Direct
    // HTTP/WS admissions have their own registry because they need not begin
    // inside discovery. Only after both sets reach a fixed point can shutdown
    // prove that no lease or engine will appear behind its back.
    await this.drainOwnedLifecycleJobs();

    // This should add nothing after the generation fence and fixed-point
    // drains. Keep the union defensive and fence it synchronously so a future
    // admission site cannot silently escape the protocol.
    const tournamentManagers = [
      ...new Map([...tournamentManagersAtFence, ...this.tournamentEngines.entries()]).entries(),
    ];
    for (const [, manager] of tournamentManagers) manager.beginServerShutdownDrain();

    /**
     * C19 FIX (2026-08-20): drain in-flight hands, then stop everything at once.
     *
     * This used to stop engines one at a time, each awaiting its own teardown
     * (which now includes a snapshot flush). With 40 tables that is 40 serial
     * round trips inside a 20s shutdown budget, so the tail of the list was
     * routinely SIGKILLed rather than stopped — and every table still mid-hand
     * had that hand abandoned outright: cards dealt, chips committed, no
     * settlement.
     *
     * Now: ask every table to park AFTER its current hand (pauseAfterHand is
     * exactly that primitive — the deal loop only reaches the gate between
     * hands), wait a bounded window for them to arrive, then tear down in
     * parallel. A table that does not drain in time is stopped anyway, so
     * shutdown is still strictly bounded; the drain converts the common case
     * from "abandon ~40 hands" into "abandon none".
     */
    const DRAIN_BUDGET_MS = 12_000;
    const DRAIN_POLL_MS = 250;
    const engineTableIds = [...this.tableEngines.keys()];
    const engines = [...this.tableEngines.values()];
    const cashLeaseClaimsByTable = new Map(this.directTablePendingLeaseReleases);
    for (let index = 0; index < engines.length; index++) {
      const engine = engines[index];
      const authority = engine.getEngineLeaseAuthority();
      if (authority?.scope === 'cash' && authority.verified) {
        cashLeaseClaimsByTable.set(engineTableIds[index], authority.generation);
      }
    }
    const cashLeaseClaims = [...cashLeaseClaimsByTable].map(([tableId, leaseGeneration]) => ({
      tableId,
      leaseGeneration,
    }));
    if (engines.length > 0) {
      // Refresh the distributed fence immediately before the bounded drain.
      // Leadership renewal remains active until every manager and dealer is
      // stopped, so a standby cannot overlap this outgoing generation.
      await this.renewOwnedEngineLeaseProofs();
      for (const engine of engines) {
        try {
          // A drain is stopping the process: do not start another hand.
          engine.pauseAfterHand(DRAIN_BUDGET_MS, { beforeNextHand: true });
        } catch {
          /* a table that cannot be asked to pause is stopped below regardless */
        }
      }
      const drainDeadline = Date.now() + DRAIN_BUDGET_MS;
      let pending = engines.filter((e) => !e.isDrained()).length;
      while (pending > 0 && Date.now() < drainDeadline) {
        await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
        pending = engines.filter((e) => !e.isDrained()).length;
      }
      console.log(
        pending === 0
          ? `[GameServer] Drained all ${engines.length} table(s) between hands`
          : `[GameServer] Drain window elapsed with ${pending}/${engines.length} table(s) still mid-hand - stopping anyway`
      );
      // The drain itself can consume most of the lease stale window. Renew at
      // its far edge so teardown still owns the database fence it relies on.
      await this.renewOwnedEngineLeaseProofs();
    }

    /* No heartbeat may race the final fence or exact release. End and join the
       shutdown-only renewal owner, then drain any lease-loss retirement it
       launched before taking authority away from the parked tables. */
    await this.stopShutdownOwnershipLeaseRenewal();
    await this.drainOwnedLifecycleJobs();
    for (const [, manager] of tournamentManagers) manager.fenceForServerShutdown();

    // Stop every dealer and manager in parallel. Manager stop is invoked
    // through the identity-CAS owner so a stale teardown can never remove a
    // successor. A cleanup error is tolerable only after the engine proves its
    // process scheduler ownership has already been released.
    const engineStops = engines.map((engine) => engine.stop());
    const managerStops = tournamentManagers.map(([id, manager]) =>
      this.stopTournamentManagerIfOwned(
        id,
        manager,
        'GameServer.shutdown_manager_stop_failed',
        false
      )
    );
    const [engineStopResults, managerStopResults] = await Promise.all([
      Promise.allSettled(engineStops),
      Promise.allSettled(managerStops),
    ]);
    for (let index = 0; index < engines.length; index++) {
      const engine = engines[index];
      const tableId = engineTableIds[index];
      const result = engineStopResults[index];
      if (result.status === 'rejected') {
        if (!engine.hasReleasedProcessOwnership()) {
          ownershipFailures.push(result.reason);
          continue;
        }
        reportError(result.reason, 'GameServer.table_engine_stop_cleanup_failed', { tableId });
      }
      if (this.tableEngines.get(tableId) === engine) this.tableEngines.delete(tableId);
    }
    for (let index = 0; index < managerStopResults.length; index++) {
      const result = managerStopResults[index];
      const [tournamentId, manager] = tournamentManagers[index];
      if (result.status === 'rejected') {
        ownershipFailures.push(result.reason);
      } else if (result.value !== true && this.tournamentEngines.get(tournamentId) === manager) {
        ownershipFailures.push(
          new Error(`Tournament manager ${tournamentId} retained shutdown ownership`)
        );
      }
    }

    // No table can enqueue new compute after the dealer/manager drain. Abort
    // and join every remaining equity operation before distributed ownership
    // is released to a successor process.
    const equityWorkerStop = await (startingEquityWorkerStop ??
      beginOwnedStop('EquityWorkerPool', stopEquityWorkerPool));
    if (equityWorkerStop.status === 'rejected') {
      const error = new AggregateError(
        [equityWorkerStop.reason],
        'EquityWorkerPool did not certify shutdown'
      );
      reportError(error, 'GameServer.equity_worker_pool_shutdown_failed');
      ownershipFailures.push(error);
    }

    // The worker FIFO can contain the last completed-hand observation or a
    // decision already accepted before its table was fenced. Dealers and
    // managers must stop first; then this drain flushes the worker-owned mind,
    // telemetry and solver clocks before any distributed lease is released.
    const horseDecisionStop = await (startingHorseDecisionStop ??
      beginOwnedStop('LiveHorseDecisionWorker', stopLiveHorseDecisionWorker));
    if (horseDecisionStop.status === 'rejected') {
      const error = new AggregateError(
        [horseDecisionStop.reason],
        'LiveHorseDecisionWorker did not certify shutdown ownership'
      );
      reportError(error, 'GameServer.horse_decision_worker_shutdown_failed');
      ownershipFailures.push(error);
    }
    await this.handOutboxListener.stop();
    this.handOutboxMetrics.stop();
    await stopHandProjectionWorker();

    /**
     * Distributed ownership is released only after all code that can deal or
     * mutate a tournament has stopped. Releasing first created a 12-27 second
     * cross-container split-brain window during every normal deploy: the
     * standby could claim the same table while the outgoing engine was still
     * finishing a hand. Explicit release here keeps fast handoff without ever
     * trading correctness for it.
     */
    if (ownershipFailures.length > 0) {
      const error = new AggregateError(
        ownershipFailures,
        `GameServer shutdown retained ${ownershipFailures.length} process owner(s); distributed leases were not released`
      );
      reportError(error, 'GameServer.shutdown_ownership_not_released');
      await flushSentry();
      throw error;
    }

    const cashRelease = await releaseTables(cashLeaseClaims);
    const distributedReleaseFailures: Error[] = [];
    if (cashRelease.status !== 'confirmed') {
      const error = new Error(
        `Shutdown cash lease release was not confirmed: ${cashRelease.reason} after ` +
          `${cashRelease.attempts} attempt(s): ${cashRelease.detail}`
      );
      distributedReleaseFailures.push(error);
      reportError(error, 'GameServer.shutdown_cash_lease_release_unconfirmed');
    }
    const tournamentLeaseClaims = new Map(this.tournamentManagerPendingLeaseReleases);
    for (const [tournamentId, manager] of tournamentManagers) {
      const leaseGeneration = manager.getTournamentLeaseGeneration();
      if (leaseGeneration) tournamentLeaseClaims.set(tournamentId, leaseGeneration);
    }
    const tournamentRelease = await releaseTournaments(
      [...tournamentLeaseClaims].map(([tournamentId, leaseGeneration]) => ({
        tournamentId,
        leaseGeneration,
      }))
    );
    if (tournamentRelease.status !== 'confirmed') {
      const error = new Error(
        `Shutdown tournament lease release was not confirmed: ${tournamentRelease.reason} after ` +
          `${tournamentRelease.attempts} attempt(s): ${tournamentRelease.detail}`
      );
      distributedReleaseFailures.push(error);
      reportError(error, 'GameServer.shutdown_tournament_lease_release_unconfirmed');
    }
    if (distributedReleaseFailures.length > 0) {
      const error = new AggregateError(
        distributedReleaseFailures,
        `GameServer shutdown could not prove ${distributedReleaseFailures.length} exact distributed lease release(s)`
      );
      reportError(error, 'GameServer.shutdown_distributed_release_unproven');
      await flushSentry();
      /* Leadership deliberately remains held and no success line is emitted.
         A supervisor may terminate this failed-stop process, after which the
         30-second DB lease boundary remains the conservative handoff gate. */
      throw error;
    }
    this.directTablePendingLeaseReleases.clear();
    this.tournamentManagerPendingLeaseReleases.clear();
    this.directTableAdmissionLeaseGenerations.clear();
    this.tournamentManagerAdmissionLeaseGenerations.clear();
    stopLeadershipRenewal();
    await releaseLeadership();

    // Phase 1.1 PR-5: no Supabase Realtime channels to clean up — engine
    // WebSocket server (EngineWebSocketServer.close()) handles its own
    // shutdown; TableStateHub has no channels to close.

    // Flush pending Sentry events before exit
    await flushSentry();

    console.log('[GameServer] Shutdown complete.');
  }

  getStatus() {
    const now = Date.now();
    const liveHorseDecision = liveHorseDecisionWorkerStatus();
    const equityWorkers = equityWorkerPoolStatus();
    // Per-table liveness first — everything below is aggregate telemetry that
    // cannot distinguish a dealing table from a frozen one.
    const tableLiveness = this.tableLivenessSnapshot();
    const stalledTables = tableLiveness
      .filter((t) => t.dealable >= 2 && !t.paused && t.msSinceProgress > 120_000)
      .map((t) => ({
        tableId: t.tableId,
        dealable: t.dealable,
        secsIdle: Math.round(t.msSinceProgress / 1000),
      }));
    // LIVENESS RACE FIX (2026-08-22): the per-table recovery chain (watchdog
    // Tier 1-3 -> killForRestart -> 180s zombie reaper -> discovery rebuild)
    // needs up to ~3 minutes end to end. Flipping the whole process 'dead' at
    // 120s meant Docker restarted the container — voiding every in-flight
    // hand on every healthy table — BEFORE the single wedged table's own
    // recovery had a chance to finish. Report stalls at 120s (visibility),
    // but only declare the process dead once a table has out-stalled the
    // entire in-process recovery chain.
    /**
     * ── A MINORITY STALL IS NOT A DEAD PROCESS (2026-09-05) ────────────────
     *
     * The fix above went half way. It moved the death threshold from 120s to
     * 300s so a wedged table's own recovery chain gets to finish first — but
     * it kept the SHAPE: one table out of hundreds still condemns the whole
     * process, and sp-autoheal then voids the in-flight hand on every other
     * table to fix that one.
     *
     * MEASURED IN PRODUCTION, 763 consecutive minutes on 2026-09-05, from
     * Prometheus rather than from reasoning:
     *
     *   poker_engine_liveness == 0 for 139 of 763 minutes   (18% of the day)
     *   of those 139, stalled tables > 0 in 136             (98%)
     *   of the 624 healthy minutes, stalled tables > 0 in 0 (0%)
     *   the MODAL stalled count during a dead minute:  1
     *
     * So the fleet was declared dead for a fifth of the day, essentially
     * always by a single table, while ~312 tables dealt normally. sp-autoheal
     * acted on it five times that day — 16:06, 16:42, 17:49, 18:26, 19:04 UTC
     * — every one an unannounced restart outside the :55 break, which §13
     * exists precisely to abolish, and every one voiding live hands (§10.5:
     * a horse's hand counts).
     *
     * It also broke deploys, which is how it was found: each bounce reset
     * uptime, the deploy pipeline read uptime as "we just restarted", and
     * coalesced. Production sat 3 commits behind for hours.
     *
     * THE RULE THIS FILE ALREADY ESTABLISHED, APPLIED ONE MORE TIME. Every
     * correction above it says the same thing in a different costume: a
     * signal may only kill the process when killing it costs less than
     * leaving it. `barrenLeaderDead` states the test outright — "we own ZERO
     * tables, so a restart voids no hand and drops no player". A stalled
     * minority fails that test by definition, and it has its own, cheaper
     * remedy: the per-table recovery chain (watchdog Tier 1-3 ->
     * killForRestart -> zombie reaper -> discovery rebuild) rebuilds exactly
     * the broken table without touching the other 311.
     *
     * So the process is dead only when the stall is the WHOLE fleet: every
     * dealable, unpaused table has out-stalled the recovery chain. Then a
     * restart voids nothing that was working, and it is the right answer.
     *
     * The other death signals are untouched and still cover the cases this
     * one no longer reaches: a wedged discovery loop (discoveryLoopDead), a
     * barren leader (barrenLeaderDead), and the database's own verdict that
     * no hands are being dealt at all (dealRate.dbConfirmedDead) — that last
     * one is the fleet-wide detector, asked of Postgres rather than of this
     * process's opinion of itself, and it is the correct home for "nothing is
     * dealing" precisely because it cannot be fooled by our own bookkeeping.
     */
    const discoveryStaleMs = now - this.lastDiscoveryOkAt;
    /**
     * ── A SLOW DATABASE IS NOT A DEAD PROCESS (2026-08-23) ──────────────────
     *
     * liveness used `discoveryStaleMs > 60_000`, and `lastDiscoveryOkAt` only
     * advances on a SUCCESSFUL rpc. So one minute of database trouble flipped
     * the whole process to 'dead' -> Docker healthcheck fails -> sp-autoheal
     * kills the container -> every in-flight hand on every table it owned is
     * voided. The engine was fine. The database was slow.
     *
     * Verified: `club-arena-engine-2` was marked unhealthy four times between
     * 05:35 and 05:43 UTC while running a healthcheck that connects perfectly,
     * so the probe was reaching the engine and being TOLD 'dead'.
     *
     * This is the same mistake as the dealing-loop watchdog in #281, one level
     * up, and it takes the same shape of fix: ask whether the loop is RUNNING
     * (`lastDiscoveryAttemptAt`), not whether its last answer was good.
     * Sustained RPC failure is still reported — see discoveryStaleMs below and
     * the fleet alarms — it simply no longer restarts a healthy container.
     */
    const discoveryLoopStalledMs = now - this.lastDiscoveryAttemptAt;
    /**
     * ── BOOTING IS NOT DEAD (2026-08-23) ────────────────────────────────────
     *
     * discoveryLoopStalledMs is measured from lastDiscoveryAttemptAt, which is
     * seeded at construction and then stamped by the discovery loop. But the
     * loop does not START until start() has finished cleanupStaleData, the
     * horse fleet and HorseMind hydration -- and on a busy database that can
     * take longer than 60s. During that window the engine reports 'dead' while
     * doing exactly what it is supposed to.
     *
     * OBSERVED LIVE, not theorised: on the 2026-08-23 leader/standby rollout
     * /health returned liveness 'dead' at ~60s uptime on a container that was
     * booting perfectly and reported 'ok' thirty seconds later.
     *
     * Docker separately gives the container a five-minute health grace. This
     * in-process grace keeps both /health and /metrics truthful during their
     * first three minutes even when read outside Docker.
     *
     * A boot that never finishes is still caught: the process either fails to
     * answer /health at all, or finishes and starts being judged normally.
     */
    // The one liveness signal not derived from this process's own beliefs.
    // deadStalledCount above is computed from msSinceProgress(), which
    // markProgress() sets about our own work; on 2026-08-22 that belief was
    // wrong for six hours and every layer above /health inherited it. This
    // asks the database instead. See services/DealRateVerifier.ts.
    const dealRate = this.dealRateVerifier.snapshot();

    /**
     * ── TABLE PROGRESS VETOES A DISCOVERY-STALL DEATH (2026-08-24) ─────────
     *
     * OBSERVED LIVE tonight: discoveryLoopStalledMs read 87s (one discovery
     * CYCLE blocked inside a slow database call, so no new attempt was
     * stamped) while 123 tables were active, 0 were stalled, and hand_history
     * showed a hand completing every second. liveness said 'dead' anyway —
     * inviting sp-autoheal to restart a demonstrably dealing engine and void
     * every one of those tables. A blocked discovery cycle pauses NEW table
     * adoption; it does not stop play. If any table made progress inside the
     * last 2 minutes the process cannot be dead, so a discovery stall alone
     * must not kill it.
     *
     * BOUNDED, because the opposite failure is real too: a discovery loop
     * wedged forever on a hung await would otherwise never be restarted while
     * horses keep tables "progressing" indefinitely. Past 15 minutes of no
     * discovery attempts the restart is the correct answer regardless.
     */
    /**
     * ── A BARREN LEADER IS DEAD, HOWEVER BUSY ITS LOOP LOOKS (2026-08-30) ───
     *
     * Every fix above moved liveness from "did discovery SUCCEED" to "is the
     * loop RUNNING", each time for a good reason: a slow database must not
     * kill an engine that is dealing. Correct — but it left a hole with no
     * detector in it. A discovery loop that ATTEMPTS every few seconds and
     * FAILS every single time is, to `discoveryLoopStalledMs`, perfectly
     * healthy: the attempt clock keeps getting stamped. So the process owns no
     * tables, deals no hands, reports liveness 'ok', and — because it is the
     * leader — holds the lease that would let a working instance take over.
     *
     * OBSERVED IN PRODUCTION 2026-08-30, the whole fleet dark for 20 minutes:
     *   role=leader status=ok uptime=175s activeTables=0 totalHandsDealt=0
     *   discoveryLoopStalledMs=4496      <- loop ticking, so "alive"
     *   discoveryStaleMs=101563          <- not one success in 101s
     * Nineteen RUNNING tournaments with ~3,000 seated players, zero hands.
     * Docker saw 'ok' and left it alone; the lease stayed held; it could only
     * be cleared by hand. `discoveryStaleMs` was RIGHT there in the payload and
     * nothing was allowed to read it, because reading it used to be the bug.
     *
     * So read it again — but only in the one state where it cannot be confused
     * with a slow database, and where acting on it costs nothing:
     *
     *   - the loop has not SUCCEEDED once in ten minutes, so this is not a
     *     blip and not an idle fleet (an idle fleet's discovery still SUCCEEDS
     *     and finds nothing, which keeps this clock at zero); and
     *   - we own ZERO tables, so a restart voids no hand and drops no player.
     *
     * That second clause is what makes this safe where its predecessors were
     * not: every regression above was harmful because it killed an engine with
     * live tables. This one is unreachable unless there is nothing to lose.
     */
    const livenessVerdict = evaluateEngineLiveness({
      isLeader: isLeader(),
      processUptimeMs: now - this.processStartedAt,
      discoveryLoopStalledMs,
      discoveryStaleMs,
      dbConfirmedDead: dealRate.dbConfirmedDead,
      tables: tableLiveness,
    });
    const { deadStalledCount, dealableTableCount, wholeFleetStalled, barrenLeaderDead } =
      livenessVerdict;

    let totalHands = 0;
    // FIX 153: Aggregate telemetry from all table engines for health endpoint
    const tableMetrics: any[] = [];
    for (const engine of this.tableEngines.values()) {
      totalHands += engine.getHandCount();
      const snapshot = engine.getTelemetrySnapshot();
      if (snapshot.tables.length > 0) {
        tableMetrics.push(...snapshot.tables);
      }
    }
    const avgHandDurationMs =
      tableMetrics.length > 0
        ? Math.round(
            tableMetrics.reduce((s, t) => s + t.avgHandDurationMs, 0) / tableMetrics.length
          )
        : 0;
    const avgHandsPerHour =
      tableMetrics.length > 0
        ? Math.round(tableMetrics.reduce((s, t) => s + t.handsPerHour, 0) / tableMetrics.length)
        : 0;
    // Bible V8 §9.1: Aggregate action performance metrics
    let totalActionProcessingMs = 0;
    let actionCount = 0;
    let processingViolations = 0;
    let broadcastViolations = 0;
    for (const engine of this.tableEngines.values()) {
      // Performance summary is on the telemetry instance via engine
      const perf = engine.getPerformanceSummary();
      if (perf) {
        totalActionProcessingMs += perf.avgProcessingMs * perf.actionCount;
        actionCount += perf.actionCount;
        processingViolations += perf.processingViolations;
        broadcastViolations += perf.broadcastViolations;
      }
    }

    return {
      // ── Phase 5.1.4: spec-compliant top-level fields (master plan §8.1.4)
      //   status: 'ok' while the dealer loop is running, 'degraded' otherwise
      //   version: git SHA baked in at build time (GIT_COMMIT_SHA env var)
      //   uptime: seconds since process start
      //   activeTables: live count (also duplicated below for back-compat)
      // ── LIVENESS (2026-08-15) ────────────────────────────────────────────
      // `status` reflects only whether the process booted. A table freeze is
      // invisible to it, which is why the 2026-08-15 incident was reported by a
      // player rather than by monitoring. `liveness` is the hard signal: it goes
      // 'dead' only when the entire dealable fleet has out-stalled its
      // five-minute recovery chain, discovery itself has stopped, the leader
      // is barren behind a stale discovery result, or the independent database
      // verifier confirms that the fleet has stopped dealing.
      // The Docker HEALTHCHECK reads this field, so a wedged process restarts
      // itself with no human involved.
      /**
       * 'standby' is deliberately its own value, read by two different
       * consumers that need different answers:
       *
       *   Caddy  active health check expects 2xx; the handler returns 503 for a
       *          standby, so it is marked down and traffic goes to the leader.
       *   Docker healthcheck exits non-zero only on 'dead', so a standby is
       *          NOT restarted -- it must stay alive to be able to take over.
       */
      liveness: livenessVerdict.status,
      /**
       * Independent evidence, reported whether or not it has reached a
       * verdict, so a fleet going quiet is visible BEFORE anything restarts.
       * `handsInWindow: null` means the database could not be asked — which is
       * explicitly NOT counted as silence.
       */
      /**
       * Independent evidence, reported whether or not it has reached a verdict.
       * `belowFloorChecks` is the canary: the deal-rate check stands down on a
       * tiny fleet, so a failure that also empties the fleet would silence it —
       * losing the floor is its own alarm.
       */
      dealRate,
      /**
       * Time since discovery last SUCCEEDED. High means the database is
       * struggling; it is reported for visibility but no longer flips
       * liveness, because it cannot distinguish a slow database from a dead
       * engine. `discoveryLoopStalledMs` can.
       */
      discoveryLoopStalledMs,
      /**
       * True when this leader owns no tables and discovery has not succeeded
       * for ten minutes — the barren-leader verdict above. Surfaced so the
       * reason a container was restarted is readable after the fact.
       */
      barrenLeaderDead,
      /**
       * C20 adoption budget. At ENGINE_START_BUDGET_MAX the database is coping;
       * lower means engine starts have been failing and the loop has throttled
       * itself. Pinned at the floor across several polls is the signal that the
       * database tier, not the engine, is the constraint.
       */
      engineStartBudget: this.engineStartBudget,
      tournamentLease: tournamentLeaseDiagnostics(),
      leadership: leadershipDiagnostics(),
      stalledTableCount: stalledTables.length,
      // A retrying settlement can keep process liveness fresh forever. Publish
      // its continuous wait separately; one blockage must not withdraw routing
      // or restart every healthy table via the HTTP health probe.
      ...settlementHealthSnapshot(tableLiveness),
      /**
       * The numerator and denominator of the liveness verdict, published so
       * the verdict can be argued with from outside the process (2026-09-05).
       *
       * Before this, `poker_engine_liveness` went to 0 and there was no way to
       * ask WHY without shelling into the box: the answer turned out to be
       * "one table out of 312" on 136 of the 139 minutes it happened. A death
       * signal whose reason is not published is a death signal nobody can
       * audit, and this one was killing production five times a day.
       */
      deadStalledCount,
      dealableTableCount,
      wholeFleetStalled,
      // Horse Monte Carlo executes in the worker, so this canonical governor
      // must come from that core. Publishing the main-thread singleton here
      // made healthy isolation look like an idle horse solver even while its
      // FIFO was saturated.
      equityGovernor: liveHorseDecision.governor,
      // Still useful, but a different question: can the realtime table loop
      // service sockets, clocks, leases and state broadcasts without delay?
      mainEventLoopGovernor: equityGovernor.snapshot(),
      // The one process-wide FIFO that owns live HorseLogic state. Queue depth
      // and phase distinguish worker pressure/failure from main-loop pressure;
      // solver store counts prove the worker reached an authoritative READY.
      liveHorseDecision,
      // HTTP and WebSocket handlers are reachable before the leader boot has
      // finished. This is the exact admission gate they await before any table
      // lookup, lease claim or dealer construction is allowed to begin.
      dealerPrerequisitesReady: this.dealerPrerequisitesReady,
      // THE REST, MEASURED (Dan 2026-09-07): completion -> next deal, fleet-wide,
      // last ten minutes. `over` is the number that means the bookkeeping did
      // not fit inside the rest. See engine/NextHandGap.ts.
      nextHandGap: nextHandGap.snapshot(),
      // Deploy drain gate reads this. A restart voids in-flight hands, so a
      // routine server/ push waits (or is explicitly forced) while real people
      // are seated. Horses are excluded — they do not care.
      humansSeatedTotal: tableLiveness.reduce((n, t) => n + t.humans, 0),
      // HANDS, NOT PEOPLE (2026-08-27). humansSeatedTotal drove the deploy
      // drain gate and counted only humans, so a horse's hand could be voided
      // by a restart while a human's could not. This counts tables actually
      // mid-hand, whoever is sitting at them, and is what the gate reads now.
      handsInFlightTotal: tableLiveness.filter(
        (t) => t.dealable >= 2 && !t.paused && t.msSinceProgress < 120_000
      ).length,
      /**
       * THE RESTART GATE (Dan 2026-09-01).
       *
       * `maintenance.readyForRestart` is what auto-deploy-hetzner.yml waits
       * for now, in place of the old handsInFlightTotal drain. The difference
       * matters: the drain gate asked "is anybody mid-hand right now", which
       * is a moving target that a busy fleet never holds still for, and it
       * restarted on live tables the moment it timed out. This asks "has the
       * platform been formally stopped, told the players, and is there enough
       * break left to finish inside it" - a state the engine DECLARES rather
       * than a race the workflow observes.
       */
      maintenance: { ...this.maintenanceBreak.snapshot(), dbClockSkewMs: this.lastDbSkewMs },
      // The stats pipeline: index lag, trigger gaps, the money repair cursor
      // and the last witness audit. null until the first read completes.
      stats: this.statsHealth.publish(),
      // THE CLUSTER CONTROLLER'S LAST PASS (2026-09-05). On 2026-09-04 its
      // latch stalled for eleven minutes with no log line; the only witness
      // was cash_cluster_events read by hand. `lastPassAt` ageing while the
      // leader is up is that stall, visible from outside the process. null
      // on a standby: the controller runs on the leader only.
      cluster: this.clusterController.isRunning ? clusterMetrics.healthSnapshot() : null,
      // ONE RAKE SPEC (R7): both checksums and whether they last agreed.
      // Informational: a drift alerts, it never holds a table.
      rakeSpec: rakeSpecDriftState(),
      // Public liveness comes from the worker-owned store. The main thread no
      // longer hydrates a second solver artifact whose status could look healthy
      // while the live action path was empty or failed.
      solverPolicyArtifact: liveHorseDecision.solverPolicyArtifact,
      equityWorkerPool: equityWorkers,
      stalledTables: stalledTables.slice(0, 20),
      discoveryStaleMs,
      tableLiveness,
      status:
        this.running &&
        this.dealerPrerequisitesReady &&
        liveHorseDecision.phase === 'ready' &&
        equityWorkers.phase === 'ready'
          ? 'ok'
          : 'degraded',
      version: process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.ENGINE_VERSION || 'local',
      // ── PROCESS IDENTITY (2026-08-16) ───────────────────────────────
      // On 2026-08-16 two engine containers served this hostname at once and
      // every field below `version` was ambiguous between them: /health said 15
      // tables, / said 0, /metrics said 0, and the database said 91. There was
      // no way to tell whether that was one flapping process or several, which
      // is why the incident took an hour to characterise. `instanceId` is
      // regenerated on every boot, so two answers carrying different ids prove
      // two processes, immediately and without host access.
      instanceId: INSTANCE_ID,
      pid: process.pid,
      // Split-brain evidence: tables this instance was refused, and who holds
      // them. Empty is the healthy state.
      lease: leaseDiagnostics(),
      // Existing fields preserved — clients reading `running` / aggregate
      // metrics keep working without change.
      running: this.running,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      activeTables: this.tableEngines.size,
      activeTournaments: this.tournamentEngines.size,
      // Spin launches the atomic authority refused and the engine parked
      // (2026-09-10, tournament/spinLaunchParking.ts). Same numbers as the
      // poker_spin_launches_parked* gauges, plus the ids and reasons so the
      // operator reading /health can go straight to the row.
      spinLaunchParks: (() => {
        const m = spinLaunchParks.metrics(now);
        return {
          count: m.parked,
          terminal: m.terminal,
          oldestAgeMs: m.oldestAgeMs,
          parked: spinLaunchParks
            .snapshot(now)
            .slice(0, 20)
            .map((p) => ({
              tournamentId: p.tournamentId,
              reason: p.reason,
              kind: p.kind,
              strikes: p.strikes,
              parkedUntil: new Date(p.until).toISOString(),
              ageMs: now - p.since,
            })),
        };
      })(),
      totalHandsDealt: totalHands,
      telemetry: {
        avgHandDurationMs,
        avgHandsPerHour,
        tablesWithMetrics: tableMetrics.length,
      },
      // Bible V8 §9.1 Performance Instrumentation
      performance: {
        avgActionProcessingMs:
          actionCount > 0 ? Math.round(totalActionProcessingMs / actionCount) : 0,
        totalActionsRecorded: actionCount,
        processingThresholdViolations: processingViolations,
        broadcastThresholdViolations: broadcastViolations,
      },
    };
  }

  /**
   * Bible V8 §10.4: Aggregate Prometheus metrics from all table engines.
   * Returns Prometheus text exposition format for /metrics endpoint.
   */
  getPrometheusMetrics(): string {
    // ── ONE SERIES PER NAME (2026-09-07) ────────────────────────────────────
    // This used to call `engine.getPrometheusMetrics()` on every table engine
    // and concatenate, stripping only the `#` comments. Each engine's block
    // carries fourteen UNLABELLED global gauges, so a 272-table fleet emitted
    // 272 samples of `poker_active_tables` in a single scrape and Prometheus
    // kept exactly one of them: it answered 1 while 272 tables were dealing.
    // Every fleet-level alert rule was reading one arbitrary table. The full
    // measurement and the two alarms it broke are in the long note on
    // `EngineTelemetry.getPrometheusTableLines`.
    const allLines: string[] = [
      EngineTelemetry.renderFleetMetrics(
        (function* (engines) {
          for (const [, engine] of engines) yield engine.telemetry;
        })(this.tableEngines)
      ),
    ];
    // ── FREEZE OBSERVABILITY (2026-08-15) ────────────────────────────────
    // Before this, /metrics carried throughput (hands dealt, hands/hour) but
    // NOTHING that distinguishes a dealing table from a frozen one — and the
    // only alert that claimed to cover it, EngineDown, queried a job label
    // (`engine_pm2`) that does not exist in any scrape config, so it could
    // never fire. A table could sit dead for 18 minutes with every dashboard
    // green. These four gauges are what make a freeze alertable from outside
    // the process, independent of whether the engine can still report itself.
    const now = Date.now();
    const liveness = this.tableLivenessSnapshot();
    const livenessVerdict = evaluateEngineLiveness({
      isLeader: isLeader(),
      processUptimeMs: now - this.processStartedAt,
      discoveryLoopStalledMs: now - this.lastDiscoveryAttemptAt,
      discoveryStaleMs: now - this.lastDiscoveryOkAt,
      dbConfirmedDead: this.dealRateVerifier.snapshot().dbConfirmedDead,
      tables: liveness,
    });
    const stalled = liveness.filter(
      (t) => t.dealable >= 2 && !t.paused && t.msSinceProgress > 120_000
    );
    const pausedCount = liveness.filter((t) => t.paused).length;
    /**
     * 2026-09-05: the gauge below used `stalled.length === 0` — the 120s
     * VISIBILITY list — while getStatus() killed on the 300s list. Two
     * thresholds, one name, and the metric Prometheus alerted on was not the
     * one Docker acted on. Both now read the same rule, computed here from the
     * same snapshot: dead only when the WHOLE dealable fleet has out-stalled
     * the recovery chain. See the long note on `wholeFleetStalled` above.
     */
    const freeze: string[] = [
      ...settlementPrometheusLines(liveness),
      '# HELP poker_stalled_tables Tables with 2+ dealable seats, not paused by design, and no progress for 2 minutes',
      '# TYPE poker_stalled_tables gauge',
      `poker_stalled_tables ${stalled.length}`,
      '# HELP poker_dead_stalled_tables Tables that have out-stalled the whole per-table recovery chain (5 minutes)',
      '# TYPE poker_dead_stalled_tables gauge',
      `poker_dead_stalled_tables ${livenessVerdict.deadStalledCount}`,
      '# HELP poker_dealable_tables Tables with 2+ dealable seats and not paused by design - the denominator of the liveness verdict',
      '# TYPE poker_dealable_tables gauge',
      `poker_dealable_tables ${livenessVerdict.dealableTableCount}`,
      '# HELP poker_paused_tables Tables paused on purpose (hand-for-hand/break) - excluded from stall detection',
      '# TYPE poker_paused_tables gauge',
      `poker_paused_tables ${pausedCount}`,
      // The maintenance break, as numbers an alert rule can silence itself
      // with. `active` exists first and foremost so every fleet-level alarm
      // (deal rate, hands/min, fleet floor) can carry `unless
      // poker_maintenance_break_active == 1` instead of firing hourly about a
      // stop we scheduled on purpose.
      '# HELP poker_maintenance_break_active 1 while the scheduled :55 maintenance break is running',
      '# TYPE poker_maintenance_break_active gauge',
      `poker_maintenance_break_active ${this.maintenanceBreak.isActive() ? 1 : 0}`,
      '# HELP poker_maintenance_break_remaining_ms Milliseconds of break left; 0 outside a break',
      '# TYPE poker_maintenance_break_remaining_ms gauge',
      `poker_maintenance_break_remaining_ms ${this.maintenanceBreak.remainingMs()}`,
      '# HELP poker_maintenance_break_ready_for_restart 1 when every table is parked and the deploy may restart the engine',
      '# TYPE poker_maintenance_break_ready_for_restart gauge',
      `poker_maintenance_break_ready_for_restart ${this.maintenanceBreak.readyForRestart() ? 1 : 0}`,
      '# HELP poker_db_clock_skew_ms Engine clock minus database clock, ms; 0 when unmeasured',
      '# TYPE poker_db_clock_skew_ms gauge',
      `poker_db_clock_skew_ms ${this.lastDbSkewMs ?? 0}`,
      '# HELP poker_discovery_stale_ms Milliseconds since the cash-table discovery loop last completed',
      '# TYPE poker_discovery_stale_ms gauge',
      `poker_discovery_stale_ms ${now - this.lastDiscoveryOkAt}`,
      '# HELP poker_discovery_loop_stalled_ms Milliseconds since the discovery loop last RAN (not since it last succeeded)',
      '# TYPE poker_discovery_loop_stalled_ms gauge',
      `poker_discovery_loop_stalled_ms ${now - this.lastDiscoveryAttemptAt}`,
      '# HELP poker_engine_liveness 1 unless the shared health verdict marks the leader dead from fleet stall, discovery failure or independently confirmed deal-rate silence; standby remains 1',
      '# TYPE poker_engine_liveness gauge',
      // Must match getStatus(): a slow database is not a dead process, so this
      // keys on whether the loop RAN, not on whether its last answer was good.
      // Alerting on poker_discovery_stale_ms is still correct and still wired;
      // it just must not be what declares the engine dead.
      //
      // 2026-08-30: the ONE exception, mirroring `barrenLeaderDead` in
      // getStatus(). A loop that runs and fails forever keeps the RAN clock
      // fresh, so with zero tables adopted this gauge reported a healthy
      // engine through twenty minutes of a completely dark fleet. Owning no
      // tables makes the ok-clock safe to read here: there is no in-flight
      // hand for a restart to void, which is the only reason it was banned.
      // 2026-09-05: `stalled.length === 0` here meant ONE table out of 312
      // reported the whole engine dead — and Docker acted on it, five times on
      // the day this was measured, every one an unannounced restart outside
      // the §13 break. It reads the same fleet-wide rule as getStatus() now.
      `poker_engine_liveness ${livenessVerdict.prometheusValue}`,
      '# HELP poker_table_ms_since_progress Milliseconds since this table last made observable progress',
      '# TYPE poker_table_ms_since_progress gauge',
      ...liveness.map(
        (t) => `poker_table_ms_since_progress{table_id="${t.tableId}"} ${t.msSinceProgress}`
      ),
      '# HELP poker_table_dealable_seats Seats able to be dealt into on this table',
      '# TYPE poker_table_dealable_seats gauge',
      ...liveness.map((t) => `poker_table_dealable_seats{table_id="${t.tableId}"} ${t.dealable}`),
      // ── SPLIT-BRAIN (2026-08-16) ─────────────────────────────────
      // Every gauge above is per-process, so with two containers behind one
      // hostname Prometheus scrapes whichever the proxy picks and silently
      // averages two different realities. The instance label makes the series
      // distinct: two live `instance_id` values on this job IS the alert.
      '# HELP poker_engine_info Always 1. Labels identify the process answering this scrape.',
      '# TYPE poker_engine_info gauge',
      `poker_engine_info{instance_id="${INSTANCE_ID}",pid="${process.pid}",version="${
        process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.ENGINE_VERSION || 'local'
      }"} 1`,
      '# HELP poker_lease_conflicts Tables this instance was refused because another engine holds them',
      '# TYPE poker_lease_conflicts gauge',
      `poker_lease_conflicts ${leaseDiagnostics().conflictCount}`,
      // ── TOURNAMENT OBSERVABILITY (2026-08-31) ────────────────────────
      // Every gauge above this line is about TABLES. A tournament that never
      // started owns no table, so nothing above can see it — and that is the
      // single most player-visible tournament failure there is. These come
      // from the database because the database is the only thing that knows
      // what SHOULD exist. See services/TournamentMetrics.ts.
      // `owned` is the half the database cannot see and this process is the only
      // thing that knows: how many of those RUNNING events actually have a
      // manager here. Leadership and boot state are passed for the same reason -
      // a standby owns nothing legitimately, and a rule reading these series
      // from outside cannot tell that apart from an outage.
      ...this.tournamentMetrics.toPrometheus({
        owned: this.tournamentEngines.size,
        isLeader: isLeader(),
        stillBooting: livenessVerdict.stillBooting,
      }),
      // ── SPIN OBSERVABILITY (2026-08-31) ──────────────────────────────
      // The tournament gauges above count events. These test the one
      // EQUALITY the Spin format is sold on, and watch the punctuality of
      // the wheel that sells it. See services/SpinMetrics.ts.
      ...this.spinMetrics.toPrometheus(),
      // ── PARKED SPIN LAUNCHES (2026-09-10) ────────────────────────────
      // A Spin whose draw the atomic authority refused for a terminal
      // reason is parked instead of retried every second
      // (tournament/spinLaunchParking.ts). Three paid seats are waiting on
      // every one of these, so the count and the age of the oldest are on
      // the scrape: an operator sees a parked Spin without reading logs.
      ...(() => {
        const parks = spinLaunchParks.metrics(now);
        return [
          '# HELP poker_spin_launches_parked Spin launches inside a park window right now because fn_spin_draw_and_settle_atomic refused the draw; each one holds three paid seats',
          '# TYPE poker_spin_launches_parked gauge',
          `poker_spin_launches_parked ${parks.parked}`,
          '# HELP poker_spin_launches_parked_terminal Of the parked launches, those refused for a reason only a data change can lift',
          '# TYPE poker_spin_launches_parked_terminal gauge',
          `poker_spin_launches_parked_terminal ${parks.terminal}`,
          '# HELP poker_spin_launch_park_oldest_age_ms Milliseconds since the longest-parked launch was first refused; 0 when nothing is parked',
          '# TYPE poker_spin_launch_park_oldest_age_ms gauge',
          `poker_spin_launch_park_oldest_age_ms ${parks.oldestAgeMs}`,
        ];
      })(),
      // ── SEAT-FIRST FILL PRE-CHECK (2026-09-10) ───────────────────────
      // How many fn_seat_horse_in_seat_first_game calls the fill loop made,
      // and how many the seat rows made unnecessary. That RPC takes the
      // platform-wide exclusive lock every hand settlement waits on, so a
      // skipped call is time off the hand path. Counted in the process because
      // three services drive the same top-up. See services/seatFirstPrecheckMetrics.ts.
      ...seatFirstPrecheckPrometheusLines(),
      // ── REPLICATION OBSERVABILITY (2026-09-04) ───────────────────────
      // How far behind the realtime replication slot is, in bytes, per slot.
      // See services/ReplicationMetrics.ts.
      ...this.replicationMetrics.toPrometheus(),
      // ── HAND PROJECTION WAKES (2026-09-10) ───────────────────────────
      // Which signal wakes the outbox drain. During the Realtime -> LISTEN
      // cutover, {source="listen"} must be >= {source="realtime"} and
      // listener_connected must read 1 before the table leaves the
      // publication. See services/supabase/handOutboxListener.ts.
      ...handProjectionWakesToPrometheus(),
      ...this.handOutboxListener.toPrometheus(),
      ...this.handOutboxMetrics.toPrometheus(),
      // ── IS ANYBODY ACTUALLY PLAYING? (2026-09-04) ────────────────────
      //
      // THE BLIND SPOT THESE FILL. On 2026-09-03 a cron revoked Dan's session
      // every 15 minutes and no human could hold a table socket for 22 hours.
      // Every alert stayed green, and all of them were telling the truth: the
      // engine dealt 5,700 hands per ten minutes, liveness was 1, no table was
      // stalled. The fleet is horse-heavy, so `poker_active_players` read 6-8
      // throughout - its normal value. Nothing distinguished "the fleet is
      // busy" from "the fleet is busy and not one human is in it".
      //
      // THESE ARE DIAGNOSTIC GAUGES, AND DELIBERATELY NOT ALERTS. Measured
      // before writing any rule: across 14 days only 15 distinct hours saw a
      // human take a seat, and multi-DAY gaps are ordinary. So "zero humans
      // seated" is this platform's NORMAL state, and an alert on it would page
      // almost continuously and be muted within a day - the failure mode that
      // makes a monitor worse than none. The alertable signal for this class is
      // a FAILED ATTEMPT, which does not depend on how many people are online:
      // one player retrying produces it. That is
      // `poker_ws_auth_refused_total` and EngineRefusingSessions, above.
      //
      // What these are for is the question every incident starts with - "is
      // anyone actually playing right now?" - answered on the dashboard in one
      // glance instead of by reading /health by hand, which is how the
      // 2026-09-03 outage was eventually found.
      //
      // Horses lose nothing here (CLAUDE.md 10.5). These do not change what a
      // horse gets; they measure whether the human-only path - sign in, hold a
      // socket, take a seat - still works, which is the one path a horse never
      // exercises.
      '# HELP poker_humans_seated Human (non-horse) players currently seated across the fleet',
      '# TYPE poker_humans_seated gauge',
      `poker_humans_seated ${liveness.reduce((n, t) => n + t.humans, 0)}`,
      '# HELP poker_tables_with_humans Tables with at least one human seated',
      '# TYPE poker_tables_with_humans gauge',
      `poker_tables_with_humans ${liveness.filter((t) => t.humans > 0).length}`,
      // Deliberately NOT a "human hands dealt" counter. That would need new
      // monotonic state surviving table churn, and the question it answers -
      // "is the table this human is at actually dealing?" - is already
      // answered by poker_table_ms_since_progress above, per table, with no
      // state at all. HumansSeatedButNotDealt joins the two.
      '# HELP poker_human_tables_ms_since_progress_max Worst time-since-progress among tables with a human seated',
      '# TYPE poker_human_tables_ms_since_progress_max gauge',
      `poker_human_tables_ms_since_progress_max ${liveness
        .filter((t) => t.humans > 0)
        .reduce((m, t) => Math.max(m, t.msSinceProgress), 0)}`,
      // ── AUTH REFUSALS (2026-09-04) ───────────────────────────────────
      // Every socket Dan opened was refused for 22 hours and nothing paged,
      // because a refused upgrade was not a number anywhere. Now it is.
      // See transport/wsHelpers.ts and EngineRefusingSessions in
      // infra/monitoring/alert-rules.yml.
      ...wsAuthRefusalPrometheusLines(),
      ...wsProtocolRefusalPrometheusLines(),
      ...wsTrustLimitPrometheusLines(),
      // ── ACTION LATENCY, ALWAYS ON (Realtime programme Phase 1, 2026-09-04)
      // The number that defines how a table feels, scraped for the first
      // time. Two series (audience=human|horse), never per table. See
      // observability/engineInstruments.ts and ActionLatency* in
      // infra/monitoring/alert-rules.yml.
      // THE CORE, READ AT SCRAPE TIME (2026-09-06). The governor's own
      // one-second timer keeps these fresh; this only copies the current
      // reading onto the gauges the scrape renders, so /metrics can never
      // show a number older than the last sample.
      ...(() => {
        const main = equityGovernor.snapshot();
        const worker = liveHorseDecisionWorkerStatus();
        const equityWorkers = equityWorkerPoolStatus();
        const workerGovernor = worker.governor;

        // Existing event-loop series retain their realtime-main-thread
        // meaning. The explicitly named companion series makes that ownership
        // impossible to confuse with the worker core.
        eventLoopDelayP50.set(Number.isFinite(main.p50Ms) ? main.p50Ms : 0);
        eventLoopDelayP99.set(Number.isFinite(main.p99Ms) ? main.p99Ms : 0);
        mainEventLoopGovernorScale.set(Number.isFinite(main.scale) ? main.scale : 1);
        mainEventLoopGovernorSamplerLateMs.set(
          Number.isFinite(main.timerLateMs) ? main.timerLateMs : 0
        );

        // These are the authoritative HorseLogic/Monte Carlo readings. Never
        // substitute the main-thread module singleton when the worker has not
        // sampled yet: absence is represented by worker_ready=0, not a fake
        // healthy scale.
        horseDecisionWorkerReady.set(worker.phase === 'ready' ? 1 : 0);
        horseDecisionWorkerQueueDepth.set(worker.queueDepth);
        horseDecisionWorkerActiveJobAgeMs.set(worker.activeJobAgeMs ?? 0);
        horseDecisionWorkerOldestQueuedAgeMs.set(worker.oldestQueuedAgeMs ?? 0);
        horseDecisionWorkerLastCompletionAgeMs.set(
          worker.lastCompletedAt === null ? -1 : Math.max(0, Date.now() - worker.lastCompletedAt)
        );
        horseDecisionWorkerLastComputeMs.set(worker.lastComputeMs ?? 0);
        horseDecisionWorkerEventLoopDelayP50.set(
          workerGovernor && Number.isFinite(workerGovernor.p50Ms) ? workerGovernor.p50Ms : 0
        );
        horseDecisionWorkerEventLoopDelayP99.set(
          workerGovernor && Number.isFinite(workerGovernor.p99Ms) ? workerGovernor.p99Ms : 0
        );
        equityGovernorScale.set(
          workerGovernor && Number.isFinite(workerGovernor.scale) ? workerGovernor.scale : 0
        );
        equityGovernorSamplerLateMs.set(
          workerGovernor && Number.isFinite(workerGovernor.timerLateMs)
            ? workerGovernor.timerLateMs
            : 0
        );
        equityWorkerPoolReady.set(equityWorkers.phase === 'ready' ? 1 : 0);
        equityWorkerPoolConfiguredWorkers.set(equityWorkers.configuredWorkers);
        equityWorkerPoolReadyWorkers.set(equityWorkers.readyWorkers);
        equityWorkerPoolBusyWorkers.set(equityWorkers.busyWorkers);
        equityWorkerPoolQueueDepth.set(equityWorkers.queueDepth);
        equityWorkerPoolOldestQueuedAgeMs.set(equityWorkers.oldestQueuedAgeMs);
        equityWorkerPoolLastCompletionAgeMs.set(equityWorkers.lastCompletionAgeMs ?? -1);
        return [];
      })(),
      ...alwaysOnPrometheusLines(),
      // ── WHAT THE PLAYER'S BROWSER SAW (Phase 2, 2026-09-05) ──────────
      // The client-side twin of poker_ws_auth_refused_total: that counts
      // sockets the server refused, these count sockets the client lost.
      // Per-user counting happens in the module; only bounded numbers reach
      // Prometheus. See observability/ClientConnectionEvents.ts.
      ...clientConnectionPrometheusLines(),
    ];

    // ── STATS PIPELINE (2026-09-04) ─────────────────────────────────────
    // Fleet-independent, so it rides with the freeze block: an empty fleet
    // still has a hand index that can fall behind.
    freeze.push(...this.statsHealth.prometheusLines());

    if (allLines.length === 0) {
      // Still emit freeze metrics: "no engines at all" is itself the loudest
      // possible signal, and returning a bare comment hid it.
      return freeze.join('\n') + '\n';
    }
    return allLines.join('\n') + '\n' + freeze.join('\n') + '\n';
  }

  /** Per-table liveness, shared by /health and /metrics. */
  /**
   * ═══ DRAIN: FINISH THE HANDS, THEN GO ═══
   *
   * Dan 2026-08-27: "TABLES ARE DESIGNED TO BE USED BY EVERYONE, EVERY HORSE
   * OR HUMAN PLAYER NEEDS TO BE TREATED 100% EXACTLY THE SAME."
   *
   * Restarting the engine mid-hand voids that hand. The only thing that ever
   * protected against it was the deploy workflow's drain gate, and that gate
   * counted HUMANS — it waited for humans to leave the table, and let a
   * horse's hand be voided without a second thought. Two things were wrong
   * with it:
   *
   *   1. It protected people rather than hands, which is the exclusion Dan
   *      banned. A hand in flight is a hand in flight.
   *   2. It waited for the wrong event. Waiting for a table to EMPTY can take
   *      forever (and with horses seated it never happens), so the gate would
   *      defer a deploy for hours and then give up and restart anyway — under
   *      seated players. Waiting for the current HAND to end takes about a
   *      minute and protects everyone.
   *
   * So the engine now drains itself, on EVERY restart path — deploy,
   * healthcheck kill, supervisor bounce — instead of relying on one CI job to
   * ask nicely first. pauseAfterHand() is the same mechanism synchronized
   * breaks and hand-for-hand already use: the table finishes the hand it is
   * playing and parks at the boundary.
   *
   * Bounded by design. A table stuck mid-hand must not hold the process open,
   * so this returns when the budget expires and the caller proceeds to stop()
   * regardless — a bounded wait that saves most hands beats an unbounded one
   * that risks SIGKILL mid-flush.
   */
  async drainHands(
    maxWaitMs = 8000
  ): Promise<{ drained: number; total: number; timedOut: boolean }> {
    const engines = [...this.tableEngines.values()];
    const total = engines.length;
    if (total === 0) return { drained: 0, total: 0, timedOut: false };

    for (const engine of engines) {
      try {
        engine.pauseAfterHand();
      } catch {
        /* a table that refuses to pause must not stop the others draining */
      }
    }

    const deadline = Date.now() + Math.max(maxWaitMs, 0);
    const atBoundary = (e: (typeof engines)[number]): boolean => {
      try {
        /* A STOPPED ENGINE IS NOT A DRAINED ONE WHILE ITS MONEY IS STILL
           MOVING. The stopped-engine shortcut below stood alone until
           2026-09-06, so the
           moment the dealing loop exited the table counted as parked - even
           with postHandTasks (settlement, rake record, hand history) still
           writing. The drain then reported "N/N parked", the process exited,
           and whatever had not been written was not written. At :55 every
           hour. */
        if (e.hasSettlementInFlight()) return false;
        return e.isWaitingForHandForHand() || e.isPausedByDesign() || !e.isRunning();
      } catch {
        return true; // unreadable: do not let it hold the drain open
      }
    };

    let drained = engines.filter(atBoundary).length;
    while (drained < total && Date.now() < deadline) {
      await this.sleep(250);
      drained = engines.filter(atBoundary).length;
    }

    const timedOut = drained < total;
    console.log(
      `[GameServer] Drain: ${drained}/${total} table(s) parked at a hand boundary` +
        (timedOut ? ' - budget expired, stopping anyway' : '')
    );
    return { drained, total, timedOut };
  }

  private tableLivenessSnapshot() {
    const tournamentDescriptorByTableId = new Map<
      string,
      { gameFormat: 'mtt' | 'spin' | 'sng'; clubId: string | null }
    >();
    for (const manager of this.tournamentEngines.values()) {
      const gameFormat = manager.getPublicLiveTableFormat();
      if (!gameFormat) continue;
      const clubId = manager.getPublicLiveTableClubId();
      for (const tableId of manager.getTableIds()) {
        tournamentDescriptorByTableId.set(tableId, { gameFormat, clubId });
      }
    }

    return [...this.tableEngines].map(([id, engine]) => {
      const tournament = tournamentDescriptorByTableId.get(id);
      return {
        tableId: id,
        // Public category and club scope only. The manager's row and lease
        // generation never enter /health; null makes an incomplete tournament
        // admission visible instead of guessing and letting the certificate
        // select a table its isolated account cannot observe.
        gameFormat: tournament?.gameFormat ?? (engine.isTournament() ? null : 'cash'),
        clubId: tournament?.clubId ?? null,
        seated: engine.seatedCount(),
        dealable: engine.dealableCount(),
        humans: engine.humansSeated(),
        handCount: engine.getHandCount(),
        msSinceProgress: engine.msSinceProgress(),
        settlementAgeMs: engine.settlementAgeMs(),
        // 2026-08-22: where the dealing loop actually is, e.g. `load_seats+96s`.
        // /health could say a table had made no progress for 96 seconds but not
        // what it was doing for those 96 seconds, so a fleet-wide stall showed up
        // as ninety identical unexplained numbers. This is the missing half.
        loopPhase: engine.describeLoopPhase(),
        paused: engine.isPausedByDesign(),
        isTournament: engine.isTournament(),
      };
    });
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // SYNCHRONIZED BREAKS — All MTTs/XMTTs pause at the top of every hour
  // ═════════════════════════════════════════════════════════════════════════════

  private scheduleSynchronizedBreaks(): void {
    /**
     * Dan 2026-08-19: "BREAKS START AT THE 55 MINUTE MARK OF EVERY HOUR AND
     * LAST FOR 5 MINUTES." So the break window is :55 → :00, and play resumes
     * exactly on the hour. This previously fired at the TOP of the hour
     * (:00 → :05), which put the break at the wrong end of the hour.
     *
     * Verified broken on production before this change: with two MTTs running
     * and a stable engine, MTT hands ran straight through 04:00 (03:59=17,
     * 04:00=12, 04:01=1, 04:02=10) — and through 01:00, 02:00 and 03:00 too.
     */
    const now = new Date();
    const nextBreak = new Date(now);
    // The shared hourly boundary uses UTC, including repeated DST hours.
    nextBreak.setUTCMinutes(GameServer.BREAK_START_MINUTE, 0, 0);
    // Already past :55 this hour — go to :55 of the next hour.
    if (nextBreak.getTime() <= now.getTime()) {
      nextBreak.setUTCHours(nextBreak.getUTCHours() + 1);
    }
    const msUntilNextBreak = nextBreak.getTime() - now.getTime();

    console.log(
      `[GameServer] Synchronized break scheduled in ${Math.round(msUntilNextBreak / 60000)} minutes (:${GameServer.BREAK_START_MINUTE} of the hour, ${GameServer.BREAK_DURATION_MS / 60000} min long)`
    );

    /**
     * BREAKS STAY ON :55, THEY DO NOT DRIFT OFF IT (2026-08-23).
     *
     * This used to fire once at :55 and then hand the cadence to
     * `setInterval(..., 60 * 60 * 1000)`. A setInterval is not a clock: it
     * measures an hour from the moment the previous tick was DISPATCHED, and a
     * tick the event loop could not run on time is simply late — the lateness
     * is never given back. Every long GC pause, every synchronous Supabase
     * burst, every second the loop spent settling a hand pushed the next break
     * further past :55 than the last one, permanently, and the error
     * accumulated for as long as the process stayed up. On a box that had been
     * up for days the "synchronized" break was landing well off the mark for
     * every tournament at once — which is the whole complaint, because :55 is
     * the entire point of the rule.
     *
     * The break is a WALL-CLOCK event, so it is re-armed against the wall
     * clock after every firing: the next :55 is recomputed from Date.now()
     * each time. Drift cannot accumulate because nothing is measured relative
     * to the previous tick, and it self-corrects across a system clock change,
     * which an interval cannot do.
     *
     * triggerSynchronizedBreak is deliberately not awaited — it runs for the
     * length of the break (last-hand wait, then five minutes) and the next
     * arming must not wait on it.
     */
    this.breakTimer = setTimeout(() => {
      if (!this.running) return;
      this.launchServerLifecycleJob(
        this.triggerSynchronizedBreak(),
        'GameServer.synchronized_break_failed'
      );
      // Re-arm from the wall clock, never from this moment.
      this.scheduleSynchronizedBreaks();
    }, msUntilNextBreak);
  }

  /**
   * A5: every 5 minutes, re-drive any fee the engine could not bank, then check
   * the two BBJ ledgers against each other.
   *
   * Both underlying operations are idempotent — `atomic_distribute_rake` is
   * hand-gated and `bbj_record_contribution` is keyed per (table, hand) — so a
   * cycle that overlaps a queue entry which has since succeeded resolves it as a
   * no-op rather than double-banking. `running` is re-checked inside the tick so
   * a shutdown mid-cycle cannot start new work.
   */
  private startFeeReconciler(): void {
    const FEE_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
    // Only alarm on drift once an hour; the reconciler runs 12x more often than
    // that and a standing drift would otherwise page twelve times per hour.
    const DRIFT_EVERY_N_CYCLES = 12;
    let cycle = 0;

    const tick = async () => {
      if (!this.running) return;
      // THE FREEZE (Dan 2026-09-01): re-driving failed fees is chip movement.
      // Every operation here is idempotent and durable-queued, so a skipped
      // cycle is picked up whole by the next one, five minutes after the thaw
      // at the latest.
      if (isMaintenanceFrozen()) return;
      try {
        const summary = await reconcilePendingFees();
        if (summary.scanned > 0) {
          console.log(
            `[FeeReconciler] scanned ${summary.scanned}, resolved ${summary.resolved}, ` +
              `still failing ${summary.stillFailing}, exhausted ${summary.exhausted}`
          );
        }
      } catch (err) {
        reportError(err, 'GameServer.fee_reconcile_failed');
      }
      if (cycle % DRIFT_EVERY_N_CYCLES === 0) {
        try {
          // SELF-HEAL 2026-08-18: repair BEFORE auditing, so the audit reports
          // what is still broken rather than what was already fixable. The
          // repair backdates recovered rows to the original hand time, so a
          // successful repair drives the drift measurement to zero in the same
          // cycle instead of alarming on money that is now banked.
          const healed = await repairUnbankedBBJFees(48);
          if (healed.repaired > 0) {
            console.log(
              `[BBJ self-heal] recovered ${healed.repaired} unbanked contribution(s), ` +
                `${healed.chips.toFixed(2)} chips`
            );
          }
          await auditBBJDrift(1);
          // Weighted contributed rake (Dan 2026-08-29): invariant 4/9 watchdog
          // — every WEIGHTED_CONTRIBUTED hand's per-player rake_attributions
          // must sum exactly to the rake collected. Files a critical
          // financial_alert per drift window; never silently repairs.
          await auditRakeAttributionDrift(24);
          // Satellite conservation (2026-08-30 audit): every completed
          // satellite must have paid its winners (seat or cash, never
          // neither) and disbursed no more than max(pool, awardable seats).
          // Files a critical financial_alert per violating event.
          await auditSatelliteConservation(24);
          // Prize disbursement (2026-08-31): a completed event must not have
          // paid out more than its pool plus any acknowledged overlay. This
          // reads wallet_transactions, NOT tournament_players.prize — the
          // Sunday $200 double payment (18,201.60) was invisible to every
          // other check precisely because the outage reset overwrote that
          // snapshot while the wallet ledger kept the truth.
          await auditPrizeDisbursement(24);
          // One shortfall, one payment (2026-09-02): the check above says an
          // event over-paid; this one says WHY, by naming the obligation that
          // two different repair paths both settled. Their idempotency keys
          // are namespaced by the repairer rather than by the debt, so the
          // unique index cannot see them as the same payment.
          await auditDoublePaidObligations(24);
          // Guarantee kept (2026-08-31, phase 6): a COMPLETED event that
          // advertised a guaranteed prize must actually have PAID it. Nothing
          // in this estate asked that question - every other guarantee check
          // is pre-start affordability, or excludes freerolls via
          // `buy_in_amount > 0`, or (the phase 2 unpaid detector) filters
          // `prize_pool > 0`, the exact column an unfunded guarantee zeroes.
          // Nine freerolls ranked a full field, crowned a winner and paid
          // nobody, silently. Detects only; the finish path does the funding.
          await auditGuaranteesKept(24);
          // Historical pre-atomic fees (2026-08-31): a process death between
          // the old independent hand and fee writes could leave no durable fee
          // claim. Measured: 20 cash hands / 72.30 chips in 24h, clustered at
          // restarts. This sweep files those historical rows into the durable
          // database queue; accepted hands now commit both records atomically.
          // 6 hours, not 48: MEASURED 2026-08-31, the 48h scan takes 12.9s and
          // PostgREST cancels at ~8s, so the very first production run of this
          // sweep died with 57014 and it had never healed anything. The SQL now
          // carries its own 120s ceiling AND this window matches the cadence —
          // at a 5-minute cycle a 6-hour window gives an orphaned hand ~72
          // chances to be caught, for an eighth of the rows (3.3s measured).
          // Pass 48 explicitly for a catch-up after an outage.
          await requeueUnbankedCashRake(6, 10, 200);
        } catch (err) {
          reportError(err, 'GameServer.bbj_drift_audit_failed');
        }
      }
      cycle++;
    };

    this.launchServerLifecycleJob(tick(), 'GameServer.fee_reconcile_tick_failed');
    this.feeReconcileTimer = setInterval(() => {
      this.launchServerLifecycleJob(tick(), 'GameServer.fee_reconcile_tick_failed');
    }, FEE_RECONCILE_INTERVAL_MS);
    console.log('[GameServer] Fee reconciler started (5-min cycle, hourly BBJ drift audit)');
  }

  /**
   * Delete lease rows nobody has renewed for an hour.
   *
   * BEST-EFFORT BY CONSTRUCTION. Housekeeping must never be the reason a boot
   * fails or a sweep stops, so every failure path here is a warn and a return.
   *
   * The cutoff is the server's, not ours: reap_dead_engine_leases refuses
   * anything under ten minutes, so a caller cannot delete the leases of a
   * briefly-stalled engine out from under it by passing a small number.
   */
  private async reapDeadLeases(): Promise<void> {
    try {
      const { data, error } = await supabase.rpc('reap_dead_engine_leases', {
        p_stale_seconds: LEASE_REAP_STALE_SECONDS,
      });
      if (error) {
        console.warn(`[GameServer] lease reap skipped: ${error.message}`);
        return;
      }
      const row = (Array.isArray(data) ? data[0] : data) as
        | { table_leases_deleted?: number; tournament_leases_deleted?: number }
        | undefined;
      const tables = row?.table_leases_deleted ?? 0;
      const tourneys = row?.tournament_leases_deleted ?? 0;
      if (tables > 0 || tourneys > 0) {
        console.log(
          `[GameServer] Reaped dead leases: ${tables} table, ${tourneys} tournament (unrenewed for ${LEASE_REAP_STALE_SECONDS}s)`
        );
      }
    } catch (err) {
      console.warn('[GameServer] lease reap threw:', (err as Error)?.message);
    }
  }

  /** Hourly reaper. Paired with the boot-time sweep, not a replacement for it. */
  /**
   * Measure engine-vs-database clock skew: one fn_db_now round trip, halved
   * RTT subtracted as the classic NTP-style estimate. Every 30 minutes and at
   * boot; published on /health (maintenance.dbClockSkewMs) and as
   * poker_db_clock_skew_ms. Past 5 seconds it raises a warning alert - that
   * is drift an order of magnitude beyond healthy NTP and one more order
   * short of breaking the freeze, which is exactly when a human should hear
   * about it. Failure to measure is not skew: the reading goes stale and
   * says so, it never guesses.
   */
  private startClockSkewMonitor(): void {
    if (this.clockSkewTimer) return;
    const measure = async () => {
      if (!this.running) return;
      try {
        const t0 = Date.now();
        const { data, error } = await supabase.rpc('fn_db_now');
        const t1 = Date.now();
        if (error) throw new Error(error.message);
        const dbMs = Date.parse(data as string);
        if (!Number.isFinite(dbMs)) throw new Error('unparseable fn_db_now: ' + String(data));
        // Engine clock at the midpoint of the round trip vs the DB's stamp.
        this.lastDbSkewMs = Math.round((t0 + t1) / 2 - dbMs);
        if (Math.abs(this.lastDbSkewMs) > 5000) {
          await raiseEngineAlert({
            alertname: 'ClubArenaClockSkew',
            severity: 'warning',
            component: 'club-arena-engine',
            summary: `Engine clock is ${this.lastDbSkewMs}ms from the database clock`,
            description:
              'The maintenance freeze compares engine-written deadlines against the ' +
              'database clock, and the break overlay counts down on a third. Past a few ' +
              'seconds of drift, players get PLATFORM_FROZEN refusals after play visibly ' +
              'resumes. Check NTP on the Hetzner host.',
            labels: { skew_ms: String(this.lastDbSkewMs) },
          });
        } else {
          await resolveEngineAlert(
            'ClubArenaClockSkew',
            'club-arena-engine',
            'Clock skew back within bounds'
          );
        }
      } catch (err) {
        console.warn('[GameServer] clock skew measurement failed:', (err as Error)?.message);
      }
    };
    this.launchServerLifecycleJob(measure(), 'GameServer.clock_skew_measurement_failed');
    this.clockSkewTimer = setInterval(
      () => this.launchServerLifecycleJob(measure(), 'GameServer.clock_skew_measurement_failed'),
      30 * 60 * 1000
    );
    this.clockSkewTimer.unref?.();
  }

  private startLeaseReaper(): void {
    if (this.leaseReapTimer) return;
    this.leaseReapTimer = setInterval(() => {
      this.launchServerLifecycleJob(this.reapDeadLeases(), 'GameServer.lease_reap_failed');
    }, LEASE_REAP_INTERVAL_MS);
    console.log('[GameServer] Lease reaper started (hourly)');
  }

  /**
   * Rebuild `bomb_pot_award_units` rows that settlement lost.
   *
   * WHY THIS EXISTS. The award-unit write in ServerTableEngineSettlement is
   * fire-and-forget by design — the ledger narrates money `logHandHistory` has
   * already recorded, so it must never be able to fail a hand. It retries three
   * times and then reports. What it never had was anything that came back for
   * the row afterwards, so a blip that outlasted the third attempt left a
   * PERMANENT hole: `fn_bomb_pot_ledger_gaps` filed it as critical, roughly 17
   * a day, and the only way to close one was a human running a backfill.
   *
   * A retry that gives up is not durability; the sweep is the other half of it.
   *
   * `fn_backfill_bomb_pot_award_units` does the arithmetic — the engine's own
   * pot/board/rake decomposition reproduced from columns already stored on the
   * hand, never card evaluation — and deliberately rebuilds SINGLE-WINNER
   * hands only. Multi-winner bomb hands stay missing and stay visible in the
   * gap report, because `hand_history.winners` is merged per user and does not
   * record which board each winner took. An incomplete ledger that says so
   * beats a complete-looking one that is partly fiction.
   *
   * Best-effort by construction, like every other sweep here: `running` is
   * re-checked inside the tick, and every failure path reports and returns so
   * housekeeping can never be the reason the platform stops dealing.
   */
  private startBombLedgerRepairSweep(): void {
    if (this.bombLedgerRepairTimer) return;

    const tick = async (): Promise<void> => {
      if (!this.running) return;
      // THE FREEZE (Dan 2026-09-01): the backfill writes award units - chip
      // accounting. Hourly cadence; the break costs it nothing.
      if (isMaintenanceFrozen()) return;
      try {
        const { data, error } = await supabase.rpc('fn_backfill_bomb_pot_award_units', {
          p_limit: BOMB_LEDGER_REPAIR_BATCH,
          p_dry_run: false,
        });
        if (error) {
          reportError(error, 'GameServer.bomb_ledger_repair_failed');
          return;
        }
        const row = (Array.isArray(data) ? data[0] : data) as
          | { hands_written?: number; units_written?: number; hands_skipped?: number }
          | undefined;
        const hands = Number(row?.hands_written ?? 0);
        if (hands > 0) {
          console.log(
            `[BombLedgerRepair] rebuilt ${Number(row?.units_written ?? 0)} award unit(s) ` +
              `across ${hands} hand(s); ${Number(row?.hands_skipped ?? 0)} left for the gap report`
          );
        }
      } catch (err) {
        reportError(err, 'GameServer.bomb_ledger_repair_threw');
      }
    };

    this.launchServerLifecycleJob(tick(), 'GameServer.bomb_ledger_repair_tick_failed');
    this.bombLedgerRepairTimer = setInterval(() => {
      this.launchServerLifecycleJob(tick(), 'GameServer.bomb_ledger_repair_tick_failed');
    }, BOMB_LEDGER_REPAIR_INTERVAL_MS);
    console.log('[GameServer] Bomb-pot award ledger repair sweep started (hourly)');
  }

  private async triggerSynchronizedBreak(): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.directAdmissionIsCurrent(generation)) return;

    /**
     * EVERY FORMAT, NOT JUST THE MTTs (Dan 2026-08-27).
     *
     * This used to be gated on a multi-table-format predicate whose entire
     * purpose is to return false for Spins and Sit-n-Gos — which is also how
     * Heads-Up is stored (variant 'sng', max_players 2). So the whole Spin
     * board and the whole Heads-Up board dealt through every break. Dan:
     * "EVERY MTT, SPIN AND HEADS UP... THEY SHOULD START AT THE :55 OF THE
     * HOUR EVERY HOUR."
     *
     * takesSynchronizedBreaks() is now the single gate, and the only opt-out
     * it honours is the explicit per-tournament `synchronized_breaks` column
     * (2026-08-22 parity) — never the format.
     */
    const breakEngines: TournamentManager[] = [];
    for (const tm of this.tournamentEngines.values()) {
      if (tm.isRunning() && tm.takesSynchronizedBreaks()) {
        breakEngines.push(tm);
      }
    }

    if (breakEngines.length === 0) {
      console.log('[GameServer] Synchronized break: no running tournaments to pause');
      return;
    }

    /**
     * Dan 2026-08-19: "AT THE 55 OF THE HOUR, THE LAST HAND IS DEALT FOR ALL
     * TOURNAMENT TABLES, ONCE THE LAST HAND ON EVERY TABLE IS COMPLETED, THE 5
     * MINUTE BREAK STARTS... SO IT CAN BE UP TO LIKE A 6 MINUTE BREAK."
     *
     * So this is two phases, not one:
     *   :55             announce the LAST HAND on every table
     *   last hand ends  START the five minutes
     *
     * The previous version started the five-minute timer at :55, which quietly
     * shortened every break by however long the final hand ran — a slow all-in
     * with runouts could eat most of it. The countdown now begins only once
     * every table across every tournament is parked between hands.
     */
    console.log(
      `[GameServer] ═══ LAST HAND ═══ Announcing final hand on ${breakEngines.length} tournament(s) (MTT / Spin / Heads-Up) - break starts when every table finishes`
    );

    /**
     * The break window opens NOW, at :55, not when the countdown starts. A
     * tournament that begins during the last-hand wait must be held too, so
     * claim the window immediately using the worst case (grace + break) and
     * tighten it below once the real countdown begins.
     */
    this.breakEndsAt =
      Date.now() + TournamentManager.LAST_HAND_GRACE_MS + GameServer.BREAK_DURATION_MS;

    for (const tm of breakEngines) {
      try {
        await tm.pauseForBreak(GameServer.BREAK_DURATION_MS);
      } catch (err: any) {
        reportError(err, 'GameServer.Failed_to_pause_tournament');
      }
      if (!this.directAdmissionIsCurrent(generation)) {
        this.breakEndsAt = 0;
        return;
      }
    }

    const waitStartedAt = Date.now();
    const allParked = await this.waitForAllTablesParked(breakEngines);
    const lastHandMs = Date.now() - waitStartedAt;
    if (!this.directAdmissionIsCurrent(generation)) {
      this.breakEndsAt = 0;
      return;
    }

    if (allParked) {
      console.log(
        `[GameServer] Last hand complete on every table after ${Math.round(lastHandMs / 1000)}s - starting the ${GameServer.BREAK_DURATION_MS / 60000} minute break`
      );
    } else {
      console.warn(
        `[GameServer] Last hand did not land on every table within ${Math.round(lastHandMs / 1000)}s - starting the break anyway so play resumes near the hour`
      );
    }

    // The countdown players see begins NOW, not at :55. Tighten the window
    // claimed above to the real end time, so a tournament starting during the
    // break is held for exactly as long as everyone else.
    this.breakEndsAt = Date.now() + GameServer.BREAK_DURATION_MS;

    for (const tm of breakEngines) {
      try {
        await tm.beginBreakCountdown(GameServer.BREAK_DURATION_MS);
      } catch (err: any) {
        reportError(err, 'GameServer.Failed_to_begin_break_countdown');
      }
      if (!this.directAdmissionIsCurrent(generation)) {
        this.breakEndsAt = 0;
        return;
      }
    }

    // Never leave two resume timers pending. If a previous break's last-hand
    // wait overran far enough to overlap this one, the older timer would still
    // fire and resume tournaments a second time — harmless for the engines
    // (resumeFromBreak no-ops when !onBreak) but it would clear on_break in
    // the database out from under a live break, showing players a break that
    // the lobby says has already ended.
    if (this.breakResumeTimer) {
      clearTimeout(this.breakResumeTimer);
      this.breakResumeTimer = null;
    }
    this.breakResumeTimer = setTimeout(() => {
      this.breakResumeTimer = null;
      this.launchServerLifecycleJob(
        this.resumeSynchronizedBreak(breakEngines, generation),
        'GameServer.synchronized_break_resume_failed'
      );
    }, GameServer.BREAK_DURATION_MS);
    this.breakResumeTimer.unref?.();
  }

  private async resumeSynchronizedBreak(
    breakEngines: TournamentManager[],
    generation: number
  ): Promise<void> {
    if (!this.directAdmissionIsCurrent(generation)) return;
    // Close the window FIRST. Anything starting from here on is not in a
    // break and must not be held.
    this.breakEndsAt = 0;
    console.log(`[GameServer] ═══ BREAK ENDED ═══ Resuming ${breakEngines.length} tournament(s)`);
    // Resume everything on break, not just the :55 snapshot - a tournament
    // that started during the break was held by holdIfBreakIsRunning and is
    // not in breakEngines. resumeFromBreak no-ops on anything not on break.
    const toResume = new Set<TournamentManager>(breakEngines);
    for (const tm of this.tournamentEngines.values()) toResume.add(tm);
    for (const tm of toResume) {
      if (!this.directAdmissionIsCurrent(generation)) return;
      try {
        await tm.resumeFromBreak();
      } catch (err: any) {
        reportError(err, 'GameServer.Failed_to_resume_tournament');
      }
    }
  }

  /**
   * How much of the platform-wide break is left, or 0 when none is running.
   * See the `breakEndsAt` field for why a tournament starting mid-break needs
   * to know this.
   */
  remainingBreakMs(): number {
    return this.breakEndsAt > 0 ? Math.max(0, this.breakEndsAt - Date.now()) : 0;
  }

  /**
   * Hold a tournament that has just started inside a live break, for whatever
   * is left of it. Without this it deals its opening levels alone while every
   * other event on the platform sits on the break screen.
   *
   * The resume is driven by the shared breakResumeTimer above, which now walks
   * every registered engine rather than the :55 snapshot, so nothing needs to
   * be scheduled here.
   */
  private async holdIfBreakIsRunning(tm: TournamentManager): Promise<void> {
    const remaining = this.remainingBreakMs();
    if (remaining <= 1000) return;
    // Same single gate as triggerSynchronizedBreak — a Spin or Heads-Up that
    // fills at :57 must sit on the break screen with everyone else, not open
    // its first level alone.
    if (!tm.isRunning() || !tm.takesSynchronizedBreaks()) return;
    try {
      console.log(
        `[GameServer] Tournament started during the break - holding it for the remaining ${Math.round(remaining / 1000)}s`
      );
      await tm.pauseForBreak(remaining);
      await tm.beginBreakCountdown(remaining);
    } catch (err: any) {
      reportError(err, 'GameServer.hold_new_tournament_for_break');
    }
  }

  /**
   * Poll until every table of every supplied tournament has finished the hand
   * that was in flight, or until the grace window expires.
   *
   * Returns true if everyone parked, false if the grace window won. A wedged
   * table must never hold the whole platform's break open — play resuming near
   * the hour matters more than one stuck table.
   */
  private async waitForAllTablesParked(managers: TournamentManager[]): Promise<boolean> {
    const deadline = Date.now() + TournamentManager.LAST_HAND_GRACE_MS;
    while (Date.now() < deadline) {
      if (!this.running) return false;
      if (managers.every((tm) => tm.areAllTablesParked())) return true;
      await this.sleep(500);
    }
    return managers.every((tm) => tm.areAllTablesParked());
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // STALE DATA CLEANUP — Run on startup
  // ═════════════════════════════════════════════════════════════════════════════

  private async cleanupStaleData(protectedTableId: string = ''): Promise<void> {
    console.log('[GameServer] Cleaning up stale data from previous runs...');
    if (protectedTableId) {
      console.log(
        `[GameServer] E2E test mode - table ${protectedTableId.slice(0, 8)} is PROTECTED from cleanup.`
      );
    }
    try {
      // 1. Batch-reset ALL stuck horses to available (fast single query)
      //    Any horse not at an active table will get re-seated by HorseFleetManager
      await supabase
        .from('profiles')
        .update({ horse_status: 'available', updated_at: new Date().toISOString() })
        .eq('is_horse', true)
        .neq('horse_status', 'available');
      console.log('[GameServer] Reset stuck horses to available');

      // 2. HORSES KEEP THEIR SEATS ACROSS A RESTART (Dan 2026-09-02, BINDING;
      //    CLAUDE.md 10.5 "horses are players").
      //
      //    This used to be "SAFE CLEANUP": cash out and vacate every HORSE seat
      //    at every cash table on every boot. It was written on 2026-08-18 to
      //    stop the sweep removing HUMANS mid-session, by exempting humans only
      //    - nine days before the horses-are-players law, and never revisited.
      //    Measured on the 20:55 break of 2026-09-02, the first restart on the
      //    fixed build: "Cashed out and vacated 383 seat(s) before cleanup
      //    (78,575.13 chips returned to club wallets)" at 20:58:03, across 223
      //    cash tables, every one a horse, and then the fleet re-seeded fresh
      //    horses into the holes. Dan watched every horse leave the table
      //    during the break and be snap-replaced after it. That is the
      //    opposite of "everything just freezes, then picks back up exactly as
      //    it was".
      //
      //    Nothing needs the sweep. A seat row IS the persisted state: the
      //    engine rebuilds every table from table_seats on boot (the very
      //    reason a human's seat was declared safe), and the fleet seeds only
      //    genuinely empty seats and refuses "Player already seated". A horse
      //    mid-hand at restart is resumed by crash recovery like any other
      //    seat. Genuinely orphaned seats - horse or human - still fall to
      //    HorseLifecycleManager's guarded 4-hour sweep.
      //
      //    Pinned by seatExitMoneyPaths.test.ts: the boot path must not cash
      //    out or vacate ANY seat, and must not tell horses apart from humans.

      // 3. FIX 202: Reset cash tables based on horse fleet mode.
      // E2E test mode (protectedTableId) ALWAYS closes everything-but-test
      // and skips the bots-resume path entirely so nothing else lights up.
      const disableHorsesOnCleanup = process.env.DISABLE_HORSE_FLEET === 'true';
      if (protectedTableId) {
        // Close every cash table EXCEPT the protected test table. The test
        // table's status is left untouched so its current state survives the
        // restart and the engine picks it up again immediately.
        await supabase
          .from('tables')
          .update({ current_players: 0, status: 'closed' })
          .is('tournament_id', null)
          .neq('id', protectedTableId)
          .in('status', ['waiting', 'running']);
        console.log(
          `[GameServer] E2E mode: closed all cash tables except ${protectedTableId.slice(0, 8)}`
        );
      } else if (disableHorsesOnCleanup) {
        // When horse fleet is disabled, CLOSE all old running/waiting tables
        // (they were horse-populated and shouldn't be resurrected).
        // Only manually-created tables with the right status will be picked up by discovery.
        await supabase
          .from('tables')
          .update({ current_players: 0, status: 'closed' })
          .is('tournament_id', null)
          .in('status', ['running']);
        console.log('[GameServer] Closed all running cash tables (horse fleet disabled)');
      } else {
        // Normal mode: reset to waiting so HorseFleetManager can re-populate.
        //
        // 2026-08-19: this used to include 'closed' in the status filter, so
        // every boot resurrected every closed cash table. Two things were
        // wrong with that:
        //
        //   1. A club admin closing a table (fn_admin_close_table) found it
        //      open again after the next deploy, with no record of why.
        //   2. Nothing could ever retire a cash table. 487 duplicate rows had
        //      accumulated from the ensureAllTablesExist bug (f73df9b2a), and
        //      closing them would have lasted exactly until the next restart.
        //
        // CLOSED IS A DECISION, NOT A STATE TO CLEAN UP. The fleet still
        // reopens the tables it owns: ensureAllTablesExist reactivates the
        // canonical row for each config when it finds it closed. What it will
        // not do any more is reopen 487 rows nobody asked for.
        await supabase
          .from('tables')
          .update({ current_players: 0, status: 'waiting' })
          .is('tournament_id', null)
          .in('status', ['waiting', 'running']);
        console.log(
          '[GameServer] Reset cash table player counts and statuses to waiting (closed tables left closed)'
        );
      }

      /**
       * 3b. Prune dead lease rows.
       *
       * `claim_table_lease` upserts on a unique id, so the tables never hold
       * more than one row per table/tournament — but nothing ever DELETES a row
       * whose table is long gone. `release_*` only runs on a graceful shutdown,
       * and a container that dies hard leaves its rows behind for good. Live
       * count when this was written: 2,054 rows, 1,348 of them untouched for
       * over a day, and growing.
       *
       * It is not a correctness problem — a lease stale by more than 30 SECONDS
       * is already ignored by every claim — but it is unbounded growth on a
       * table read on every discovery sweep, and this release adds a second one
       * exactly like it. Leaving a known leak while adding another would be
       * sloppy.
       *
       * Seven days is deliberately absurd next to a 30-second staleness window:
       * nothing this old can possibly be a live lease, so the delete cannot
       * race a running engine. Best-effort — housekeeping must never be the
       * reason a boot fails.
       */
      // 2026-08-29: SEVEN DAYS AT BOOT COULD NOT KEEP UP. Deploys land many
      // times a day and each hard-killed container abandons a full set of rows,
      // so the tables grew faster than a weekly cutoff shed them. Measured this
      // morning: 263 live table leases against 1,987 dead, and 39 live
      // tournament leases against 3,015 dead — 95% garbage on a table read on
      // every discovery sweep. The reaper now runs on a timer as well (see
      // startLeaseReaper) and the cutoff is an hour, which is still 120x the
      // 30-second staleness window and so cannot race a live engine.
      await this.reapDeadLeases();

      // 4. Cancel stale REGISTERING/ANNOUNCED tournaments whose start time is
      //    well past — with REFUNDS.
      // SWEEP #4 P1-2 FIX (2026-07-23): this previously (a) keyed on created_at,
      //    so a tournament created in the afternoon for an evening start was
      //    cancelled on any restart hours before it should even begin, and
      //    (b) issued NO refunds — every registered player's buy-in was
      //    swallowed. Now key on start_time (genuinely past-due) and refund each
      //    registered player buy_in_amount + buy_in_fee before cancelling.
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const { data: stalePreStart } = await supabase
        .from('tournaments')
        .select('id, name, buy_in_amount, buy_in_fee')
        .in('status', ['ANNOUNCED', 'REGISTERING'])
        .lt('start_time', oneHourAgo);
      /**
       * Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
       *
       * This sweep used to refund and CANCEL every REGISTERING/ANNOUNCED
       * tournament whose start time was more than an hour past — the boot-time
       * twin of the 30-minute auto-cancel in discoverTournaments(). Both
       * existed to tidy up games that never filled. Neither is acceptable in a
       * poker room: a player who registered and paid a buy-in is owed a game,
       * not a refund and an apology.
       *
       * Past-due tournaments are now left exactly where they are. The discovery
       * loop tops them up with horses and starts them, which is the same
       * outcome a real room reaches by having a dealer sit the game.
       */
      if ((stalePreStart?.length || 0) > 0) {
        console.log(
          `[GameServer] ${stalePreStart!.length} past-due REGISTERING/ANNOUNCED tournament(s) found - leaving them for the fill-and-start path (never cancelled)`
        );
      }

      // 5. Running SNG/Spin tournaments — NEVER cancelled on restart.
      //
      // Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
      //
      // This sweep used to cancel EVERY running SNG/Spin on boot, on the
      // premise that they "can't survive a server restart". That premise was
      // false: discoverTournaments() finds RUNNING tournaments with no engine
      // and calls TournamentManager.resume(), which rebuilds an engine per
      // surviving table, restores the blind level and resumes the level clock
      // mid-level. resume() now also REBUILDS the tables when none survived,
      // so there is no longer any state a restart cannot recover from.
      //
      // Because the engine redeploys on every push touching server/**, this
      // sweep fired constantly and destroyed live games. Dan registered for a
      // 9-max SNG that filled 9/9, started 03:14:13 and was cancelled at
      // 03:14:28 — alive for FIFTEEN SECONDS with its table open and all nine
      // seats occupied. The sweep is gone; the resume path owns this case.
      {
        const { count: runningSngSpins } = await supabase
          .from('tournaments')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'RUNNING');
        if ((runningSngSpins || 0) > 0) {
          console.log(
            `[GameServer] ${runningSngSpins} running tournament(s) preserved across restart — the resume path will rebuild them`
          );
        }
      }

      // Run slow background sweeps asynchronously so they don't block the
      // server boot sequence, but retain their ownership promise so shutdown
      // cannot release leadership while one is still changing shared rows.
      const cleanupGeneration = this.lifecycleGeneration;
      this.launchServerLifecycleJob(
        Promise.resolve().then(async () => {
          if (!this.directAdmissionIsCurrent(cleanupGeneration)) return;
          try {
            // 6. Cancel stale RUNNING MTT tournaments (BUG 019 FIX 2026-04-15):
            //    Prior threshold was 2 hours which killed every legitimate MTT - deep-stack
            //    tournaments routinely run 6+ hours. 133 MTTs were nuked before this fix.
            //    New policy:
            //      - bump threshold to 12 hours (truly crashed servers would mean tournaments
            //        stalled much longer than that)
            //      - set ended_at = NOW() so audit trail is preserved (was NULL before)
            //      - only target tournaments where last_activity is also stale
            //      - DO NOT touch MTTs that have recent hand_history activity (they're live)
            //    A separate scheduled cleanup should refund affected players; that's handled
            //    by TournamentManager.cancelTournament via normal refund path. This startup
            //    sweep is strictly a safety-net for server crashes and should rarely fire.
            const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
            const recentActivityCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            // Find stale RUNNING tournaments with no recent hand activity
            /**
             * TWELVE HOURS OF PLAYING, NOT TWELVE HOURS OF EXISTING
             * (2026-09-06). This asked `created_at`, which for a scheduled or
             * recurring event is when the ROW was written, not when the cards
             * went in the air. Measured on production the day this was fixed:
             * 94 RUNNING tournaments, 5 of them "stale" by `created_at` and
             * ZERO by `started_at` - all five created on 09-03 as scheduled
             * rows, started this morning, at level 4 and level 10 of 40, and
             * dealing 100+ hands an hour while this sweep sized them up for
             * settlement every time the engine booted.
             *
             * Only the hand-activity check below stood between five healthy
             * games (21-28 players, 405 to 600 in prize pools) and being
             * ranked by chipstack and paid out. One quiet hour - a stall, a
             * long break, a slow Postgres - and the wrong axis becomes an
             * outage. `started_at` is the question this sweep is actually
             * asking; `created_at` remains the fallback for a row that somehow
             * never recorded one.
             */
            const { data: staleTourneys, error: staleTourneysError } = await supabase
              .from('tournaments')
              // payout_structure / variant / tournament_type / spin_multiplier
              // joined the list on 2026-09-06: the sweep now asks the SAME
              // structural question the recovery will ask before it claims the
              // row. See the guard below.
              .select(
                'id, name, started_at, created_at, payout_structure, variant, tournament_type, spin_multiplier, prize_pool'
              )
              .eq('status', 'RUNNING')
              .or(
                `started_at.lt.${twelveHoursAgo},and(started_at.is.null,created_at.lt.${twelveHoursAgo})`
              );
            if (staleTourneysError) {
              reportError(
                new Error(
                  `[GameServer] Stale-tournament sweep could not list RUNNING tournaments: ${staleTourneysError.message}`
                ),
                'GameServer.stale_tournament_list_failed'
              );
            }
            const staleTournamentCandidates = staleTourneysError ? [] : staleTourneys || [];
            for (const t of staleTournamentCandidates) {
              const { data: recentHands, error } = await supabase
                .from('hand_history')
                .select('id')
                .eq('tournament_id', t.id)
                .gte('created_at', recentActivityCutoff)
                .limit(1);

              if (error) {
                console.log(
                  `[GameServer] Skipping cancel of tournament ${t.id.slice(0, 8)} - error checking activity, assuming active.`
                );
                continue;
              }

              if (recentHands && recentHands.length > 0) {
                console.log(
                  `[GameServer] Skipping cancel of tournament ${t.id.slice(0, 8)} - found recent hands in last hour (still active)`
                );
                continue;
              }
              /**
               * Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
               *
               * This was the last cancel write on the server. A tournament wedged for
               * over 12 hours with no hands is genuinely stuck, but voiding it is
               * still the wrong ending: the players earned their chip positions. A
               * real room settles the game and pays the places out.
               *
               * So instead of CANCELLED, this now walks it through the normal
               * finish: flip to COMPLETING (CAS-guarded so a live engine that is
               * mid-finish always wins the race) and hand it to
               * recoverStuckCompletingTournaments, which ranks the remaining players
               * by chip count, assigns the top positions, pays the payout structure
               * and flips to COMPLETED. Money reaches the players who earned it and
               * the game shows a real result instead of vanishing.
               */
              /**
               * A SWEEP NEVER MAKES A ROW THE RECOVERY WILL REFUSE (2026-09-06).
               *
               * `recoverStuckCompletingTournaments` asks `fieldIsStillLive`
               * before it pays anything, and refuses a field with more players
               * left than the structure has places - correctly, since ranking a
               * live tournament by chipstack once paid an entire 20,880 pool to
               * nine of ninety players (see recoveryFieldGuard.ts).
               *
               * The sweep did not ask. It flipped the row to COMPLETING anyway
               * and handed it over, and the recovery then refused it - leaving
               * the event in a state NOTHING can finish: the discovery loop
               * resumes RUNNING tournaments only, so a COMPLETING row is
               * invisible to the one path that could have played it out. The
               * sweep took a stalled game that a manager could still adopt and
               * made it permanently stuck.
               *
               * PLO4 Heads-Up 25 (3e281f5c) was in exactly that state for three
               * days with two players still holding chips, and had to be settled
               * by hand on 2026-09-06 (migration 20260906153943).
               *
               * So ask first, with the same numbers and the same pure guard. A
               * field the recovery would refuse is LEFT RUNNING - the state it
               * can still be rescued from - and reported. `count: 'exact'` on
               * both reads, and an unreadable count skips the row rather than
               * guessing: a sweep that cannot tell must not act (10.86).
               */
              const [{ count: liveCount, error: liveErr }, { count: fieldCount, error: fieldErr }] =
                await Promise.all([
                  supabase
                    .from('tournament_players')
                    .select('id', { count: 'exact', head: true })
                    .eq('tournament_id', t.id)
                    .eq('status', 'playing'),
                  supabase
                    .from('tournament_players')
                    .select('id', { count: 'exact', head: true })
                    .eq('tournament_id', t.id),
                ]);
              if (liveErr || fieldErr || typeof liveCount !== 'number') {
                console.log(
                  `[GameServer] Skipping settlement of tournament ${t.id.slice(0, 8)} - could not read its field (${liveErr?.message ?? fieldErr?.message ?? 'no count'}); left RUNNING.`
                );
                continue;
              }
              const sweepPayouts =
                resolvePayoutStructure(
                  t as never,
                  typeof fieldCount === 'number' && fieldCount >= 1 ? fieldCount : undefined
                ) ?? [];
              if (fieldIsStillLive({ livePlayers: liveCount, paidPlaces: sweepPayouts.length })) {
                reportError(
                  new Error(
                    `[GameServer] ${t.name} (${t.id.slice(0, 8)}) has been RUNNING over 12h with no hand in the last hour, but ${liveCount} player(s) are still in it against ${sweepPayouts.length} paid place(s) - the recovery would refuse to settle that, and a COMPLETING row cannot be resumed by anything. LEFT RUNNING so a manager can adopt and play it out; it needs an operator if it does not deal.`
                  ),
                  'GameServer.stale_sweep_left_live_field_running'
                );
                continue;
              }

              // Silence is not a terminal result. Completion is now committed
              // only through fn_complete_tournament_terminal, which derives the
              // canonical survivor and stores the complete settlement receipt in
              // one transaction. Leave this contest RUNNING so normal lease-backed
              // discovery can resume its manager; never rank a live field by a
              // timeout and never manufacture a COMPLETING recovery row.
              reportError(
                new Error(
                  `[GameServer] ${t.name} (${t.id.slice(0, 8)}) has no recent hand after 12h; left RUNNING for lease-backed manager resumption because inactivity is not finish evidence.`
                ),
                'GameServer.stale_tournament_left_for_resume'
              );
            }
            if (!staleTourneysError) {
              console.log(
                `[GameServer] Stale-tournament sweep complete (${staleTourneys?.length || 0} reviewed)`
              );
            }

            // 7. Recover stuck COMPLETING tournaments (crashed during finishTournament flow)
            // TOURNEY-AUDIT 2026-07-24 [CRITICAL]: the old path blind-flipped
            // COMPLETING → COMPLETED. A crash between the COMPLETING claim and the
            // winner credit meant the winner (and any unpaid ITM places) were NEVER
            // paid - the tournament just "completed" with stranded 'playing' rows
            // (verified live: a COMPLETED bounty MTT with 8 players still 'playing'
            // and $60 of a $100 guaranteed pool never paid). Recovery now PAYS what
            // is owed (positions by chip count, prizes per normalized payout
            // structure) before completing.
            await recoverStuckCompletingTournaments('startup-cleanup');

            // Terminal table and seat closeout is now owned by the atomic
            // settlement/cancellation transaction. Migration 20260909014545
            // closes the exact historical backlog once under the same write
            // barrier, records every affected id, and arms the permanent
            // seat-exit guard. Process startup never repairs this state.
          } catch (bgErr) {
            reportError(bgErr, 'GameServer.background_stale_cleanup_error');
          }
        }),
        'GameServer.background_stale_cleanup_job_failed'
      );
    } catch (err) {
      reportError(err, 'GameServer.Stale_data_cleanup_error');
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // CASH TABLE DISCOVERY — Every 5 seconds, find tables needing engines
  // ═════════════════════════════════════════════════════════════════════════════

  private async discoverCashTables(): Promise<void> {
    const generation = this.lifecycleGeneration;
    while (this.directAdmissionIsCurrent(generation)) {
      /**
       * C20 FIX-UP (2026-08-24): the sweep verdict must be reached on EVERY
       * exit path, so it is captured here and applied in a finally.
       *
       * Shipped first with the verdict as an ordinary statement near the end
       * of the try. That is only reached when the sweep runs to completion,
       * and the sweep contains heartbeatTables(), claimTableLease() and the whole
       * adoption loop before it - any of which can throw when the database is
       * struggling, which is exactly when this control loop matters. Meanwhile
       * the discovery-RPC error path still halved the budget. So distress
       * lowered the budget and a throw denied it the clean sweep needed to
       * climb back: the budget ratcheted to the floor and stayed there.
       *
       * Observed in production at 6f994dce with budget pinned at 6 and only
       * 16 tables adopted after 472s, while Engine_start_failed was 0 - the
       * budget was starving adoption on its own, with nothing failing.
       *
       * A finally cannot be skipped by a throw, a continue or a return.
       */
      const failuresSinceLastSweep = this.engineStartFailures;
      this.engineStartFailures = 0;
      let sweepDistressed = failuresSinceLastSweep > 0;
      try {
        // Proof the loop is EXECUTING, independent of what the database says.
        this.lastDiscoveryAttemptAt = Date.now();
        // C17 FIX (2026-08-08): ONE grouped query, not an N+1.
        //
        // This used to read every waiting/running cash table and then issue a
        // separate count(*) on table_seats FOR EACH ONE. With 500-1,000 tables
        // that is 500-1,000 serial round trips every 5 seconds — and the worst
        // case is immediately after a restart, when no table has an engine yet
        // so every single one gets counted, at exactly the moment the database
        // is already absorbing the reconnect storm.
        //
        // cash_tables_with_players() does the GROUP BY ... HAVING server-side
        // (PostgREST cannot express it) and returns only tables that already
        // meet the threshold, which is the only thing the loop below cared about.
        //
        // 2026-08-22: `cash_tables_needing_engine` is `cash_tables_with_players`
        // plus "...OR at least one seated player". Below two occupants no engine
        // existed, so the FIRST person to sit at an empty table got WS close
        // 4404 from the engine transport and sat on "connecting" until somebody
        // else arrived — there was nothing to connect TO. The engine is what
        // publishes the idle snapshot (stage 'waiting', seats, stacks), so its
        // mere existence is the difference between a real table and an eternal
        // spinner.
        //
        // HORSES ARE PLAYERS (Dan 2026-08-27). This comment used to end "A
        // table of horses alone still does not get one." That was an exclusion
        // stated outright: a lone human was given a dealer and a lone horse was
        // denied one. Any occupied table gets an engine now — see CLAUDE.md
        // section 10.5, which forbids this class of rule entirely.
        //
        // It returns `human_count` so the two ideas below can stay separate:
        // "needs an engine" is NOT "should be dealing". See seatedCounts.
        const { data: ready, error } = await supabase.rpc('cash_tables_needing_engine', {
          p_min: 2,
        });

        // Discovery liveness stamp. If this stops advancing, no engine can be
        // started and no zombie can be reaped — a platform-wide freeze that
        // nothing else would notice. Surfaced as `discoveryStaleMs` on /health.
        if (!error) this.lastDiscoveryOkAt = Date.now();

        if (error) {
          const errMsg =
            error?.message || (typeof error === 'object' ? JSON.stringify(error) : String(error));
          reportError(new Error(errMsg), 'GameServer.Cash_table_discovery_error');
          /**
           * C20: the one cheap indexed read that drives discovery is failing,
           * so adopting a full budget the moment it recovers is the worst
           * possible next move. The finally below applies the retreat - this
           * only records that the sweep was distressed.
           */
          sweepDistressed = true;
          await this.sleep(TABLE_DISCOVERY_INTERVAL);
          continue;
        }

        /* Lease authority is renewed and loss-fenced by the dedicated primary
           lifecycle started in performStart. Discovery deliberately performs
           no ownership heartbeat: its heavier adoption/reaper work can consume
           a full database timeout without delaying the next proof pass. */

        /**
         * C19 FIX (2026-08-20): stagger the starts.
         *
         * After a restart NO table has an engine, so this loop used to construct
         * and start every one of them inside a single tick: hundreds of engines
         * each immediately loading seats, reading table config and arming timers,
         * against a database simultaneously absorbing the reconnect storm. It
         * also synchronised every table's hand cadence, so from then on they all
         * dealt, settled and wrote snapshots in lockstep — which is what turns
         * one table's all-in equity computation into a stall visible on all of
         * them.
         *
         * A few tens of milliseconds between starts costs nothing (this sweep
         * runs every 5s regardless) and spreads both the connection burst and
         * the steady-state cadence.
         */
        const ENGINE_START_STAGGER_MS = 40;
        let startedThisSweep = 0;
        const budgetThisSweep = this.engineStartBudget;
        for (const row of (ready || []) as Array<{
          table_id: string;
          player_count: number;
          human_count?: number;
        }>) {
          if (!this.directAdmissionIsCurrent(generation)) break;
          // C20: adoption budget spent. The remaining tables are picked up by
          // the next sweep in TABLE_DISCOVERY_INTERVAL - nothing is dropped, and
          // a table with no engine is by definition one nobody is dealing at.
          if (startedThisSweep >= budgetThisSweep) break;

          // Skip if already running
          if (this.tableEngines.has(row.table_id)) continue;

          if (startedThisSweep > 0) await this.sleep(ENGINE_START_STAGGER_MS);
          startedThisSweep++;

          console.log(
            `[GameServer] Starting engine for cash table ${row.table_id} ` +
              `(${row.player_count} seated, ${row.human_count ?? 0} human)` +
              (row.player_count < 2
                ? ' - lone seat, engine exists so the table is not a spinner'
                : '')
          );
          // Discovery and an arriving viewer now share ONE serialized
          // lookup/claim/publication primitive. The old duplicate path could
          // finish an awaited claim after shutdown and publish an engine that
          // was absent from stop()'s snapshot. This operation is lifecycle
          // fenced after every await and retains its own causal retry.
          this.launchDiscoveryJob(
            this.ensureCashTableEngineAdmission(row.table_id)
              .then((outcome) =>
                this.finishDirectTableAdmission(row.table_id, 'discovery_admission_failed', outcome)
              )
              .catch((error) => {
                this.scheduleDirectTableRecovery(row.table_id, 'discovery_admission_threw');
                throw error;
              }),
            'GameServer.discovery_table_admission_threw',
            { tableId: row.table_id }
          );
        }

        // C20: the verdict is applied in the finally below, so that a throw
        // anywhere above cannot deny the loop its recovery.

        // Clean up engines for tables that stopped — AND engines that are
        // lying about being alive.
        //
        // 2026-08-15: isRunning() only reflects a boolean the dealing loop
        // never clears when it dies, so a crashed engine stays in this map
        // forever and the `if (this.tableEngines.has(...)) continue;` guard
        // above then prevents discovery from ever rebuilding the table. Ten
        // production tables sat dead for 18+ minutes this way. Cross-check
        // against observable progress: if the discovery RPC still lists the
        // table as ready to deal but its engine has done nothing for three
        // minutes, its loop is gone — drop it so the next cycle rebuilds it.
        /**
         * DELIBERATELY NARROWER THAN THE SPAWN LIST (2026-08-22).
         *
         * This set feeds `shouldBeDealing` below, which is the ZOMBIE test: a
         * table that should be dealing and has made no progress for 180s gets
         * its engine killed. A table with one seated human makes no progress
         * BY DESIGN — you cannot deal to one player — so including it here
         * would kill and rebuild that engine every three minutes, which is the
         * fleet-wide kill loop of PR #281 re-created in a new place.
         *
         * So: two or more occupants is what "should be dealing" means, exactly
         * as before. A lone seat gets an engine and is left alone in it.
         *
         * 2026-08-27: "two or more" was still not the whole truth. The
         * ENGINE'S definition of enough is max(2, auto_start_players) —
         * minPlayersToDeal, which ServerTableEngineDealing's header warns
         * "the watchdog reads too so the two cannot disagree". This reaper
         * was the one reader that disagreed: a table with AutoStart 5 and
         * 2-4 seats makes no progress by design, and a hard-coded >= 2 here
         * called that a zombie and rebuilt its engine every 180s forever.
         * The COUNTS are kept so each engine can be measured against its own
         * threshold below.
         */
        const seatedCounts = new Map<string, number>(
          ((ready || []) as Array<{ table_id: string; player_count: number }>).map((r) => [
            r.table_id,
            Number(r.player_count) || 0,
          ])
        );
        for (const [id, engine] of this.tableEngines) {
          if (!engine.isRunning()) {
            /* TournamentManager owns its child's causal restart callback and
               map replacement. Discovery must never delete that slot. A cash
               generation instead joins the one teardown that stops it, proves
               exact lease release, compare-deletes, and only then readmits. */
            if (!this.tournamentOwnedTables.has(id)) {
              void this.recoverDirectTableEngine(
                id,
                engine,
                'not_running_generation_seen_by_discovery'
              ).catch((recoveryError) =>
                reportError(recoveryError, 'GameServer.not_running_engine_recovery_failed', {
                  tableId: id,
                })
              );
            }
            continue;
          }
          // 2026-08-15: the seat counts come from a cash-only RPC (its WHERE
          // clause includes `t.tournament_id IS NULL`). Gating the rebuild
          // on it meant TOURNAMENT tables had no freeze recovery at all: when
          // one died, the `!isRunning()` branch above deleted it and nothing
          // anywhere recreated it, so every seated player was frozen
          // permanently. Tournament tables are rebuilt by their own
          // TournamentManager sweep, so here we only need to stop treating a
          // cash-only list as the definition of "should be dealing".
          //
          // 2026-08-27: a cash table "should be dealing" when it has reached
          // ITS OWN deal threshold — dealThreshold() is minPlayersToDeal, the
          // same number the dealing loop and the turn watchdog use.
          const shouldBeDealing =
            (seatedCounts.get(id) ?? 0) >= engine.dealThreshold() ||
            this.tournamentOwnedTables.has(id);
          /**
           * Dan 2026-08-19: PAUSED IS NOT DEAD — the other half of the break fix.
           *
           * TournamentManagerBase.reviveDeadTableEngines was guarded against
           * breaks, but THIS reaper never was, and it uses the same 180s
           * threshold. A synchronized break parks every tournament table for
           * five minutes, so three minutes in, this loop called a perfectly
           * healthy paused table a zombie, stopped its engine and dropped it —
           * mid-break, while the manager's own sweep was correctly standing
           * down. The table only returned after the break when the manager
           * rebuilt it, discarding engine state for no reason.
           *
           * isPausedByDesign() is the same signal the turn watchdog already
           * trusts (ServerTableEngineTurns) and /health already reports; it was
           * simply never consulted here.
           */
          // ...but paused is not a licence to sit there forever. A pause that
          // outlives any legitimate one (break + last-hand grace, with room to
          // spare) is a wedged table, and MUST still be reaped — otherwise this
          // guard would trade "breaks get dismantled" for "a stuck table never
          // recovers", which is the worse bug.
          const pausedTooLong = engine.msPaused() > GameServer.MAX_HEALTHY_PAUSE_MS;
          const parkedOnPurpose = engine.isPausedByDesign() && !pausedTooLong;
          if (shouldBeDealing && !parkedOnPurpose && engine.msSinceProgress() > 180_000) {
            reportError(
              new Error(
                'Engine for ' +
                  id +
                  ' shows no progress for ' +
                  Math.round(engine.msSinceProgress() / 1000) +
                  's - rebuilding'
              ),
              'GameServer.zombie_engine_rebuilt'
            );
            if (this.tournamentOwnedTables.has(id)) {
              /* Synchronously stop mutation and notify the exact owning manager;
                 its identity-CAS replacement preserves the tournament lease. */
              engine.fenceForEngineLeaseLoss('tournament_table_zombie', true);
            } else {
              // Stop mutation before the first teardown await, then retain the
              // old map generation until its exact DB lease is released.
              engine.fenceForEngineLeaseLoss('cash_table_zombie', false);
              void this.recoverDirectTableEngine(id, engine, 'zombie_engine').catch(
                (recoveryError) =>
                  reportError(recoveryError, 'GameServer.zombie_engine_recovery_failed', {
                    tableId: id,
                  })
              );
            }
          }
        }
      } catch (err) {
        const errMsg =
          err instanceof Error
            ? err.message
            : (err as any)?.message ||
              (typeof err === 'object' ? JSON.stringify(err) : String(err));
        reportError(new Error(errMsg), 'GameServer.Cash_table_discovery_error');
        /**
         * A throw mid-sweep is a distress signal in its own right - it is what
         * a timeout inside heartbeatTables() or claimTableLease() looks like from
         * out here - and it must not be mistaken for a clean sweep.
         */
        sweepDistressed = true;
      } finally {
        /**
         * Exactly one verdict per sweep, on every path: clean, RPC error, or
         * throw. This is the whole reason the flag exists rather than the
         * adjust being called at each site.
         */
        this.adjustEngineStartBudget(sweepDistressed);
      }

      await this.sleep(TABLE_DISCOVERY_INTERVAL);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // TOURNAMENT DISCOVERY — Find and manage tournaments
  // ═════════════════════════════════════════════════════════════════════════════
  // NOTE for the C20 wiring guard in engineStartBudget.test.ts: it slices the
  // source from discoverCashTables to discoverTournaments, so nothing may sit
  // between those two methods. The seat-first helpers live AFTER
  // discoverTournaments for exactly that reason.

  private async discoverTournaments(): Promise<void> {
    const generation = this.lifecycleGeneration;
    while (this.directAdmissionIsCurrent(generation)) {
      try {
        // Find REGISTERING tournaments ready to start
        const registeringReadAt = Date.now();
        const { data: registering, error: registeringErr } = await supabase
          .from('tournaments')
          .select(
            'id, name, start_time, current_players, min_players, max_players, variant, tournament_type, buy_in_amount, buy_in_fee, guaranteed_prize, prize_pool'
          )
          .eq('status', 'REGISTERING');
        if (registeringErr) {
          /* An unreadable board is not an EMPTY board. Discarding this error
             let a failed read fall through as "nothing is registering", so
             every start, every ramp and every top-up on the platform stopped
             for as long as the failure lasted, and the logs said nothing at
             all. Skip the pass loudly and try again in five seconds. */
          reportError(
            new Error(`[GameServer] REGISTERING board read failed: ${registeringErr.message}`),
            'GameServer.registering_board_read_failed'
          );
          await this.sleep(TOURNAMENT_DISCOVERY_INTERVAL);
          continue;
        }

        /**
         * PAID SEATS FOR EVERY SEAT-FIRST GAME, IN TWO QUERIES (2026-08-23).
         *
         * A Spin starts when its seats are BOUGHT, so the start gate below has
         * to know the live seat count. Asking per tournament meant two round
         * trips each, and with ~33 Spins on the board and this loop running
         * every 5 seconds that is ~13 extra queries a second, forever, just to
         * decide that nothing has changed. Batched here instead: one read for
         * the live tables, one for their seats.
         */
        // SEAT-FIRST DEFINITION (2026-08-24 audit): spin, or a 2-seat SNG
        // (heads-up). This must match fn_take_seat_and_buy_in and
        // isSeatFirstFormat exactly. The old \`any sng\` reading made every
        // 3+ seat SNG a structural deadlock: the RPC refused its seat sales
        // (not_a_seat_first_game) while this gate waited for seats forever.
        const seatFirstRows = (registering || []).filter(
          (t) => t.variant === 'spin' || (t.variant === 'sng' && Number(t.max_players) <= 2)
        );
        const paidSeatsByTournament = await this.readSeatFirstPaidSeats(seatFirstRows);

        for (const tournament of registering || []) {
          if (!this.directAdmissionIsCurrent(generation)) break;
          if (this.tournamentEngines.has(tournament.id)) continue;
          // THE FREEZE IS TOTAL (Dan 2026-09-03): starting an event pre-seats its
          // field and topping it up buys horses in. Both are chip movement.
          // The event starts on the first pass after the thaw, exactly as a
          // human's buy-in would be accepted then and not before.
          if (isMaintenanceFrozen()) break;

          // Guard: skip tournaments with no start_time set
          if (!tournament.start_time) {
            console.warn(`[GameServer] Tournament ${tournament.name} has no start_time - skipping`);
            continue;
          }
          const startTime = new Date(tournament.start_time).getTime();
          if (isNaN(startTime)) {
            console.warn(
              `[GameServer] Tournament ${tournament.name} has invalid start_time - skipping`
            );
            continue;
          }
          const now = Date.now();
          const minPlayers = tournament.min_players || 3;

          /**
           * Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
           *
           * This used to cancel any tournament still short of min_players 30
           * minutes after its start time. That single branch was responsible
           * for essentially every cancellation on the platform: over two days,
           * 557 of 562 cancelled tournaments were short by exactly ONE player
           * (363 at 2/3, 138 at 5/6, 56 at 8/9). Horses are seeded at creation
           * leaving a seat for a human, and when no human took it the game was
           * deleted instead of dealt.
           *
           * A real poker room fills the seat. Past its start time and still
           * short, we top the field up with horses and let the normal start
           * logic fire on the next pass — the buy-in stays in play, the prize
           * pool stands, and the player who registered gets the game they paid
           * for. If the horse pool cannot deliver right now we simply try
           * again next pass; waiting is always better than destroying a game.
           */
          /**
           * ── MTT PRE-START HORSE RAMP (Dan 2026-08-23, standard practice) ──
           *
           * "HORSES NEED TO BE REGISTERING FOR MTT TOURNAMENTS UP TO AN HOUR
           *  BEFORE THE TOURNAMENT STARTS. PLAYERS DON'T JUMP IN AND PLAY
           *  TOURNAMENTS THAT HAVE NO PLAYERS IN THEM."
           *
           * This is the ONLY place the rule lives, deliberately. Seeding used
           * to be spread across creation time (recurring service), spawn time
           * (scheduled service) and past-start rescue (below), and an event
           * that missed all three - which a day-ahead scheduled MTT always did
           * - simply sat at 0 until its clock ran out. Putting the ramp in the
           * discovery loop means every REGISTERING tournament gets it, however
           * it was created, without each creator having to remember.
           *
           * The target curve and its safety properties are documented on
           * mttPrestartHorseTarget. The two that matter here: it never exceeds
           * max_players - 1, so it cannot trip the `maxReached` gate below and
           * start an event early; and it returns 0 for seat-first games, whose
           * rule is bought seats, not registrations.
           */
          const msUntilStart = startTime - now;
          if (msUntilStart > 0 && msUntilStart <= MTT_PRESTART_RAMP_MS) {
            const lastRamp = this.lastMttRampAt.get(tournament.id) ?? 0;
            if (now - lastRamp >= 45_000) {
              // The whole decision - window, curve, seat-first exclusion, pool
              // cap and per-tick step - is inside this pure function, so the
              // rule is tested without a database and this call site cannot
              // drift from it.
              const rampTarget = mttPrestartHorseTarget({
                msUntilStart,
                maxPlayers: tournament.max_players ?? 0,
                variant: String(tournament.variant ?? ''),
                currentPlayers: tournament.current_players ?? 0,
                /* A GUARANTEED event ramps to whatever covers it, not to the
                   default 24. These three columns were already being selected
                   here and simply not used. buy_in_amount is the PRIZE side:
                   the fee is rake and never reaches the pool. */
                guaranteedPrize: Number(tournament.guaranteed_prize) || 0,
                prizePool: Number((tournament as { prize_pool?: unknown }).prize_pool) || 0,
                buyInPrizeShare: Number(tournament.buy_in_amount) || 0,
              });
              if (rampTarget > 0) {
                this.lastMttRampAt.set(tournament.id, now);
                const rampAdded = await this.tournamentRecurring.topUpWithHorses(
                  tournament.id,
                  rampTarget
                );
                if (rampAdded > 0) {
                  console.log(
                    `[GameServer] Pre-start ramp: +${rampAdded} into "${tournament.name}" ` +
                      `(${tournament.current_players} -> target ${rampTarget}, ` +
                      `${Math.round(msUntilStart / 60000)}m to start)`
                  );
                }
              }
            }
          }

          const isPastStart = startTime <= now;
          if (isPastStart && tournament.current_players < minPlayers) {
            /**
             * Dan 2026-08-19: fill to a FULL FIELD, every format.
             *
             * "ALLOW HORSES TO FILL ALL SEATS FOR SIT N GO'S AND MTT AND SPINS"
             *
             * SNG/Spin only ever start when full, so max_players was always the
             * right target for them. MTTs used to be topped up to min_players
             * only — enough to start, but a 50-seat event running 6-handed.
             * They now aim for a full field too. topUpWithHorses can only seat
             * horses that are genuinely free (not in another tournament, not
             * sitting at an open table), so asking for max_players fills the
             * event as far as the pool allows and never starves cash games.
             */
            const target = tournament.max_players > 0 ? tournament.max_players : minPlayers;

            const added = await this.tournamentRecurring.topUpWithHorses(tournament.id, target);
            if (added > 0) {
              console.log(
                `[GameServer] Filled "${tournament.name}" with ${added} player(s) toward ${target} seats - running it instead of cancelling`
              );
            }
            // Re-evaluate on the next discovery pass with the refreshed count.
            continue;
          }

          // SNG / Spin: start ONLY when every seat is bought (not time-based)
          // MTT / Bounty / PKO / Mystery: start at scheduled time if min_players met
          // Seat-first = spin or heads-up (2-seat SNG). Must agree with
          // fn_take_seat_and_buy_in / isSeatFirstFormat — see 2026-08-24 audit.
          const isSngOrSpin =
            tournament.variant === 'spin' ||
            (tournament.variant === 'sng' && Number(tournament.max_players) <= 2);

          /**
           * PAID SEATS, NOT REGISTRATIONS (Dan 2026-08-23, verbatim: "spins can
           * never ever start until 3 players have sat down, and paid for there
           * seat, only then does the spin feature start.")
           *
           * `current_players` is the registration counter. It is incremented by
           * fn_register_for_tournament and never decremented when somebody
           * leaves or busts, so it drifts badly: the live lobby was carrying
           * spins reading 3/3 with two seats actually sold, and others reading
           * 0/3 with three sold. Starting a spin off that number deals a game
           * to seats nobody bought.
           *
           * A seat-first game's truth is the seat rows on its live table.
           * Count those. Registrations do not open the door — money in a seat
           * does.
           */
          const paidSeats = paidSeatsByTournament.get(tournament.id) ?? 0;
          const seatFirstReady =
            isSngOrSpin && tournament.max_players > 0 && paidSeats >= tournament.max_players;

          const maxReached =
            tournament.max_players > 0 && tournament.current_players >= tournament.max_players;
          /**
           * ONE MINUTE EARLY, ON PURPOSE — see TOURNAMENT_PRESEAT_LEAD_MS.
           *
           * The comparison used to be `startTime <= now`, which meant the field
           * was seated after the advertised start rather than before it. The
           * lead moves the SEATING, not the game: start() holds every table's
           * dealing and its level clock to `start_time`, so a player who opens
           * the lobby at T-60 finds a seat waiting and a TAKE SEAT button, and
           * the first card is still dealt at the time the lobby advertised.
           *
           * The min-players requirement is unchanged and is still evaluated
           * against the pre-start horse ramp above, which runs right up to this
           * moment — so an event short of a field at T-60 simply is not started
           * early, and falls through to the past-start top-up branch as before.
           */
          const timeReached =
            startTime - TOURNAMENT_PRESEAT_LEAD_MS <= now &&
            tournament.current_players >= minPlayers;

          // SNG/Spin: only start when every seat has been bought and paid for.
          // MTT variants: start at scheduled time with minimum players.
          const shouldStart = isSngOrSpin ? seatFirstReady : maxReached || timeReached;

          if (shouldStart) {
            /* Report the number the decision was actually made on. A Spin is
               gated on SEATS, and current_players can disagree with those —
               logging it here is how a drifted counter reads as a healthy
               start in the logs. */
            const reason = isSngOrSpin
              ? `seats sold (${paidSeats}/${tournament.max_players})`
              : maxReached
                ? `full (${tournament.current_players}/${tournament.max_players})`
                : startTime > now
                  ? `pre-seating ${tournament.current_players} players, cards in ${Math.round((startTime - now) / 1000)}s`
                  : `${tournament.current_players} players`;
            /* Re-check in the same tick as the set: the seat-first fast lane
               (discoverSeatFirstStarts) may have started this game while this
               pass was busy with earlier rows. Both sites check-and-set with
               no await in between, so one manager per id is structural. */
            if (this.tournamentEngines.has(tournament.id)) continue;
            const tournamentId = String(tournament.id);
            this.launchDiscoveryJob(
              this.ensureTournamentManagerAdmission(
                tournamentId,
                'start',
                `Starting tournament: ${tournament.name} (${reason})`,
                generation
              ),
              'GameServer.Tournament_start_failed_for_to',
              { tournamentId }
            );
          }
        }

        /**
         * ── FULLY PAID BUT NEVER STARTED (2026-08-24 audit, P2-7) ──
         *
         * Every other watchdog on the platform proves a game is broken by
         * finding evidence it PLAYED: the played-but-REGISTERING sweep below
         * needs an eliminated/winner/finished row, the decided-but-RUNNING
         * sweep needs an elimination. A game that never dealt a card cannot
         * produce either, so a heads-up that sold both its seats and then sat
         * there was invisible to all of them — measured at 85 minutes on
         * 2026-08-24, with the money already taken.
         *
         * The evidence THIS one runs on is the only evidence such a game has:
         * every seat it sells is sold, and it is still REGISTERING. The
         * failure it catches is specifically a tournamentEngines slot held by
         * a manager that is no longer running — the top of this loop skips
         * every id in that map, so such a game is never looked at again by
         * anything.
         */
        {
          const stallNow = Date.now();
          const stillSeatFirst = new Set(seatFirstRows.map((t) => String(t.id)));
          for (const id of this.seatFirstFullSince.keys()) {
            if (!stillSeatFirst.has(id)) this.seatFirstFullSince.delete(id);
          }

          for (const t of seatFirstRows) {
            if (!this.directAdmissionIsCurrent(generation)) break;
            // THE FREEZE IS TOTAL (Dan 2026-09-03): a seat-first start seats its
            // players and a partial fill buys horses in.
            if (isMaintenanceFrozen()) break;
            const id = String(t.id);
            const seats = Number(t.max_players) || 0;
            const paid = paidSeatsByTournament.get(id) ?? 0;

            if (seats <= 0 || paid < seats) {
              // Still filling, or a seat opened up again. Not a stall.
              this.seatFirstFullSince.delete(id);
              continue;
            }
            const fullSince = this.seatFirstFullSince.get(id) ?? null;
            if (fullSince === null) {
              // First pass that saw it full — start the clock, judge nothing.
              this.seatFirstFullSince.set(id, stallNow);
              continue;
            }
            if (
              !seatFirstStartStalled({
                paidSeats: paid,
                maxPlayers: seats,
                fullSinceMs: fullSince,
                now: stallNow,
                stallMs: SEAT_FIRST_START_STALL_MS,
              })
            ) {
              continue;
            }
            /* A parked launch is not a stall this watchdog can cure: the
               front door would refuse the force-start anyway, and reporting
               "force-starting" every stall window for a game the authority
               has refused would be a lie in Sentry. The clock is left
               running, so the pass after the park ends acts at once. */
            if (spinLaunchParks.isParked(id, stallNow)) continue;

            const held = this.tournamentEngines.get(id);
            if (held && !held.isRunning()) {
              // A finished or dead manager still owning the map slot IS the
              // bug: the start gate at the top of this loop skips it forever.
              await this.stopTournamentManagerIfOwned(
                id,
                held,
                'GameServer.seat_first_stalled_manager_stop_failed'
              );
            }
            if (this.tournamentEngines.has(id)) continue;

            reportError(
              new Error(
                `[GameServer] ${t.name} (${id.slice(0, 8)}) fully paid ${paid}/${seats} and ` +
                  `still REGISTERING after ${Math.round((stallNow - fullSince) / 60000)}m - force-starting`
              ),
              'GameServer.seat_first_fully_paid_never_started'
            );

            this.launchDiscoveryJob(
              this.ensureTournamentManagerAdmission(
                id,
                'start',
                `Force-starting fully paid seat-first game ${t.name}`,
                generation
              ),
              'GameServer.seat_first_stall_start_failed',
              { tournamentId: id }
            );
            // Re-arm the clock rather than clearing it: if this start does not
            // take either, the next attempt is one stall window away and not
            // one five-second pass away.
            this.seatFirstFullSince.set(id, stallNow);
          }
        }

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  THE LONGEST-WAITING TOURNAMENT IS ADOPTED FIRST (2026-09-09)
         * ═══════════════════════════════════════════════════════════════════
         *
         * This read had no ORDER BY, so the resume order was whatever
         * PostgREST happened to return - in practice stable, which is worse
         * than random: the same events land at the end of the list on every
         * single pass. Adoption is not free (a manager plus an engine per
         * table, against a database where a single bounty-evidence read can
         * take eight seconds), so when the fleet cannot all be adopted at once
         * the tail is not merely late, it is ALWAYS the same tail.
         *
         * Measured on production 2026-09-09: after the 05:55 maintenance
         * restart, tournaments dealing in the last ten minutes fell from 86 to
         * EIGHT of 126 RUNNING, while THIRTEEN events had been stalled for more
         * than an hour - across several hourly restarts, so they had lost the
         * race every time. The oldest, `$100 Freeroll 6:00 AM`, had not dealt a
         * hand in 903 minutes with players still seated in it.
         *
         * `started_at` ascending makes the order a queue instead of a lottery.
         * It is the cheapest possible fix for starvation and it cannot make
         * anything slower: the same set is adopted in the same number of
         * passes, and the event that has been waiting longest is simply no
         * longer the one that waits again. NULLS LAST because a row with no
         * start time is not evidence of a long wait.
         */
        const { data: running, error: runningErr } = await supabase
          .from('tournaments')
          .select('id, name')
          .eq('status', 'RUNNING')
          .order('started_at', { ascending: true, nullsFirst: false });
        if (runningErr) {
          // Same rule as the REGISTERING read: unreadable is UNKNOWN. Reading
          // it as "nothing is running" silently stops every re-adoption.
          reportError(
            new Error(`[GameServer] RUNNING board read failed: ${runningErr.message}`),
            'GameServer.running_board_read_failed'
          );
        }

        for (const tournament of running || []) {
          if (!this.directAdmissionIsCurrent(generation)) break;
          if (this.tournamentEngines.has(tournament.id)) continue;

          const tournamentId = String(tournament.id);
          this.launchDiscoveryJob(
            this.ensureTournamentManagerAdmission(
              tournamentId,
              'resume',
              `Resuming tournament: ${tournament.name}`,
              generation
            ),
            'GameServer.Tournament_resume_failed_for_t',
            { tournamentId }
          );
        }

        // The ramp map only ever holds tournaments still in REGISTERING.
        // Without this it grows by every event the engine has ever seen and
        // is never freed for the life of the process.
        if (this.lastMttRampAt.size > 0 || spinLaunchParks.size > 0) {
          const stillRegistering = new Set((registering || []).map((r) => String(r.id)));
          for (const id of this.lastMttRampAt.keys()) {
            if (!stillRegistering.has(id)) this.lastMttRampAt.delete(id);
          }
          // The park registry is bounded the same way (2026-09-10): a park
          // gates a 'start', and a Spin that has left REGISTERING (RUNNING,
          // COMPLETED, CANCELLED) can never be started again. Only entries
          // older than this pass's board read are judged by it.
          spinLaunchParks.retain(stillRegistering, registeringReadAt);
        }

        // Clean up completed tournaments
        for (const [id, tm] of this.tournamentEngines) {
          if (!tm.isRunning()) {
            await this.stopTournamentManagerIfOwned(
              id,
              tm,
              'GameServer.tournament_completed_cleanup_failed'
            );
          }
        }

        // Bound the tournament-owned table set to what is still owned. See the
        // field's own comment for the three things its unbounded growth broke.
        this.pruneTournamentOwnedTables();

        // ── STUCK COMPLETING RECOVERY ──
        // A tournament that has been COMPLETING for more than five minutes is
        // recovered: paid what it still owes, then completed. The dwell is
        // measured by this process (tournament/completingDwell.ts) because
        // nothing maintains `updated_at` on this path, and it is what keeps the
        // recovery off the back of a finish that is still paying - the row is
        // flipped to COMPLETING BEFORE the money moves, and a manager leaves
        // `tournamentEngines` the moment it stops.
        const { data: stuckTournaments, error: completingScanErr } = await supabase
          .from('tournaments')
          .select('id, name, status')
          .eq('status', 'COMPLETING');

        // An unreadable scan is not an empty one: forgetting every dwell here
        // would restart all five-minute clocks on a transient error, which is
        // the one way this gate could hold a genuinely stuck row forever.
        if (completingScanErr) {
          reportError(
            new Error(
              `[GameServer] COMPLETING scan failed: ${completingScanErr.message} - dwell clocks kept, nothing recovered this pass`
            ),
            'GameServer.completing_scan_failed'
          );
        } else {
          const dwell = selectCompletingDue(
            (stuckTournaments || []).map((t) => String(t.id)),
            this.completingFirstSeenAt,
            Date.now()
          );
          this.completingFirstSeenAt = dwell.seenAt;
          const dueIds = new Set(dwell.due);
          for (const stuck of stuckTournaments || []) {
            if (!dueIds.has(String(stuck.id))) continue;
            /* A MANAGER THAT NEVER CAME BACK (2026-09-06). See
               managerHasOverstayed. Past the grace the registered manager is
               the thing that is stuck, not the thing that will fix it. */
            const lingering = this.tournamentEngines.get(String(stuck.id));
            if (lingering && managerHasOverstayed(dwell.seenAt.get(String(stuck.id)), Date.now())) {
              reportError(
                new Error(
                  `[GameServer] ${stuck.name} (${String(stuck.id).slice(0, 8)}) has been COMPLETING past the managed grace with its manager still registered - its finish never returned. Stopping the manager and recovering.`
                ),
                'GameServer.completing_manager_overstayed'
              );
              await this.stopTournamentManagerIfOwned(
                String(stuck.id),
                lingering,
                'GameServer.completing_manager_stop_failed'
              );
            }
            if (!this.tournamentEngines.has(stuck.id)) {
              // No active engine managing this tournament - it's truly stuck.
              // TOURNEY-AUDIT 2026-07-24: recovery now PAYS remaining players
              // (winner + unpaid ITM places) before completing - the old path
              // flipped straight to COMPLETED and the winner's prize vanished.
              console.warn(
                `[GameServer] Recovering stuck COMPLETING tournament: ${stuck.name} (${stuck.id.slice(0, 8)})`
              );
              await recoverStuckCompletingTournaments('discovery-watchdog', stuck.id);
            }
          }
        }

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  A SPIN THAT IS OVER MUST END (round 18, 2026-08-30)
         * ═══════════════════════════════════════════════════════════════════
         *
         * Found by sweeping production rather than by reading code. EVERY
         * RUNNING spin older than five minutes was stuck — nine of nine:
         *
         *     live stacks <= 1 on all nine (a winner IS determinable)
         *     no hand dealt for 17 to 450 minutes
         *     1,093 chips of prize_pool unpaid
         *     average 147 minutes stuck, worst 7.7 hours
         *
         * A healthy spin never appears in that list; it finishes in minutes.
         * So the shape is unambiguous and had zero false positives across the
         * whole live board.
         *
         * WHY IT HAPPENS. Players LEAVE the felt — `table_seats.left_at` is
         * set — while `tournament_players.status` stays `playing`. The engine
         * therefore counts a player who is gone as still in the game, waits
         * for an action that is never coming, and never reaches the "one
         * player left" that would finish it. The chips sit on the table and
         * the prize sits unpaid.
         *
         * WHY THE EXISTING SWEEP DOES NOT CATCH IT. There is one, and it is
         * startup-only with a TWELVE HOUR threshold plus a no-hands-in-the-
         * last-hour test. Twelve hours is a reasonable floor for an MTT and
         * meaningless for a format designed to last minutes.
         *
         * WHAT THIS DOES. It never cancels — Dan 2026-08-19, "TOURNAMENTS
         * RUN. THEY DO NOT CANCEL." It claims the row with the same
         * CAS-guarded RUNNING -> COMPLETING flip the 12-hour path uses, so a
         * live engine mid-finish always wins the race, then hands it to
         * `recoverStuckCompletingTournaments`, which ranks the remaining
         * players by chips, assigns the places and pays the structure. The
         * money reaches whoever earned it.
         *
         * The thresholds are deliberately well clear of a healthy game: the
         * reveal alone holds dealing for 16.6s, so "no hand for three
         * minutes" cannot fire during a start, and `started_at` older than
         * five minutes puts another wall in front of it.
         */
        if (Date.now() - this.lastSeatFirstFinishSweepAt > 60 * 1000) {
          this.lastSeatFirstFinishSweepAt = Date.now();
          this.launchDiscoveryJob(
            this.finishSeatFirstGamesThatAreOver(),
            'GameServer.seat_first_finish_sweep_error'
          );
        }

        /**
         * ── PUT BACK THE FELT SOMETHING ELSE TOOK AWAY (2026-08-31) ─────────
         *
         * See liveTournamentTableRecovery.ts for the two production outages
         * this exists for. Same cadence and the same fire-and-forget shape as
         * the finish sweep above: a minute is far faster than the hours these
         * husks actually sat for, and the pass is three bounded reads on a
         * healthy board.
         */
        if (Date.now() - this.lastClosedTableReopenSweepAt > 60 * 1000) {
          this.lastClosedTableReopenSweepAt = Date.now();
          this.launchDiscoveryJob(
            this.reopenTablesClosedUnderLiveTournaments(),
            'GameServer.closed_table_reopen_sweep_error'
          );
        }

        /**
         * ── A STRANDED PLAYER IS BROUGHT BACK TO THE FELT (2026-09-01) ──────
         *
         * The reopen sweep above declines when the tournament still owns an
         * open table, and it is right to: the repair for a player left on a
         * CLOSED table is to move them to the felt that is already open, not
         * to put a second felt under the game. Nothing did that, and the state
         * fell between all three existing sweeps, so "$100 Freeroll - 12:00 AM"
         * sat RUNNING and silent for 5h21m with two entrants, one on each side
         * of a closed table. See tournament/orphanedSeatRepair.ts.
         *
         * Same cadence and the same fire-and-forget shape as its neighbours.
         */
        if (Date.now() - this.lastOrphanSeatSweepAt > 60 * 1000) {
          this.lastOrphanSeatSweepAt = Date.now();
          this.launchDiscoveryJob(
            this.repairOrphanedTournamentSeats(),
            'GameServer.orphan_seat_repair_sweep_error'
          );
        }

        // Conservation: per-event money in vs money out (prizes + bounties +
        // refunds + booked rake + funded overlay). Every 6 hours; anything
        // beyond tolerance files a deduped financial_alert. This is the
        // invariant that would have caught both the minted overlays and the
        // HU shortfalls on day one.
        if (Date.now() - this.lastConservationAt > 6 * 60 * 60 * 1000) {
          this.lastConservationAt = Date.now();
          try {
            const { data: cons, error: consErr } = await supabase.rpc(
              'fn_tournament_money_conservation',
              { p_since_days: 7, p_tolerance: 1.0, p_limit: 500 }
            );
            if (consErr) {
              reportError(
                new Error(`[GameServer] conservation sweep failed: ${consErr.message}`),
                'GameServer.conservation_sweep_failed'
              );
            } else if (Number(cons?.flagged) > 0) {
              console.log(
                `[GameServer] Conservation sweep: ${cons.flagged} event(s) flagged (retained ${cons.retained_chips}, unfunded ${cons.unfunded_chips})`
              );
            }
          } catch (consEx) {
            reportError(consEx, 'GameServer.conservation_sweep_threw');
          }
        }

        // ── NO RESULT WITHOUT A HAND (2026-09-01) ──
        // Seven events in the fortnight to 2026-08-30 were COMPLETED with a
        // full set of finishing places, a stamped winner and 775.00 chips paid
        // between five of them, and hand_history holds not one hand for any of
        // them. The recovery had sorted a field in which every survivor held
        // exactly starting_chips. The guard in tournamentRecovery stops that
        // being invented again; this is what makes the CLASS visible, so a new
        // cause arriving by another route cannot be silent for a fortnight the
        // way that one was. It reports and moves no money.
        // Its OWN timer, per the lesson recorded on the overpay charge below.
        if (Date.now() - this.lastNoHandResultCheckAt > 6 * 60 * 60 * 1000) {
          this.lastNoHandResultCheckAt = Date.now();
          try {
            const { data: nh, error: nhErr } = await supabase.rpc(
              'fn_detect_results_without_a_hand',
              {}
            );
            if (nhErr) {
              reportError(
                new Error(`[GameServer] no-hand result check failed: ${nhErr.message}`),
                'GameServer.no_hand_result_check_failed'
              );
            } else if (Number(nh?.flagged) > 0) {
              console.log(
                `[GameServer] No-hand result check: ${nh.flagged} event(s) ranked without a hand (${nh.chips_paid} chips paid, ${nh.alerts_raised} new alert(s), ${nh.parked_completing} held in COMPLETING)`
              );
            }
          } catch (nhEx) {
            reportError(nhEx, 'GameServer.no_hand_result_check_threw');
          }
        }

        // ── DUPLICATE-PLACE OVERPAY CHARGE (2026-08-28) ──
        // 259 duplicate finishing places were renumbered; 19 of the demoted
        // rows had collected more than their corrected place is worth. Dan's
        // call: no clawback from players, the hosting club absorbs it. The
        // charge cannot always be taken on the spot - fn_debit_treasury
        // refuses to overdraw, and a club that has been funding advertised
        // guarantees can sit negative until the weekly rakeback close - so the
        // obligation is a queue and this drains it. Its OWN timer: the lesson
        // from the HU back-pay is that a repair gated on another job's clock
        // runs once at boot and then effectively never.
        if (Date.now() - this.lastPlaceOverpayChargeAt > 60 * 60 * 1000) {
          this.lastPlaceOverpayChargeAt = Date.now();
          try {
            const { data: chg, error: chgErr } = await supabase.rpc('fn_charge_place_overpays', {
              p_limit: 500,
            });
            if (chgErr) {
              reportError(
                new Error(`[GameServer] place overpay charge failed: ${chgErr.message}`),
                'GameServer.place_overpay_charge_failed'
              );
            } else if (Number(chg?.charged) > 0 || Number(chg?.clubs_blocked) > 0) {
              console.log(
                `[GameServer] Place overpay charge: ${chg.charged} chips from ${chg.clubs_charged} club(s), ` +
                  `${chg.blocked_insufficient_treasury} still owed by ${chg.clubs_blocked} (queue ${chg.owed_before} -> ${chg.owed_after})`
              );
            }
          } catch (chgEx) {
            reportError(chgEx, 'GameServer.place_overpay_charge_threw');
          }
        }

        /* ── UNFILLED-SPIN REFUND, ON THE ENGINE'S OWN CLOCK (2026-08-31) ──
         * A Spin is seat-first: you pay when you sit. Nothing bounded the
         * wait for the third seat, so a game that never filled held every
         * seated player's chips indefinitely - worst observed 76,648s, 21
         * hours. fn_spin_expire_unfilled cancels those through
         * atomic_cancel_tournament, which refunds; it never touches a
         * full-but-unstarted game, and the timeout is a config row
         * (spin_fill_policy, 0 disables).
         *
         * IT ALSO RUNS FROM THE WORLD HUB SWEEP, AND THAT IS DELIBERATE
         * DUPLICATION. The RPC is idempotent - it only ever acts on games
         * that are still open, unstarted and past the policy - so two callers
         * cost nothing and either one alone is sufficient. Verified on the
         * day this shipped: /api/cron/spin-sweep had not fired for 37 minutes
         * on a fifteen-minute schedule while the engine's own timers kept perfect time.
         * Money owed back to a player must not wait on the least reliable
         * clock available; this is the same reasoning as the back-pay above,
         * whose comment says a repair gated on another job's clock runs at
         * boot and then effectively never. */
        if (Date.now() - this.lastSpinExpireAt > 10 * 60 * 1000) {
          this.lastSpinExpireAt = Date.now();
          try {
            const { data: exp, error: expErr } = await supabase.rpc('fn_spin_expire_unfilled', {
              p_limit: 50,
            });
            if (expErr) {
              reportError(
                new Error(`[GameServer] unfilled-spin expiry failed: ${expErr.message}`),
                'GameServer.spin_expire_unfilled_failed'
              );
            } else if (exp?.ok === false || Number(exp?.failed) > 0) {
              reportError(
                new Error(
                  `[GameServer] unfilled-spin expiry batch failed: ${Number(exp?.failed) || 0} ` +
                    `failure(s), ${Number(exp?.expired) || 0} expired`
                ),
                'GameServer.spin_expire_unfilled_failed'
              );
            } else if (Number(exp?.expired) > 0) {
              console.log(
                `[GameServer] Unfilled-spin expiry: ${exp.expired} game(s) cancelled and refunded, ` +
                  `${exp.chips_refunded} chips returned (timeout ${exp.timeout_minutes}m)`
              );
            }
          } catch (expEx) {
            reportError(expEx, 'GameServer.spin_expire_unfilled_threw');
          }
        }

        // ── UNBANKED FEE RE-QUEUE (2026-08-28) ──
        // queueUnbankedFee is the last line of defence: when a rake or BBJ fee
        // cannot be banked it goes into pending_fee_distributions, and the
        // drain above empties that. When the QUEUE INSERT itself failed - a
        // Cloudflare 520, a PostgREST schema-cache blip - the alert was the
        // only record left, and its text said the chips were "recoverable only
        // by hand". They are not: since 2026-08-22 the alert carries the whole
        // payload (pot, numPlayers, contributions), which is everything needed
        // to put the row back in the queue.
        //
        // fn_requeue_unbanked_fees re-runs feeIsAccountedFor in SQL before
        // queueing anything, because most of these alerts describe fees that
        // were banked moments later - on the first run, 1,205 of 1,459. Without
        // that check this would double-book the overwhelming majority of what
        // it touches.
        if (Date.now() - this.lastFeeRequeueAt > 30 * 60 * 1000) {
          this.lastFeeRequeueAt = Date.now();
          try {
            const { data: rq, error: rqErr } = await supabase.rpc('fn_requeue_unbanked_fees', {
              p_apply: true,
              p_limit: 500,
            });
            if (rqErr) {
              reportError(
                new Error(`[GameServer] unbanked fee re-queue failed: ${rqErr.message}`),
                'GameServer.fee_requeue_failed'
              );
            } else if (Number(rq?.requeued) > 0 || Number(rq?.already_accounted) > 0) {
              console.log(
                `[GameServer] Unbanked fee re-queue: ${rq.requeued} re-queued ` +
                  `(${rq.rake_requeued} rake, ${rq.bbj_requeued} bbj), ` +
                  `${rq.already_accounted} already banked (alerts ${rq.alerts_open_before} -> ${rq.alerts_open_after})`
              );
            }
          } catch (rqEx) {
            reportError(rqEx, 'GameServer.fee_requeue_threw');
          }
        }

        /* The former PLAYED-BUT-STILL-REGISTERING repair is intentionally
           gone. It was compensating for start() dealing before its lifecycle
           transition committed. Launch setup now completes through one
           immutable receipt transaction and dealer admission happens only
           afterwards, so that state is structurally impossible. Keeping a
           periodic direct relabel would create a second, receipt-free door to
           RUNNING and turn a fixed invariant back into reconciliation. A
           production pre-deploy proof on 2026-09-07 found zero legacy rows. */

        // ── STALLED DECIDED-BUT-RUNNING RECOVERY (2026-08-21) ──
        // A tournament whose LAST elimination was processed but whose finish
        // check never ran (engine restart in the gap) stays RUNNING forever:
        // the survivor sits in status='playing' with no position, no prize,
        // and an open table where no hand can ever be dealt again. Observed
        // live twice in the 23:00-00:25Z deploy-churn window (two Turbo SNGs,
        // ~2h stalled). Re-adoption does NOT self-heal: the finish check only
        // runs inside elimination processing, and with one player there are
        // no hands, no eliminations, no check. Detect the decided state here,
        // stop any idle engine, and route through the SAME recovery path that
        // rescues stuck-COMPLETING tournaments (ranks survivors, pays via
        // computePlacePrize, closes every player row).
        const decidedCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const { data: maybeDecided } = await supabase
          .from('tournaments')
          .select('id, name')
          .eq('status', 'RUNNING')
          .lt('started_at', decidedCutoff);
        for (const t of maybeDecided || []) {
          const { count: playingCount, error: playingErr } = await supabase
            .from('tournament_players')
            .select('*', { count: 'exact', head: true })
            .eq('tournament_id', t.id)
            .eq('status', 'playing');
          // PAYOUT-INTEGRITY: a count we could not read is UNKNOWN, not zero.
          if (playingErr || playingCount === null || playingCount === undefined) continue;
          if (playingCount > 1) continue; // still a live contest
          console.warn(
            `[GameServer] RUNNING tournament ${t.name} (${t.id.slice(0, 8)}) is decided (${playingCount} playing) - recovering the winner`
          );
          const idleTm = this.tournamentEngines.get(String(t.id));
          if (idleTm) {
            idleTm.requestEliminationSweep('stalled_decided_survivor');
          } else {
            this.launchDiscoveryJob(
              this.ensureTournamentManagerAdmission(
                String(t.id),
                'resume',
                `Resuming decided tournament through its finish owner: ${t.name}`,
                generation
              ),
              'GameServer.stalled_decided_resume_failed',
              { tournamentId: String(t.id) }
            );
          }
        }

        // ── STARTED-BUT-NEVER-DEALT RECOVERY (2026-08-24) ──
        //
        // Measured live during the 03:31-05:1x UTC deploy-churn window: 92
        // RUNNING seat-first games, every seat funded, 2+ players seated,
        // tables at 'waiting' - and not one hand ever dealt. 91 of 92 held no
        // engine lease, and the population did not drain while the engine was
        // healthy and dealing everything else: whatever incarnation started
        // them died before the first deal, and no later incarnation picked
        // them up (or a resumed manager wedged before dealing, which the
        // cleanup above cannot see because isRunning() is still true).
        //
        // No existing sweep covers this state. The played-but-registering
        // sweep demands finished player rows - a never-dealt game has none.
        // The decided-but-running sweep demands playingCount <= 1 - a
        // never-dealt game has a full field. So the paid players sit at a
        // dead felt forever, buy-ins committed.
        //
        // Recovery: preserve the durably completed RUNNING launch. Stop the
        // exact idle manager generation holding the map entry; the ordinary
        // RUNNING discovery path above then resumes it from its existing
        // tables and seats on the next pass. Rewinding to REGISTERING used to
        // erase the lifecycle truth. With an immutable completed launch
        // receipt it also creates an impossible state that no start or resume
        // path may legally adopt.
        //
        // Budgeted to 15 candidates a pass so a pathological backlog cannot
        // turn this sweep into its own outage; in steady state it is empty.
        /**
         * EVERY VARIANT, NOT THE TWO THE FIRST INCIDENT HAPPENED TO CONTAIN
         * (2026-08-25).
         *
         * This sweep shipped filtered to `['sng', 'spin']` because the outage
         * that prompted it was 92 seat-first games. "Started and never dealt"
         * is a property of a tournament, not of its variant, and MTTs were
         * left covered by no sweep at all - the comment above says so in its
         * own words and the filter then contradicted it.
         *
         * Found live: `Monday Grind PLO6 Turbo` (18 paid players, 2 tables,
         * 183 minutes, zero hands) and `Six-Card Late Night` (499 players,
         * 56 tables, 548 live seats, zero hands). Both sat at a dead felt
         * with buy-ins committed and nothing in the engine looking for them.
         *
         * The 15-minute cutoff holds for MTTs, measured rather than assumed:
         * of 187 non-seat-first tournaments started in 48h, 127 dealt their
         * first hand in under 5 minutes - INCLUDING a full 500-player field -
         * and 153 of 187 within 15. The slow tail is not big fields waiting
         * to seat (its average field is 31 against 42 for the sub-5m group);
         * it is this same stall, recovering by luck on a later re-adoption.
         */
        const neverDealtCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        const { data: maybeNeverDealt } = await supabase
          .from('tournaments')
          .select('id, name, started_at')
          .eq('status', 'RUNNING')
          .lt('started_at', neverDealtCutoff);
        for (const t of (maybeNeverDealt || []).slice(0, 15)) {
          const { data: tRows, error: tErr } = await supabase
            .from('tables')
            .select('id, status')
            .eq('tournament_id', t.id);
          if (tErr) continue; // unreadable is UNKNOWN, never "it never dealt"
          const tableIds = (tRows || []).map((r) => String((r as { id: string }).id));
          if (tableIds.length === 0) continue; // no table at all - creation path owns it

          const { count: dealt, error: dealtErr } = await supabase
            .from('hand_history')
            .select('id', { count: 'exact', head: true })
            .in('table_id', tableIds);
          if (dealtErr || dealt === null || dealt === undefined) continue;
          if (dealt > 0) continue; // it played; the sweeps above own it

          // Only a game that can actually deal goes back in the queue: 2+
          // live seats on a non-closed table.
          const openTableIds = (tRows || [])
            .filter((r) => String((r as { status?: string }).status) !== 'closed')
            .map((r) => String((r as { id: string }).id));
          if (openTableIds.length === 0) continue;
          const { count: liveSeats, error: seatErr } = await supabase
            .from('table_seats')
            .select('id', { count: 'exact', head: true })
            .in('table_id', openTableIds)
            .is('left_at', null);
          if (seatErr || !liveSeats || liveSeats < 2) continue;

          /**
           * SEATING HAS TO BE FINISHED BEFORE "NEVER DEALT" MEANS "DEAD".
           *
           * A seat-first game seats everyone in one call, so it is settled the
           * moment it has two seats. A large MTT does not: it adopts tables and
           * fills them over several passes, and a game still mid-seating has
           * dealt nothing for a legitimate reason. Requeueing that one is
           * harmless but pointless churn, and at 56 tables it is not cheap.
           *
           * Every player still `playing` must hold a live seat. Only then is
           * there nothing left to wait for and no hand is an answer rather
           * than a delay. An unreadable count is UNKNOWN, never "settled" -
           * same rule the sweeps above hold themselves to.
           */
          const { count: stillPlaying, error: playingCountErr } = await supabase
            .from('tournament_players')
            .select('id', { count: 'exact', head: true })
            .eq('tournament_id', t.id)
            .eq('status', 'playing');
          if (playingCountErr || stillPlaying === null || stillPlaying === undefined) continue;
          if (liveSeats < stillPlaying) continue;

          console.warn(
            `[GameServer] RUNNING ${t.name} (${t.id.slice(0, 8)}) has dealt nothing since ${t.started_at} - releasing its idle manager for RUNNING resume`
          );
          const idleNeverDealtTm = this.tournamentEngines.get(t.id);
          if (idleNeverDealtTm) {
            await this.stopTournamentManagerIfOwned(
              String(t.id),
              idleNeverDealtTm,
              'GameServer.never_dealt_stop_engine'
            );
          }
          // Do not mutate durable lifecycle state here. A tournament that
          // just dealt or completed is harmlessly left alone; a genuinely
          // never-dealt RUNNING tournament is visible to normal resume as
          // soon as the exact old manager has left the ownership map.
        }
      } catch (err) {
        reportError(err, 'GameServer.Tournament_discovery_error');
      }

      await this.sleep(TOURNAMENT_DISCOVERY_INTERVAL);
    }
  }

  /**
   * Subscribe before taking the initial outbox snapshot.  New eliminations
   * normally pay in their own atomic manager path; this process-wide channel
   * exists for the one exceptional state that must survive a crash or a lost
   * response: a committed, exact-generation bounty obligation still pending.
   */
  private startTournamentBountyObligationSubscription(): void {
    if (this.tournamentBountyObligationChannel) return;
    if (currentTournamentDataAuthority() !== null) {
      throw new Error('Tournament recovery subscriptions must start outside tournament authority');
    }
    // The shared Realtime socket can reconnect inside any manager's async
    // chain. Capture this process-owned receiver at registration so incoming
    // notifications cannot inherit that unrelated tournament or lease.
    // Manager methods still establish and enforce their own exact authority.

    const onObligationChange = AsyncResource.bind(
      (payload: { new?: Record<string, unknown> }): void => {
        const row = payload.new;
        if (!this.running || !row) return;
        const state = String(row.state ?? '');
        if (state === 'pending') {
          // The database is the clock authority. Read the order-eligible,
          // DB-relative retry delay from the sweep response instead of comparing
          // a database timestamp with this host's wall clock.
          this.requestPendingTournamentBountyRecovery();
          return;
        }
        if (state === 'settled') {
          const tournamentId = String(row.tournament_id ?? '');
          this.tournamentEngines.get(tournamentId)?.requestEliminationSweep('bounty_settled');
        }
      },
      'GameServer.bountyObligations.notification'
    );

    const channel = supabase
      .channel(`tournament-bounty-obligations:${process.pid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'tournament_bounty_obligations' },
        onObligationChange
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tournament_bounty_obligations' },
        onObligationChange
      );
    this.tournamentBountyObligationChannel = channel;
    channel.subscribe(
      AsyncResource.bind((status: string) => {
        if (this.tournamentBountyObligationChannel !== channel) return;
        if (status === 'SUBSCRIBED') {
          bountyRecoveryRealtimeConnected.set(1);
          this.tournamentBountyReconnectBackoffMs = 1_000;
          // Subscription first, snapshot second closes the boot/reconnect
          // race.  The snapshot also reconstructs the exact due timer after a
          // process crash, so no periodic poll is needed.
          this.requestPendingTournamentBountyRecovery();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          bountyRecoveryRealtimeConnected.set(0);
          reportError(
            new Error(`Tournament bounty obligation channel entered ${status}`),
            'GameServer.tournament_bounty_channel_error'
          );
          // Realtime will rejoin this channel. A direct database drain closes
          // the delivery gap without waiting for that transport recovery.
          this.requestPendingTournamentBountyRecovery();
        } else if (status === 'CLOSED') {
          bountyRecoveryRealtimeConnected.set(0);
          this.tournamentBountyObligationChannel = null;
          this.launchServerLifecycleJob(
            Promise.resolve(supabase.removeChannel(channel)),
            'GameServer.tournament_bounty_closed_channel_remove_failed'
          );
          this.requestPendingTournamentBountyRecovery();
          this.scheduleTournamentBountySubscriptionReconnect();
        }
      }, 'GameServer.bountyObligations.status')
    );
    // Boot is itself a causal recovery signal. Do not make durable settlement
    // depend on receiving SUBSCRIBED from the transport.
    this.requestPendingTournamentBountyRecovery();
  }

  /** Recreate a channel only after it actually closes; never poll a healthy one. */
  private scheduleTournamentBountySubscriptionReconnect(): void {
    if (
      !this.running ||
      this.tournamentBountyObligationChannel ||
      this.tournamentBountyReconnectTimer
    ) {
      return;
    }
    const delayMs = this.tournamentBountyReconnectBackoffMs;
    this.tournamentBountyReconnectBackoffMs = Math.min(
      60_000,
      this.tournamentBountyReconnectBackoffMs * 2
    );
    this.tournamentBountyReconnectTimer = setTimeout(() => {
      this.tournamentBountyReconnectTimer = null;
      if (!this.running || this.tournamentBountyObligationChannel) return;
      this.startTournamentBountyObligationSubscription();
    }, delayMs);
    this.tournamentBountyReconnectTimer.unref?.();
  }

  /**
   * Admit one causal recovery signal. Future mystery-chest obligations arm a
   * single timer for their persisted due instant; immediate work drains now.
   * This is a durable work queue, not a cron or a discovery-loop watch list.
   */
  private requestPendingTournamentBountyRecovery(): void {
    if (!this.running) return;
    if (this.bountyRecoveryDueTimer) {
      clearTimeout(this.bountyRecoveryDueTimer);
      this.bountyRecoveryDueTimer = null;
      this.bountyRecoveryDueAt = 0;
    }
    this.bountyRecoveryRequested = true;
    if (this.bountyRecoverySweepInFlight) {
      bountyRecoverySweepRunsTotal.inc(1, { outcome: 'coalesced' });
      return;
    }
    this.launchServerLifecycleJob(
      this.sweepPendingTournamentBounties(),
      'GameServer.bounty_outbox_drain_unhandled'
    );
  }

  /** Keep only the earliest DB-relative retry delay on this process clock. */
  private armPendingTournamentBountyRecovery(retryAfterMs: number): void {
    if (!this.running || !Number.isFinite(retryAfterMs)) return;
    const dueAt = Date.now() + Math.max(0, Math.floor(retryAfterMs));
    if (this.bountyRecoveryDueTimer && this.bountyRecoveryDueAt <= dueAt) return;
    if (this.bountyRecoveryDueTimer) clearTimeout(this.bountyRecoveryDueTimer);
    this.bountyRecoveryDueAt = dueAt;
    this.bountyRecoveryDueTimer = setTimeout(
      () => {
        this.bountyRecoveryDueTimer = null;
        this.bountyRecoveryDueAt = 0;
        this.requestPendingTournamentBountyRecovery();
      },
      Math.max(0, dueAt - Date.now())
    );
    this.bountyRecoveryDueTimer.unref?.();
  }

  private startTournamentManagerWakeSubscription(): void {
    if (this.tournamentManagerWakeChannel) return;
    if (currentTournamentDataAuthority() !== null) {
      throw new Error('Tournament recovery subscriptions must start outside tournament authority');
    }
    // The shared Realtime socket can reconnect inside any manager's async
    // chain. Capture this process-owned receiver at registration so incoming
    // notifications cannot inherit that unrelated tournament or lease.
    // Manager methods still establish and enforce their own exact authority.

    const onManagerWake = AsyncResource.bind((payload: { new?: Record<string, unknown> }): void => {
      if (!this.running || this.tournamentManagerWakeChannel !== channel) return;
      const row = payload.new;
      // The acknowledgement UPDATE is also published. It is completion, not a
      // new signal, and must never re-admit the generation it just consumed.
      if (!row || row.consumed_at != null) return;
      this.launchServerLifecycleJob(
        this.admitTournamentManagerWake(row),
        'GameServer.tournament_manager_realtime_wake_failed'
      );
    }, 'GameServer.managerWakes.notification');
    const channel = supabase
      .channel(`tournament-manager-wakes:${process.pid}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'tournament_manager_wakes',
        },
        onManagerWake
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'tournament_manager_wakes',
        },
        onManagerWake
      )
      // Rolling cutover: older web bundles insert directly into the vote
      // table and therefore cannot create the new durable wake row. The new
      // server still receives those committed votes immediately. New bundles
      // use fn_cast_tournament_deal_vote, whose wake survives a lost frame or
      // process crash; this compatibility listener can be removed only after
      // the old browser build is outside its cache lifetime.
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'tournament_deal_votes',
        },
        AsyncResource.bind((payload: { new?: Record<string, unknown> }) => {
          if (!this.running || this.tournamentManagerWakeChannel !== channel) return;
          const tournamentId = String(payload.new?.tournament_id ?? '');
          if (!tournamentId) return;
          this.tournamentEngines.get(tournamentId)?.requestEliminationSweep('deal_vote');
        }, 'GameServer.managerWakes.dealVote')
      );
    this.tournamentManagerWakeChannel = channel;
    channel.subscribe(
      AsyncResource.bind((status: string) => {
        if (this.tournamentManagerWakeChannel !== channel) return;
        if (status === 'SUBSCRIBED') {
          tournamentManagerWakeRealtimeConnected.set(1);
          this.tournamentManagerWakeReconnectBackoffMs = 1_000;
          // Subscription comes first, drain second: an INSERT cannot disappear
          // between the snapshot and the live frame. Duplicate delivery is
          // harmless because the scheduler coalesces by tournament.
          this.launchServerLifecycleJob(
            this.drainTournamentManagerWakes(),
            'GameServer.tournament_manager_wake_initial_drain_failed'
          );
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          tournamentManagerWakeRealtimeConnected.set(0);
          reportError(
            new Error(`Tournament manager wake channel entered ${status}`),
            'GameServer.tournament_manager_wake_channel_error'
          );
          this.launchServerLifecycleJob(
            this.drainTournamentManagerWakes(),
            'GameServer.tournament_manager_wake_error_drain_failed'
          );
        } else if (status === 'CLOSED') {
          tournamentManagerWakeRealtimeConnected.set(0);
          this.tournamentManagerWakeChannel = null;
          this.launchServerLifecycleJob(
            Promise.resolve(supabase.removeChannel(channel)),
            'GameServer.tournament_manager_wake_closed_channel_remove_failed'
          );
          this.launchServerLifecycleJob(
            this.drainTournamentManagerWakes(),
            'GameServer.tournament_manager_wake_closed_drain_failed'
          );
          this.scheduleTournamentManagerWakeSubscriptionReconnect();
        }
      }, 'GameServer.managerWakes.status')
    );
    // Boot is a causal recovery signal even if the transport never reports
    // SUBSCRIBED. This closes the process-start gap without a polling loop.
    this.launchServerLifecycleJob(
      this.drainTournamentManagerWakes(),
      'GameServer.tournament_manager_wake_boot_drain_failed'
    );
  }

  /** Recreate the durable-wake channel only after an actual close event. */
  private scheduleTournamentManagerWakeSubscriptionReconnect(): void {
    if (
      !this.running ||
      this.tournamentManagerWakeChannel ||
      this.tournamentManagerWakeReconnectTimer
    ) {
      return;
    }
    const delayMs = this.tournamentManagerWakeReconnectBackoffMs;
    this.tournamentManagerWakeReconnectBackoffMs = Math.min(
      60_000,
      this.tournamentManagerWakeReconnectBackoffMs * 2
    );
    this.tournamentManagerWakeReconnectTimer = setTimeout(() => {
      this.tournamentManagerWakeReconnectTimer = null;
      if (!this.running || this.tournamentManagerWakeChannel) return;
      this.startTournamentManagerWakeSubscription();
    }, delayMs);
    this.tournamentManagerWakeReconnectTimer.unref?.();
  }

  /**
   * Preserve one failed durable-read cause with bounded backoff. This timer is
   * armed only by that failure and is cancelled by shutdown or a newer direct
   * signal; it never scans a healthy queue periodically.
   */
  private scheduleTournamentManagerWakeDrainRetry(): void {
    if (!this.running) return;
    this.tournamentManagerWakeDrainRequested = true;
    if (this.tournamentManagerWakeDrainRetryTimer) return;

    const generation = ++this.tournamentManagerWakeDrainRetryGeneration;
    const delayMs = this.tournamentManagerWakeDrainRetryBackoffMs;
    this.tournamentManagerWakeDrainRetryBackoffMs = Math.min(
      30_000,
      this.tournamentManagerWakeDrainRetryBackoffMs * 2
    );
    this.tournamentManagerWakeDrainRetryTimer = setTimeout(() => {
      if (generation !== this.tournamentManagerWakeDrainRetryGeneration) return;
      this.tournamentManagerWakeDrainRetryTimer = null;
      if (!this.running) return;
      this.launchServerLifecycleJob(
        this.drainTournamentManagerWakes(),
        'GameServer.tournament_manager_wake_read_retry_failed'
      );
    }, delayMs);
    this.tournamentManagerWakeDrainRetryTimer.unref?.();
  }

  /** A clean global proof page retires the exact failed-read retry cause. */
  private resetTournamentManagerWakeDrainRetry(): void {
    this.tournamentManagerWakeDrainRetryBackoffMs = 250;
    if (!this.tournamentManagerWakeDrainRetryTimer) return;
    clearTimeout(this.tournamentManagerWakeDrainRetryTimer);
    this.tournamentManagerWakeDrainRetryTimer = null;
    this.tournamentManagerWakeDrainRetryGeneration++;
  }

  /**
   * Admit one durable browser-action wake and acknowledge it only after the
   * owning manager exists and its process-wide scheduler has accepted the
   * signal. A managerless row deliberately remains pending for adoption.
   */
  private async admitTournamentManagerWake(row: Record<string, unknown>): Promise<boolean> {
    const id = Number(row.id);
    const generation = Number(row.generation);
    const tournamentId = String(row.tournament_id ?? '');
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      !tournamentId ||
      row.consumed_at != null
    ) {
      return false;
    }
    const manager = this.tournamentEngines.get(tournamentId);
    if (!manager || !manager.isRunning()) return false;

    // Queue admission is not completion. Leave the row pending until the
    // manager finishes a full reason-aware sweep; a crash, lifecycle abort or
    // cooperative budget yield must be replayed by the next manager.
    return manager.requestEliminationSweep(String(row.reason ?? ''), id, generation);
  }

  /** Acknowledge durable action wakes only after their full sweep completed. */
  async acknowledgeTournamentManagerWakes(
    tournamentId: string,
    wakeReceipts: TournamentManagerWakeReceipt[]
  ): Promise<{ ok: boolean; current: TournamentManagerWakeDatabaseState[] }> {
    if (wakeReceipts.length === 0) return { ok: true, current: [] };
    const exactIds = new Set<number>();
    for (const wake of wakeReceipts) {
      if (
        !Number.isSafeInteger(wake.id) ||
        wake.id <= 0 ||
        !Number.isSafeInteger(wake.generation) ||
        wake.generation <= 0 ||
        exactIds.has(wake.id)
      ) {
        return { ok: false, current: [] };
      }
      exactIds.add(wake.id);
    }

    const current: TournamentManagerWakeDatabaseState[] = [];
    try {
      for (const chunk of chunkTournamentManagerWakeReceipts(wakeReceipts)) {
        const { data, error } = await supabase.rpc('fn_ack_tournament_manager_wakes', {
          p_tournament_id: tournamentId,
          p_wake_ids: chunk.map((wake) => wake.id),
          p_wake_generations: chunk.map((wake) => wake.generation),
        });
        const result = (data ?? {}) as {
          ok?: boolean;
          reason?: string;
          current_receipts?: unknown;
        };
        const rows = Array.isArray(result.current_receipts) ? result.current_receipts : [];
        const parsed = rows
          .map((value) => value as Record<string, unknown>)
          .map((value) => ({
            id: Number(value.id),
            generation: Number(value.generation),
            consumed: value.consumed === true,
          }));
        const expectedIds = new Set(chunk.map((wake) => wake.id));
        const validContract =
          parsed.length === chunk.length &&
          parsed.every(
            (wake) =>
              Number.isSafeInteger(wake.id) &&
              expectedIds.delete(wake.id) &&
              Number.isSafeInteger(wake.generation) &&
              wake.generation > 0
          ) &&
          expectedIds.size === 0;
        if (!error && result.ok === true && validContract) {
          current.push(...parsed);
          continue;
        }
        reportError(
          new Error(
            `[GameServer] exact tournament manager wake acknowledgement failed for ${tournamentId}: ${error?.message ?? result.reason ?? (validContract ? 'database refusal' : 'invalid acknowledgement contract')}`
          ),
          'GameServer.tournament_manager_wake_ack_failed'
        );
        return { ok: false, current };
      }
      return { ok: true, current };
    } catch (err) {
      reportError(err, 'GameServer.tournament_manager_wake_ack_threw');
      return { ok: false, current };
    }
  }

  /**
   * Crash/lost-frame defence for the Realtime-first bridge. Bounded globally,
   * and optionally narrowed to the manager that has just become runnable.
   */
  private async drainTournamentManagerWakes(tournamentId?: string): Promise<void> {
    if (tournamentId) {
      const drained = await this.drainTournamentManagerWakePages(tournamentId);
      if (!drained) this.scheduleTournamentManagerWakeDrainRetry();
      return;
    }

    // A fresh direct signal pre-empts an older failed-read delay. If this read
    // also fails, it re-arms the same backoff chain below.
    if (this.tournamentManagerWakeDrainRetryTimer) {
      clearTimeout(this.tournamentManagerWakeDrainRetryTimer);
      this.tournamentManagerWakeDrainRetryTimer = null;
      this.tournamentManagerWakeDrainRetryGeneration++;
    }
    // Every global cause latches, including one received after the current
    // pass issued its final SELECT but before it released ownership.
    this.tournamentManagerWakeDrainRequested = true;
    if (this.tournamentManagerWakeDrainInFlight) return;
    this.tournamentManagerWakeDrainInFlight = true;
    try {
      while (this.running && this.tournamentManagerWakeDrainRequested) {
        this.tournamentManagerWakeDrainRequested = false;
        const drained = await this.drainTournamentManagerWakePages();
        if (!drained) {
          this.scheduleTournamentManagerWakeDrainRetry();
          break;
        }
        this.resetTournamentManagerWakeDrainRetry();
      }
    } finally {
      this.tournamentManagerWakeDrainInFlight = false;
    }

    // Close the final-page edge: a signal that landed after the while check
    // but before ownership cleared must start the next pass itself.
    if (
      this.running &&
      this.tournamentManagerWakeDrainRequested &&
      !this.tournamentManagerWakeDrainRetryTimer
    ) {
      this.launchServerLifecycleJob(
        this.drainTournamentManagerWakes(),
        'GameServer.tournament_manager_wake_redrain_failed'
      );
    }
  }

  /** One bounded, keyset-paged snapshot of durable manager wake receipts. */
  private async drainTournamentManagerWakePages(tournamentId?: string): Promise<boolean> {
    const pageSize = tournamentId ? 50 : 200;
    let afterId = 0;
    for (;;) {
      let query = supabase
        .from('tournament_manager_wakes')
        .select('id,tournament_id,reason,generation,created_at,consumed_at')
        .is('consumed_at', null)
        .gt('id', afterId)
        .order('id', { ascending: true })
        .limit(pageSize);
      if (tournamentId) query = query.eq('tournament_id', tournamentId);
      const response = await (async () => {
        try {
          return await query;
        } catch (err) {
          reportError(err, 'GameServer.tournament_manager_wake_drain_read_threw');
          return null;
        }
      })();
      if (!response) return false;
      const { data, error } = response;
      if (error) {
        reportError(error, 'GameServer.tournament_manager_wake_drain_read_failed');
        return false;
      }
      const rows = data || [];
      for (const row of rows) {
        if (!this.running) return true;
        await this.admitTournamentManagerWake(row as Record<string, unknown>);
      }
      if (rows.length < pageSize) return true;
      afterId = Number(rows[rows.length - 1]?.id ?? 0);
      if (!Number.isSafeInteger(afterId) || afterId <= 0) {
        reportError(
          new Error('Tournament wake drain received a non-monotonic page cursor'),
          'GameServer.tournament_manager_wake_drain_cursor_invalid'
        );
        return false;
      }
      // Yield between bounded pages. This continues the same work signal;
      // it is not a timer, poll, cron, or later reconciliation pass.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Drain durable bounty obligations from Realtime/startup/thaw signals. The
   * database claims at most twenty rows per statement; if more work is due we
   * yield once and continue the SAME signal. A future mystery reveal arms the
   * exact persisted due instant. Nothing here runs from table/tournament
   * discovery and there is no polling interval.
   */
  private async sweepPendingTournamentBounties(): Promise<void> {
    if (this.bountyRecoverySweepInFlight) return;

    this.bountyRecoverySweepInFlight = true;
    bountyRecoverySweepInflight.set(1);
    const startedAt = Date.now();
    try {
      while (this.running && this.bountyRecoveryRequested) {
        this.bountyRecoveryRequested = false;
        if (isMaintenanceFrozen()) {
          bountyRecoverySweepRunsTotal.inc(1, { outcome: 'frozen' });
          break;
        }

        const { data, error } = await supabase.rpc('fn_sweep_pending_tournament_bounties', {
          p_tournament_id: null,
          p_limit: 20,
        });
        if (error) {
          bountyRecoverySweepRunsTotal.inc(1, { outcome: 'error' });
          reportError(error, 'GameServer.bounty_outbox_recovery_failed');
          this.armPendingTournamentBountyRecovery(this.bountyRecoveryTransportBackoffMs);
          this.bountyRecoveryTransportBackoffMs = Math.min(
            60_000,
            this.bountyRecoveryTransportBackoffMs * 2
          );
          break;
        }
        const answer = (Array.isArray(data) ? data[0] : data) as {
          ok?: boolean;
          pending?: number;
          processed?: number;
          failed?: number;
          reason?: string;
          retry_after_ms?: number | string | null;
          settled_tournament_ids?: unknown;
        } | null;
        if (answer?.ok !== true) {
          bountyRecoverySweepRunsTotal.inc(1, { outcome: 'error' });
          reportError(
            new Error(
              `[GameServer] bounty outbox recovery refused: ${answer?.reason ?? 'empty response'}`
            ),
            'GameServer.bounty_outbox_recovery_refused'
          );
          this.armPendingTournamentBountyRecovery(this.bountyRecoveryTransportBackoffMs);
          this.bountyRecoveryTransportBackoffMs = Math.min(
            60_000,
            this.bountyRecoveryTransportBackoffMs * 2
          );
          break;
        }

        this.bountyRecoveryTransportBackoffMs = 1_000;
        const pending = Math.max(0, Number(answer.pending) || 0);
        const processed = Math.max(0, Number(answer.processed) || 0);
        const failed = Math.max(0, Number(answer.failed) || 0);
        if (pending === 0 || processed > 0) this.bountyRecoveryContentionBackoffMs = 50;
        bountyRecoveryPending.set(pending);
        bountyRecoverySweepRunsTotal.inc(1, { outcome: failed > 0 ? 'partial' : 'completed' });

        // A successful payout can unblock a different manager from the one
        // that owned the recovery RPC. Wake it directly as well as through
        // the durable Realtime UPDATE, so same-process progress is immediate.
        const settledTournamentIds = Array.isArray(answer.settled_tournament_ids)
          ? [...new Set(answer.settled_tournament_ids.map((id) => String(id)))].slice(0, 20)
          : [];
        for (const tournamentId of settledTournamentIds) {
          this.tournamentEngines.get(tournamentId)?.requestEliminationSweep('bounty_settled');
        }

        if (failed > 0) {
          reportError(
            new Error(
              `[GameServer] bounty outbox recovery left ${failed} failed attempt(s); ${pending} pending`
            ),
            'GameServer.bounty_outbox_recovery_partial'
          );
        }
        if (pending === 0) continue;

        const retryAfterMs = Number(answer.retry_after_ms);
        if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
          reportError(
            new Error('[GameServer] pending bounty outbox has no valid retry_after_ms'),
            'GameServer.bounty_outbox_due_time_missing'
          );
          this.armPendingTournamentBountyRecovery(1_000);
          break;
        }
        if (retryAfterMs > 25) {
          this.armPendingTournamentBountyRecovery(retryAfterMs);
          break;
        }

        if (processed === 0) {
          // SKIP LOCKED can prove that work exists while another engine or
          // manager still owns the exact row. Back off this causal signal with
          // jitter so competing processes do not synchronize into a new RPC
          // storm. Any committed UPDATE still pre-empts this with an immediate
          // Realtime signal.
          const contentionDelayMs = Math.max(
            25,
            Math.floor(this.bountyRecoveryContentionBackoffMs * (0.75 + Math.random() * 0.5))
          );
          this.bountyRecoveryContentionBackoffMs = Math.min(
            1_000,
            this.bountyRecoveryContentionBackoffMs * 2
          );
          this.armPendingTournamentBountyRecovery(contentionDelayMs);
          break;
        }

        // The bounded page filled or a PKO predecessor just became eligible.
        // Continue this exact work signal after yielding to table actions.
        this.bountyRecoveryRequested = true;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (err) {
      bountyRecoverySweepRunsTotal.inc(1, { outcome: 'error' });
      reportError(err, 'GameServer.bounty_outbox_recovery_threw');
      this.armPendingTournamentBountyRecovery(this.bountyRecoveryTransportBackoffMs);
      this.bountyRecoveryTransportBackoffMs = Math.min(
        60_000,
        this.bountyRecoveryTransportBackoffMs * 2
      );
    } finally {
      this.bountyRecoverySweepInFlight = false;
      bountyRecoverySweepInflight.set(0);
      bountyRecoverySweepMs.observe(Date.now() - startedAt);
    }

    // Close the narrow edge where a Realtime frame arrived after the loop's
    // condition but before the in-flight flag cleared.
    if (this.running && this.bountyRecoveryRequested && !isMaintenanceFrozen()) {
      this.requestPendingTournamentBountyRecovery();
    }
  }

  /**
   * PAID SEATS FOR EVERY SEAT-FIRST GAME, IN TWO QUERIES (2026-08-23).
   *
   * A Spin starts when its seats are BOUGHT, so both start gates have to know
   * the live seat count. Asking per tournament meant two round trips each, and
   * with ~33 Spins on the board this ran ~13 extra queries a second, forever,
   * just to decide that nothing had changed. Batched here instead: one read
   * for the live tables, one for their seats.
   *
   * Extracted from discoverTournaments on 2026-08-28 so the seat-first fast
   * start loop (discoverSeatFirstStarts below) counts seats with EXACTLY the
   * same rules — same primary-table election, same telemetry — and the two
   * loops cannot drift apart.
   *
   * THE TABLE THE GAME IS ON, WHICH IS NOT ALWAYS THE NEWEST ONE.
   *
   * This used to take the freshest non-closed table, on the reasoning that the
   * recycler leaves the newest open and an older sibling not yet stamped
   * closed is a corpse. That is true of a RECYCLED table and false of a
   * DUPLICATE one, and these games are created with two `waiting` tables
   * about 0.6s apart: the players sit on the FIRST, and the empty one is
   * NEWER.
   *
   * Measured 2026-08-24: of 31 seat-first games past their start time, 28
   * were blocked this way and in 12 an empty table had outranked a sibling
   * holding every player in the game. Grouped by hour the count of games with
   * a duplicate live table equalled the count of stuck games exactly - 2/2,
   * 2/2, 9/9, 1/1, 1/1. One game had been waiting 486 minutes to deal.
   *
   * Occupancy first, oldest to break the tie. Identical to
   * fn_tournament_primary_table in the database and to the ordering
   * fn_seat_late_registrant already used, so the engine, the counter and the
   * seating path cannot disagree about which table is the game. Seats are
   * read for every live table rather than for one guessed table, which is
   * what makes the choice possible at all.
   */
  private async readSeatFirstPaidSeats(
    seatFirstRows: Array<{ id: string }>
  ): Promise<Map<string, number>> {
    const paidSeatsByTournament = new Map<string, number>();
    if (seatFirstRows.length === 0) return paidSeatsByTournament;

    const { data: liveTables, error: liveTablesErr } = await supabase
      .from('tables')
      .select('id, tournament_id, created_at')
      .in(
        'tournament_id',
        seatFirstRows.map((t) => t.id)
      )
      .neq('status', 'closed');
    if (liveTablesErr) {
      // A silent failure here read as paidSeats=0 fleet-wide and no
      // seat-first game could start, with zero telemetry (2026-08-24).
      reportError(
        new Error(`[GameServer] seat-first live-table read failed: ${liveTablesErr.message}`),
        'GameServer.seat_first_table_read_failed'
      );
    }

    const liveTableIds = (liveTables || [])
      .map((row) => String((row as { id?: string }).id ?? ''))
      .filter((id) => id.length > 0);
    if (liveTableIds.length > 0) {
      const { data: seatRows, error: seatRowsErr } = await supabase
        .from('table_seats')
        .select('table_id')
        .in('table_id', liveTableIds)
        .is('left_at', null);
      if (seatRowsErr) {
        reportError(
          new Error(`[GameServer] seat-first seat-count read failed: ${seatRowsErr.message}`),
          'GameServer.seat_first_seat_read_failed'
        );
      }

      const seatsByTable = new Map<string, number>();
      for (const s of seatRows || []) {
        const tbl = String((s as { table_id: string }).table_id);
        seatsByTable.set(tbl, (seatsByTable.get(tbl) ?? 0) + 1);
      }
      /* Most live seats wins; the oldest table breaks a tie so the
         ORIGINAL survives a duplicate and the answer is stable between
         passes. */
      const primaryTable = new Map<string, { id: string; seats: number; createdAt: number }>();
      for (const row of liveTables || []) {
        const tid = String((row as { tournament_id?: string }).tournament_id ?? '');
        if (!tid) continue;
        const id = String((row as { id?: string }).id ?? '');
        if (!id) continue;
        const createdAt = new Date(
          String((row as { created_at?: string }).created_at ?? 0)
        ).getTime();
        const seats = seatsByTable.get(id) ?? 0;
        const seen = primaryTable.get(tid);
        if (!seen || seats > seen.seats || (seats === seen.seats && createdAt < seen.createdAt)) {
          primaryTable.set(tid, { id, seats, createdAt });
        }
      }
      /**
       * SEATS SPLIT ACROSS DUPLICATE TABLES STILL COUNT (2026-08-28).
       *
       * The election above answers "which table IS the game", and that is the
       * right question for seating. It was also being used as the paid-seat
       * COUNT, which is a different question — it takes the max and discards
       * every seat on a sibling live table. These games are created with two
       * `waiting` tables about 0.6s apart (see the note above), so a 3-seat
       * spin can land 2+1 across the pair. That yielded paidSeats = 2, and
       * then nothing in the platform could see it:
       *
       *   - the main start gate needs paid >= max_players: never opens;
       *   - the fast lane uses the same number: skips it;
       *   - the fully-paid stall watchdog is gated on `paid < seats`, so it
       *     stays silent too.
       *
       * Three paid seats, no game, no telemetry, indefinitely. The money is
       * taken either way, so the honest count is every live seat the
       * tournament holds. The primary table still decides WHERE to seat.
       */
      const seatsByTournament = new Map<string, number>();
      for (const row of liveTables || []) {
        const tid = String((row as { tournament_id?: string }).tournament_id ?? '');
        const id = String((row as { id?: string }).id ?? '');
        if (!tid || !id) continue;
        seatsByTournament.set(tid, (seatsByTournament.get(tid) ?? 0) + (seatsByTable.get(id) ?? 0));
      }
      for (const [tid, tbl] of primaryTable) {
        const total = seatsByTournament.get(tid) ?? tbl.seats;
        if (total > tbl.seats) {
          console.warn(
            `[GameServer] Seat-first game ${tid.slice(0, 8)} has ${total} paid seat(s) split across ` +
              `duplicate live tables (primary ${tbl.id.slice(0, 8)} holds ${tbl.seats}) - counting all of them`
          );
        }
        paidSeatsByTournament.set(tid, total);
      }
    }
    return paidSeatsByTournament;
  }

  /**
   * ── SEAT-FIRST FAST START (Dan 2026-08-21, verbatim: "THE WHEEL STARTS
   * SPINNING THE MOMENT THE 3RD PLAYER PAYS FOR HIS SEAT") ──────────────────
   *
   * discoverTournaments carries the whole board on every pass: the MTT horse
   * ramp, the past-start top-up, and an await per tournament in between. With
   * ~180 games REGISTERING a full pass takes on the order of a minute under
   * load, so a spin whose last seat was bought just after its row was read
   * waited a whole pass to deal. Measured live 2026-08-28 against production:
   * median 62 seconds from third paid seat to started_at across 684 spins in
   * 24 hours, p90 88s, worst 3.5 minutes (the fully-paid stall watchdog) —
   * and the shared wheel reveal, which is anchored to the third payment, had
   * often expired before any client heard the game existed.
   *
   * This loop does exactly one job so its pass is three cheap reads: find
   * REGISTERING seat-first games, count their paid seats through the same
   * readSeatFirstPaidSeats the main loop uses, start the full ones. Every
   * other duty deliberately stays in discoverTournaments.
   *
   * Double-start safety: both loops re-check tournamentEngines synchronously
   * in the same tick they set it (no await between check and set), so two
   * managers can never be created for one id. A held manager that is not
   * running is the standdown zombie the fully-paid watchdog exists for —
   * TournamentManager.start() sets running=true on entry synchronously, so a
   * held-but-not-running manager has genuinely stood down or finished, and
   * deleting it here just lets the retry happen in 5s instead of 3 minutes.
   * start() itself re-validates the field and the payments, so a retry
   * against a game that stood down for a real reason stands down again.
   */
  private async discoverSeatFirstStarts(): Promise<void> {
    const generation = this.lifecycleGeneration;
    while (this.directAdmissionIsCurrent(generation)) {
      try {
        const { data: registering, error: registeringErr } = await supabase
          // start_time is selected for the window rule below: for a seat-first
          // game the recycler sets it to "when the human window ends" (see
          // seatFirstHumanWindowMs in TournamentRecurringService).
          .from('tournaments')
          .select('id, name, max_players, variant, start_time')
          .eq('status', 'REGISTERING')
          .in('variant', ['spin', 'sng']);
        if (registeringErr) {
          reportError(
            new Error(
              `[GameServer] seat-first fast-start board read failed: ${registeringErr.message}`
            ),
            'GameServer.seat_first_fast_board_read_failed'
          );
        } else {
          // Same seat-first definition as discoverTournaments and
          // fn_take_seat_and_buy_in: spin, or a 2-seat SNG (heads-up).
          const seatFirstRows = (registering || []).filter(
            (t) => t.variant === 'spin' || (t.variant === 'sng' && Number(t.max_players) <= 2)
          );
          const paidSeats = await this.readSeatFirstPaidSeats(seatFirstRows);
          for (const t of seatFirstRows) {
            if (!this.directAdmissionIsCurrent(generation)) break;
            // THE FREEZE IS TOTAL (Dan 2026-09-03): a seat-first start seats its
            // players and a partial fill buys horses in.
            if (isMaintenanceFrozen()) break;
            const id = String(t.id);
            const seats = Number(t.max_players) || 0;
            const paid = paidSeats.get(id) ?? 0;

            /**
             * ── AND THE WINDOW IS A WINDOW, NOT A WAIT (round 15) ───────────
             *
             * A horse-opened board holds its LAST seat for a human for 60-150
             * randomised seconds (seatFirstHumanWindowMs), and `start_time` is
             * the instant that window closes. After it closes the board is
             * supposed to fill itself immediately. Measured over 6 hours it
             * did not: median partial dwell 296s, p90 1,608s, worst 115
             * MINUTES, with 222 of 330 spins (67%) overshooting the 180s
             * ceiling and 89 sitting longer than ten minutes.
             *
             * The reason is the same one round 13 found for humans: the only
             * steady-state filler for a partial board lived in
             * discoverTournaments' past-start branch, the loop most disturbed
             * by an engine restart. So a board whose window had closed simply
             * waited for that loop to come back.
             *
             * A stale 2/3 board is not harmless: it still COVERS its price
             * point for ensureBoardOpen, so no replacement is created, and the
             * lobby fills with games that look joinable and never deal.
             *
             * The rule is therefore: fill a partial seat-first board when a
             * human is in it (round 13) OR when its human window has closed.
             * The window itself is untouched - it is honoured exactly, and
             * only the lateness is removed.
             */
            /**
             * ── A HUMAN IS NEVER LEFT WAITING (2026-08-29, round 13) ────────
             *
             * Dan, live, 18:06Z today: bought a seat in a held-empty Spin,
             * sat alone for 24 seconds while nothing came, gave up — and the
             * horses filled that exact game six minutes after he left.
             * Production showed why the wait was so erratic: the fill lived
             * only in discoverTournaments' past-start branch, and today's
             * twenty engine deploys each opened a 3-13 minute window where
             * that loop was not running (29 such windows in 12 hours). A
             * human who sits during one waits it out with no fill at all.
             *
             * So the FAST lane — the lightest loop in the process, running
             * from the first seconds of boot — now owns the human case too:
             * a partially-paid seat-first game with a HUMAN in a seat is
             * topped up immediately, per Dan's 2026-08-26 rule ("the moment
             * one does, topUpWithHorses fills the remaining seats"). A
             * partial game with only horses is left alone on purpose: that
             * is the horse-opened board holding its last seat for a human
             * (60-150s window), and the held-empty rotation — filling those
             * here would erase both designs.
             */
            if (seats > 0 && paid > 0 && paid < seats) {
              /* Has the human window closed? A missing or unparseable
                 start_time is treated as NOT closed, so a malformed row can
                 never cause a board to be filled early - it simply waits for
                 the human, which is the safe direction. */
              const startMs = t.start_time ? Date.parse(String(t.start_time)) : NaN;
              const windowClosed = Number.isFinite(startMs) && startMs <= Date.now();
              this.launchDiscoveryJob(
                this.fillPartialSeatFirstGame(id, seats, paid, windowClosed),
                'GameServer.human_seat_first_fill_error',
                { tournamentId: id }
              );
            }

            if (seats <= 0 || paid < seats) continue;

            /**
             * A PARKED LAUNCH IS LEFT ALONE (2026-09-10). The "stop the dead
             * manager, start a fresh one" below is what turned one refused
             * draw into ~87 database calls a second across the board: the
             * manager stood down for a reason the database had just said was
             * deterministic, and this pass restarted it a second later. The
             * draw path (spinLaunchParking.ts) now parks the id with a
             * doubling window; until that window ends, nothing here touches
             * it, not even the stale-manager stop.
             */
            if (spinLaunchParks.isParked(id)) continue;

            const held = this.tournamentEngines.get(id);
            if (held && !held.isRunning()) {
              await this.stopTournamentManagerIfOwned(
                id,
                held,
                'GameServer.seat_first_fast_stale_manager_stop_failed'
              );
            }
            if (this.tournamentEngines.has(id)) continue;

            this.launchDiscoveryJob(
              this.ensureTournamentManagerAdmission(
                id,
                'start',
                `Fast-starting seat-first game: ${t.name} (${paid}/${seats} seats sold)`,
                generation
              ),
              'GameServer.seat_first_fast_start_failed',
              { tournamentId: id }
            );
          }
        }
      } catch (err) {
        reportError(err, 'GameServer.seat_first_fast_start_error');
      }
      /* ONE SECOND, not five. See SEAT_FIRST_START_INTERVAL: Dan's rule is a
         number, and four fifths of the old floor was this line. */
      await this.sleep(SEAT_FIRST_START_INTERVAL);
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  BRING A STRANDED PLAYER BACK TO THE FELT
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The rules, and the tournament that sat silent for 5h21m holding them
   * apart, are in `tournament/orphanedSeatRepair.ts`. This method is the one
   * read that finds the shape and the hand-off to the manager that owns the
   * move; the move itself goes through `executePlayerMoves`, the only hardened
   * seat-move path on the platform, so this sweep writes no seat rows itself.
   *
   * A tournament with no live manager on this instance is left for the next
   * pass: discovery adopts it within a cycle and the repair runs then. Doing
   * the move without a manager would mean re-implementing the move, which is
   * how the duplicate-seat incidents of 2026-08-20 and 2026-08-25 happened.
   */
  private async repairOrphanedTournamentSeats(): Promise<void> {
    if (this.tournamentEngines.size === 0) return;

    for (const [tournamentId, tm] of this.tournamentEngines) {
      if (!tm.isRunning()) continue;
      try {
        const moved = await tm.absorbOrphanedSeats();
        if (moved > 0) {
          console.warn(
            `[GameServer] Orphaned-seat repair: ${moved} stranded player(s) moved back onto open felt in tournament ${tournamentId.slice(0, 8)}`
          );
        }
      } catch (err) {
        reportError(err, 'GameServer.orphan_seat_repair_failed');
      }
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  REOPEN A TABLE THAT WAS CLOSED UNDER A LIVE TOURNAMENT
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The rules, and the two outages that wrote them, are in
   * `services/liveTournamentTableRecovery.ts`. The planner there is pure; this
   * method is the three reads and the two writes around it.
   *
   * Every read fails CLOSED: an unreadable board is UNKNOWN, never "reopen
   * everything". The writes are per plan rather than batched so one bad row
   * cannot stop the rest, and the status filter on the UPDATE makes the
   * reopen a no-op if something opened the table in the meantime.
   */
  private async reopenTablesClosedUnderLiveTournaments(): Promise<void> {
    const { data: liveRows, error: liveErr } = await supabase
      .from('tournaments')
      .select('id, status, start_time')
      .in('status', ['REGISTERING', 'RUNNING'])
      .limit(500);
    if (liveErr) {
      reportError(
        new Error(`[GameServer] reopen sweep tournament read failed: ${liveErr.message}`),
        'GameServer.reopen_sweep_tournament_read_failed'
      );
      return;
    }
    const tournaments = (liveRows ?? []) as LiveTournamentRow[];
    if (tournaments.length === 0) return;

    const { data: tableRows, error: tableErr } = await supabase
      .from('tables')
      .select('id, tournament_id, status, is_deleted, created_at')
      .in(
        'tournament_id',
        tournaments.map((t) => String(t.id))
      );
    if (tableErr) {
      reportError(
        new Error(`[GameServer] reopen sweep table read failed: ${tableErr.message}`),
        'GameServer.reopen_sweep_table_read_failed'
      );
      return;
    }
    const tables = (tableRows ?? []) as TournamentTableRow[];

    /* Seat counts for the CLOSED candidates only. A seat row survives its
       table being closed - that is exactly what stranded 411 of them on
       2026-08-30 - so this is the count the reopened table gets back. */
    const closedIds = tables
      .filter((t) => t.is_deleted !== true && String(t.status ?? '').toLowerCase() === 'closed')
      .map((t) => String(t.id));
    const openSeatsByTable = new Map<string, number>();
    if (closedIds.length > 0) {
      const { data: seatRows, error: seatErr } = await supabase
        .from('table_seats')
        .select('table_id')
        .in('table_id', closedIds)
        .is('left_at', null);
      if (seatErr) {
        reportError(
          new Error(`[GameServer] reopen sweep seat read failed: ${seatErr.message}`),
          'GameServer.reopen_sweep_seat_read_failed'
        );
        return;
      }
      for (const row of seatRows ?? []) {
        const id = String((row as { table_id?: string }).table_id ?? '');
        if (!id) continue;
        openSeatsByTable.set(id, (openSeatsByTable.get(id) ?? 0) + 1);
      }
    }

    const plans = planTableReopens(tournaments, tables, openSeatsByTable);
    if (plans.length === 0) return;

    let reopened = 0;
    for (const plan of plans) {
      const { error: reopenErr } = await supabase
        .from('tables')
        .update({ status: plan.toStatus, current_players: plan.currentPlayers })
        .eq('id', plan.tableId)
        .eq('status', 'closed');
      if (reopenErr) {
        reportError(
          new Error(
            `[GameServer] reopen of ${plan.tableId.slice(0, 8)} failed: ${reopenErr.message}`
          ),
          'GameServer.reopen_sweep_update_failed'
        );
        continue;
      }
      reopened++;

      if (plan.refreshHumanWindow) {
        /* The window closed hours ago. Hand the board a fresh one rather than
           straight to the past-start filler, so a repaired game is a game that
           was open, not one that was filled the instant it came back. Same
           rule as fn_repair_seat_first_games. */
        const { error: windowErr } = await supabase
          .from('tournaments')
          .update({ start_time: new Date(Date.now() + freshHumanWindowMs()).toISOString() })
          .eq('id', plan.tournamentId)
          .eq('status', 'REGISTERING');
        if (windowErr) {
          reportError(
            new Error(
              `[GameServer] human window refresh for ${plan.tournamentId.slice(0, 8)} failed: ${windowErr.message}`
            ),
            'GameServer.reopen_sweep_window_refresh_failed'
          );
        }
      }
    }

    if (reopened > 0) {
      console.log(
        `[GameServer] Reopened ${reopened} table(s) that were closed under a live tournament`
      );
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  FINISH THE SEAT-FIRST GAMES THAT ARE ALREADY OVER (round 18)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * See the call site for the production evidence. The test is deliberately
   * three conditions that must ALL hold, each one wide of a healthy game:
   *
   *   1. RUNNING and started more than STUCK_MIN_AGE_MS ago — a start, with
   *      its 16.6s reveal hold, is nowhere near this;
   *   2. no hand dealt for STUCK_NO_HAND_MS — a live table deals constantly,
   *      and every stuck game in production had been silent for 17+ minutes;
   *   3. at most ONE seat still holds chips — which is the definition of the
   *      game being decided.
   *
   * Any one of them alone would be a guess. Together they described exactly
   * the nine broken games on the live board and none of the healthy ones.
   */
  private async finishSeatFirstGamesThatAreOver(): Promise<void> {
    /**
     * THE FREEZE (Dan 2026-09-01), and this one is not a courtesy skip.
     * This sweep decides a spin is OVER partly from "no hand recorded in the
     * last three minutes" - and during a five-minute freeze that is true of
     * every healthy spin on the platform. Unguarded, the first sweep after
     * :58 would force-finish LIVE games whose only crime was obeying the
     * break, paying them out mid-tournament. Frozen time is not silence.
     */
    if (isMaintenanceFrozen()) return;
    /** Old enough that a start, and its reveal hold, cannot be in progress. */
    const STUCK_MIN_AGE_MS = 5 * 60 * 1000;
    /** Silent long enough that the table has genuinely stopped dealing. */
    const STUCK_NO_HAND_MS = 3 * 60 * 1000;
    const now = Date.now();

    const { data: running, error: runningErr } = await supabase
      .from('tournaments')
      .select('id, name, variant, max_players, started_at')
      .eq('status', 'RUNNING')
      .in('variant', ['spin', 'sng'])
      .lt('started_at', new Date(now - STUCK_MIN_AGE_MS).toISOString());
    if (runningErr) {
      reportError(
        new Error(`[GameServer] seat-first finish sweep board read failed: ${runningErr.message}`),
        'GameServer.seat_first_finish_board_read_failed'
      );
      return;
    }

    const candidates = (running || []).filter(
      (t) => t.variant === 'spin' || (t.variant === 'sng' && Number(t.max_players) <= 2)
    );
    if (candidates.length === 0) return;

    for (const t of candidates) {
      const id = String(t.id);
      try {
        const { data: tables, error: tablesErr } = await supabase
          .from('tables')
          .select('id')
          .eq('tournament_id', id);
        if (tablesErr) throw tablesErr;
        const tableIds = (tables || []).map((r) => String(r.id));
        if (tableIds.length === 0) continue;

        /* Is anything still being dealt? One row is enough to answer it. */
        const { data: recentHand, error: handErr } = await supabase
          .from('hand_history')
          .select('id')
          .in('table_id', tableIds)
          .gte('created_at', new Date(now - STUCK_NO_HAND_MS).toISOString())
          .limit(1);
        if (handErr) throw handErr;
        if (recentHand && recentHand.length > 0) continue; // still playing

        /* How many seats still hold chips? Two or more and the game is not
           decided, however quiet it is — leave it alone. */
        const { data: seats, error: seatsErr } = await supabase
          .from('table_seats')
          .select('user_id, stack')
          .in('table_id', tableIds)
          .is('left_at', null)
          .gt('stack', 0);
        if (seatsErr) throw seatsErr;
        const liveStacks = new Set((seats || []).map((s) => String(s.user_id))).size;
        if (liveStacks > 1) continue;

        // A zero stack is an elimination event, not permission for an external
        // watchdog to choose a winner. Wake (or adopt) the one manager whose
        // bounded elimination transaction owns standings and the immutable
        // RUNNING -> COMPLETING claim.
        const claimedManager = this.tournamentEngines.get(id);
        if (claimedManager) {
          claimedManager.requestEliminationSweep('seat_first_terminal_stack');
        } else {
          await this.ensureTournamentManagerAdmission(
            id,
            'resume',
            `Resuming seat-first terminal state: ${t.name}`,
            this.lifecycleGeneration
          );
        }
      } catch (err) {
        reportError(err, 'GameServer.seat_first_finish_sweep_failed', { tournamentId: id });
      }
    }
  }

  /** Per-game throttle for fillPartialSeatFirstGame - one attempt per 12s. */
  private lastHumanFillAt = new Map<string, number>();
  /**
   * Consecutive top-ups that came back short, per game. Drives the backoff in
   * fillPartialSeatFirstGame; cleared the moment a top-up fills the board.
   */
  private seatFirstFillMisses = new Map<string, number>();
  /** Per-game throttle for the human-waiting alarm - one report per 60s. */
  private lastHumanWaitReportAt = new Map<string, number>();

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  FILL A HUMAN'S GAME NOW (2026-08-29, round 13)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Called from the seat-first fast lane for any REGISTERING spin/heads-up
   * with SOME seats paid but not all. If one of those seats belongs to a
   * HUMAN, the game is committed (Dan 2026-08-26: "The moment one does,
   * topUpWithHorses fills the remaining seats") and the remaining seats are
   * filled immediately. If every occupant is a horse, this does nothing -
   * that partial game is the horse-opened board deliberately holding its
   * last seat for a human, and taking it here would erase that design.
   *
   * Every read is error-bound, and a fill that comes back short of the
   * shortfall raises `seat_first_human_waiting` (throttled) - a human
   * sitting in an unfillable game is precisely the situation that must
   * never be silent again.
   */
  private async fillPartialSeatFirstGame(
    tournamentId: string,
    seats: number,
    paid: number,
    windowClosed: boolean
  ): Promise<void> {
    const now = Date.now();
    const last = this.lastHumanFillAt.get(tournamentId) ?? 0;
    /* BACK OFF A BOARD THAT WILL NOT FILL (2026-09-02).

       Measured on the live engine: 96 Deep Stack Society seat-first boards
       (heads-up and 3-max) with their human window closed 2.5 to 25 HOURS
       ago, each retried here every 12 s and each coming back "top-up added 0
       of 1 needed" - 400 refusals per five minutes. Every attempt is two
       RPCs, fn_sync_seat_first_player_count (160 ms) and
       fn_seat_horse_in_seat_first_game (849 ms): 278,970 and 21,781 calls
       since the 09-01 stats reset, ~7 calls a second, roughly a whole core of
       a two-core database spent re-asking a question whose answer had not
       changed since yesterday. That is the same database every hand, every
       buy-in and every socket handshake was queueing behind.

       So a board that keeps coming back short is asked less and less often:
       12 s, 24 s, 48 s ... up to ten minutes, and the counter resets the
       moment a top-up fills it. Only the WINDOW-CLOSED trigger backs off. A
       board with a HUMAN in a seat keeps the 12 s cadence - Dan 2026-08-29,
       a human is never left waiting - and if that board cannot fill either,
       seat_first_human_waiting still says so once a minute. */
    const misses = windowClosed ? (this.seatFirstFillMisses.get(tournamentId) ?? 0) : 0;
    const interval = Math.min(12_000 * 2 ** Math.min(misses, 6), 10 * 60_000);
    if (now - last < interval) return;
    this.lastHumanFillAt.set(tournamentId, now);

    /* ROUND 15 OPTIMISATION. When the human window has already closed the
       board fills regardless of WHO is sitting in it, so the two reads that
       exist purely to answer "is one of them a human" are pure waste. Skip
       straight to the top-up and spend nothing. Only a board still inside its
       window has to ask, because there the answer decides. */
    if (windowClosed) {
      await this.topUpPartialSeatFirst(tournamentId, seats, paid, 'window closed');
      return;
    }

    const { data: primaryId, error: primErr } = await supabase.rpc('fn_tournament_primary_table', {
      p_tournament_id: tournamentId,
    });
    if (primErr || !primaryId) {
      if (primErr) {
        reportError(
          new Error(`[GameServer] human-fill primary-table read failed: ${primErr.message}`),
          'GameServer.human_fill_primary_table_read_failed'
        );
      }
      return;
    }

    const { data: occupants, error: occErr } = await supabase
      .from('table_seats')
      .select('user_id')
      .eq('table_id', String(primaryId))
      .is('left_at', null);
    if (occErr) {
      reportError(
        new Error(`[GameServer] human-fill occupant read failed: ${occErr.message}`),
        'GameServer.human_fill_occupant_read_failed'
      );
      return;
    }
    const ids = (occupants || [])
      .map((o) => String((o as { user_id?: string }).user_id ?? ''))
      .filter((v) => v.length > 0);
    if (ids.length === 0) return;

    const { data: profiles, error: profErr } = await supabase
      .from('profiles')
      .select('id, is_horse')
      .in('id', ids);
    if (profErr) {
      reportError(
        new Error(`[GameServer] human-fill profile read failed: ${profErr.message}`),
        'GameServer.human_fill_profile_read_failed'
      );
      return;
    }
    const hasHuman = (profiles || []).some((p) => !(p as { is_horse?: boolean }).is_horse);
    if (!hasHuman) return;

    await this.topUpPartialSeatFirst(tournamentId, seats, paid, 'a human is waiting');
  }

  /**
   * The top-up itself, shared by both triggers (a human is seated, or the
   * human window has closed). A fill that comes back short raises
   * `seat_first_human_waiting`, throttled per game — a board that cannot be
   * filled is exactly the situation that must never be silent, whichever
   * trigger asked for it.
   */
  private async topUpPartialSeatFirst(
    tournamentId: string,
    seats: number,
    paid: number,
    why: string
  ): Promise<void> {
    const added = await this.tournamentRecurring.topUpWithHorses(tournamentId, seats);
    const shortfall = seats - paid;
    // See the backoff in fillPartialSeatFirstGame: a filled board forgets its
    // misses, a short one counts another.
    if (added >= shortfall) this.seatFirstFillMisses.delete(tournamentId);
    else
      this.seatFirstFillMisses.set(
        tournamentId,
        (this.seatFirstFillMisses.get(tournamentId) ?? 0) + 1
      );
    if (added > 0) {
      console.log(
        `[GameServer] Seat-first fill: +${added} horse(s) into ${tournamentId.slice(0, 8)} ` +
          `(${paid}/${seats} paid, ${why})`
      );
    }
    if (added < shortfall) {
      const now = Date.now();
      const lastReport = this.lastHumanWaitReportAt.get(tournamentId) ?? 0;
      if (now - lastReport >= 60_000) {
        this.lastHumanWaitReportAt.set(tournamentId, now);
        reportError(
          new Error(
            `[GameServer] SEAT-FIRST BOARD CANNOT FILL ${tournamentId.slice(0, 8)}: ` +
              `${paid}/${seats} paid, top-up added ${added} of ${shortfall} needed (${why})`
          ),
          'GameServer.seat_first_human_waiting'
        );
      }
    }
  }

  /**
   * Register a table engine (used by TournamentManager for tournament tables)
   */
  registerTableEngine(tableId: string, engine: ServerTableEngine): boolean {
    // A manager callback already awaiting I/O when shutdown began must not
    // publish a dealer after stop() has taken its engine snapshot.
    if (!this.running) return false;
    // Admission is synchronous and fail-closed. An independent manager may
    // discover the same table while the owning manager is still draining, but
    // it cannot evict that generation or start a second dealer. Intentional
    // replacement goes through replaceTableEngine(), which awaits teardown and
    // repeats the identity check after the await.
    if (!admitOwnedTableEngine(this.tableEngines, this.tournamentOwnedTables, tableId, engine)) {
      return false;
    }
    // Tournament tables get the same treatment as cash ones. The tournament
    // break suspends the blind clock; this keeps cards off the felt.
    this.maintenanceBreak.adopt(tableId, engine);
    return true;
  }

  /**
   * Replace one exact tournament table-engine generation after its complete
   * teardown. The incumbent remains in the global map while stop is pending or
   * rejected, and a post-await identity CAS prevents a stale revival sweep from
   * overwriting a generation installed by another owner.
   */
  async replaceTableEngine(
    tableId: string,
    expected: ServerTableEngine,
    replacement: ServerTableEngine
  ): Promise<boolean> {
    if (!this.running) return false;
    // A lost transport response may follow a committed seat move. The old
    // source engine remains the physical fence until that exact UUID replays;
    // replacing it here would let the successor deal from an unknown roster.
    if (expected.hasClaimedTournamentMoveBoundary()) return false;
    let replaced = false;
    try {
      replaced = await replaceOwnedTableEngine(
        this.tableEngines,
        this.tournamentOwnedTables,
        tableId,
        expected,
        replacement,
        () => !expected.hasClaimedTournamentMoveBoundary()
      );
    } catch (error) {
      // ServerTableEngine reports cleanup failures only after releasing its
      // process-global scheduler ownership. When that exact fence is proven,
      // retaining the terminal object would turn a diagnostic into a permanent
      // outage. Any failure before the fence remains quarantined.
      if (!expected.hasReleasedProcessOwnership() || this.tableEngines.get(tableId) !== expected) {
        throw error;
      }
      reportError(error, 'GameServer.tournament_table_teardown_cleanup_failed', { tableId });
      this.tableEngines.set(tableId, replacement);
      this.tournamentOwnedTables.add(tableId);
      replaced = true;
    }
    if (!replaced) return false;
    if (!this.running) {
      await replacement.stop().catch(() => undefined);
      unregisterOwnedTournamentTableEngine(
        this.tableEngines,
        this.tournamentOwnedTables,
        tableId,
        replacement,
        () => tableStateHub.dropTable(tableId)
      );
      return false;
    }
    tableStateHub.dropTable(tableId);
    this.maintenanceBreak.adopt(tableId, replacement);
    return true;
  }

  /**
   * Drop one exact stopped tournament engine from the process-wide registry.
   * A retiring manager may finish after a successor has claimed the same table
   * id, so this is identity-CAS rather than a table-id-only delete.
   */
  unregisterTournamentTableEngine(tableId: string, engine: ServerTableEngine): boolean {
    return unregisterOwnedTournamentTableEngine(
      this.tableEngines,
      this.tournamentOwnedTables,
      tableId,
      engine,
      () => tableStateHub.dropTable(tableId)
    );
  }

  /**
   * Release a terminal tournament manager's table engine after that exact
   * instance has stopped and the caller has durably closed the table. A stale
   * manager must never delete a replacement dealer that won the same map slot
   * while its shutdown was awaiting I/O.
   *
   * Returning false means a different live instance owns the slot. A missing
   * slot is already unregistered and is therefore an idempotent success.
   */
  unregisterTableEngine(tableId: string, engine: ServerTableEngine): boolean {
    const current = this.tableEngines.get(tableId);
    if (current === undefined) {
      this.tournamentOwnedTables.delete(tableId);
      tableStateHub.dropTable(tableId);
      return true;
    }
    if (current !== engine) return false;
    this.tableEngines.delete(tableId);
    this.tournamentOwnedTables.delete(tableId);
    tableStateHub.dropTable(tableId);
    return true;
  }

  /**
   * Stop whichever engine currently owns a tournament table, but only after a
   * fresh database read proves that table is terminal. This closes the narrow
   * race where a replacement takes GameServer's map slot while the tournament
   * manager is awaiting its old engine's stop. The post-await unregister is
   * still exact-instance guarded, so a second replacement can never be erased.
   */
  async stopClosedTournamentTableEngine(tableId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('tables')
      .select('status, tournament_id')
      .eq('id', tableId)
      .maybeSingle();
    const row = data as { status?: string | null; tournament_id?: string | null } | null;
    if (error || !row || row.status !== 'closed' || !row.tournament_id) {
      reportError(
        new Error(
          `[GameServer] refused terminal engine stop for ${tableId}: ${error?.message ?? `status=${row?.status ?? 'missing'}, tournament=${row?.tournament_id ?? 'missing'}`}`
        ),
        'GameServer.terminal_table_engine_stop_unproven'
      );
      return false;
    }

    const current = this.tableEngines.get(tableId);
    if (!current) {
      // The desired map state already holds. Finish the two terminal ownership
      // tails that no future engine-map reaper can discover once the slot is
      // absent.
      this.tournamentOwnedTables.delete(tableId);
      tableStateHub.dropTable(tableId);
      return true;
    }

    try {
      await current.stop();
    } catch (stopError) {
      if (!current.hasReleasedProcessOwnership()) {
        reportError(stopError, 'GameServer.terminal_table_engine_stop_failed', { tableId });
        return false;
      }
      // Durable table closure makes the snapshot recovery-only. Preserve the
      // diagnostic while allowing only the exact, fully released generation
      // captured above to leave the process registry.
      reportError(stopError, 'GameServer.terminal_table_engine_stop_cleanup_failed', { tableId });
    }
    return this.unregisterTableEngine(tableId, current);
  }

  /**
   * Ensure one newly-created cash table has a live engine before an authorized
   * WebSocket viewer is admitted.
   *
   * Background discovery is intentionally occupancy-driven so thousands of
   * abandoned empty lobby rows do not consume an engine forever. That makes it
   * the wrong primitive for Create And Start: the client opens the table before
   * anybody has bought a seat. This on-demand path validates the durable table,
   * takes the same lease as discovery, installs the map entry synchronously to
   * collapse concurrent connects, and lets start() publish the waiting snapshot
   * as soon as its database reads complete.
   */
  async ensureCashTableEngine(tableId: string): Promise<boolean> {
    let outcome: DirectTableAdmission;
    try {
      outcome = await this.ensureCashTableEngineAdmission(tableId);
    } catch (error) {
      reportError(error, 'GameServer.on_demand_table_admission_threw', { tableId });
      this.scheduleDirectTableRecovery(tableId, 'on_demand_admission_threw');
      return false;
    }
    this.finishDirectTableAdmission(tableId, 'on_demand_admission_failed', outcome);
    return outcome === 'ready';
  }

  private async ensureCashTableEngineAdmission(tableId: string): Promise<DirectTableAdmission> {
    const existingAdmission = this.directTableAdmissionOperations.get(tableId);
    if (existingAdmission) return existingAdmission;

    const generation = this.lifecycleGeneration;
    const operation = this.awaitDealerPrerequisites(generation).then((ready) =>
      ready ? this.performCashTableEngineAdmission(tableId, generation) : 'not_wakeable'
    );
    const tracked = operation.finally(() => {
      if (this.directTableAdmissionOperations.get(tableId) === tracked) {
        this.directTableAdmissionOperations.delete(tableId);
      }
    });
    this.directTableAdmissionOperations.set(tableId, tracked);
    return tracked;
  }

  private directAdmissionIsCurrent(generation: number): boolean {
    return this.running && this.lifecycleGeneration === generation;
  }

  private resetDealerPrerequisiteGate(generation: number): void {
    let resolve!: (ready: boolean) => void;
    const promise = new Promise<boolean>((settle) => {
      resolve = settle;
    });
    this.dealerPrerequisitesReady = false;
    this.dealerPrerequisiteGate = { generation, promise, resolve, settled: false };
  }

  private settleDealerPrerequisiteGate(generation: number, ready: boolean): void {
    const gate = this.dealerPrerequisiteGate;
    if (!gate || gate.generation !== generation || gate.settled) return;
    gate.settled = true;
    gate.resolve(ready);
  }

  private publishDealerPrerequisitesReady(generation: number): boolean {
    if (!this.directAdmissionIsCurrent(generation)) return false;
    const gate = this.dealerPrerequisiteGate;
    if (!gate || gate.generation !== generation || gate.settled) return false;
    this.dealerPrerequisitesReady = true;
    this.settleDealerPrerequisiteGate(generation, true);
    return true;
  }

  private revokeDealerPrerequisites(generation: number): void {
    const gate = this.dealerPrerequisiteGate;
    if (!gate || gate.generation !== generation) return;
    this.dealerPrerequisitesReady = false;
    this.settleDealerPrerequisiteGate(generation, false);
  }

  private dealerAdmissionIsCurrent(generation: number): boolean {
    return this.directAdmissionIsCurrent(generation) && this.dealerPrerequisitesReady;
  }

  private async awaitDealerPrerequisites(generation: number): Promise<boolean> {
    if (!this.directAdmissionIsCurrent(generation)) return false;
    if (this.dealerAdmissionIsCurrent(generation)) return true;
    const gate = this.dealerPrerequisiteGate;
    if (!gate || gate.generation !== generation) return false;
    const ready = await gate.promise;
    return ready && this.dealerAdmissionIsCurrent(generation);
  }

  private async performCashTableEngineAdmission(
    tableId: string,
    generation: number
  ): Promise<DirectTableAdmission> {
    if (!(await this.awaitDealerPrerequisites(generation))) return 'not_wakeable';
    const existingStart = this.tableEngineStartPromises.get(tableId);
    if (existingStart) return existingStart;
    const existingEngine = this.tableEngines.get(tableId);
    if (existingEngine) {
      if (existingEngine.isRunning()) return 'ready';
      void this.recoverDirectTableEngine(
        tableId,
        existingEngine,
        'dead_generation_seen_during_admission'
      ).catch((recoveryError) =>
        reportError(recoveryError, 'GameServer.dead_generation_admission_recovery_threw', {
          tableId,
        })
      );
      return 'retryable_failure';
    }

    await this.awaitDirectTableLeaseRelease(tableId);
    if (!this.dealerAdmissionIsCurrent(generation)) return 'not_wakeable';

    let table: Parameters<typeof isWakeableCashTable>[0];
    let error: { message: string } | null = null;
    try {
      const result = await supabase
        .from('tables')
        .select('id, tournament_id, status, game_type, is_deleted')
        .eq('id', tableId)
        .maybeSingle();
      table = result.data;
      error = result.error;
    } catch (lookupError) {
      reportError(lookupError, 'GameServer.on_demand_table_lookup_threw', { tableId });
      return 'retryable_failure';
    }

    if (!this.dealerAdmissionIsCurrent(generation)) return 'not_wakeable';

    if (error) {
      reportError(
        new Error(`On-demand table lookup failed for ${tableId}: ${error.message}`),
        'GameServer.on_demand_table_lookup_failed'
      );
      return 'retryable_failure';
    }
    if (!isWakeableCashTable(table)) {
      // No lease was acquired by this operation, so there is nothing it may
      // safely release. A table-id/instance-only release here can delete a
      // tournament manager's lease or a concurrent discovery grant.
      return 'not_wakeable';
    }

    const requestedLeaseGeneration =
      this.directTableAdmissionLeaseGenerations.get(tableId) ?? randomUUID();
    this.directTableAdmissionLeaseGenerations.set(tableId, requestedLeaseGeneration);
    const lease = await claimTableLease(tableId, requestedLeaseGeneration);
    const uncertainLeaseGeneration =
      lease.status === 'acquired_but_proof_expired'
        ? lease.leaseGeneration
        : lease.status === 'retryable_failure' && lease.mayHaveCommitted
          ? lease.requestedGeneration
          : null;
    if (uncertainLeaseGeneration) {
      this.directTablePendingLeaseReleases.set(tableId, uncertainLeaseGeneration);
      try {
        await this.awaitDirectTableLeaseRelease(tableId);
      } catch (releaseError) {
        reportError(releaseError, 'GameServer.uncertain_cash_claim_release_unconfirmed', {
          tableId,
          leaseGeneration: uncertainLeaseGeneration,
        });
      }
      return 'retryable_failure';
    }
    if (lease.status === 'retryable_failure') return 'retryable_failure';
    if (lease.status === 'owned_elsewhere') return 'owned_elsewhere';
    if (lease.status !== 'granted') return 'retryable_failure';
    const grantedLeaseGeneration = lease.leaseGeneration;
    if (!this.dealerAdmissionIsCurrent(generation)) {
      // Shutdown won while the lease RPC was in flight. Hand the exact lease
      // back before resolving so no post-snapshot dealer can escape stop().
      const staleGeneration = lease.leaseGeneration;
      this.directTablePendingLeaseReleases.set(tableId, staleGeneration);
      try {
        await this.awaitDirectTableLeaseRelease(tableId);
      } catch (releaseError) {
        reportError(releaseError, 'GameServer.stale_cash_admission_release_unconfirmed', {
          tableId,
          leaseGeneration: staleGeneration,
        });
      }
      return 'not_wakeable';
    }
    // Another authorized connection may have completed the same wake while the
    // lease call was in flight. Never construct a second dealer, and hand back
    // the exact generation acquired by this losing admission before returning
    // the incumbent. Otherwise a tournament-table publication race leaves an
    // invisible protocol-2 row alive.
    const racedStart = this.tableEngineStartPromises.get(tableId);
    if (racedStart) {
      if (grantedLeaseGeneration) {
        this.directTablePendingLeaseReleases.set(tableId, grantedLeaseGeneration);
        try {
          await this.awaitDirectTableLeaseRelease(tableId);
        } catch (releaseError) {
          reportError(releaseError, 'GameServer.raced_cash_start_release_unconfirmed', {
            tableId,
            leaseGeneration: grantedLeaseGeneration,
          });
        }
      }
      return racedStart;
    }
    const racedEngine = this.tableEngines.get(tableId);
    if (racedEngine) {
      if (grantedLeaseGeneration) {
        this.directTablePendingLeaseReleases.set(tableId, grantedLeaseGeneration);
        try {
          await this.awaitDirectTableLeaseRelease(tableId);
        } catch (releaseError) {
          reportError(releaseError, 'GameServer.raced_cash_engine_release_unconfirmed', {
            tableId,
            leaseGeneration: grantedLeaseGeneration,
          });
        }
      }
      if (racedEngine.isRunning()) return 'ready';
      void this.recoverDirectTableEngine(
        tableId,
        racedEngine,
        'dead_generation_won_admission_race'
      ).catch((recoveryError) =>
        reportError(recoveryError, 'GameServer.dead_generation_race_recovery_threw', {
          tableId,
        })
      );
      return 'retryable_failure';
    }

    const engine = new ServerTableEngine(tableId, {
      scope: 'cash',
      verified: true,
      generation: lease.leaseGeneration,
      proofDeadlineMonotonicMs: lease.proofDeadlineMonotonicMs,
    });
    engine.setHub(tableStateHub);
    this.wireDirectTableEngineRecovery(tableId, engine);
    this.tableEngines.set(tableId, engine);
    /* The caller UUID is retryable only until one dealer object consumes it.
       A startup failure retires that object and its exact database generation;
       its successor must choose a new UUID so delayed work from the retired
       dealer can never become authoritative again after re-admission. */
    this.directTableAdmissionLeaseGenerations.delete(tableId);
    // On-demand wake during a break: the player gets the break screen, not a
    // table that deals to them alone.
    this.maintenanceBreak.adopt(tableId, engine);
    const readyPromise = this.trackDirectTableEngineReadiness(tableId, engine);
    void engine
      .start()
      .catch(async (startError) => {
        this.engineStartFailures++;
        reportError(startError, 'GameServer.direct_table_start_failed');
        await this.recoverDirectTableEngine(tableId, engine, 'direct_start_failed', true);
      })
      .catch((recoveryError) => {
        reportError(recoveryError, 'GameServer.direct_table_start_recovery_threw', {
          tableId,
        });
        this.scheduleDirectTableRecovery(tableId, 'direct_start_recovery_threw');
      });
    /* ═══ READY IS NOT DEALING (2026-09-05) ═══
       `start()` resolves when the dealing loop begins, i.e. once the table has
       its AutoStart figure of players. Returning THAT here meant every
       on-demand caller - GET /state, GET /actions, the WS ensureTable, the
       cluster wake (its BUG 4 of 2026-09-05: one lone-seated Main 1 parked
       the whole controller) - waited for a second player before it could
       serve the first. What they need is `engine.ready`: row loaded,
       sub-engines configured, waiting snapshot publishable. The start chain
       above keeps running for its failure handling; only the promise the
       caller gets has changed. `ready` settles false when start fails before
       `waiting`, and true means the engine is in the map and publishing. */
    const readiness = await readyPromise;
    return this.dealerAdmissionIsCurrent(generation) ? readiness : 'not_wakeable';
  }

  /**
   * Get a table engine by ID (used by HTTP action endpoint)
   */
  getTableEngine(tableId: string): ServerTableEngine | undefined {
    return this.tableEngines.get(tableId);
  }

  /**
   * Synchronous identity proof for a TournamentManager about to mutate a
   * source table.  The engine object and the ownership classification must
   * agree; a recovery swaps the global object before it swaps the manager's
   * local map, and that post-await window may never authorize a seat move.
   */
  ownsTournamentTableEngine(tableId: string, engine: ServerTableEngine): boolean {
    return this.tableEngines.get(tableId) === engine && this.tournamentOwnedTables.has(tableId);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
