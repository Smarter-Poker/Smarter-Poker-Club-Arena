/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT TABLE FIXES — Anti-Regression Suite
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Covers:
 * 1. Tournament Sit-Out & Return Rules: no dead blinds, no post BB required,
 *    players are dealt in immediately without waiting for BB.
 * 2. Card Visibility on Sit Back: tournament players are not blocked by waitingForBB.
 * 3. Bust & Elimination Flow: heroSeat cleared, ghost avatar removed, lobby exit triggered.
 * 4. Bad Beat Jackpot Banner: strictly excluded on MTT, Spins, and Heads-Up tables.
 * 5. Top-Row Avatar Sizing: top avatars are full normal size in tournaments.
 * 6. Tournament STATS Button: upper right HUD widget displays STATS button to open tournament info.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MiniStatsCard } from '../../src/components/table/MiniStatsCard';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const tsCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SEATING_SRC = 'server/src/engine/ServerTableEngineSeating.ts';
const DEALING_SRC = 'server/src/engine/ServerTableEngineDealing.ts';
const TABLE_PAGE_SRC = 'src/pages/TablePage.tsx';
const MODALS_LAYER_SRC = 'src/components/table/TableModalsLayer.tsx';

describe('Tournament Table Engine Seating & Dealing Rules', () => {
  it('does not add tournament players to returningFromSitout (no dead blinds)', () => {
    const code = tsCode(read(SEATING_SRC));
    // Verify that returningFromSitout is guarded by !this.isTournamentTable()
    expect(code).toMatch(
      /if\s*\(!this\.isTournamentTable\(\)\)\s*\{\s*this\.returningFromSitout\.add\(userId\)/
    );
  });

  it('does not add tournament players to waitingForBB on registerWaitForBB', () => {
    const code = tsCode(read(SEATING_SRC));
    expect(code).toMatch(
      /this\.tableInfo\?\.wait_for_big_blind\s*&&\s*!this\.isTournamentTable\(\)/
    );
  });

  it('does not registerWaitForBB for tournament players when seated', () => {
    const code = tsCode(read(DEALING_SRC));
    expect(code).toMatch(
      /!this\.returningFromSitout\.has\(p\.user_id\)\s*&&\s*!this\.isTournamentTable\(\)/
    );
  });

  it('does not attach deadBlinds or bbOnlyPosts in tournament HandConfig', () => {
    const code = tsCode(read(DEALING_SRC));
    expect(code).toMatch(
      /deadBlinds:\s*!this\.isTournamentTable\(\)\s*&&\s*this\.returningFromSitout\.size\s*>\s*0/
    );
    expect(code).toMatch(
      /bbOnlyPosts:\s*!this\.isTournamentTable\(\)\s*&&\s*this\.postingBBToEnter\.size\s*>\s*0/
    );
  });
});

describe('BBJ Exclusion Rules in TableModalsLayer', () => {
  it('hides Bad Beat Jackpot on MTT, Spins, and Heads-Up tables', () => {
    const code = tsCode(read(MODALS_LAYER_SRC));
    expect(code).toMatch(/!isTournament/);
    expect(code).toMatch(/!tournamentId/);
    expect(code).toMatch(/maxPlayers\s*>\s*2/);
    expect(code).toMatch(/gameType\s*!==\s*'heads_up'/);
    expect(code).toMatch(/gameType\s*!==\s*'spin'/);
    expect(code).toMatch(/gameType\s*!==\s*'spins'/);
  });
});

describe('Tournament Table UI & Avatar Sizing in TablePage', () => {
  it('does not shrink top avatars with seat-wrapper--top in tournaments', () => {
    const code = tsCode(read(TABLE_PAGE_SRC));
    expect(code).toMatch(
      /pos\.y\s*<\s*20\s*&&\s*!tableState\.isTournament\s*\?\s*'\s*seat-wrapper--top'/
    );
  });

  it('never renders Post BB To Enter button in tournament tables', () => {
    const code = tsCode(read(TABLE_PAGE_SRC));
    expect(code).toMatch(
      /!tableState\.isTournament\s*&&\s*Array\.isArray\(tableState\.waitingForBBUserIds\)/
    );
  });

  it('resets heroSeat to 0 and cleans up state on tournament player bust/elimination', () => {
    const code = tsCode(read(TABLE_PAGE_SRC));
    expect(code).toMatch(/const isHeroBusted = bustedId === userId;/);
    expect(code).toMatch(/heroSeatRef\.current = 0;/);
  });
});

describe('MiniStatsCard Tournament Stats Bar', () => {
  /**
   * Dan 2026-08-25 (binding): "tournaments are still missing the stats bar in
   * the right corner."
   *
   * This spec used to assert `toHaveTextContent('STATS')` — i.e. it pinned the
   * exact bug. The tournament branch of MiniStatsCard short-circuited past every
   * figure the card exists to show and rendered a bare chart glyph labelled
   * STATS, and this test guarded that. Rewritten in the same commit as the fix
   * (CLAUDE.md §5.8: if you replace behaviour a test pins, update it here, not
   * later) to assert what the corner must now actually contain.
   *
   * The two things worth protecting are unchanged and are both still asserted:
   * it renders for a tournament EVEN WHEN NOT SEATED, and tapping it still
   * opens the tournament lobby / info panel.
   */
  it('renders the real stats bar in tournament mode even when not seated', () => {
    const handleTap = vi.fn();
    render(
      <MiniStatsCard
        currentStack={12345}
        totalBuyIn={0}
        handsPlayed={20}
        vpipCount={5}
        handsWon={3}
        isSeated={false}
        isTournament={true}
        onTap={handleTap}
      />
    );

    const statsBtn = screen.getByRole('button', { name: /tournament stats/i });
    expect(statsBtn).toBeInTheDocument();

    // Figures, not a placeholder glyph. Stack is the one a tournament player
    // actually needs; hands/VPIP/won are the session colour beside it.
    expect(statsBtn).toHaveTextContent('Stack');
    expect(statsBtn).toHaveTextContent('12,345');
    expect(statsBtn).toHaveTextContent('Hands');
    expect(statsBtn).toHaveTextContent('20');
    expect(statsBtn).toHaveTextContent('VPIP');
    expect(statsBtn).toHaveTextContent('25%');
    expect(statsBtn).toHaveTextContent('Won');

    // Buy-In and P&L are deliberately absent: in a tournament the buy-in is
    // money and the stack is chips, so subtracting one from the other is
    // meaningless. Asserted so nobody "restores" them.
    expect(statsBtn).not.toHaveTextContent(/Buy-In/i);
    expect(statsBtn).not.toHaveTextContent(/P&L/i);

    fireEvent.click(statsBtn);
    expect(handleTap).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when not seated in non-tournament cash game', () => {
    const { container } = render(
      <MiniStatsCard
        currentStack={0}
        totalBuyIn={0}
        handsPlayed={0}
        vpipCount={0}
        handsWon={0}
        isSeated={false}
        isTournament={false}
      />
    );

    expect(container.firstChild).toBeNull();
  });
});

describe('Tournament Leave & Unregister Refund Rules', () => {
  it('does not cash out or delete seat on tournament table leave in server engine', () => {
    const code = tsCode(read(SEATING_SRC));
    expect(code).toMatch(/if\s*\(this\.isTournamentTable\(\)\)\s*\{/);
    expect(code).toMatch(
      /this\.disconnectEngine\.sitOut\(this\.tableId,\s*userId,\s*'voluntary'\)/
    );
  });

  it('does not clear seat or eliminate player on tournament table leave in TableService', () => {
    const code = tsCode(read('src/services/TableService.ts'));
    expect(code).toMatch(/table_seats[\s\S]*?status:\s*'sitting_out'/);
    // Ensure we do NOT set left_at for tournament leaves
    expect(code).not.toMatch(
      /if\s*\(tableData\?\.tournament_id\)\s*\{\s*await supabase[\s\S]*?status:\s*'eliminated'/
    );
  });

  it('informs player of tournament sit-out behavior on LeaveTableConfirm', () => {
    const code = tsCode(read('src/components/table/LeaveTableConfirm.tsx'));
    expect(code).toMatch(/isTournament\s*\?\s*'Leave Tournament Table\?'\s*:\s*'Leave Table\?'/);
    expect(code).toMatch(/In Tournaments, Leaving The Table/);
  });
});
