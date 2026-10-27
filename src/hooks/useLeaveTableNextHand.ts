import { useEffect, useState, useSyncExternalStore } from 'react';

type Scope = { userId: string; tableId: string; occupancyId: string };
export type LeaveNextHandInputs = Scope & {
  /** Matching engine scope and its mapped phase are authoritative. */
  ready: boolean;
  seated: boolean;
  handLive: boolean;
  /** Changes only after authoritative hand-history completion. */
  completionVersion: string | number;
  setSitOut: () => Promise<{ success: boolean; error?: string; willFoldNextHand?: boolean }>;
  onLeave: () => unknown | Promise<unknown>;
};
type Intent = { version: 1; waitForBoundary: boolean; completionVersion: string };
type State = { queued: boolean; pending: boolean; error: string | null };
const EMPTY: State = { queued: false, pending: false, error: null };
const keyFor = (x: Scope) =>
  x.userId && x.tableId && x.occupancyId
    ? `ca:leave-next-hand:v1:${x.userId}:${x.tableId}:${x.occupancyId}`
    : '';

/** Queues only a sit-out. The existing leave owner remains the sole money door. */
export class LeaveTableNextHandController {
  private input: LeaveNextHandInputs | null = null;
  private key = '';
  private intent: Intent | null = null;
  private armed = false;
  private arming = false;
  private leaving = false;
  private generation = 0;
  private state = EMPTY;
  private listeners = new Set<() => void>();
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private publish(state: State) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private clear() {
    try {
      if (this.key) this.storage?.removeItem(this.key);
    } catch {
      /* Memory still clears. */
    }
    this.intent = null;
    this.armed = false;
    this.arming = false;
    this.generation++;
    this.publish(EMPTY);
  }
  update(input: LeaveNextHandInputs) {
    this.input = input;
    // Hydration is not evidence that the occupancy ended. Keep durable intent
    // untouched until the matching engine scope and phase are mapped.
    if (!input.ready) return;
    const key = keyFor(input);
    if (key !== this.key) {
      this.clear();
      this.key = key;
      this.leaving = false;
      try {
        const saved = key ? JSON.parse(this.storage?.getItem(key) ?? 'null') : null;
        if (
          saved?.version === 1 &&
          typeof saved.waitForBoundary === 'boolean' &&
          typeof saved.completionVersion === 'string'
        )
          this.intent = saved;
      } catch {
        /* An unreadable saved intent cannot trigger departure. */
      }
    }
    this.input = input;
    if (!key || !input.seated) {
      this.clear();
      return;
    }
    if (this.intent && !this.armed && !this.arming) void this.arm();
    this.tryLeave();
  }
  cancel = () => {
    this.clear();
  };
  deactivate() {
    this.generation++;
    this.arming = false;
    this.input = null;
  }
  request = async (): Promise<boolean> => {
    if (!this.input?.ready || !this.input.seated || !this.key || this.leaving) return false;
    if (this.intent) return true; // Never reverse another accepted sit-out.
    this.intent = {
      version: 1,
      waitForBoundary: this.input.handLive,
      completionVersion: String(this.input.completionVersion),
    };
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.intent));
    } catch {
      this.intent = null;
      this.publish({ ...EMPTY, error: 'Could Not Save Your Leave Request. Please Try Again.' });
      return false;
    }
    return this.arm();
  };
  private async arm(): Promise<boolean> {
    if (!this.input?.ready || !this.intent || this.arming) return false;
    const generation = this.generation;
    this.arming = true;
    this.publish({ queued: true, pending: true, error: null });
    try {
      const response = await this.input.setSitOut();
      if (generation !== this.generation) return false;
      if (!response.success) throw new Error(response.error || 'Could Not Queue Your Leave.');
      // The server may start a hand after the idle click but before its ACK.
      // Keep the request's original completion baseline: a completion may also
      // reach this window before the delayed ACK does.
      if (response.willFoldNextHand && this.intent && !this.intent.waitForBoundary) {
        this.intent = { ...this.intent, waitForBoundary: true };
        this.storage?.setItem(this.key, JSON.stringify(this.intent));
      }
      this.arming = false;
      this.armed = true;
      this.publish({ queued: true, pending: false, error: null });
      this.tryLeave();
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.clear();
      this.publish({
        ...EMPTY,
        error: error instanceof Error ? error.message : 'Could Not Queue Your Leave.',
      });
      return false;
    }
  }
  private tryLeave() {
    const input = this.input;
    if (
      !input?.ready ||
      !this.intent ||
      !this.armed ||
      this.leaving ||
      !input.seated ||
      input.handLive
    )
      return;
    if (
      this.intent.waitForBoundary &&
      (!String(input.completionVersion).trim() ||
        String(input.completionVersion) === this.intent.completionVersion)
    )
      return;
    const leave = input.onLeave;
    this.leaving = true;
    // From here the existing occupancy-bound leave intent owns recovery/retries.
    this.clear();
    const generation = this.generation;
    const failed = (error: unknown) => {
      if (generation !== this.generation) return;
      this.publish({
        ...EMPTY,
        error: error instanceof Error ? error.message : 'Could Not Leave The Table.',
      });
    };
    try {
      void Promise.resolve(leave()).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}

export function useLeaveTableNextHand(input: LeaveNextHandInputs) {
  const [controller] = useState(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Queue remains local. */
    }
    return new LeaveTableNextHandController(storage);
  });
  useEffect(() => {
    controller.update(input);
  });
  useEffect(() => () => controller.deactivate(), [controller]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  return {
    ...state,
    requestLeaveNextHand: controller.request,
    cancelQueuedLeave: controller.cancel,
    getError: () => controller.getSnapshot().error,
  };
}
