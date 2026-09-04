/**
 * THE DOOR IS NEVER LOCKED (Dan 2026-09-04)
 *
 * "You should never be 'denied' the ability to leave a table, even if you
 * 'aren't logged in'. The leave table acts like the back button or takes you
 * back to the lobby, that's the default."
 *
 * What he saw: spectating a PLO6 table with 0 chips, Leave Table produced an
 * "Authentication Required" toast and the table stayed on screen. The engine's
 * /leave handler had answered 401 to a request that carried no Authorization
 * header, TableService (correctly) refused to move chips without an engine ack,
 * and TablePage showed that refusal as the reason the player could not leave a
 * table they were only WATCHING.
 *
 * Leaving the VIEW is always allowed. Cashing out is the engine's to grant.
 * These pins keep the two apart.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const PAGE = strip(read('src/pages/TablePage.tsx'));

const slice = (from: string, to: string) => {
  const a = PAGE.indexOf(from);
  expect(a, `${from} not found`).toBeGreaterThan(-1);
  const b = PAGE.indexOf(to, a + from.length);
  expect(b, `${to} not found after ${from}`).toBeGreaterThan(-1);
  return PAGE.slice(a, b);
};

describe('Leave Table (the menu door)', () => {
  const body = slice(
    'const handleLeaveTable = async () => {',
    'const handleForceLeaveTable = async'
  );

  it('never returns silently for a missing user or table', () => {
    // The old first line: `if (!tableId || !userId) return;` - a player whose
    // session had not hydrated got nothing at all from the button.
    expect(body).not.toMatch(/if \(!tableId \|\| !userId\) return;/);
  });

  it('a spectator leaves without asking the engine to release a seat', () => {
    const guard = body.indexOf('liveSeat <= 0');
    const engine = body.indexOf('tableService.leaveTable(');
    expect(guard).toBeGreaterThan(-1);
    expect(engine).toBeGreaterThan(-1);
    expect(guard, 'the no-seat exit must come before the engine call').toBeLessThan(engine);
    const noSeat = body.slice(guard, body.indexOf('}', guard));
    expect(noSeat).toMatch(/leaveWithoutCashout\(/);
  });

  it('an engine refusal sends the player to the lobby with the seat kept, never holds them on the felt', () => {
    // Every refusal branch goes through goToLobbyKeepingSeat, and none of
    // them parks the reason in leaveNotice (the toast that used to be the
    // whole outcome).
    expect(body).not.toMatch(/setLeaveNotice\((?!null)/);
    const refusals = body.match(/goToLobbyKeepingSeat\(/g) ?? [];
    // stay clock, seat-first refused, seat-first threw, engine refused, threw
    expect(refusals.length).toBeGreaterThanOrEqual(5);
    // and the engine's own reason still leads the message
    expect(body).toMatch(/goToLobbyKeepingSeat\(\s*`\$\{result\.error\}/);
  });

  it('the stay clock still says when the cash-out opens, and still lets the player look at the lobby', () => {
    const lock = body.slice(
      body.indexOf('if (heroLeaveLocked)'),
      body.indexOf('}', body.indexOf('if (heroLeaveLocked)'))
    );
    expect(lock).toMatch(/leaveAvailableLabel\(heroLeaveMs\)/);
    expect(lock).toMatch(/goToLobbyKeepingSeat\(/);
    expect(lock).not.toMatch(/toast\.error/);
  });
});

describe('the tab X (the other door)', () => {
  const body = slice(
    'const handleForceLeaveTable = async () => {',
    'const handleHoleCardPayload = useCallback('
  );

  it('closes a seatless tab without an engine call', () => {
    const guard = body.indexOf('forceLiveSeat <= 0');
    const engine = body.indexOf('tableService.leaveTable(');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(engine);
    const noSeat = body.slice(guard, body.indexOf('return;', guard));
    expect(noSeat).toMatch(/masterBus\.emit\('TABLE_LEFT'/);
  });

  it('a refused cash-out keeps the tab and still goes to the lobby', () => {
    expect(body).toMatch(/goToLobbyKeepingSeat\(\s*`\$\{forced\.error\}/);
    expect(body).not.toMatch(/setLeaveNotice\(/);
  });
});

describe('the helpers that make it true', () => {
  it('goToLobbyKeepingSeat navigates and does NOT close the tab (the seat is live)', () => {
    const helper = slice('const goToLobbyKeepingSeat = ', 'const leaveWithoutCashout = ');
    expect(helper).toMatch(/navigate\(exitDestination\(\)\)/);
    expect(helper).not.toMatch(/CLOSE_TABLE_TAB/);
    expect(helper).not.toMatch(/heroSeatRef\.current = 0/);
  });

  it('leaveWithoutCashout closes the tab and navigates, and moves no chips', () => {
    const helper = slice('const leaveWithoutCashout = ', 'const handleLeaveTable = async');
    expect(helper).toMatch(/CLOSE_TABLE_TAB/);
    expect(helper).toMatch(/navigate\(exitDestination\(\)\)/);
    expect(helper).not.toMatch(/tableService\.leaveTable\(|atomic_table_cashout|supabase\.rpc\(/);
  });

  it('the engine client tries a session refresh before sending an unauthenticated request', () => {
    const api = strip(read('src/services/GameServerAPI.ts'));
    const fn = api.slice(
      api.indexOf('async function getAuthHeaders'),
      api.indexOf('\n}\n', api.indexOf('async function getAuthHeaders'))
    );
    expect(fn).toMatch(/supabase\.auth\.refreshSession\(\)/);
    expect(fn.indexOf('getSession()')).toBeLessThan(fn.indexOf('refreshSession()'));
  });
});
