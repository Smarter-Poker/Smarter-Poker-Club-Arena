/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROMPT LANE - one ask on screen at a time
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Found on the first device walkthrough, 2026-09-29. A player signing in met
 * every first-run question at once. The notifications sheet armed its timer at
 * sign-in and rose while the terms were still up; the analytics question rose
 * 2.5 seconds after sign-in underneath the age gate; the two sheets then sat
 * on top of each other at the bottom of the screen, and after an under-18
 * refusal signed the account out, both were still there on the sign-in form.
 * Every prompt had its own timer and none of them knew the others existed.
 *
 * The rule now lives here, in one place:
 *
 *   GATES hold the lane while an answer is owed: the terms, the age gate, the
 *   first-run welcome and the profile gate. A gate renders itself exactly as
 *   before; holding the lane only tells everything else to wait.
 *
 *   SOFT ASKS take turns, in SOFT_ASK_ORDER, and only while no gate holds:
 *   the daily bonus sheet, then the analytics question, then notifications.
 *   One at a time. The ask on screen keeps its turn until it is answered - a
 *   later ask never pushes it off - and a gate that appears mid-way hides it
 *   until the gate is answered.
 *
 *   An ask's own "let the player land first" delay should count only while
 *   the lane is CLEAR for it (`clear` below), so a sheet never lands the
 *   instant the player finishes the previous one.
 *
 * Module state, not React context, on purpose: the prompts are mounted in
 * different subtrees (the app root, inside the terms guard, inside the
 * layout) and none of them should have to be moved to share a provider.
 */

import { useEffect, useSyncExternalStore } from 'react';

export type PromptGate = 'terms' | 'age' | 'welcome' | 'profile';

/** The order soft asks are shown in when more than one is waiting. */
export const SOFT_ASK_ORDER = ['daily-bonus', 'analytics-consent', 'push'] as const;
export type SoftAsk = (typeof SOFT_ASK_ORDER)[number];

/* Counted, not a Set: a host can mount the same prompt twice in passing
   (the daily bonus lives in two hosts), and one unmount must not release a
   hold the other still has. */
const gateHolds = new Map<PromptGate, number>();
const readyAsks = new Map<SoftAsk, number>();
let owner: SoftAsk | null = null;
const listeners = new Set<() => void>();

function bump<K>(map: Map<K, number>, key: K, by: 1 | -1): void {
  const next = (map.get(key) ?? 0) + by;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

function settle(): void {
  if (owner && !readyAsks.has(owner)) owner = null;
  if (!owner && gateHolds.size === 0) {
    owner = SOFT_ASK_ORDER.find((ask) => readyAsks.has(ask)) ?? null;
  }
}

function publish(): void {
  settle();
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A primitive snapshot, so useSyncExternalStore compares it by value. */
function snapshot(): string {
  return `${gateHolds.size > 0 ? 'gated' : 'open'}|${owner ?? ''}`;
}

/** Hold the lane while `holding` - for a gate that owes the player a question. */
export function useHoldPromptLane(gate: PromptGate, holding: boolean): void {
  useEffect(() => {
    if (!holding) return undefined;
    bump(gateHolds, gate, 1);
    publish();
    return () => {
      bump(gateHolds, gate, -1);
      publish();
    };
  }, [gate, holding]);
}

export interface PromptTurn {
  /** This ask holds the turn and may render now. */
  onScreen: boolean;
  /** Nothing else is asking: no gate holds, and no other soft ask is on screen. */
  clear: boolean;
}

/**
 * For a soft ask. `ready` means it has something to show right now. Render
 * only while `onScreen`; arm any "let the player land" delay only while
 * `clear`.
 */
export function usePromptTurn(ask: SoftAsk, ready: boolean): PromptTurn {
  useEffect(() => {
    if (!ready) return undefined;
    bump(readyAsks, ask, 1);
    publish();
    return () => {
      bump(readyAsks, ask, -1);
      publish();
    };
  }, [ask, ready]);
  const [lane, current] = useSyncExternalStore(subscribe, snapshot, snapshot).split('|');
  const gated = lane === 'gated';
  return {
    onScreen: ready && !gated && current === ask,
    clear: !gated && (current === '' || current === ask),
  };
}

/** True while any gate holds the lane. */
export function usePromptLaneGated(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot).startsWith('gated');
}

/** Tests only: forget every hold and turn. */
export function resetPromptLaneForTests(): void {
  gateHolds.clear();
  readyAsks.clear();
  owner = null;
  publish();
}
