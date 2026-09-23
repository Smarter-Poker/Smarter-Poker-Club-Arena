/**
 * A VIEWER THE ENGINE WILL NOT ADMIT IS TOLD WHY, NOT "RECONNECTING"
 * (Create A Club Phase 2, 2026-09-20).
 *
 * People allowed to CREATE a table (union owners and admins) are not always
 * allowed to WATCH it. The engine's verdict used to ride the reconnect ladder,
 * so the felt said "Reconnecting To The Table", then "Connection Lost. Trying
 * To Get You Back", about a link with nothing wrong with it. The transport
 * half is pinned in tests/a-new-table-is-waking-not-gone.test.ts; this is the
 * sentence the player actually reads, the bullet printed beside it, and the
 * runbook page the next person on call reads about it.
 *
 * 2026-09-22, after main's #ClubArenaConsole banner (#4696) landed underneath:
 * the banner is inked now, not drawn. It prints an aria-hidden kit bullet
 * before the sentence (blue while an attempt is live, red once the link is
 * down) and the stylesheet no longer styles any `--<status>` modifier. So the
 * sentence is read from its own span, the whole line is pinned as exactly
 * bullet + sentence, and the verdict's bullet is pinned to the refusal red,
 * held still by a rule the stylesheet really has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import TableConnectionBanner, {
  AUTH_REFUSED_LABEL,
  GRACE_MS,
  labelFor,
  type TableConnectionState,
} from '../src/components/table/TableConnectionBanner';
import {
  MUX_ACCESS_REFUSAL_CODES,
  MUX_REFUSAL_REASON_PREFIX,
} from '../src/services/EngineSocketMux';
import { sliceCssRule, sliceMarkdownSection } from './helpers/sourceWindow';

/** The sentences, read through the one door the component itself uses. */
const ACCESS_REFUSED_LABELS = {
  CLUB_MEMBERSHIP_REQUIRED: labelFor('access_refused', false, 'CLUB_MEMBERSHIP_REQUIRED')!,
  OBSERVERS_RESTRICTED: labelFor('access_refused', false, 'OBSERVERS_RESTRICTED')!,
  default: labelFor('access_refused')!,
};

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const BANNER_CSS = read('src/components/table/TableConnectionBanner.css');
const RUNBOOK = read('docs/runbooks/tables-say-reconnecting.md');

async function passGrace() {
  await act(async () => {
    vi.advanceTimersByTime(GRACE_MS + 50);
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the banner has its own words for an access refusal', () => {
  it.each([...MUX_ACCESS_REFUSAL_CODES, null] as const)(
    'access_refused (%s) is never told as a connection problem',
    async (code) => {
      render(<TableConnectionBanner status="access_refused" accessRefusal={code} hasLiveState />);
      await passGrace();
      const banner = screen.getByTestId('table-connection-banner');
      const sentence = ACCESS_REFUSED_LABELS[code ?? 'default'];
      const label = banner.querySelector('.table-conn-banner__label');
      const dot = banner.querySelector('.table-conn-banner__dot');

      // What the player reads is exactly the verdict...
      const text = label?.textContent ?? '';
      expect(text).toBe(sentence);
      expect(text).not.toBe(labelFor('reconnecting'));
      expect(text).not.toMatch(/Reconnecting|Connecting|Connection|Trying|Refresh|Reload/i);
      // ...and the only other thing on the line is the kit's bullet, which a
      // screen reader never announces. Nothing else is printed.
      expect(banner.children).toHaveLength(2);
      expect(dot?.getAttribute('aria-hidden')).toBe('true');
      expect(banner.textContent).toBe(`${dot?.textContent ?? ''}${sentence}`);

      // House copy law: Title Case, no em dashes.
      expect(text).not.toMatch(/[–—]/);
      for (const word of text.trim().split(/\s+/)) {
        if (/^[a-zA-Z]/.test(word)) expect(word[0], word).toBe(word[0].toUpperCase());
      }

      // The bullet is the refusal red, never the blue of an attempt in
      // progress, and it carries its own modifier - the one the stylesheet
      // holds still (pinned below).
      expect(dot?.className).toContain('sc-ink--red');
      expect(dot?.className).not.toContain('sc-ink--blue');
      expect(banner.className).toContain('table-conn-banner--access_refused');
    }
  );

  it('the stylesheet holds the verdict bullet still, and paints nothing of its own', () => {
    const rule = sliceCssRule(
      BANNER_CSS,
      '.table-conn-banner--access_refused .table-conn-banner__dot'
    );
    expect(rule).toMatch(/animation:\s*none;/);
    expect(rule).toMatch(/opacity:\s*1;/);
    // The ink is the kit's (sc-ink--red, set in the component). A colour here
    // would be a tone the schema does not own.
    expect(rule).not.toMatch(/color|background|#[0-9a-f]{3,8}\b|rgb/i);
    // The pulse it overrides is still the live-attempt signal for everyone else.
    expect(sliceCssRule(BANNER_CSS, '.table-conn-banner__dot {')).toMatch(
      /animation:\s*table-conn-banner-pulse/
    );
  });

  it("every other state keeps main's bullet: red once the link is down, blue while trying", async () => {
    const inks: Record<string, string> = {};
    for (const status of ['connecting', 'reconnecting', 'failed', 'auth_failed'] as const) {
      const { unmount } = render(<TableConnectionBanner status={status} />);
      await passGrace();
      const dot = screen
        .getByTestId('table-connection-banner')
        .querySelector('.table-conn-banner__dot');
      inks[status] = /sc-ink--red/.test(dot?.className ?? '')
        ? 'red'
        : /sc-ink--blue/.test(dot?.className ?? '')
          ? 'blue'
          : 'none';
      unmount();
    }
    expect(inks).toEqual({
      connecting: 'blue',
      reconnecting: 'blue',
      failed: 'red',
      auth_failed: 'red',
    });
  });

  it('each verdict says what would change it, and they are different sentences', () => {
    expect(ACCESS_REFUSED_LABELS.CLUB_MEMBERSHIP_REQUIRED).toMatch(/Club Members Only/);
    expect(ACCESS_REFUSED_LABELS.CLUB_MEMBERSHIP_REQUIRED).toMatch(/Join The Club/);
    expect(ACCESS_REFUSED_LABELS.OBSERVERS_RESTRICTED).toMatch(/Seated Players Only/);
    expect(new Set(Object.values(ACCESS_REFUSED_LABELS)).size).toBe(3);
    // Every code the mux can produce has a sentence.
    for (const code of MUX_ACCESS_REFUSAL_CODES) expect(ACCESS_REFUSED_LABELS[code]).toBeTruthy();
  });

  it('a stale auth flag cannot relabel the verdict', () => {
    expect(labelFor('access_refused', true, 'OBSERVERS_RESTRICTED')).toBe(
      ACCESS_REFUSED_LABELS.OBSERVERS_RESTRICTED
    );
    expect(labelFor('access_refused', true)).not.toBe(AUTH_REFUSED_LABEL);
  });

  it('every other status says exactly what it said before', () => {
    expect(labelFor('idle')).toBeNull();
    expect(labelFor('connected')).toBeNull();
    expect(labelFor('connecting')).toBe('Connecting To The Table');
    expect(labelFor('reconnecting')).toBe('Reconnecting To The Table');
    expect(labelFor('failed')).toBe('Connection Lost. Trying To Get You Back');
    expect(labelFor('auth_failed')).toBe('Checking Your Sign-In');
    expect(labelFor('failed', true)).toBe(AUTH_REFUSED_LABEL);
    // The accessRefusal argument means nothing outside 'access_refused'.
    expect(labelFor('reconnecting', false, 'CLUB_MEMBERSHIP_REQUIRED')).toBe(
      'Reconnecting To The Table'
    );
  });

  it("the banner's status union is the client's status union", () => {
    // tsc covers one direction at the call site (TablePage passes the client's
    // status to this prop); tests are not type-checked, so the equality of the
    // two unions is read from the source, where a drift is a failure.
    const members = (rel: string, name: string) => {
      // Comments out first: a doc comment on a member may carry a semicolon.
      const src = read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const at = src.indexOf(`export type ${name} =`);
      expect(at, `${name} not found in ${rel}`).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf(';', at));
      return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    };
    const client = members('src/services/EngineStateClient.ts', 'EngineConnectionStatus');
    const banner = members(
      'src/components/table/TableConnectionBanner.tsx',
      'TableConnectionState'
    );
    expect(client).toContain('access_refused');
    expect(banner).toEqual(client);
    // And it is a status the banner has words for.
    const status: TableConnectionState = 'access_refused';
    expect(labelFor(status)).toBeTruthy();
  });

  it('TablePage hands the banner the verdict from the close that produced the status', () => {
    expect(TABLE_PAGE).toMatch(
      /const engineAccessRefusal =\s*engineWsStatus === 'access_refused'\s*\?\s*accessRefusalFromClose\(engineLastError\?\.code, engineLastError\?\.reason\)\s*:\s*null;/
    );
    expect(TABLE_PAGE).toMatch(/<TableConnectionBanner[^>]*accessRefusal=\{engineAccessRefusal\}/);
  });
});

describe('the runbook knows this refusal by name', () => {
  // Read inside each test: a missing section fails these three, not the file.
  const section = () => sliceMarkdownSection(RUNBOOK, 'access_refused');

  it('documents both reason strings exactly as the mux writes them', () => {
    for (const code of MUX_ACCESS_REFUSAL_CODES) {
      expect(section()).toContain(`${MUX_REFUSAL_REASON_PREFIX}${code}`);
    }
    expect(section()).toContain('4400');
  });

  it('prints the sentences the banner prints, so the page and the felt agree', () => {
    for (const sentence of Object.values(ACCESS_REFUSED_LABELS)) {
      expect(section().replace(/\s+/g, ' ')).toContain(sentence);
    }
  });

  it('says nothing retries it, where the rule lives, and what the mux-off path looks like', () => {
    const flat = section().replace(/\s+/g, ' ');
    expect(flat).toMatch(/nothing retries it/i);
    expect(flat).toContain('server/src/services/TableViewerAccess.ts');
    // With the multiplexed socket switched off the same verdict is a
    // pre-handshake HTTP 403, which reaches the browser as 1006.
    expect(flat).toContain('1006');
    expect(flat).toContain("ca_ws_mux='0'");
  });
});
