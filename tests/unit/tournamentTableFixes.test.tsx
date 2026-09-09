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
// `sliceMethod` was imported twice here (a duplicate named import, TS2300).
// Pre-existing on main and harmless only because tests/ sits outside the app
// tsconfig; corrected in passing, 2026-08-28.
import { sliceMethod } from '../helpers/sourceWindow';

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
    // The tournament exclusion is what this test is about, and it is intact.
    // The `wait_for_big_blind &&` half was dropped on 2026-08-25: that set no
    // longer gates a WAIT (cash entry is free and released on the next loop
    // tick), it only gates the two positional hold-outs — and one of those
    // enforces "CASH GAME PLAYERS CAN NEVER BE DEALT INTO THE SMALL BLIND."
    // Leaving the gate in meant a host who turned the setting off skipped
    // registration, skipped the hold-out, and had brand-new players dealt
    // straight into the small blind. A table setting must not be able to switch
    // off a house rule.
    const at = code.indexOf('public registerWaitForBB');
    expect(at).toBeGreaterThan(-1);
    const body = sliceMethod(code, 'public registerWaitForBB');
    expect(body).toMatch(
      /if \(!this\.isTournamentTable\(\)\)\s*\{\s*this\.waitingForBB\.add\(userId\)/
    );
  });

  it('does not registerWaitForBB for tournament players when seated', () => {
    const code = tsCode(read(DEALING_SRC));
    expect(code).toMatch(
      /!this\.returningFromSitout\.has\(p\.user_id\)\s*&&\s*!this\.isTournamentTable\(\)/
    );
  });

  it('never attaches deadBlinds to a tournament, and bills a tournament seat only through mustPostBB', () => {
    const code = tsCode(read(DEALING_SRC));
    // Unchanged: a tournament player never owes a dead small blind.
    expect(code).toMatch(
      /deadBlinds:\s*!this\.isTournamentTable\(\)\s*&&\s*this\.returningFromSitout\.size\s*>\s*0/
    );

    /* UPDATED 2026-08-27, house rule 8 — this half of the contract genuinely
       CHANGED, so the spec changes with it rather than being deleted.

       `bbOnlyPosts` is no longer cash-only. B2 gave it a second source: a
       tournament arrival that lands on the button or the small blind has taken
       the one seat the big blind has just passed, and would otherwise play most
       of a free orbit while everyone already at the table had paid to be there.
       A cash player is held out of the hand instead (registerWaitForBB), which
       is not available in a tournament — tournament players must be dealt in
       and blinded off or the field never shrinks. So they owe one live big
       blind, billed through the same config field.

       The invariant this test guards is therefore no longer "tournaments never
       populate bbOnlyPosts" but the SPLIT, which is what is pinned below: the
       cash set can still never bill a tournament seat, and the tournament set
       can still never bill a cash seat. Nothing here is loosened — the two
       gates are each asserted where the single old assertion covered one, and
       the behaviour itself is exercised in
       server/src/engine/TournamentArrivalPosting.test.ts. */
    expect(code).toMatch(/if \(!this\.isTournamentTable\(\) && this\.postingBBToEnter\.size > 0\)/);
    expect(code).toMatch(/if \(this\.isTournamentTable\(\) && this\.mustPostBB\.size > 0\)/);
    expect(code).toMatch(
      /bbOnlyPosts:\s*bbOnlyPostSeats\.length > 0 \? bbOnlyPostSeats : undefined/
    );
    // And mustPostBB is only ever added to on a tournament table.
    const seating = tsCode(read(SEATING_SRC));
    const note = sliceMethod(seating, 'protected noteTournamentArrival');
    expect(note).toMatch(/if \(!this\.isTournamentTable\(\)\) return;/);
    expect(note).toMatch(/this\.mustPostBB\.add\(userId\)/);
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
   * it renders for a tournament, and tapping it opens the tournament lobby /
   * info panel.
   *
   * ── 2026-08-26: THIS SPEC USED AN IMPOSSIBLE FIXTURE ──────────────────────
   *
   * It passed `isSeated={false}` together with `currentStack={12345}`, a
   * combination production cannot produce: TablePage feeds
   * `players[heroSeat - 1]?.stack || 0`, and an observer's `heroSeat` is 0, so
   * an unseated viewer's stack is ALWAYS 0. The spec therefore asserted the
   * figures render for a spectator while proving nothing about what a spectator
   * actually sees — which was `Stack 0 · Hands 0 · VPIP 0% · Won 0`, a readout
   * that looks like a broken HUD. Watching a running tournament is a first-class
   * route now (Dan 2026-08-25, item 1), so that is a real screen a real user
   * reaches.
   *
   * Split in two, with fixtures that can occur: a SEATED player gets the
   * figures, an observer gets the lobby button and no zeroes.
   */
  /**
   * ── 2026-08-28: THE FIGURES LEFT THIS CORNER ALTOGETHER ──────────────────
   *
   * Dan, ruling on this control: "ALL TOURNAMENTS NEED THE STATS ICON IN THE
   * UPPER RIGHT HAND CORNER. IT SHOULDN'T SHOW THE STATS, BUT OPEN TO THE
   * TOURNAMENT LOBBY PAGE AS A IN GAME 3/4 POP UP", and then: "STATS SHOULD
   * LIVE INSIDE THE HERO AVATAR, WHEN YOU CLICK IT YOU SHOULD SEE STATS INSIDE
   * THERE. STATS ICON IS NOT THE TOURNAMENT LOBBY BUTTON. USE THE EXACT BUTTON
   * AS IT IS."
   *
   * So the seated/observer split this block used to draw is gone: BOTH now get
   * the same single button, and it opens the lobby. The 2026-08-25 four-figure
   * bar these specs were rewritten to protect has been removed — its numbers
   * are shown behind the hero's own avatar (HeroHubPanel's Stats tab) instead.
   *
   * Updated here in the same commit as the change, per CLAUDE.md §5.8 and rule
   * 8: a spec that pins behaviour we deliberately replaced must move with it,
   * never be left for someone else.
   */
  it('gives a seated tournament player one lobby button, with no figures on it', () => {
    const handleTap = vi.fn();
    render(
      <MiniStatsCard
        currentStack={12345}
        totalBuyIn={0}
        isSeated={true}
        isTournament={true}
        onTap={handleTap}
      />
    );

    const btn = screen.getByRole('button', { name: /tournament lobby/i });
    expect(btn).toBeInTheDocument();

    // The corner is a door, not a readout. Asserted so nobody reinstates the
    // bar: these figures now live behind the hero avatar.
    expect(btn).not.toHaveTextContent('Stack');
    expect(btn).not.toHaveTextContent('12,345');
    expect(btn).not.toHaveTextContent('VPIP');
    expect(btn).not.toHaveTextContent(/Buy-In/i);
    expect(btn).not.toHaveTextContent(/P&L/i);

    fireEvent.click(btn);
    expect(handleTap).toHaveBeenCalledTimes(1);
  });

  it('gives an observer the same lobby button, and no zeroes', () => {
    /* The fixture a spectator actually produces: heroSeat 0, so every session
       figure is 0. Printing "Stack 0 · Hands 0 · VPIP 0% · Won 0" read as a
       broken HUD rather than as "you are watching". The BUTTON must survive —
       it is how an observer reaches standings, payouts and the clock. */
    const handleTap = vi.fn();
    render(
      <MiniStatsCard
        currentStack={0}
        totalBuyIn={0}
        isSeated={false}
        isTournament={true}
        onTap={handleTap}
      />
    );

    const btn = screen.getByRole('button', { name: /tournament lobby/i });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toHaveTextContent('Stack');
    expect(btn).not.toHaveTextContent('VPIP');
    expect(btn).not.toHaveTextContent('0%');

    fireEvent.click(btn);
    expect(handleTap).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when not seated in non-tournament cash game', () => {
    const { container } = render(
      <MiniStatsCard currentStack={0} totalBuyIn={0} isSeated={false} isTournament={false} />
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

  it('delegates tournament departure without client seat deletion or elimination', () => {
    const code = tsCode(read('src/services/TableService.ts'));
    const start = code.indexOf('async leaveTable(');
    const leave = code.slice(start, code.indexOf('subscribeToTable(', start));
    expect(leave).toContain('leaveSeatWithIntent(tableId, userId)');
    expect(leave).not.toMatch(/\.update\(|\.delete\(|supabase\.rpc/);
  });

  it('informs player of tournament sit-out behavior on LeaveTableConfirm', () => {
    const code = tsCode(read('src/components/table/LeaveTableConfirm.tsx'));
    expect(code).toMatch(/isTournament\s*\?\s*'Leave Tournament Table\?'\s*:\s*'Leave Table\?'/);
    expect(code).toMatch(/In Tournaments, Leaving The Table/);
  });
});
