import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
    url: () => 'https://smarter.poker/hub/club-arena/wallet',
    getByRole: () => ({
      isEnabled: async () => true,
      inputValue: async () => 'newest',
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

describe('the fit baseline follows authoritative roster preference hydration', () => {
  const initial = 'https://smarter.poker/hub/club-arena/clubs/kings-club/members';
  function roster(states: Array<{ url: string; enabled: boolean; sort: string }>) {
    let index = 0;
    const current = () => states[index];
    const page: AccessCheckPage = {
      url: () => current().url,
      getByRole: () => ({
        isEnabled: async () => current().enabled,
        inputValue: async () => current().sort,
        filter: () => ({ count: async () => 0 }),
      }),
      waitForTimeout: async () => {
        index = Math.min(index + 1, states.length - 1);
      },
    };
    return page;
  }

  it('waits for workspace readiness and its restored canonical sort before baseline capture', async () => {
    const page = roster([
      { url: initial, enabled: false, sort: 'newest' },
      { url: initial, enabled: true, sort: 'name' },
      { url: initial + '?sort=name', enabled: true, sort: 'name' },
    ]);
    await awaitAccessDecision(page, 'player-sessions');
    expect(page.url()).toBe(initial + '?sort=name');
  });

  it('refuses a real path navigation while waiting instead of accepting a new baseline', async () => {
    const page = roster([
      { url: initial, enabled: false, sort: 'newest' },
      { url: initial.replace('/members', '/cashier'), enabled: true, sort: 'newest' },
    ]);
    await expect(awaitAccessDecision(page, 'player-sessions')).rejects.toThrow(
      'Roster preference workspace navigated while settling'
    );
  });

  it('does not call an enabled control settled while its canonical URL is still pending', async () => {
    const page = roster([{ url: initial, enabled: true, sort: 'name' }]);
    await expect(awaitAccessDecision(page, 'player-sessions', { timeoutMs: 0 })).rejects.toThrow(
      'Roster preference workspace did not settle within 0 ms'
    );
  });

  it('retains the serving audit call and refuses query or path changes after baseline capture', () => {
    const source = readFileSync('tests/e2e/mobile-fit-audit.spec.ts', 'utf8');
    expect(source.indexOf('await awaitAccessDecision(page, route)')).toBeLessThan(
      source.indexOf('const destinationUrl = page.url()')
    );
    expect(source).toContain('test.setTimeout(30_000)');
    const guard = source.match(
      /expect\(page\.url\(\),[\s\S]*?\.toBe\(\s*destinationUrl\s*\);/
    )?.[0];
    expect(guard).toBeDefined();
    const verify = new Function('page', 'expect', 'route', 'viewport', 'destinationUrl', guard!);
    const baseline = initial + '?sort=name';
    for (const changed of [initial + '?sort=oldest', initial.replace('/members', '/cashier')])
      expect(() =>
        verify({ url: () => changed }, expect, 'player-sessions', { label: 'tablet' }, baseline)
      ).toThrow('player-sessions navigated while resizing to tablet');
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
