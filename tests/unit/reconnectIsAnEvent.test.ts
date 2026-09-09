/**
 * RECONNECT IS AN EVENT, AND EVERY CONNECTION MESSAGE IS ON THE FELT
 * (Dan 2026-09-04)
 *
 * "I should never have to 'refresh' after I disconnected and auto
 * reconnected. The page should 'auto refresh for me'. And all disconnection,
 * re connecting messages should be on the table, not at the top of the page."
 *
 * What he saw: "Session Lost. Refresh To Rejoin The Table." pinned over the
 * tab bar, on a table whose socket had already come back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const PAGE = read('src/pages/TablePage.tsx');
const TOAST = read('src/components/table/DisconnectToast.tsx');
const TOAST_CSS = strip(read('src/components/table/DisconnectToast.css'));
const API = strip(read('src/services/GameServerAPI.ts'));
const CLIENT = strip(read('src/services/EngineStateClient.ts'));

describe('no connection message tells the player to refresh', () => {
  it('the "Refresh To Rejoin" copy is gone from the felt components', () => {
    for (const f of [
      'src/components/table/DisconnectToast.tsx',
      'src/components/table/TableConnectionBanner.tsx',
      'src/pages/TablePage.tsx',
    ]) {
      expect(strip(read(f)), f).not.toMatch(/Refresh To Rejoin|Session Lost/);
    }
  });
});

describe('DisconnectToast lives on the felt', () => {
  it('is position:absolute on the wordmark line, never position:fixed at the top of the page', () => {
    const rule = TOAST_CSS.slice(TOAST_CSS.indexOf('.disconnect-toast {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/--sp-brand-top/);
    expect(TOAST_CSS).not.toMatch(/position:\s*fixed/);
  });

  it('is mounted inside .table-surface beside TableConnectionBanner, gated on isActive and the socket', () => {
    /* Whitespace-insensitive since 2026-09-05: the banner gained a third prop
       in Realtime Phase 3 (`authRefused`, so it can say a sign-in was refused
       rather than blaming the connection), which pushes Prettier to wrap the
       element. A literal one-line match found nothing and failed a pin about
       ADJACENCY, which had not changed. Both props this test cares about are
       still asserted, on the element itself. */
    const banner = PAGE.search(
      /<TableConnectionBanner\s+status=\{engineWsStatus\}\s+isActive=\{isActive\}/
    );
    const toast = PAGE.indexOf('<DisconnectToast');
    expect(banner).toBeGreaterThan(-1);
    expect(toast).toBeGreaterThan(banner);
    expect(toast - banner).toBeLessThan(900);
    const mount = PAGE.slice(toast, PAGE.indexOf('/>', toast));
    expect(mount).toMatch(/socketStatus=\{engineWsStatus\}/);
    expect(mount).toMatch(/isActive=\{isActive\}/);
    expect(PAGE.match(/<DisconnectToast/g)).toHaveLength(1);
  });

  it('defers to the socket banner whenever the socket is not connected (its map is stale then)', () => {
    expect(strip(TOAST)).toMatch(/if \(socketStatus !== 'connected'\) return null;/);
  });

  it('hides at zero instead of parking a dead countdown', () => {
    expect(strip(TOAST)).toMatch(/remainingSec <= 0\) return null/);
  });
});

describe('the socket coming back is handled, not hoped for', () => {
  const at = PAGE.indexOf('const wasOffTheSocketRef = useRef(false);');
  const effect = PAGE.slice(at, PAGE.indexOf('}, [engineWsStatus, tableId]);', at));

  it('resets the circuit breaker, heartbeats at once, and re-arms the hole-card read', () => {
    expect(at).toBeGreaterThan(-1);
    expect(effect).toMatch(/resetEngineCircuitBreaker\(\)/);
    expect(effect).toMatch(/sendHeartbeat\(tableId/);
    expect(effect).toMatch(/heroCardFetchRef\.current\?\.\(\)/);
    expect(effect).toMatch(/live\.isHandInProgress && blind/);
  });

  it('GameServerAPI exports the breaker reset', () => {
    expect(API).toMatch(/export function resetEngineCircuitBreaker\(\)/);
  });

  it("EngineStateClient's RESYNC on reconnect reads seq BEFORE resetInbox zeroes it", () => {
    const open = CLIENT.slice(
      CLIENT.indexOf('ws.onopen = () => {'),
      CLIENT.indexOf('ws.onmessage = (e) => {')
    );
    const had = open.indexOf('const hadState = this.seq > 0;');
    const reset = open.indexOf('this.resetInbox();');
    expect(had).toBeGreaterThan(-1);
    expect(had).toBeLessThan(reset);
    expect(open).toMatch(/if \(hadState\) \{/);
  });
});

describe("one I'm Back", () => {
  it('the floating bottom-right button and its direct setSitOut call are gone', () => {
    const src = strip(PAGE);
    expect(src).not.toMatch(/floating-im-back/);
    expect(src).not.toMatch(/floating-action-br/);
    // The only client-side sit-back-in request goes through handleSitBackIn.
    const direct = src.match(/setSitOut\(tableId, false\)/g) ?? [];
    expect(direct).toHaveLength(1);
  });

  it('the sit-out pill no longer renders one either', () => {
    expect(strip(read('src/components/table/SitOutModal.tsx'))).not.toMatch(/I'm Back/);
  });
});

describe('one connection vocabulary (disconnect audit item 7, 2026-09-04)', () => {
  it('the tab-bar chip names the feed it is about, not "Reconnecting" like the felt', () => {
    const bar = strip(read('src/components/table/TableTabBar.tsx'));
    expect(bar).toMatch(/Live Feed Reconnecting/);
    expect(bar).not.toMatch(/>Reconnecting…</);
  });

  it('the top-of-page offline bar stays off the table route', () => {
    const app = read('src/App.tsx');
    expect(app).toMatch(
      /isOffline && !\/\^\\\/\(table\|multi\)\/\.test\(location\.pathname\) && \(/
    );
    expect(app).not.toMatch(/ConnectionIndicator/);
  });

  it('the action row is marked while the socket is down', () => {
    expect(PAGE).toMatch(/connectionStale=\{engineWsStatus !== 'connected'\}/);
    const panel = strip(read('src/components/table/ActionPanel.tsx'));
    expect(panel).toMatch(/action-panel--stale/);
    expect(panel).toMatch(/These Buttons May Be A Moment Behind/);
    // marked, not disabled: the HTTP action path is a second transport
    expect(panel).not.toMatch(/disabled=\{!canFold \|\| connectionStale\}/);
  });
});

describe("the player's own facts ride the engine socket (audit items 11 + 12, 2026-09-04)", () => {
  it('EngineStateClient hands a USER_EVENT frame straight to onUserEvent, never the queue', () => {
    expect(CLIENT).toMatch(
      /if \(msg\.type === 'USER_EVENT'\) \{[\s\S]*?this\.opts\.onUserEvent\(msg\.payload\);[\s\S]*?return;/
    );
    expect(CLIENT).toMatch(/onUserEvent\?: \(payload: Record<string, unknown>\) => void;/);
  });

  it('the hook exposes it and TablePage reconciles hole cards and the pre-action from it', () => {
    const hook = strip(read('src/hooks/useEngineTableState.ts'));
    expect(hook).toMatch(/onUserEvent: \(payload\) => setLastUserEvent\(payload\),/);
    expect(hook).toMatch(/lastUserEvent/);
    const page = strip(PAGE);
    expect(page).toMatch(/lastUserEvent: engineLastUserEvent,/);
    expect(page).toMatch(/ev\.kind === 'hole_cards' && ev\.row && typeof ev\.row === 'object'/);
    expect(page).toMatch(/handleHoleCardPayload\(\{ new: ev\.row \}\);/);
    expect(page).toMatch(/if \(mapped === null\) hadPreActionRef\.current = false;/);
    expect(page).toMatch(/setPreAction\(\(cur\) => \(cur === mapped \? cur : mapped\)\);/);
  });

  it('the engine sends both, and re-sends both on RESYNC', () => {
    const dealing = strip(read('server/src/engine/ServerTableEngineDealing.ts'));
    expect(dealing).toMatch(
      /this\.hub\?\.sendToUser\(this\.tableId, userId, \{\s*kind: 'hole_cards',/
    );
    const base = strip(read('server/src/engine/ServerTableEngineBase.ts'));
    expect(base).toMatch(/kind: 'pre_action',/);
    // Every PreActionEngine event still pushes the engine's copy - EXCEPT
    // execution, which outran the snapshot and disarmed the client's bar a
    // frame before the turn arrived (2026-09-08; see
    // server/src/engine/PreActionPushDoesNotOutrunTheTurn.test.ts).
    expect(base).toMatch(
      /if \(event\.type === 'PRE_ACTION_EXECUTED'\) return;\s*this\.pushPreActionToPlayer\(\s*event\.playerId,/
    );
    const index = strip(read('server/src/index.ts'));
    expect(index).toMatch(/engine\?\.rePushPreAction\(userId\);/);
    expect(index).toMatch(/void engine\?\.rePushHoleCards\(userId\);/);
  });
});
