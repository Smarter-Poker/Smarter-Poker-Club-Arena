import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FINAL SWEEP, 2026-09-08 - three things the table said that were not true
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "DO A FINAL SWEEP AND CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS,
 * REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE."
 *
 * 1. HandReveal offered a greyed "Reveal (10)" button that could never fire:
 *    TableModalsLayer never passed `userDiamonds` or `onPayReveal`, so the
 *    defaults (0 < 10) disabled it for ever. A dead button on a diamond price.
 * 2. WaitListModal quoted "Est. Wait" as (position - 1) x 5 minutes, from a
 *    default nobody ever overrode - a number nobody measured.
 * 3. TournamentBreakScreen was handed `currentLevel={0}`, `topPlayers={[]}`,
 *    `prizePool={0}` and ONE table's seats as the field, so every break said
 *    "Coming Next: Level 1", a prize pool of 0, no leaders and no hero line.
 */

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import { HandReveal } from '../../src/components/table/HandReveal';
import { WaitListModal } from '../../src/components/table/WaitListModal';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('HandReveal never shows a paid reveal it cannot sell', () => {
  const base = {
    isOpen: true,
    isWinner: false,
    winnerId: 'w',
    winnerName: 'Winner',
    revealedCards: [],
    onShow: () => {},
    onMuck: () => {},
    onClose: () => {},
  };

  it('with no pay handler the loser gets Done, not a dead Reveal button', () => {
    render(<HandReveal {...base} />);
    expect(screen.queryByRole('button', { name: /reveal/i })).toBeNull();
    expect(screen.getByRole('button', { name: /done/i })).toBeTruthy();
  });

  it('with a pay handler the Reveal button appears and is priced', () => {
    render(<HandReveal {...base} onPayReveal={() => {}} userDiamonds={50} revealCost={10} />);
    const btn = screen.getByRole('button', { name: /reveal/i });
    expect(btn.textContent).toContain('10');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('WaitListModal quotes a wait only when it has one', () => {
  const players = [
    { playerId: 'a', playerName: 'A', position: 1, joinedAt: new Date() },
    { playerId: 'me', playerName: 'Me', position: 2, joinedAt: new Date() },
  ];
  const base = {
    isOpen: true,
    onClose: () => {},
    tableName: 'NLH 1/2',
    blinds: '1/2',
    players,
    myPlayerId: 'me',
    onLeaveWaitList: () => {},
  };

  it('prints the position and no estimate when none was supplied', () => {
    const { container } = render(<WaitListModal {...base} />);
    expect(container.textContent).toContain('#2');
    expect(container.textContent).not.toContain('Est. Wait');
  });

  it('prints the estimate when the caller supplies a real average', () => {
    const { container } = render(<WaitListModal {...base} avgWaitTimeMinutes={4} />);
    expect(container.textContent).toContain('Est. Wait');
  });
});

describe('the break screen reads the tournament, not four constants', () => {
  it('TableModalsLayer hands it the tournament and the hero, and no zeros', () => {
    const layer = read('src/components/table/TableModalsLayer.tsx');
    const block = layer.slice(
      layer.indexOf('<TournamentBreakScreen'),
      layer.indexOf('{/* Tournament Announcement Overlay */}')
    );
    expect(block).toMatch(/tournamentId=\{tournamentId \?\? null\}/);
    expect(block).toMatch(/heroUserId=\{userId \?\? null\}/);
    expect(block).not.toMatch(/currentLevel=\{0\}|topPlayers=\{\[\]\}|prizePool=\{0\}/);
  });

  it('the screen reads level, pool, field and leaders from the tournament rows', () => {
    const screenSrc = read('src/components/table/TournamentBreakScreen.tsx');
    expect(screenSrc).toMatch(
      /\.from\('tournaments'\)\s*\.select\('current_level, prize_pool, current_players, max_players'\)/
    );
    expect(screenSrc).toMatch(
      /\.from\('tournament_players'\)\s*\.select\('user_id, username, chips, status'\)/
    );
    expect(screenSrc).toMatch(/topPlayers: ranked\.slice\(0, 5\)/);
    expect(screenSrc).toMatch(/myPlayer: ranked\.find\(\(r\) => r\.isCurrentUser\)/);
  });
});

describe('the engine side of the sweep', () => {
  const BASE = read('server/src/engine/ServerTableEngineBase.ts');
  const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');
  const SETTLEMENT = read('server/src/engine/ServerTableEngineSettlement.ts');
  const PENDING = read('server/src/services/supabase/pendingWrites.ts');

  it('every busted exit, human or horse, leaves through releaseBustedSeat', () => {
    expect(BASE).toMatch(/protected async releaseBustedSeat\(/);
    expect(DEALING).toMatch(/releaseBustedSeat\(player, 'busted_no_rebuy'\)/);
    expect(DEALING).toMatch(/releaseBustedSeat\(horse, 'busted_stop_loss'\)/);
    expect(DEALING).toMatch(/releaseBustedSeat\(horse, 'busted_unfunded'\)/);
    expect(SETTLEMENT).toMatch(/releaseBustedSeat\(horse, 'busted_stop_loss'\)/);
    expect(SETTLEMENT).toMatch(/releaseBustedSeat\(horse, 'busted_unfunded'\)/);
    // The Dealing sweep and Settlement stop at the SAME rule.
    expect(DEALING).toMatch(/if \(atRebuyStopLoss\(horse\.user_id, currentRebuys\)\)/);
    expect(DEALING).not.toMatch(/if \(currentRebuys >= 2\)/);
  });

  it('the two cash sweeps that move seats honour the platform freeze', () => {
    const standUp = DEALING.slice(
      DEALING.indexOf('protected async standUpBustedCashPlayers'),
      DEALING.indexOf('protected async recoverBustedSeatedHorses')
    );
    expect(standUp).toMatch(/if \(isMaintenanceFrozen\(\)\) return;/);
    const evict = BASE.slice(
      BASE.indexOf('protected async evictExpiredSitOuts'),
      BASE.indexOf('protected async evictExpiredSitOuts') + 1200
    );
    expect(evict).toMatch(/if \(isMaintenanceFrozen\(\)\) return;/);
  });

  it('the off-path write queue does not spend its budget on a freeze', () => {
    expect(PENDING).toMatch(
      /if \(isMaintenanceFrozen\(\)\) \{\s*for \(const e of pending\.values\(\)\) e\.frozenMs \+= sinceLast;/
    );
    expect(PENDING).toMatch(
      /now\(\) - entry\.enqueuedAt - entry\.frozenMs >= PENDING_WRITE_BUDGET_MS/
    );
  });

  it('a refused start settles ready, and the three orphaned engines report to the hub', () => {
    const start = BASE.slice(
      BASE.indexOf('  async start(): Promise<void> {'),
      BASE.indexOf('this.running = true;')
    );
    expect((start.match(/this\.settleReady\(false\);/g) ?? []).length).toBe(3);
    expect(BASE).toMatch(/new StraddleEngine\(\(event\) => bridgeToHub\('Straddle', event\)\)/);
    expect(BASE).toMatch(/new ChipRaceEngine\(\(event\) => bridgeToHub\('ChipRace', event\)\)/);
    expect(BASE).toMatch(/new TableBreakEngine\(\(event\) => bridgeToHub\('TableBreak', event\)\)/);
  });
});
