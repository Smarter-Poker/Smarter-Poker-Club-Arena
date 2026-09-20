/**
 * Bus contract verification — against the REAL MasterBus.
 *
 * REWRITTEN 2026-08-28. The previous version of this file was a decoy: it
 * never imported MasterBus. All four tests defined a LOCAL reimplementation
 * of subscribe/emit inside the test body and asserted against that — so the
 * file passed green whatever src/core/MasterBus.ts did, including a total
 * rewrite. That is precisely the false assurance that let the wrapper bug
 * class ship (handlers reading payload fields off the event wrapper): the
 * one file named "verify-bus-listeners" verified nothing.
 *
 * tests/setup.ts replaces MasterBus with a no-op global mock, so this file
 * restores the real module the same way useUserThemeSettings.live.test.ts
 * does. What is pinned here:
 *
 *   1. Subscribers receive the WRAPPER ({ type, payload, timestamp }) — the
 *      payload's fields are NOT on the top-level object. Every handler must
 *      read event.payload (or unwrap with `event?.payload ?? event`).
 *   2. The wrapper's `type` is the EVENT NAME — a payload that carries its
 *      own `type` field (WHEEL_SPIN_RESULT does) is only reachable through
 *      .payload, never through the wrapper.
 *   3. Unsubscribe detaches, for both subscribe and subscribeDebounced.
 *   4. subscribeDebounced delivers the wrapper too — it shares the contract,
 *      and it is the idiom the dead-subscription scanner missed for months.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/MasterBus', async () => await vi.importActual('../src/core/MasterBus'));

import { masterBus } from '../src/core/MasterBus';
import { useUnionStore } from '../src/stores/useUnionStore';
import { useClubStore } from '../src/stores/useClubStore';
import { useWalletStore } from '../src/stores/useWalletStore';

describe('MasterBus subscriber contract (real bus)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('synchronously clears union accounting on every auth event, including account ABA', () => {
    const loadMemberships = useClubStore.getState().loadMemberships;
    const refreshAll = useWalletStore.getState().refreshAll;
    useClubStore.setState({ loadMemberships: vi.fn(async () => {}) });
    useWalletStore.setState({ refreshAll: vi.fn(async () => {}) });
    masterBus.reset();
    masterBus.init();

    try {
      const actorA = '11111111-1111-4111-8111-111111111111';
      const actorB = '22222222-2222-4222-8222-222222222222';
      for (const userId of [actorA, actorB, actorA, actorA, null]) {
        useUnionStore.setState({
          accountingScopeId: '33333333-3333-4333-8333-333333333333',
          accountingCurrent: () => true,
          accountingUnavailable: true,
          isLoadingSettlement: true,
        });

        masterBus.emit('AUTH_STATE_CHANGED', { userId, isAuthenticated: userId !== null });

        expect(useUnionStore.getState()).toMatchObject({
          accountingScopeId: null,
          accountingCurrent: null,
          accountingUnavailable: false,
          isLoadingSettlement: false,
        });
      }
    } finally {
      useClubStore.setState({ loadMemberships });
      useWalletStore.setState({ refreshAll });
      masterBus.reset();
    }
  });

  it('hands subscribers the wrapper, with payload fields ONLY under .payload', () => {
    const seen: unknown[] = [];
    const off = masterBus.subscribe('HAND_COMPLETED', (e) => seen.push(e));
    masterBus.emit('HAND_COMPLETED', { handId: 'h1', tableId: 't1' } as never);
    off();

    expect(seen).toHaveLength(1);
    const evt = seen[0] as { type?: string; payload?: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    expect(evt.payload).toMatchObject({ handId: 'h1', tableId: 't1' });
    // The trap this file exists to pin: these are NOT on the wrapper.
    expect(evt.handId).toBeUndefined();
    expect(evt.tableId).toBeUndefined();
  });

  it("the wrapper's .type is the event name — a payload's own type only lives under .payload", () => {
    const seen: Array<{ type?: string; payload?: { type?: string } }> = [];
    const off = masterBus.subscribe('WHEEL_SPIN_RESULT', (e) => seen.push(e as never));
    masterBus.emit('WHEEL_SPIN_RESULT', { segmentId: 's1', amount: 5, type: 'diamonds' } as never);
    off();

    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('WHEEL_SPIN_RESULT'); // NOT 'diamonds'
    expect(seen[0].payload?.type).toBe('diamonds');
  });

  it('unsubscribe detaches a plain subscription', () => {
    const handler = vi.fn();
    const off = masterBus.subscribe('BALANCE_UPDATED', handler);
    masterBus.emit('BALANCE_UPDATED', { source: 'hand-payout' } as never);
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    masterBus.emit('BALANCE_UPDATED', { source: 'agent-send' } as never);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('subscribeDebounced delivers the wrapper and detaches on unsubscribe', async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const off = masterBus.subscribeDebounced('MISSION_CLAIMED', (e) => seen.push(e), 50);

    masterBus.emit('MISSION_CLAIMED', { missionId: 'm1', rewardType: 'diamonds' } as never);
    await vi.advanceTimersByTimeAsync(80);

    expect(seen.length).toBeGreaterThanOrEqual(1);
    const evt = seen[0] as { payload?: { rewardType?: string }; rewardType?: string };
    expect(evt.payload?.rewardType).toBe('diamonds');
    expect(evt.rewardType).toBeUndefined();

    off();
    masterBus.emit('MISSION_CLAIMED', { missionId: 'm2', rewardType: 'chips' } as never);
    await vi.advanceTimersByTimeAsync(80);
    expect(seen.length).toBe(1);
    vi.useRealTimers();
  });
});
