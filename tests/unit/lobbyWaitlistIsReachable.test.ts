import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cashEntry } from '../../src/components/lobby/lobbyEntries';
import type { LobbyTableRow } from '../../src/components/lobby/lobbyEntries';

/**
 * The waitlist was half-built: `'waitlist'` had been a LobbyStatusKey since the
 * lobby was written, the CSS for it existed, WaitlistService could join and
 * leave, and the detail panel had the buttons — but nothing ever PRODUCED that
 * status and no card ever offered the action. A full table said "Full" and
 * offered Join Table, a button that can only fail.
 *
 * These pin the three halves together so none can rot away on its own again.
 */

const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const table = (over: Partial<LobbyTableRow> = {}): LobbyTableRow =>
  ({
    id: 't1',
    name: 'Table One',
    game_type: 'NLH',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 40,
    max_buy_in: 200,
    max_players: 6,
    current_players: 6,
    status: 'active',
    ...over,
  }) as unknown as LobbyTableRow;

describe('a full cash table offers the waitlist', () => {
  it('says Full when nobody is waiting', () => {
    expect(cashEntry(table()).status).toBe('full');
    expect(cashEntry(table()).statusLabel).toBe('Full');
  });

  it('counts the waiters when there are some', () => {
    const e = cashEntry(table(), 3);
    expect(e.status).toBe('waitlist');
    expect(e.statusLabel).toBe('Waitlist 3');
  });

  it('does not claim a waitlist on a table with a seat free', () => {
    // A stale count must never outrank an actually open seat.
    const e = cashEntry(table({ current_players: 4 }), 3);
    expect(e.status).not.toBe('waitlist');
  });

  it('renders a Join Waitlist action instead of a join that cannot succeed', () => {
    const tsx = src('src/components/lobby/LobbyTable.tsx');
    expect(tsx).toContain('data-act="waitlist"');
    expect(tsx).toContain('Join Waitlist');
    expect(tsx).toContain('Leave Waitlist');
    // Join Table must be gated on the table NOT being full.
    expect(tsx).toContain('{!full && ctx.onJoinTable && (');
  });

  it('is wired from the page, with the count in the memo signature', () => {
    const page = src('src/pages/ClubHomePage.tsx');
    expect(page).toContain('waitlistService.countsFor');
    expect(page).toContain('onWaitlistToggle');
    // Without the count in the signature the entry cache would keep a stale
    // "Waitlist 2" forever, because the count is not a field on the row.
    expect(page).toMatch(
      /const sig = `\$\{JSON\.stringify\(row\)\}\|\$\{waitlistCounts\.get\(row\.id\)/
    );
  });

  it('asks for the counts in one query, not one per row', () => {
    const svc = src('src/services/WaitlistService.ts');
    expect(svc).toContain('countsFor');
    expect(svc).toMatch(/\.in\(\s*'table_id'/);
  });
});
