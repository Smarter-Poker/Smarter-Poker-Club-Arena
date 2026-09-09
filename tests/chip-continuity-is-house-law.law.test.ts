/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP CONTINUITY IS HOUSE LAW - THE CLIENT HALF (Operation Table Stakes,
 *  Slice 0 - OPORD 1.3 section 6). 2026-09-04.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The client renders what the engine sends and decides nothing. This file
 * pins the four things the client is responsible for:
 *
 *   A0.1   there is NO way to take chips off a seat: no removeChips, no
 *          /withdrawchips, no second tab in the table cashier;
 *   A0.14  no player-visible string contains the forbidden words - not a
 *          label, not a tooltip, not a toast, not a rule chip;
 *   6.1    the leave control's only copy while locked is
 *          "Leave Available In M:SS", and the buy-in modal says nothing about
 *          WHY its minimum is higher;
 *   6.3    the countdown ticks only while the engine says the clock is
 *          running, from the engine's clock, and locks only while time remains.
 *
 * The forbidden-word scan is over STRING LITERALS AND JSX TEXT, not
 * identifiers or comments: `no_rathole` is a database column the lobby row
 * type still names until the Slice 6 cutover drops it, and a comment that
 * explains history is not a thing a player reads.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mapEngineSnapshot } from '../src/utils/mapEngineSnapshot';
import {
  heroLeaveIsLocked,
  heroLeaveRemainingMs,
  leaveAvailableLabel,
} from '../src/lib/chipContinuity';
import { cashBuyInRefusalText } from '../src/lib/cashBuyIn';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

/** Strip comments so only code, string literals and JSX text remain. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(
      /(^|[^:'"`])\/\/[^\n]*/g,
      (m, lead: string) => lead + ' '.repeat(m.length - lead.length)
    );

const FORBIDDEN = /\brathole\b|\banti[ -]?rathole\b|\bhit[ -]and[ -]run\b|\bhit\s*&\s*run\b/i;

describe('A0.14 - no player-visible string carries the forbidden words', () => {
  it('scans every src/ file outside comments and identifiers', () => {
    const hits: string[] = [];
    for (const file of walk(path.join(ROOT, 'src'))) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        if (FORBIDDEN.test(line))
          hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the refusal copy for the floor is a number, not a reason', () => {
    expect(
      cashBuyInRefusalText({
        message: 'BUYIN_BELOW_FLOOR: minimum buy-in for this game right now is 250.00',
      })
    ).toBe('The Minimum Buy In For This Game Right Now Is 250.00');
    expect(
      cashBuyInRefusalText({
        message: 'BUYIN_BELOW_FLOOR: minimum buy-in for this game right now is 250.00',
      })
    ).not.toMatch(FORBIDDEN);
    expect(
      cashBuyInRefusalText({
        message: 'NO_RATHOLE: this table requires you to return with the 2,500 you left with',
      })
    ).toBeNull();
  });
});

describe('A0.1 - chips cannot leave a seat without the player', () => {
  const GAME_SERVER_API = read('src/services/GameServerAPI.ts');
  const CASHIER = read('src/components/table/CashierModal.tsx');
  const TABLE_PAGE = read('src/pages/TablePage.tsx');

  it('has no removeChips and no /withdrawchips call', () => {
    expect(stripComments(GAME_SERVER_API)).not.toContain('removeChips');
    expect(stripComments(GAME_SERVER_API)).not.toContain('withdrawchips');
    expect(stripComments(TABLE_PAGE)).not.toContain('handleWithdrawChips');
    expect(stripComments(TABLE_PAGE)).not.toContain('onWithdrawChips');
  });

  it('the table cashier has one action: Add Chips', () => {
    const code = stripComments(CASHIER);
    expect(code).not.toContain('onWithdrawChips');
    expect(code).not.toContain('activeTab');
    expect(code).not.toContain('canWithdrawAmount');
    expect(code).not.toContain('table-cashier-tab-withdraw');
    expect(code).toContain('Add Chips');
  });

  it('the occupancy protocol preserves stay-clock refusals without a browser cashout fallback', () => {
    const TS = stripComments(read('src/services/TableService.ts'));
    const intent = stripComments(read('src/services/SeatLeaveIntent.ts'));
    expect(TS).toContain('leaveSeatWithIntent(tableId, userId)');
    expect(intent).toContain("result.code === 'LEAVE_LOCKED'");
    expect(intent).toMatch(/typeof result\.error === 'string'\s*\?\s*result\.error/);
    expect(TS).not.toContain('record_table_cashout');
    expect(intent).not.toMatch(/supabase\.rpc/);
  });

  it('the lobby has no rule chip and the host has no toggle for the floor', () => {
    expect(stripComments(read('src/components/lobby/lobbyEntries.ts'))).not.toContain(
      "key: 'no_rathole'"
    );
    expect(stripComments(read('src/pages/TableConfigPage.tsx'))).not.toContain('noRathole');
  });
});

describe('6.1 / 6.3 - the leave control renders the engine clock and nothing else', () => {
  it('formats M:SS and nothing more', () => {
    expect(leaveAvailableLabel(372_000)).toBe('Leave Available In 6:12');
    expect(leaveAvailableLabel(0)).toBe('Leave Available In 0:00');
  });

  it('counts down from the engine clock only while running, and unlocks at zero', () => {
    const at = 1_000_000;
    const running = { locked: true, remainingMs: 60_000, running: true, at };
    expect(heroLeaveRemainingMs(running, at + 25_000)).toBe(35_000);
    expect(heroLeaveIsLocked(running, at + 25_000)).toBe(true);
    expect(heroLeaveIsLocked(running, at + 61_000)).toBe(false);
    const paused = { ...running, running: false };
    expect(heroLeaveRemainingMs(paused, at + 25_000)).toBe(60_000);
    expect(heroLeaveIsLocked(paused, at + 999_999)).toBe(true); // frozen, still locked (A0.5)
    expect(heroLeaveIsLocked(null, at)).toBe(false);
  });

  it('mapEngineSnapshot lifts the hero clock out of the seat payload', () => {
    const snapshot = {
      table_id: 't',
      hand_number: 3,
      pot: 0,
      community_cards: [],
      stage: 'preflop',
      dealer_seat: 1,
      current_player: null,
      server_time_ms: 5_000_000,
      players: [
        {
          seat: 1,
          user_id: 'hero',
          stack: 180,
          stay_remaining_ms: 372_000,
          stay_running: true,
          leave_locked: true,
        },
        {
          seat: 2,
          user_id: 'villain',
          stack: 90,
          stay_remaining_ms: 0,
          stay_running: false,
          leave_locked: false,
        },
      ],
    } as unknown as Parameters<typeof mapEngineSnapshot>[0];
    const mapped = mapEngineSnapshot(snapshot, 'hero', 9);
    expect(mapped.heroLeave).toEqual({
      locked: true,
      remainingMs: 372_000,
      running: true,
      at: 5_000_000,
    });
    const older = mapEngineSnapshot(
      { ...(snapshot as any), players: [{ seat: 1, user_id: 'hero', stack: 180 }] } as any,
      'hero',
      9
    );
    expect(older.heroLeave).toBeNull();
  });

  it('the confirm dialog and the menu item carry the label and the buy-in modal says nothing about why', () => {
    const CONFIRM = read('src/components/table/LeaveTableConfirm.tsx');
    expect(CONFIRM).toContain('lockedLabel');
    expect(CONFIRM).toContain('disabled={leaving || !!lockedLabel}');
    const TABLE_PAGE = read('src/pages/TablePage.tsx');
    expect(TABLE_PAGE).toContain(
      "label: heroLeaveLocked ? leaveAvailableLabel(heroLeaveMs) : 'Leave Table'"
    );
    // The floor is read from the server at mount AND every time the buy-in
    // sheet opens (whitespace-tolerant: Prettier owns the layout).
    expect((TABLE_PAGE.match(/supabase\.rpc\(\s*'fn_cash_effective_buyin'/g) ?? []).length).toBe(2);
    expect(TABLE_PAGE).toContain('}, [showBuyInModal, tableId, userId]);');
    const BUYIN = read('src/components/table/BuyInModal.tsx');
    expect(stripComments(BUYIN)).not.toContain('For 2 Hours');
    expect(stripComments(BUYIN)).not.toContain('You Cashed Out');
  });

  it('House Rules carry exactly the three sentences allowed', () => {
    const RULES = read('src/components/table/GameRulesModal.tsx');
    const flat = RULES.replace(/\s+/g, ' ');
    expect(flat).toContain('Chips On The Table Stay On The Table Until You Leave.');
    expect(flat).toContain(
      'If You Are Ahead Of The Money You Put In, You Remain Seated For 10 Minutes Before You Can Leave.'
    );
    expect(flat).toContain(
      'If You Return To The Same Game In This Club Within 2 Hours, You Buy In For At Least The Stack You Left With.'
    );
    // Cash tables only: a tournament seat has no stay clock and no floor.
    expect(RULES).toContain('{isCashTable && (');
    expect(read('src/components/table/TableModalsLayer.tsx')).toContain(
      'isCashTable={!isTournament}'
    );
  });
});
