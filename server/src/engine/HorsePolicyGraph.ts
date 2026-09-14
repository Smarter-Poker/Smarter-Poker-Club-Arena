import type { HorseDecision } from '../types.js';

/** Executable outer decision order. Reference internals and the authoritative
 * table executor retain their own contracts; this is not a full Phase15 ledger. */
export const HORSE_POLICY_ORDER = Object.freeze([
  'reference',
  'reference_legality',
  'variant_policy',
  'tournament_utility',
  'tournament_continuation',
  'variant_utility_guard',
  'joint_policy',
  'timing',
] as const);
export type HorsePolicyNode = (typeof HORSE_POLICY_ORDER)[number];
export interface HorsePolicyAction {
  action: HorseDecision['action'];
  amount: number | null;
}
export interface HorsePolicyTransition {
  node: HorsePolicyNode;
  before: HorsePolicyAction | null;
  after: HorsePolicyAction;
  changed: boolean;
  elapsedMs: number;
}
export interface HorsePolicyGraphReceipt {
  version: 'horse-policy-order-v1';
  transitions: HorsePolicyTransition[];
  finalAction: HorsePolicyAction;
}
function snapshot(decision: HorseDecision): HorsePolicyAction {
  if (
    !decision ||
    !['fold', 'check', 'call', 'bet', 'raise', 'all_in', 'discard'].includes(decision.action)
  )
    throw new Error('Horse policy graph returned an invalid action');
  if (decision.amount !== undefined && (!Number.isFinite(decision.amount) || decision.amount < 0))
    throw new Error('Horse policy graph returned an invalid amount');
  return { action: decision.action, amount: decision.amount ?? null };
}
function same(a: HorsePolicyAction, b: HorsePolicyAction): boolean {
  return a.action === b.action && a.amount === b.amount;
}

/** One instance owns exactly one decision. A node executes only after its
 * predecessor and must consume that predecessor's action. No I/O or RNG. */
export class HorsePolicyGraph {
  private readonly transitions: HorsePolicyTransition[] = [];
  private sealed = false;
  private executing = false;
  private failed = false;
  constructor(private readonly now: () => number = () => performance.now()) {}

  run<T extends { decision: HorseDecision }>(
    node: HorsePolicyNode,
    previous: HorseDecision | null,
    execute: () => T
  ): T {
    if (
      this.sealed ||
      this.failed ||
      this.executing ||
      HORSE_POLICY_ORDER[this.transitions.length] !== node
    )
      throw new Error('Horse policy graph node is out of order');
    const before = previous === null ? null : snapshot(previous);
    const predecessor = this.transitions.at(-1)?.after;
    if (
      (predecessor && (!before || !same(before, predecessor))) ||
      (!predecessor && before !== null)
    )
      throw new Error('Horse policy graph predecessor does not match');
    this.executing = true;
    const start = this.now();
    try {
      const result = execute();
      const after = snapshot(result.decision);
      // Think-time can consume its usual private RNG but cannot reopen policy.
      if (node === 'timing' && before && !same(before, after))
        throw new Error('Horse policy timing changed the selected action');
      const elapsedMs = this.now() - start;
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
        throw new Error('Horse policy graph clock is invalid');
      this.transitions.push({
        node,
        before,
        after,
        changed: before !== null && !same(before, after),
        elapsedMs,
      });
      return result;
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.executing = false;
    }
  }

  finish(decision: HorseDecision): HorseDecision {
    if (
      this.failed ||
      this.executing ||
      this.sealed ||
      this.transitions.length !== HORSE_POLICY_ORDER.length
    )
      throw new Error('Horse policy graph is incomplete');
    const finalAction = snapshot(decision);
    if (!same(finalAction, this.transitions.at(-1)!.after))
      throw new Error('Horse policy graph final action does not match');
    this.sealed = true;
    return {
      ...decision,
      policyGraph: { version: 'horse-policy-order-v1', transitions: this.transitions, finalAction },
    };
  }
}
