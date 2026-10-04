/**
 * A SEAT THE TOURNAMENT MOVED IS NOT A RECONNECTING SEAT, AND THE RECONNECT
 * LINE IS NEVER CUT OFF (Dan 2026-10-04)
 *
 * "WHEN A TABLE BREAKS AND YOU ARE MOVED TO A NEW TABLE AND SEAT, IT DISPLAYS
 *  THE 'RECONNECTING YOUR SEAT' INSTEAD OF 'YOU'VE BEEN MOVED TO TABLE XXX'.
 *  (AND THE 'RECONNECTING YOUR SEAT' NEEDS TO BE FULLY DISPLAYED AND NOT CUT
 *  OFF WHEN YOU ARE ACTUALLY HAVING CONNECTION ISSUES.)"
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DisconnectToast, { MOVED_HERE_MS } from '../src/components/table/DisconnectToast';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const strip = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const HERO = 'hero-1';
const missing = () => ({
  [HERO]: { state: 'MISSING', sinceMs: Date.now(), graceDeadlineMs: Date.now() + 30_000 },
});
const text = (c: HTMLElement) => c.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-04T14:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the felt says what happened', () => {
  it('a seat that has just been moved here reads "You\'ve Been Moved To <table>", not "Reconnecting"', () => {
    const { container } = render(
      <DisconnectToast
        heroUserId={HERO}
        disconnectStates={missing() as never}
        socketStatus="connected"
        movedHereAtMs={Date.now()}
        tableName="Main Event - Table 4"
      />
    );
    expect(text(container)).toBe("You've Been Moved To Main Event - Table 4");
    expect(text(container)).not.toMatch(/Reconnecting/);
    expect(container.querySelector('.disconnect-toast--moved')).not.toBeNull();
    expect(container.querySelector('.disconnect-toast__spinner')).toBeNull();
  });

  it('says so even when the engine can already hear the player', () => {
    const { container } = render(
      <DisconnectToast
        heroUserId={HERO}
        disconnectStates={{}}
        socketStatus="connected"
        movedHereAtMs={Date.now()}
        tableName="Table 7"
      />
    );
    expect(text(container)).toBe("You've Been Moved To Table 7");
  });

  it('names no table it does not know', () => {
    const { container } = render(
      <DisconnectToast
        heroUserId={HERO}
        disconnectStates={{}}
        socketStatus="connected"
        movedHereAtMs={Date.now()}
      />
    );
    expect(text(container)).toBe("You've Been Moved To A New Table");
  });

  it('is a bounded window: a seat still unheard after it gets the real line and its countdown', () => {
    const { container } = render(
      <DisconnectToast
        heroUserId={HERO}
        disconnectStates={missing() as never}
        socketStatus="connected"
        movedHereAtMs={Date.now()}
        tableName="Table 7"
      />
    );
    expect(text(container)).toMatch(/Moved To Table 7/);
    act(() => {
      vi.advanceTimersByTime(MOVED_HERE_MS + 50);
    });
    expect(text(container)).toMatch(/^Reconnecting Your Seat, \d+s Until Auto Action$/);
  });

  it('an old move does not speak, and a table the player opened themselves never does', () => {
    const old = render(
      <DisconnectToast
        heroUserId={HERO}
        disconnectStates={{}}
        socketStatus="connected"
        movedHereAtMs={Date.now() - MOVED_HERE_MS - 1}
        tableName="Table 7"
      />
    );
    expect(text(old.container)).toBe('');
    const own = render(
      <DisconnectToast heroUserId={HERO} disconnectStates={{}} socketStatus="connected" />
    );
    expect(text(own.container)).toBe('');
  });

  it('defers to the socket banner and to a background tab exactly as before', () => {
    const down = render(
      <DisconnectToast
        heroUserId={HERO}
        disconnectStates={{}}
        socketStatus="reconnecting"
        movedHereAtMs={Date.now()}
      />
    );
    expect(text(down.container)).toBe('');
    const background = render(
      <DisconnectToast
        heroUserId={HERO}
        disconnectStates={{}}
        socketStatus="connected"
        isActive={false}
        movedHereAtMs={Date.now()}
      />
    );
    expect(text(background.container)).toBe('');
  });
});

describe('the move is announced once, whichever transport hears it first', () => {
  const MTP = strip(read('src/pages/MultiTablePage.tsx'));
  const PAGE = strip(read('src/pages/TablePage.tsx'));

  it('both move paths go through one announcer that speaks once per destination', () => {
    expect(MTP).toMatch(/if \(announcedMovesRef\.current\.has\(destinationId\)\) return;/);
    expect(MTP).toMatch(/toast\.info\(`You've Been Moved To \$\{name\}`, 6000\)/);
    // The socket path (the tab re-point) ...
    expect(MTP).toMatch(
      /if \(before\?\.isTournament\) announceTournamentMoveRef\.current\(updates\.movedToTableId\);/
    );
    // ... and the seat-row path.
    expect(MTP).toMatch(/announceTournamentMove\(newId, name\);/);
    // The old wording, which only one of the two paths ever said, is gone.
    expect(MTP).not.toMatch(/You Were Moved To/);
  });

  it('both paths stamp the tab, and the table page hands the stamp to the felt line', () => {
    expect(MTP.match(/arrivedByMoveAt: Date\.now\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(MTP.match(/arrivedByMoveAtMs=\{table\.arrivedByMoveAt\}/g)).toHaveLength(2);
    const at = PAGE.indexOf('<DisconnectToast');
    const mount = PAGE.slice(at, PAGE.indexOf('/>', at));
    expect(mount).toMatch(/movedHereAtMs=\{arrivedByMoveAtMs\}/);
    expect(mount).toMatch(/tableName=\{/);
  });
});

describe('the line is never cut off', () => {
  const CSS = strip(read('src/components/table/DisconnectToast.css'));
  const rule = CSS.slice(CSS.indexOf('.disconnect-toast {'));
  const body = rule.slice(0, rule.indexOf('}'));

  it('wraps instead of clipping', () => {
    expect(body).toMatch(/white-space:\s*normal/);
    expect(body).not.toMatch(/nowrap/);
    expect(CSS).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(body).not.toMatch(/overflow:\s*hidden/);
  });

  it('can use the width of the felt: pinned at both edges, not hung from the centre line', () => {
    // `left: 50%` alone caps an absolute box at HALF its container.
    expect(body).not.toMatch(/left:\s*50%/);
    expect(body).toMatch(/left:\s*4%/);
    expect(body).toMatch(/right:\s*4%/);
    expect(body).toMatch(/margin-inline:\s*auto/);
    expect(body).toMatch(/width:\s*fit-content/);
  });
});
