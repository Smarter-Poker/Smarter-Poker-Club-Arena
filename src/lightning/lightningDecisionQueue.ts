/**
 * LIGHTNING PHASE 8: THE DECISION QUEUE, AS THE CLIENT HOLDS IT.
 *
 * The engine announces every decision the player owes in any Lightning hand
 * to every Lightning room they have open (USER_EVENT 'lightning_decision'),
 * and retracts it when it is no longer owed ('lightning_decision_cleared').
 * This store keeps one entry per hand, keyed by the engine's hand id, so the
 * same announcement arriving through three rooms is one entry.
 *
 * THE CLOCK IS THE ENGINE'S. `deadline_at` is engine epoch ms; the countdown
 * is `deadline_at - serverNow()`, the same server-offset clock the felt's own
 * timer uses. The client never invents a deadline.
 *
 * THE QUEUE NEVER MOVES THE VIEW (CLAUDE.md 10.6, "NEVER AUTO-CHANGE
 * TABLES"). It is read by a strip that lists the rooms in order of time left
 * and highlights them; the player taps to focus one. Nothing here, and
 * nothing that reads it, changes which table is shown without that tap.
 */
import { serverNow } from '../utils/serverClock';

export type LightningDecisionUrgency = 'normal' | 'high' | 'critical';

export interface LightningDecisionEntry {
  poolSessionId: string;
  handId: string;
  street: string;
  /** Engine epoch ms the decision runs out. */
  deadlineAt: number;
}

/** The engine's thresholds (LightningRegistry): 5 s critical, 10 s high. */
export const LIGHTNING_DECISION_CRITICAL_MS = 5_000;
export const LIGHTNING_DECISION_HIGH_MS = 10_000;
/** An entry this long past its deadline with no retraction is dropped (the hand moved on). */
export const LIGHTNING_DECISION_STALE_MS = 3_000;

export function lightningDecisionUrgency(remainingMs: number): LightningDecisionUrgency {
  if (remainingMs <= LIGHTNING_DECISION_CRITICAL_MS) return 'critical';
  if (remainingMs <= LIGHTNING_DECISION_HIGH_MS) return 'high';
  return 'normal';
}

const entries = new Map<string, LightningDecisionEntry>();
const listeners = new Set<() => void>();
let version = 0;
let cachedVersion = -1;
let cached: LightningDecisionEntry[] = [];

function emit(): void {
  version++;
  for (const l of listeners) l();
}

/**
 * Feed one private frame. True when it was a decision frame (consumed);
 * false for every other USER_EVENT, which the caller handles as before.
 */
export function noteLightningUserEvent(
  payload: Record<string, unknown> | null | undefined
): boolean {
  const type = payload?.type;
  if (type === 'lightning_cluster_status') {
    noteLightningClusterStatus(payload);
    return true;
  }
  if (type !== 'lightning_decision' && type !== 'lightning_decision_cleared') return false;
  const handId = typeof payload?.hand_id === 'string' ? payload.hand_id : '';
  if (!handId) return true;
  if (type === 'lightning_decision_cleared') {
    if (entries.delete(handId)) emit();
    return true;
  }
  const room = typeof payload?.pool_session_id === 'string' ? payload.pool_session_id : '';
  const deadline = Number(payload?.deadline_at);
  if (!room || !Number.isFinite(deadline) || deadline <= 0) return true;
  const street = typeof payload?.street === 'string' ? payload.street : '';
  const prev = entries.get(handId);
  if (
    prev &&
    prev.deadlineAt === deadline &&
    prev.poolSessionId === room &&
    prev.street === street
  ) {
    return true;
  }
  entries.set(handId, { poolSessionId: room, handId, street, deadlineAt: deadline });
  emit();
  return true;
}

/** Drop entries well past their deadline (a retraction lost on a dropped socket). */
export function pruneLightningDecisions(nowServerMs = serverNow()): void {
  let changed = false;
  for (const [id, e] of entries) {
    if (e.deadlineAt + LIGHTNING_DECISION_STALE_MS < nowServerMs) {
      entries.delete(id);
      changed = true;
    }
  }
  if (changed) emit();
}

/** Owed decisions, soonest deadline first (ties by room id, so the order is stable). */
export function lightningDecisions(): LightningDecisionEntry[] {
  if (cachedVersion !== version) {
    cached = [...entries.values()].sort(
      (a, b) =>
        a.deadlineAt - b.deadlineAt ||
        (a.poolSessionId < b.poolSessionId ? -1 : a.poolSessionId > b.poolSessionId ? 1 : 0)
    );
    cachedVersion = version;
  }
  return cached;
}

/** Free of React on purpose: the socket client feeds this store. The hook is useLightningDecisions. */
export function subscribeLightningDecisions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The most pressing urgency per room right now (rooms with nothing owed are absent). */
export function lightningUrgencyByRoom(
  list: readonly LightningDecisionEntry[],
  nowServerMs: number
): Record<string, LightningDecisionUrgency> {
  const rank: Record<LightningDecisionUrgency, number> = { normal: 0, high: 1, critical: 2 };
  const out: Record<string, LightningDecisionUrgency> = {};
  for (const e of list) {
    const u = lightningDecisionUrgency(e.deadlineAt - nowServerMs);
    const prior = out[e.poolSessionId];
    if (!prior || rank[u] > rank[prior]) out[e.poolSessionId] = u;
  }
  return out;
}

/** Tests only. */
export function resetLightningDecisionsForTests(): void {
  entries.clear();
  emit();
}

// ─── LIGHTNING PHASE 13: A HELD CLUSTER, AS ITS ROOMS ARE TOLD ───────────────

/**
 * The engine tells every room of a Cluster when it stops forming hands
 * (USER_EVENT 'lightning_cluster_status'): 'ending' while it drains back to
 * MUST MOVE, 'paused' while an operator holds it, null when it forms again.
 * Kept per Cluster here (the socket client feeds it, beside the decisions) so
 * the room can say "Lightning Is Ending" before it closes. It never moves the
 * view (CLAUDE.md 10.6): it is words, nothing else.
 */
export type LightningClusterStatus = 'ending' | 'paused';

const clusterStatuses = new Map<string, LightningClusterStatus>();
const statusListeners = new Set<() => void>();

function noteLightningClusterStatus(payload: Record<string, unknown> | null | undefined): void {
  const clusterId = typeof payload?.cluster_id === 'string' ? payload.cluster_id : '';
  if (!clusterId) return;
  const raw = payload?.status;
  const status: LightningClusterStatus | null = raw === 'ending' || raw === 'paused' ? raw : null;
  if ((clusterStatuses.get(clusterId) ?? null) === status) return;
  if (status === null) clusterStatuses.delete(clusterId);
  else clusterStatuses.set(clusterId, status);
  for (const l of statusListeners) l();
}

/** What the engine last said about this Cluster's hold (null: it forms, or nothing was said). */
export function lightningClusterStatus(
  clusterId: string | null | undefined
): LightningClusterStatus | null {
  return clusterId ? (clusterStatuses.get(clusterId) ?? null) : null;
}

export function subscribeLightningClusterStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/** Tests only. */
export function resetLightningClusterStatusForTests(): void {
  clusterStatuses.clear();
  for (const l of statusListeners) l();
}
