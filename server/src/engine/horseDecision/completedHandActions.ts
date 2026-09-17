import type { ActionRecord } from '../../types.js';
import type { ReadScope } from '../HorseMind.js';

// The existing accepted-history binding has the same 4096-record ceiling.
// This limit bounds the new learning projection, not settlement or a decision.
const MAX_ACTIONS = 4096;
const ACTIONS = new Set(['fold', 'check', 'call', 'bet', 'raise', 'all_in', 'discard']);
const STAGES = new Set(['preflop', 'flop', 'pineapple_discard', 'turn', 'river', 'showdown']);

/** The live decision sees HandController.actionHistory, whereas the accepted
 * list also contains forced posts, returns, insurance and RIT pseudo-actions.
 * Preserve exactly the controller-action order/fields so observe() reuses its
 * existing first-action hand key and per-action deduplication. This projection
 * never replaces the full accepted list or reassigns its canonical ordinals.
 *
 * Missing legacy scalar fields refuse the entire new basic-read update; they
 * are not guessed from a later receipt, a current roster or the local clock.
 * Existing deep-read compatibility is handled separately by the caller.
 * These local shape checks do not authenticate an accepted transaction.
 */
export function completedHandActionsForMind(
  actions: unknown,
  scope: unknown
): { actions: ActionRecord[]; scope: ReadScope | null } | null {
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    actions.length > MAX_ACTIONS ||
    (scope !== undefined &&
      scope !== null &&
      (typeof scope !== 'string' || !/^(holdem|omaha|sixplus):(hu|short|full)$/.test(scope)))
  )
    return null;

  const projected: ActionRecord[] = [];
  for (const raw of actions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.action !== 'string' || !a.action.length) return null;
    // Accounting and display records are not controller actions. Do not
    // manufacture participation for their actors (including the system row).
    if (!ACTIONS.has(a.action)) continue;
    if (
      !Number.isInteger(a.seat) ||
      (a.seat as number) < 1 ||
      (a.seat as number) > 10 ||
      typeof a.userId !== 'string' ||
      a.userId.length === 0 ||
      a.userId.length > 256 ||
      typeof a.amount !== 'number' ||
      !Number.isFinite(a.amount) ||
      a.amount < 0 ||
      !Number.isSafeInteger(a.timestamp) ||
      (a.timestamp as number) < 0 ||
      typeof a.stage !== 'string' ||
      !STAGES.has(a.stage) ||
      (a.isFullRaise !== undefined && typeof a.isFullRaise !== 'boolean')
    )
      return null;
    projected.push({
      seat: a.seat as number,
      userId: a.userId,
      action: a.action as ActionRecord['action'],
      amount: a.amount,
      timestamp: a.timestamp as number,
      stage: a.stage as ActionRecord['stage'],
      ...(a.isFullRaise === undefined ? {} : { isFullRaise: a.isFullRaise }),
    });
  }
  return projected.length
    ? { actions: projected, scope: (scope ?? null) as ReadScope | null }
    : null;
}
