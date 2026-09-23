/**
 * A VIEWER THE ENGINE WILL NOT ADMIT IS TOLD WHY, NOT "RECONNECTING"
 * (Create A Club Phase 2, 2026-09-20).
 *
 * People allowed to CREATE a table (union owners and admins) are not always
 * allowed to WATCH it. The engine's verdict used to ride the reconnect ladder,
 * so the felt said "Reconnecting To The Table", then "Connection Lost. Trying
 * To Get You Back", about a link with nothing wrong with it. The transport
 * half is pinned in tests/a-new-table-is-waking-not-gone.test.ts; this is the
 * sentence the player actually reads.
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
import { MUX_ACCESS_REFUSAL_CODES } from '../src/services/EngineSocketMux';
import type { EngineConnectionStatus } from '../src/services/EngineStateClient';

/** The sentences, read through the one door the component itself uses. */
const ACCESS_REFUSED_LABELS = {
  CLUB_MEMBERSHIP_REQUIRED: labelFor('access_refused', false, 'CLUB_MEMBERSHIP_REQUIRED')!,
  OBSERVERS_RESTRICTED: labelFor('access_refused', false, 'OBSERVERS_RESTRICTED')!,
  default: labelFor('access_refused')!,
};

const TABLE_PAGE = readFileSync(join(__dirname, '..', 'src/pages/TablePage.tsx'), 'utf8');

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
      const text = banner.textContent ?? '';
      expect(text).toBe(ACCESS_REFUSED_LABELS[code ?? 'default']);
      expect(text).not.toBe(labelFor('reconnecting'));
      expect(text).not.toMatch(/Reconnecting|Connecting|Connection|Trying|Refresh|Reload/i);
      // House copy law: Title Case, no em dashes.
      expect(text).not.toMatch(/[–—]/);
      for (const word of text.trim().split(/\s+/)) {
        if (/^[a-zA-Z]/.test(word)) expect(word[0], word).toBe(word[0].toUpperCase());
      }
      // It wears a tone the stylesheet actually defines.
      expect(banner.className).toContain('table-conn-banner--failed');
      expect(banner.className).not.toContain('access_refused');
    }
  );

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
    // Compile-time: each is assignable to the other, so a status added to one
    // and not the other fails `tsc` here rather than falling to `default`.
    const a: TableConnectionState = 'access_refused' as EngineConnectionStatus;
    const b: EngineConnectionStatus = 'access_refused' as TableConnectionState;
    expect(a).toBe(b);
  });

  it('TablePage hands the banner the verdict from the close that produced the status', () => {
    expect(TABLE_PAGE).toMatch(
      /const engineAccessRefusal =\s*engineWsStatus === 'access_refused'\s*\?\s*accessRefusalFromClose\(engineLastError\?\.code, engineLastError\?\.reason\)\s*:\s*null;/
    );
    expect(TABLE_PAGE).toMatch(/<TableConnectionBanner[^>]*accessRefusal=\{engineAccessRefusal\}/);
  });
});
