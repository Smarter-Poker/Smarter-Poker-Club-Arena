import { describe, expect, it } from 'vitest';
import {
  ACCESS_CHECK_STATUS_TEXT,
  awaitAccessDecision,
  type AccessCheckPage,
} from '../e2e/support/settledRoute';
import { isEngineCutoverHandshake } from '../e2e/support/engineCutoverConsole';

function pageAnswering(pendingCounts: number[]) {
  const asked: string[] = [];
  let waited = 0;
  const page: AccessCheckPage = {
    getByRole: () => ({
      filter: ({ hasText }) => ({
        count: async () => {
          asked.push(hasText);
          return pendingCounts.length > 1 ? pendingCounts.shift()! : pendingCounts[0];
        },
      }),
    }),
    waitForTimeout: async (ms) => {
      waited += ms;
    },
  };
  return { page, asked, waited: () => waited };
}

describe('the mobile fit audit measures where an access guard decided the route lands', () => {
  it('waits while the guard is still checking, then lets the destination be read', async () => {
    const { page, asked, waited } = pageAnswering([1, 1, 0]);
    await awaitAccessDecision(page, 'unions/create', { timeoutMs: 10_000, pollMs: 250 });
    expect(asked).toEqual([
      ACCESS_CHECK_STATUS_TEXT,
      ACCESS_CHECK_STATUS_TEXT,
      ACCESS_CHECK_STATUS_TEXT,
    ]);
    expect(waited()).toBe(500);
  });

  it('does not wait at all on a route with no access check', async () => {
    const { page, waited } = pageAnswering([0]);
    await awaitAccessDecision(page, 'wallet');
    expect(waited()).toBe(0);
  });

  it('names a guard that never decides instead of measuring it as a page', async () => {
    const { page } = pageAnswering([1]);
    await expect(
      awaitAccessDecision(page, 'unions/create', { timeoutMs: 0, pollMs: 1 })
    ).rejects.toThrow('unions/create access guard did not decide within 0 ms');
  });
});

describe('an engine cutover is not a cashier page error', () => {
  it('sets aside only the gateway refusing the engine channel upgrade during a replacement', () => {
    for (const code of ['502', '503']) {
      expect(
        isEngineCutoverHandshake(
          "WebSocket connection to 'wss://engine.smarter.poker/ws/channel?v=1' failed: " +
            'Error during WebSocket handshake: Unexpected response code: ' +
            code
        )
      ).toBe(true);
    }
  });

  it('still fails every other console error', () => {
    for (const text of [
      // Another status is not a cutover.
      "WebSocket connection to 'wss://engine.smarter.poker/ws/channel?v=1' failed: Error during WebSocket handshake: Unexpected response code: 500",
      "WebSocket connection to 'wss://engine.smarter.poker/ws/channel?v=1' failed: Error during WebSocket handshake: Unexpected response code: 401",
      // Another host or path is not the engine channel.
      "WebSocket connection to 'wss://kuklfnapbkmacvwxktbh.supabase.co/realtime/v1/websocket' failed: Error during WebSocket handshake: Unexpected response code: 502",
      "WebSocket connection to 'wss://engine.smarter.poker/ws/table/abc' failed: Error during WebSocket handshake: Unexpected response code: 502",
      // An application error is never set aside.
      'Failed to load resource: the server responded with a status of 500 ()',
      'TypeError: Cannot read properties of undefined',
    ]) {
      expect(isEngineCutoverHandshake(text), text).toBe(false);
    }
  });
});
