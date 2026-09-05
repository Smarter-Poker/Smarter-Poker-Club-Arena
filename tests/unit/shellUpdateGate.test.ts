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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  mayReloadForShell,
  isAtTable,
  extractEntryScript,
  settleDelayMs,
  RELOAD_COOLDOWN_MS,
  IDLE_BEFORE_RELOAD_MS,
  STALE_CHECK_MIN_INTERVAL_MS,
  STARTUP_WINDOW_MS,
  SETTLE_MS,
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

  it('NEVER reloads a player who is using the page (Dan 2026-09-05: the random lobby reload)', () => {
    // 91 bundles a day made every visible lobby stale every few minutes; a
    // reload is now also refused while the player has touched the page
    // inside IDLE_BEFORE_RELOAD_MS, except inside the startup window.
    expect(mayReloadForShell({ ...base, lastInputAt: base.now - 1000, pageAgeMs: 60_000 })).toBe(
      false
    );
    expect(
      mayReloadForShell({
        ...base,
        lastInputAt: base.now - IDLE_BEFORE_RELOAD_MS + 1,
        pageAgeMs: 60_000,
      })
    ).toBe(false);
    expect(
      mayReloadForShell({
        ...base,
        lastInputAt: base.now - IDLE_BEFORE_RELOAD_MS - 1,
        pageAgeMs: 60_000,
      })
    ).toBe(true);
    // A stale boot still restarts at once, before anything is built.
    expect(mayReloadForShell({ ...base, lastInputAt: base.now, pageAgeMs: 1000 })).toBe(true);
    expect(IDLE_BEFORE_RELOAD_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(RELOAD_COOLDOWN_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  it('the hook listens for the player input that gates it, passively', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../src/hooks/useShellUpdateGate.ts'),
      'utf8'
    );
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
      expect(src).toContain(`'${ev}'`);
    }
    expect(src).toMatch(/window\.addEventListener\(ev, noteInput, \{ passive: true \}\)/);
    expect(src).toMatch(/lastInputAt,\s*pageAgeMs: performance\.now\(\),/);
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

describe('settleDelayMs — a startup reload happens NOW, a mid-session one settles first', () => {
  /* Dan 2026-08-29: the open-from-Hub glitch was the app painting, sitting
     for the 3s settle, then hard-reloading — "it looks like broken code."
     Inside the startup window a genuinely-stale boot restarts immediately,
     while it still reads as part of loading. After the window, the settle
     delay exists to protect a player who just opened a table, and stays. */
  it('skips the settle inside the startup window', () => {
    expect(settleDelayMs(0)).toBe(0);
    expect(settleDelayMs(STARTUP_WINDOW_MS - 1)).toBe(0);
  });

  it('keeps the full settle after the window', () => {
    expect(settleDelayMs(STARTUP_WINDOW_MS)).toBe(SETTLE_MS);
    expect(settleDelayMs(STARTUP_WINDOW_MS + 60_000)).toBe(SETTLE_MS);
  });

  it('the settle delay itself remains long enough to be a real re-check', () => {
    expect(SETTLE_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe('SHELL_UPDATED and controllerchange arm the gate only after verification', () => {
  /* Both events fire in situations where the running bundle is ALREADY
     current (the SW freshness race serves the new shell on the very
     navigation whose revalidation then reports "changed"; a new SW claiming
     a page says nothing about what that page executes). Blindly arming on
     either reboots a current session for nothing. The hook must compare the
     running entry chunk against the deployed one first — pin the source
     because the trigger is a SW message and the effect is a page reload,
     which no unit harness can honestly execute. */
  const src = readFileSync(
    path.resolve(__dirname, '../../src/hooks/useShellUpdateGate.ts'),
    'utf8'
  );

  it('neither event handler sets pending directly any more', () => {
    expect(src.includes('verifyThenArm')).toBe(true);
    expect(
      /onMessage[\s\S]{0,200}?pending = true/.test(
        src.slice(src.indexOf('const onMessage'), src.indexOf('const onControllerChange'))
      ),
      'SHELL_UPDATED arms the reload without verifying staleness'
    ).toBe(false);
    expect(
      /pending = true/.test(
        src.slice(src.indexOf('const onControllerChange'), src.indexOf('let lastStaleCheckAt'))
      ),
      'controllerchange arms the reload without verifying staleness'
    ).toBe(false);
  });
});

describe('shell telemetry — the fix is measured, not believed (2026-08-29 hardening)', () => {
  /* SHELL_STALENESS_CHECKED (both outcomes, per source) gives the stale-boot
     rate; SHELL_RELOADED (with page age) counts actual reboots. Together they
     are how we know the open-from-Hub glitch stays dead. Source-level pin:
     the triggers are SW events and the effect is a page reload. */
  const src = readFileSync(
    path.resolve(__dirname, '../../src/hooks/useShellUpdateGate.ts'),
    'utf8'
  );

  it('every staleness verification emits SHELL_STALENESS_CHECKED — both outcomes', () => {
    const emits = src.match(/masterBus\.emit\('SHELL_STALENESS_CHECKED'/g) ?? [];
    // One in verifyThenArm (shell-updated / controllerchange), one in the
    // resume probe. Emitting only when stale would destroy the denominator.
    expect(emits.length).toBeGreaterThanOrEqual(2);
    expect(src.includes("source: 'resume-probe'")).toBe(true);
  });

  it('every actual reload emits SHELL_RELOADED with the page age', () => {
    expect(
      /masterBus\.emit\('SHELL_RELOADED', \{ pageAgeMs[\s\S]{0,120}?window\.location\.reload\(\)/.test(
        src
      ),
      'the reload fires without being counted — the glitch rate is unmeasurable again'
    ).toBe(true);
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
