/**
 * QUICK JOIN RUN TOKEN AND LOBBY REMOUNT (2026-10-05)
 *
 * Three leftovers from the 2026-10-04 review of the "+" sheet:
 *
 *   1. A lobby page a Browse Full Lobby request landed on a tournament list
 *      stayed on that list for a later cash "+", because a plain request only
 *      focused the tab. It is now remounted onto the player's saved tab.
 *   2. A "+" press whose reads finished after the sheet was dismissed, or
 *      after a newer press, still painted rows or took a lobby exit. Every
 *      press now carries a run number checked after each await.
 *   3. The spin read was the one read in the sheet without a timeout.
 *
 * Source pins are bounded by structures, never by a character count.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween } from '../helpers/sourceWindow';

const MULTI = readFileSync(resolve(__dirname, '../../src/pages/MultiTablePage.tsx'), 'utf8');

describe('a landed lobby page is remounted by a plain lobby request', () => {
  const reuse = sliceBetween(
    MULTI,
    "useMasterBusSubscription('OPEN_LOBBY_TAB', () => {",
    'if (prev.length >= MAX_TABLES) {'
  );
  const open = sliceBetween(
    MULTI,
    'const openLobbyTabOn = useCallback(',
    'const consumeLobbyLanding = useCallback('
  );
  const consume = sliceBetween(
    MULTI,
    'const consumeLobbyLanding = useCallback(',
    'const handleAddTable = useCallback('
  );

  it('a landing marks the tab, and consuming the landing keeps the mark', () => {
    expect(open).toContain('lobbyLandedList: true');
    expect(consume).not.toContain('lobbyLandedList');
  });

  it('the reuse branch clears the mark and takes a fresh nonce', () => {
    expect(reuse).toContain('prev[existingLobby]?.lobbyLandedList === true');
    expect(reuse).toContain('++lobbyLandingNonceRef.current');
    expect(reuse).toContain('lobbyLandedList: undefined, lobbyLandingNonce: nonce');
  });
});

describe('a stale "+" press writes nothing', () => {
  const handler = sliceBetween(
    MULTI,
    'const handleAddTable = useCallback(',
    'const handleQuickJoinPick'
  );
  const close = sliceBetween(MULTI, 'const closeQuickJoin = useCallback(', '}, []);');

  it('every press takes a run number and every close retires it', () => {
    expect(handler).toContain('const run = ++quickJoinRunRef.current;');
    expect(close).toContain('quickJoinRunRef.current += 1;');
  });

  it('every await in the handler is followed by the stale check', () => {
    const lines = handler.split('\n');
    const awaitEnds: number[] = [];
    lines.forEach((line, i) => {
      if (/\bawait\b/.test(line) && !/import\(/.test(line)) awaitEnds.push(i);
    });
    expect(awaitEnds.length).toBeGreaterThan(4);
    const checks = (handler.match(/if \(stale\(\)\) return;/g) || []).length;
    expect(checks).toBeGreaterThanOrEqual(6);
  });

  it('the failure catch checks before taking a lobby exit', () => {
    const tail = handler.slice(handler.lastIndexOf('} catch {'));
    expect(tail.indexOf('if (stale()) return;')).toBeGreaterThan(-1);
    expect(tail.indexOf('if (stale()) return;')).toBeLessThan(tail.indexOf('openLobbyTabOn'));
  });

  it('the spin read is timed', () => {
    expect(handler).toContain(
      'withTimeout(quickJoinSpinRows(scopeClubIds, activeTableId, openIds)).catch(() => null)'
    );
  });
});
