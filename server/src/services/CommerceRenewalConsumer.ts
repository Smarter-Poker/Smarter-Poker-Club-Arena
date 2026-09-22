/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB AND UNION DIAMOND COSTS - the durable renewal consumer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), Phase 4.2. A renewal
 * authorization is a durable row (ca_commerce_renewal_mandates) with a due
 * time; a trial reminder is a durable notice with a due time. This process is
 * their named owner: on the leader it wakes on a short interval, claims due
 * work under a lease (fn_ca_commerce_claim_due_renewals, FOR UPDATE SKIP
 * LOCKED), executes each mandate once (fn_ca_commerce_execute_renewal, which
 * re-validates authority, price ceiling, lateness and funds inside the same
 * atomic purchase boundary the owner uses), and delivers due notices
 * (fn_ca_commerce_deliver_due_notices).
 *
 * The interval is a WAKE SIGNAL, never the record (EVENT-DRIVEN-EXECUTION.md).
 * Nothing here repairs, back-pays or retries a charge on its own: a mandate
 * that could not be executed leaves a visible needs_attention state and a
 * notice to the payer, and the next due mandate is independent of it. A lease
 * that expires is reclaimed by whichever leader is alive; a stale lease token
 * is refused by the database, so two processes never execute one mandate.
 *
 * During the hourly maintenance freeze nothing is claimed: the platform is
 * frozen for the whole break, and a renewal charge is a money movement.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';

export const COMMERCE_RENEWAL_POLL_MS = Number(process.env.COMMERCE_RENEWAL_POLL_MS ?? 60_000);
const CLAIM_LIMIT = 10;
const NOTICE_LIMIT = 100;

export interface CommerceConsumerStatus {
  active: boolean;
  lastWakeAt: string | null;
  lastRenewals: { claimed: number; renewed: number; attention: number; leaseLost: number } | null;
  lastNoticesDelivered: number | null;
  lastError: string | null;
}

interface ClaimedMandate {
  id: string;
  scope_kind: string;
  scope_id: string;
  sku: string;
  due_at: string;
}

interface ExecuteResult {
  success?: boolean;
  error?: string;
  outcome?: 'renewed' | 'needs_attention';
  reason?: string;
}

/** The database calls the consumer makes; injectable so the loop is testable without Postgres. */
export interface CommerceConsumerDoors {
  claim(leaseToken: string, limit: number): Promise<ClaimedMandate[]>;
  execute(mandateId: string, leaseToken: string): Promise<ExecuteResult>;
  deliverNotices(limit: number): Promise<number>;
  frozen(): boolean;
}

const rpcDoors: CommerceConsumerDoors = {
  async claim(leaseToken, limit) {
    const { data, error } = await supabase.rpc('fn_ca_commerce_claim_due_renewals', {
      p_lease_token: leaseToken,
      p_limit: limit,
    });
    if (error) throw new Error(`fn_ca_commerce_claim_due_renewals: ${error.message}`);
    return (data ?? []) as ClaimedMandate[];
  },
  async execute(mandateId, leaseToken) {
    const { data, error } = await supabase.rpc('fn_ca_commerce_execute_renewal', {
      p_mandate_id: mandateId,
      p_lease_token: leaseToken,
    });
    if (error) throw new Error(`fn_ca_commerce_execute_renewal: ${error.message}`);
    return (data ?? {}) as ExecuteResult;
  },
  async deliverNotices(limit) {
    const { data, error } = await supabase.rpc('fn_ca_commerce_deliver_due_notices', {
      p_limit: limit,
    });
    if (error) throw new Error(`fn_ca_commerce_deliver_due_notices: ${error.message}`);
    return Number(data ?? 0);
  },
  frozen: isMaintenanceFrozen,
};

let doors: CommerceConsumerDoors = rpcDoors;
let timer: NodeJS.Timeout | null = null;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlight = new Set<Promise<void>>();
const status: CommerceConsumerStatus = {
  active: false,
  lastWakeAt: null,
  lastRenewals: null,
  lastNoticesDelivered: null,
  lastError: null,
};

const lifecycleIsCurrent = (generation: number): boolean =>
  lifecycleActive && lifecycleGeneration === generation;

export function commerceRenewalConsumerStatus(): CommerceConsumerStatus {
  return { ...status };
}

/** Test seam: replace the database doors. Never called in production. */
export function __setCommerceConsumerDoors(next: CommerceConsumerDoors | null): void {
  doors = next ?? rpcDoors;
}

/**
 * One wake: claim due mandates under a fresh lease and execute each once,
 * then deliver due notices. Every step is fenced on the lifecycle generation,
 * so a stopped consumer never executes a mandate it claimed before the stop
 * (the lease expires and a live leader reclaims it).
 */
export async function wakeCommerceConsumer(generation: number): Promise<void> {
  if (!lifecycleIsCurrent(generation)) return;
  status.lastWakeAt = new Date().toISOString();
  if (doors.frozen()) return;
  const leaseToken = crypto.randomUUID();
  const summary = { claimed: 0, renewed: 0, attention: 0, leaseLost: 0 };
  try {
    const claimed = await doors.claim(leaseToken, CLAIM_LIMIT);
    if (!lifecycleIsCurrent(generation)) return;
    summary.claimed = claimed.length;
    for (const mandate of claimed) {
      if (!lifecycleIsCurrent(generation) || doors.frozen()) break;
      const result = await doors.execute(mandate.id, leaseToken);
      if (result.error === 'lease_lost') summary.leaseLost += 1;
      else if (result.outcome === 'renewed') summary.renewed += 1;
      else summary.attention += 1;
      console.log(
        `[CommerceRenewal] ${mandate.scope_kind} ${mandate.scope_id} ${mandate.sku} due ${mandate.due_at}: ${
          result.error ?? result.outcome ?? 'unknown'
        }${result.reason ? ` (${result.reason})` : ''}`
      );
    }
    status.lastRenewals = summary;
    if (!lifecycleIsCurrent(generation)) return;
    status.lastNoticesDelivered = await doors.deliverNotices(NOTICE_LIMIT);
    status.lastError = null;
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : String(err);
    reportError(err, 'CommerceRenewalConsumer.wake');
  }
}

function launchWake(): void {
  const generation = lifecycleGeneration;
  if (!lifecycleIsCurrent(generation) || inFlight.size > 0) return;
  const tracked: Promise<void> = wakeCommerceConsumer(generation).finally(() =>
    inFlight.delete(tracked)
  );
  inFlight.add(tracked);
}

async function drain(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

export function startCommerceRenewalConsumer(): void {
  if (lifecycleActive) return;
  lifecycleActive = true;
  lifecycleGeneration += 1;
  stopOperation = null;
  status.active = true;
  launchWake();
  timer = setInterval(launchWake, COMMERCE_RENEWAL_POLL_MS);
  timer.unref?.();
}

export function stopCommerceRenewalConsumer(): Promise<void> {
  if (stopOperation) return stopOperation;
  lifecycleActive = false;
  lifecycleGeneration += 1;
  status.active = false;
  if (timer) clearInterval(timer);
  timer = null;
  stopOperation = drain();
  return stopOperation;
}
