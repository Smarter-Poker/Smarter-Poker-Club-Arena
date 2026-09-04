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
    const banner = PAGE.indexOf(
      '<TableConnectionBanner status={engineWsStatus} isActive={isActive} />'
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
