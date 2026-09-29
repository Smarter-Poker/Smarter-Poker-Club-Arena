/**
 * The first-run sheets wait their turn, and leave with the account.
 *
 * Found on the first device walkthrough, 2026-09-29 (Android emulator):
 *   - the notifications sheet rose over the terms and under the age gate,
 *     because its twenty-second timer started at sign-in;
 *   - the analytics question rose 2.5 seconds after sign-in under the gate;
 *   - once the gate closed, the two sheets sat stacked at the bottom;
 *   - after an under-18 refusal signed the account out, both were still on
 *     the sign-in form.
 *
 * This renders the REAL ConsentPrompt and FirstRunPushPrompt beside a gate
 * holding the prompt lane, on fake timers, and walks that exact sequence.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let currentUser: { id: string } | null = { id: 'player-1' };
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: currentUser, isHydrating: false }),
}));
const pushMocks = vi.hoisted(() => ({
  enablePush: vi.fn(),
  hasLocalSubscription: vi.fn(),
  isIos: vi.fn(),
  isIosStandalonePwa: vi.fn(),
  isWebPushSupported: vi.fn(),
  notificationPermission: vi.fn(),
}));
vi.mock('../../src/lib/pushClient', () => pushMocks);
// The analytics question exists in the app build only.
vi.mock('../../src/lib/appBase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/appBase')>()),
  IS_NATIVE_BUILD: true,
}));

import ConsentPrompt from '../../src/components/legal/ConsentPrompt';
import FirstRunPushPrompt from '../../src/components/notifications/FirstRunPushPrompt';
import { resetPromptLaneForTests, useHoldPromptLane } from '../../src/lib/promptLane';

function AgeGateStandIn({ owed }: { owed: boolean }) {
  useHoldPromptLane('age', owed);
  return owed ? <div role="dialog" aria-label="Confirm Your Age" /> : null;
}

const tree = (gateOwed: boolean) => (
  <MemoryRouter initialEntries={['/']}>
    <AgeGateStandIn owed={gateOwed} />
    <ConsentPrompt />
    <FirstRunPushPrompt />
  </MemoryRouter>
);

const consent = () => screen.queryByRole('dialog', { name: /help improve club arena/i });
const push = () => screen.queryByRole('dialog', { name: /enable notifications/i });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('first-run sheets: one at a time', () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
    localStorage.clear();
    currentUser = { id: 'player-1' };
    act(() => resetPromptLaneForTests());
    pushMocks.enablePush.mockReset();
    pushMocks.hasLocalSubscription.mockReset().mockResolvedValue(false);
    pushMocks.isIos.mockReset().mockReturnValue(false);
    pushMocks.isIosStandalonePwa.mockReset().mockReturnValue(false);
    pushMocks.isWebPushSupported.mockReset().mockReturnValue(true);
    pushMocks.notificationPermission.mockReset().mockReturnValue('default');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('nothing rises under a gate, however long it stays up', async () => {
    render(tree(true));
    await advance(90_000);
    expect(consent()).toBeNull();
    expect(push()).toBeNull();
  });

  it('after the gate: the analytics question alone, then notifications only after a fresh beat', async () => {
    const view = render(tree(true));
    await advance(60_000);
    view.rerender(tree(false));

    await advance(2_500);
    expect(consent()).not.toBeNull();
    // The notifications timer did not run while the gate was up, and does
    // not run while the question is on screen: no stacking, however long.
    await advance(60_000);
    expect(push()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /not now/i }));
    expect(consent()).toBeNull();
    // Not the instant the previous sheet closes...
    await advance(1_000);
    expect(push()).toBeNull();
    // ...but after its own twenty seconds of a clear lane.
    await advance(20_000);
    expect(push()).not.toBeNull();
    expect(consent()).toBeNull();
  });

  it('a sign-out takes every sheet with it', async () => {
    localStorage.setItem('ca.consent.analytics.v1', 'denied'); // question already answered
    const view = render(tree(false));
    await advance(21_000);
    expect(push()).not.toBeNull();

    currentUser = null;
    view.rerender(tree(false));
    await advance(0);
    expect(push()).toBeNull();
    expect(consent()).toBeNull();
  });
});
