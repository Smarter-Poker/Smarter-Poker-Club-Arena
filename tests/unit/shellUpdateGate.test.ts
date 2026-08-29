/**
 * THE SHELL UPDATE GATE — the rules for WHEN a stale bundle may be adopted,
 * and the resume-path staleness probe added 2026-08-29.
 *
 * Why this file exists: useShellUpdateGate.ts said "Exported for the unit
 * test" since 2026-08-28 and no such test existed — the same shape as the
 * SHELL_UPDATED message that was posted for months with no listener. A rule
 * that nothing asserts is a comment, not a rule.
 *
 * The resume-path context (see the hook's own block comment): an installed
 * PWA resumed from the app switcher performs no navigation, so nothing
 * revalidated the shell and nothing rotated the SW — a phone could run a
 * replaced bundle for days and every fix shipped in between read as "still
 * broken" or, worse, an OLD bug read as a NEW regression when the bundle
 * finally rotated. Dan, 2026-08-29: "we don't ever want things randomly
 * regressing." The probe is the fix; these beats pin its pieces.
 */
import { describe, it, expect } from 'vitest';
import {
  mayReloadForShell,
  isAtTable,
  extractEntryScript,
  RELOAD_COOLDOWN_MS,
  STALE_CHECK_MIN_INTERVAL_MS,
} from '../../src/hooks/useShellUpdateGate';

describe('mayReloadForShell — never mid-hand, never unseen, never in a loop', () => {
  const base = {
    pathname: '/hub/club-arena/clubs',
    visible: true,
    lastReloadAt: null,
    now: 1_000_000,
  };

  it('allows a reload on a boring page, visible, no recent reload', () => {
    expect(mayReloadForShell(base)).toBe(true);
  });

  it('NEVER reloads a player who is at a table', () => {
    expect(mayReloadForShell({ ...base, pathname: '/hub/club-arena/table/abc' })).toBe(false);
    expect(mayReloadForShell({ ...base, pathname: '/table/abc' })).toBe(false);
  });

  it('never burns the update on a hidden tab', () => {
    expect(mayReloadForShell({ ...base, visible: false })).toBe(false);
  });

  it('refuses a second reload inside the cooldown, allows one after it', () => {
    expect(mayReloadForShell({ ...base, lastReloadAt: base.now - RELOAD_COOLDOWN_MS + 1 })).toBe(
      false
    );
    expect(mayReloadForShell({ ...base, lastReloadAt: base.now - RELOAD_COOLDOWN_MS - 1 })).toBe(
      true
    );
  });
});

describe('isAtTable — the one route the gate must respect', () => {
  it('matches single-table and multi-table URLs', () => {
    expect(isAtTable('/hub/club-arena/table/f2c86e7a')).toBe(true);
    expect(isAtTable('/table/f2c86e7a')).toBe(true);
  });
  it('does not match the lobby, clubs, or a word containing "table"', () => {
    expect(isAtTable('/hub/club-arena/clubs')).toBe(false);
    expect(isAtTable('/hub/club-arena/tournaments')).toBe(false);
    expect(isAtTable('/hub/club-arena/create-table')).toBe(false);
  });
});

describe('extractEntryScript — the build identity read from a shell document', () => {
  it('finds the vite entry chunk in a production shell', () => {
    const html =
      '<head><link rel="modulepreload" href="/hub/club-arena/assets/vendor-react-C2kmzSSi-v6.js">' +
      '<script type="module" crossorigin src="/hub/club-arena/assets/index-DjnB0U9N-v6.js"></script></head>';
    expect(extractEntryScript(html)).toBe('assets/index-DjnB0U9N-v6.js');
  });

  it('two shells naming different entries are two different deploys', () => {
    const a = extractEntryScript('<script src="/hub/club-arena/assets/index-AAAAaaaa-v6.js">');
    const b = extractEntryScript('<script src="/hub/club-arena/assets/index-BBBBbbbb-v6.js">');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('returns null for a dev-server shell, so the probe stands down', () => {
    expect(extractEntryScript('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
  });
});

describe('the probe is throttled', () => {
  it('cannot touch the network more than once a minute', () => {
    // The constant is load-bearing: without it every visibility flick puts a
    // shell fetch on the wire. If someone lowers it below 30s, they should be
    // doing it here, on purpose, with a reason.
    expect(STALE_CHECK_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(30 * 1000);
  });
});
