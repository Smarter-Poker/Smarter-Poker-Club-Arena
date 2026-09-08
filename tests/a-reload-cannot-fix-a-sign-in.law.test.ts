/**
 * LAW: A RELOAD CANNOT FIX A SIGN-IN (Realtime programme Phase 3, 2026-09-05)
 *
 * TablePage used to carry a failsafe: twenty seconds of a 'failed' engine
 * socket reloaded the page. A fresh page cannot repair engine capacity,
 * authentication or the network; it only discards the felt, overlays and any
 * armed pre-action before presenting the same inputs to the same failure.
 *
 * On 2026-09-03 that is exactly what happened, all night, and nothing on the
 * platform could tell it apart from bad Wi-Fi. The client cannot tell them
 * apart from the STATUS either: 'auth_failed' is a state EngineStateClient
 * passes through in milliseconds - it sets it on a 4401 and then calls
 * scheduleReconnect(), which immediately sets 'reconnecting' and, at
 * maxRetries, 'failed'. So the cause has to be remembered separately, and it
 * has to be sticky for the outage: an auth refusal followed by nine 1006s is
 * still an auth outage.
 *
 * PINS
 *   1. TablePage has no generic reload path at all.
 *   2. The cause is remembered from the close frame (4401 / auth: reason) and
 *      from the auth_failed status, and cleared ONLY by a socket that opens.
 *   3. The player is told it is a sign-in problem while the reconnect ladder
 *      continues; no page-level workaround competes with that ladder.
 *   4. `reload_suppressed` is a symptom report and must not inflate the
 *      per-user reconnect count the alert reads.
 *   5. The banner copy obeys the house rule (Title Case, no em dashes) and
 *      never blames the connection for an auth refusal.
 *   6. The inlined predicate stays byte-equivalent to the exported one, so
 *      keeping sessionRevoked out of the entry chunk cannot silently drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sliceMethod,
  sliceEnclosingBlock,
  sliceStatement,
  blankNonCode,
} from './helpers/sourceWindow';
import { AUTH_REFUSED_LABEL, labelFor } from '../src/components/table/TableConnectionBanner';
import { isEngineAuthClose } from '../src/lib/sessionRevoked';

const ROOT = join(__dirname, '..');
const TABLE_PAGE = readFileSync(join(ROOT, 'src', 'pages', 'TablePage.tsx'), 'utf8');
const EVENTS = readFileSync(
  join(ROOT, 'server', 'src', 'observability', 'ClientConnectionEvents.ts'),
  'utf8'
);

describe('LAW 1 - a failed socket never reloads the live table', () => {
  it('removes the old page-level reload loop and its throttle key', () => {
    const code = blankNonCode(TABLE_PAGE);
    expect(code).not.toContain('window.location.reload()');
    expect(code).not.toContain('ca_ws_autoreload_at');
    expect(code).not.toContain('wsAutoReload');
  });

  it('leaves the explicit incompatible-bundle reload in the transport', () => {
    const client = readFileSync(join(ROOT, 'src', 'services', 'EngineStateClient.ts'), 'utf8');
    expect(client).toContain('CLOSE_UPGRADE_REQUIRED');
    expect(client).toContain('void reloadForNewBundle()');
  });
});

describe('LAW 2 - the cause is remembered, and only an open socket clears it', () => {
  it('a 4401 close and an auth: reason both set it', () => {
    const block = sliceEnclosingBlock(TABLE_PAGE, 'if (isAuth) setEngineRefusedAuth(true)');
    expect(block).toContain('engineLastError.code === 4401');
    expect(block).toMatch(/\/\^auth:\/\.test/);
  });

  it('the auth_failed status sets it too, though it is passed through in ms', () => {
    expect(TABLE_PAGE).toContain(
      "if (engineWsStatus === 'auth_failed') setEngineRefusedAuth(true)"
    );
  });

  it('it is cleared on connected, and nowhere weaker', () => {
    const cleared = blankNonCode(TABLE_PAGE).split('setEngineRefusedAuth(false)');
    expect(cleared.length - 1, 'exactly one place may clear the auth cause').toBe(1);
    const block = sliceEnclosingBlock(TABLE_PAGE, 'setEngineRefusedAuth(false)', 0, 2);
    expect(block).toContain("engineWsStatus === 'connected'");
  });
});

describe('LAW 3/4 - legacy suppression telemetry stays harmless', () => {
  it('the server accepts the reason rather than folding it into other', () => {
    // Read as source, not imported: this is a client suite and the engine's
    // module graph has no business being pulled into it.
    const list = sliceStatement(EVENTS, 'export const CLIENT_EVENT_REASONS');
    expect(list).toContain("'reload_suppressed'");
  });

  it('it is a symptom report: it never counts toward the per-user reconnects', () => {
    // Raw, not blanked: the reason is a string literal, which blankNonCode
    // erases by design.
    const fn = sliceMethod(EVENTS, 'export function recordClientConnectionEvent(');
    const bail = fn.indexOf("reason === 'reload_suppressed'");
    expect(bail).toBeGreaterThan(0);
    // The bail-out is above the per-user bookkeeping the alert reads.
    expect(bail).toBeLessThan(fn.indexOf('perUser.get(userId)'));
  });
});

describe('LAW 5 - the player is told what it actually is', () => {
  it('says a sign-in problem, not a lost connection, when auth was refused', () => {
    expect(labelFor('failed', true)).toBe(AUTH_REFUSED_LABEL);
    expect(labelFor('reconnecting', true)).toBe(AUTH_REFUSED_LABEL);
    expect(labelFor('auth_failed', true)).toBe(AUTH_REFUSED_LABEL);
    expect(AUTH_REFUSED_LABEL).toContain('Sign In');
    expect(AUTH_REFUSED_LABEL).not.toMatch(/connection lost/i);
  });

  it('leaves every other state exactly as it was', () => {
    // The transport words are unchanged when auth is not the cause, and a
    // healthy or seat-first table still says nothing at all.
    expect(labelFor('failed', false)).toBe('Connection Lost. Trying To Get You Back');
    expect(labelFor('reconnecting', false)).toBe('Reconnecting To The Table');
    expect(labelFor('connecting', true)).toBe('Connecting To The Table');
    expect(labelFor('idle', true)).toBeNull();
    expect(labelFor('connected', true)).toBeNull();
  });

  it('obeys the popup house rule: Title Case, no em dashes (CLAUDE.md 5.7)', () => {
    expect(AUTH_REFUSED_LABEL).not.toContain('—');
    for (const word of AUTH_REFUSED_LABEL.replace(/[.,]/g, '').split(' ')) {
      expect(word[0], `"${word}" is not Title Case`).toBe(word[0].toUpperCase());
    }
  });

  it('the label wins over the transport words for every state that blames the link', () => {
    const src = readFileSync(
      join(ROOT, 'src', 'components', 'table', 'TableConnectionBanner.tsx'),
      'utf8'
    );
    const fn = sliceMethod(src, 'function labelFor(');
    for (const state of ['failed', 'reconnecting', 'auth_failed']) {
      expect(fn).toContain(`status === '${state}'`);
    }
    // 'connecting' is a fresh attempt that may succeed, and 'idle' is a
    // seat-first table with no socket yet: neither is overridden.
    const override = fn.slice(0, fn.indexOf('switch (status)'));
    expect(override).not.toContain("status === 'connecting'");
    expect(override).not.toContain("status === 'idle'");
  });

  it('TablePage actually passes the flag to the banner', () => {
    expect(TABLE_PAGE).toContain('authRefused={engineRefusedAuth}');
  });
});

describe('LAW 6 - the inlined predicate has not drifted from the exported one', () => {
  it('TablePage agrees with lib/sessionRevoked on every close code it sees', () => {
    const block = sliceEnclosingBlock(TABLE_PAGE, 'if (isAuth) setEngineRefusedAuth(true)');
    const body = block.slice(block.indexOf('const isAuth'), block.indexOf('if (isAuth)'));
    const inlined = (code: number | undefined, reason: string | undefined): boolean => {
      const engineLastError = { code, reason };
      // Evaluate the SOURCE, so a drift is a failure rather than a comment.
      const expr = body
        .replace(/^[\s\S]*?const isAuth\s*=/, '')
        .replace(/;\s*$/, '')
        .trim();
      return new Function('engineLastError', `return (${expr});`)(engineLastError) as boolean;
    };
    const cases: Array<[number | undefined, string | undefined]> = [
      [4401, ''],
      [1006, 'auth:session_not_found'],
      [1006, ''],
      [4404, 'table_not_found'],
      [4429, 'slow down'],
      [undefined, undefined],
      [1000, 'auth is fine'],
    ];
    for (const [code, reason] of cases) {
      expect(inlined(code, reason), `close ${code} / "${reason}"`).toBe(
        isEngineAuthClose(code, reason)
      );
    }
  });
});
