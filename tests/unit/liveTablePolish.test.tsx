/**
 * LIVE-TABLE POLISH (2026-10-05)
 *
 * Follow-ups from the final review of the ten live-table fixes:
 *
 *   1. A failed Quick Join cash read is not "No Open Seats Right Now", and
 *      every Supabase error on the "+" sheet and the move path is reported.
 *   2. The tournament buy-in read throws a failed read instead of answering
 *      "no buy-ins" silently.
 *   3. Every move path asks one question, "is this tab a tournament", the same
 *      way the tab bar does; both move paths name an unknown table the same.
 *   4. The `/tournaments` backstop lands on the tournament list.
 *   5. The tournament dock is a group a screen reader can read, with a real
 *      toggle button and a visible focus ring.
 *   6. The dock's collapse choice follows another browser tab.
 *   7. "You've Been Moved To" is shown even when the new table's socket takes
 *      longer than the window to connect.
 *   8. A recovery reservation on record for a routine cause is not reused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween } from '../helpers/sourceWindow';
import DisconnectToast, {
  MOVED_HERE_MAX_WAIT_MS,
  MOVED_HERE_MS,
} from '../../src/components/table/DisconnectToast';
import {
  resetTournamentDockStoreForTests,
  subscribeTournamentDock,
  tournamentDockCollapsed,
} from '../../src/lib/tournamentDockStore';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const MULTI = read('src/pages/MultiTablePage.tsx');
const HUD = read('src/components/tournament/TournamentHUD.tsx');
const HUD_CSS = read('src/components/tournament/TournamentHUD.css');
const LABEL = read('src/lib/tournamentTabLabel.ts');
const SEAL = read('server/scripts/engine-release-seal.py');

describe('1. the "+" sheet reports what it could not read', () => {
  const handler = sliceBetween(
    MULTI,
    'const handleAddTable = useCallback(',
    'const handleQuickJoinPick'
  );

  it('a failed cash read takes the lobby exit, reported, instead of an empty sheet', () => {
    const failed = handler.indexOf('if (res.error) throw res.error;');
    expect(failed).toBeGreaterThan(-1);
    expect(failed).toBeLessThan(handler.indexOf('const all = res.data ?? [];'));
    expect(handler).toMatch(
      /\} catch \(err\) \{\s*if \(stale\(\)\) return;\s*reportError\(err, 'MultiTablePage\.quickJoin_read_failed'\);/
    );
  });

  it('the club lookup and the active-row read report their errors', () => {
    expect(handler).toContain("reportError(res.error, 'MultiTablePage.quickJoin_club_lookup')");
    expect(handler).toContain("reportError(one.error, 'MultiTablePage.quickJoin_active_row')");
  });

  it('the seat-move read reports a failed read and a thrown one', () => {
    expect(MULTI).toContain("reportError(rowsErr, 'MultiTablePage.heroSeatMoveRead');");
    expect(MULTI).toContain("reportError(err, 'MultiTablePage.heroSeatMove');");
  });
});

describe('2. the buy-in read throws a failed read', () => {
  it('neither read answers an error with an empty map', () => {
    expect(LABEL).toContain('if (tblErr) throw tblErr;');
    expect(LABEL).toContain('if (tourErr) throw tourErr;');
    expect(LABEL).not.toMatch(/if \(tblErr \|\| !tbls\) return out;/);
    expect(LABEL).not.toMatch(/if \(tourErr \|\| !tours\) return out;/);
  });
});

describe('3. one tournament test on every move path', () => {
  it('the socket path and the re-point both use tabIsTournament', () => {
    expect(MULTI).toMatch(
      /const tabIsTournament = \(t: TableInstance \| undefined\): boolean =>\s*!!t && \(t\.isTournament === true \|\| isTournamentGameCode\(t\.gameCode\)\);/
    );
    expect(MULTI).toContain('if (tabIsTournament(before)) {');
    expect(MULTI).toContain(
      'if (!tabIsTournament(current)) return prev.filter((t) => t.id !== tableId);'
    );
    expect(MULTI).toContain('isTournament: tabIsTournament(current),');
    expect(MULTI).not.toContain('before?.isTournament');
  });

  it('both move paths name an unknown table the same way', () => {
    expect(MULTI).not.toContain("'Your New Table'");
  });
});

describe('4. the /tournaments backstop', () => {
  it('lands on the tournament list', () => {
    const effect = sliceBetween(
      MULTI,
      "if (!matchPath('/tournaments', location.pathname)) return;",
      '}, ['
    );
    expect(effect).toContain("openLobbyTabOn('MTT');");
    expect(effect).not.toContain("masterBus.emit('OPEN_LOBBY_TAB'");
  });
});

describe('5. the tournament dock can be read', () => {
  it('the dock is a group with a real toggle button, not one big button', () => {
    expect(HUD).not.toContain("role={toggle ? 'button' : 'group'}");
    expect(HUD).toMatch(/role="group"\s*aria-label="Tournament Info"\s*onClick=\{toggle\}/);
    expect(HUD).toMatch(
      /<button\s*type="button"\s*className="tournament-dock__line tournament-dock__line--toggle"/
    );
    expect(HUD).toContain(
      "aria-label={collapsed ? 'Show Tournament Info' : 'Hide Tournament Info'}"
    );
  });

  it('the toggle and the LOBBY button show a focus ring', () => {
    expect(HUD_CSS).toMatch(
      /\.tournament-dock__line--toggle:focus-visible,\s*\.tournament-lobby-corner-btn:focus-visible \{\s*outline: 2px solid/
    );
  });
});

describe('6. the dock follows another browser tab', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetTournamentDockStoreForTests();
  });

  it('a storage event for the dock key updates every subscriber', () => {
    expect(tournamentDockCollapsed()).toBe(false);
    const listener = vi.fn();
    const off = subscribeTournamentDock(listener);
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'ca.tournamentDock.collapsed', newValue: '1' })
    );
    expect(tournamentDockCollapsed()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    // Another key, or the same value again, changes nothing.
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: '0' }));
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'ca.tournamentDock.collapsed', newValue: '1' })
    );
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    // With no subscriber left the listener is gone.
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'ca.tournamentDock.collapsed', newValue: '0' })
    );
    expect(tournamentDockCollapsed()).toBe(true);
  });
});

describe('7. the moved line waits for the socket', () => {
  const HERO = 'hero-1';
  const text = (c: HTMLElement) => c.textContent ?? '';
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T14:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a socket that connects after the window still shows the line, for the full window', () => {
    const movedAt = Date.now();
    const props = {
      heroUserId: HERO,
      disconnectStates: {},
      movedHereAtMs: movedAt,
      tableName: 'Table 7',
    };
    const { container, rerender } = render(
      <DisconnectToast {...props} socketStatus="connecting" />
    );
    expect(text(container)).toBe('');
    act(() => {
      vi.advanceTimersByTime(MOVED_HERE_MS + 5000);
    });
    rerender(<DisconnectToast {...props} socketStatus="connected" />);
    expect(text(container)).toBe("You've Been Moved To Table 7");
    act(() => {
      vi.advanceTimersByTime(MOVED_HERE_MS - 100);
    });
    expect(text(container)).toBe("You've Been Moved To Table 7");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(text(container)).toBe('');
  });

  it('a move first seen on a connected socket is still timed from the move', () => {
    const { container } = render(
      <DisconnectToast
        heroUserId={HERO}
        disconnectStates={{}}
        socketStatus="connected"
        movedHereAtMs={Date.now() - MOVED_HERE_MS + 1000}
        tableName="Table 7"
      />
    );
    expect(text(container)).toBe("You've Been Moved To Table 7");
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(text(container)).toBe('');
  });

  it('an old move never resurfaces when a socket finally connects', () => {
    const movedAt = Date.now() - MOVED_HERE_MAX_WAIT_MS - 1;
    const props = {
      heroUserId: HERO,
      disconnectStates: {},
      movedHereAtMs: movedAt,
      tableName: 'Table 7',
    };
    const { container, rerender } = render(
      <DisconnectToast {...props} socketStatus="connecting" />
    );
    rerender(<DisconnectToast {...props} socketStatus="connected" />);
    expect(text(container)).toBe('');
  });
});

describe('8. a routine recovery reservation is not reused', () => {
  it('the seal checks the recorded cause before replaying a reservation', () => {
    const reuse = sliceBetween(SEAL, 'if path.exists():', 'cause = args.cause or ""');
    expect(reuse).toContain('if not RECOVERY_CAUSE_RE.fullmatch(str(value.get("cause") or "")):');
    expect(reuse.indexOf('RECOVERY_CAUSE_RE.fullmatch')).toBeLessThan(
      reuse.indexOf('print(value["announcedAt"])')
    );
  });
});
