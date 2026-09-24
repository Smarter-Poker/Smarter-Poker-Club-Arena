/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB AND UNION DIAMOND COSTS - the durable renewal consumer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), Phase 4.2 and 6.4. A renewal
 * authorization is a durable row (ca_commerce_renewal_mandates) with a due
 * time; an approved refund is a durable request (ca_commerce_refund_requests);
 * a trial reminder or a 72-hour balance check is a durable notice with a due
 * time. This process is their named owner. On the leader it wakes on a short
 * interval and, in this order:
 *
 *   1. claims due mandates under a lease (fn_ca_commerce_claim_due_renewals,
 *      FOR UPDATE SKIP LOCKED). The claim also stamps the consumer heartbeat
 *      on EVERY call, due work or not: the launch cohort refuses to enrol
 *      anybody unless this consumer has woken in the last ten minutes, because
 *      nobody else delivers their reminders or executes their renewals;
 *   2. executes each mandate once (fn_ca_commerce_execute_renewal, which
 *      re-validates authority, price ceiling, lateness, sponsorship and funds
 *      inside the same atomic purchase boundary the owner uses);
 *   3. executes approved refunds (fn_ca_commerce_execute_approved_refunds):
 *      the trusted server route the spec requires, in service context,
 *      through the exact-value refund core, each exactly once with the
 *      request id as its request key. A refund the wallet cannot receive yet
 *      stays `owed` with its reason and is attempted again on the next wake.
 *      That is this consumer executing its own obligation when it can be
 *      executed; no live path paid it first, and nothing else will;
 *   4. delivers due notices (fn_ca_commerce_deliver_due_notices), deciding a
 *      balance check against the price in effect that day.
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

const REFUND_LIMIT = 10;

export interface CommerceConsumerStatus {
  active: boolean;
  lastWakeAt: string | null;
  lastRenewals: { claimed: number; renewed: number; attention: number; leaseLost: number } | null;
  lastRefunds: { claimed: number; refunded: number; owed: number; failed: number } | null;
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

interface RefundRunResult {
  success?: boolean;
  error?: string;
  claimed?: number;
  refunded?: number;
  owed?: number;
  failed?: number;
}

/** The database calls the consumer makes; injectable so the loop is testable without Postgres. */
export interface CommerceConsumerDoors {
  claim(leaseToken: string, limit: number): Promise<ClaimedMandate[]>;
  execute(mandateId: string, leaseToken: string): Promise<ExecuteResult>;
  executeRefunds(leaseToken: string, limit: number): Promise<RefundRunResult>;
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
  async executeRefunds(leaseToken, limit) {
    const { data, error } = await supabase.rpc('fn_ca_commerce_execute_approved_refunds', {
      p_lease_token: leaseToken,
      p_limit: limit,
    });
    if (error) throw new Error(`fn_ca_commerce_execute_approved_refunds: ${error.message}`);
    return (data ?? {}) as RefundRunResult;
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
  lastRefunds: null,
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
 * One wake: claim due mandates under a fresh lease (stamping the heartbeat)
 * and execute each once, then execute approved refunds, then deliver due
 * notices. Every step is fenced on the lifecycle generation and on the
 * maintenance freeze, so a stopped consumer never executes a mandate it
 * claimed before the stop (the lease expires and a live leader reclaims it)
 * and nothing moves diamonds while the platform is frozen.
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
    // A refund is a money movement: never during the freeze. The notices
    // below are not, so a freeze that began mid-wake still lets them go out.
    if (!doors.frozen()) {
      const refunds = await doors.executeRefunds(leaseToken, REFUND_LIMIT);
      if (refunds.success === false) {
        throw new Error(
          `fn_ca_commerce_execute_approved_refunds refused: ${refunds.error ?? 'unknown'}`
        );
      }
      status.lastRefunds = {
        claimed: Number(refunds.claimed ?? 0),
        refunded: Number(refunds.refunded ?? 0),
        owed: Number(refunds.owed ?? 0),
        failed: Number(refunds.failed ?? 0),
      };
      if (status.lastRefunds.claimed > 0) {
        console.log(
          `[CommerceRenewal] refunds claimed ${status.lastRefunds.claimed}: refunded ${status.lastRefunds.refunded}, owed ${status.lastRefunds.owed}, failed ${status.lastRefunds.failed}`
        );
      }
    }
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
