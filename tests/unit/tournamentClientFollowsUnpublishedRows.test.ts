/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE TOURNAMENT CLIENT READS WHAT REALTIME NO LONGER CARRIES (2026-10-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `tournaments`, `tournament_players`, `tables` and `table_seats` left the
 * supabase_realtime publication by measurement on 2026-09-19
 * (scripts/ci/check-realtime-publication.mjs, KNOWN_UNPUBLISHED). A
 * postgres_changes listener on any of them joins, reports SUBSCRIBED and never
 * fires. The launch audit of the player-facing Spin / Sit & Go / MTT client
 * found four places that still depended on one of those silent listeners, and
 * one lobby that offered a money action to people it could never sell to:
 *
 * 1. A seat-first Spin cancelled unfilled (fn_spin_expire_unfilled refunds it
 *    through atomic_cancel_tournament) was only ever learned from the dead
 *    `tournaments` UPDATE: the player sat at an empty felt that kept selling
 *    seats, with no word about their refund, and level 1's clock never started.
 * 2. PKO bounty badges were read once at mount; a re-entry's fresh head or a
 *    player balanced in later kept the stale value.
 * 3. The Spin quick-join sheet refreshed only on the dead listeners, so a board
 *    that filled stayed offered.
 * 4. The tournament lobby answered a busted player in a re-entry event with
 *    ELIMINATED and nothing to press, though process_tournament_rebuy accepts
 *    exactly that seatless eliminated entry for as long as re-entry is open.
 * 5. The club tournament page offered Add-On to every viewer of the event; the
 *    RPC sells an add-on only to a live 'playing' entry.
 *
 * Source-contract pins, the repo's pattern for rules inside components too
 * heavy to render in a unit test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');
const table = read('pages/TablePage.tsx');
const multi = read('pages/MultiTablePage.tsx');
const details = read('pages/tournament/TournamentDetails.tsx');
const clubPage = read('pages/TournamentPage.tsx');

describe('a seat-first table polls its tournament row', () => {
  it('the roster poll reads the tournament status before the seats', () => {
    const reload = sliceMethod(table, 'const reloadRoster = async () => {');
    expect(reload).toMatch(/await reloadTournamentRow\(\)/);
    const row = sliceMethod(table, 'const reloadTournamentRow = async (): Promise<boolean> => {');
    expect(row).toMatch(/\.from\('tournaments'\)/);
    expect(row).toMatch(/applyTournamentRow\(/);
  });

  it('a cancelled game tells the seated player their buy-in came back', () => {
    const apply = sliceMethod(table, 'const applyTournamentRow = (');
    expect(apply).toMatch(/status === 'CANCELLED' && heroHeldSeat/);
    expect(apply).toMatch(/Your Buy-In Was Refunded/);
    expect(apply).toMatch(/setPlayHasBegun\(true\)/);
  });
});

describe('PKO bounty badges are re-read on a cadence', () => {
  it('arms and clears a bounty map poll', () => {
    expect(table).toMatch(
      /bountyMapPollTimer = setInterval\(\(\) => void refreshBountyMap\(\), 30_000\)/
    );
    expect(table).toMatch(/clearInterval\(bountyMapPollTimer\)/);
  });
});

describe('the Spin quick-join sheet polls while open', () => {
  it('re-asks on an interval and stops when closed', () => {
    expect(multi).toMatch(/const pollId = setInterval\(refresh, QUICK_JOIN_SPIN_POLL_MS\)/);
    expect(multi).toMatch(/clearInterval\(pollId\)/);
  });
});

describe('the tournament lobby sells a re-entry to a busted player', () => {
  it('the eliminated footer offers Re-Enter when canRebuy allows it', () => {
    expect(details).toMatch(/await tournamentService\.canRebuy\(t\.id, userId\)/);
    const handler = sliceMethod(details, 'const handleReEnter = async () => {');
    expect(handler).toMatch(/tournamentService\.processRebuy\(tournament\.id, user\.id, token\)/);
    expect(details).toMatch(/myEntry\?\.status === 'eliminated'\) \{\s*if \(reEntryOffer\)/);
  });
});

describe('the club tournament page offers Add-On only to a live entry', () => {
  it('canAddOnNow requires the viewer to be playing', () => {
    expect(clubPage).toMatch(
      /setCanAddOnNow\(\s*addOnCheck\.allowed && !mine\.error && String\(mine\.data\?\.status \?\? ''\) === 'playing'/
    );
  });
});

describe('the tournament lobby re-reads its board instead of joining a channel per event', () => {
  const lobby = read('pages/tournament/TournamentLobbyPage.tsx');
  it('joins no per-tournament t-break channel', () => {
    expect(lobby).not.toMatch(/getOrCreateChannel\(/);
    expect(lobby).not.toMatch(/`t-break-\$\{/);
  });
  it('polls quietly while visible and only the newest read paints', () => {
    expect(lobby).toMatch(/setInterval\(refresh, LOBBY_REFRESH_MS\)/);
    expect(lobby).toMatch(/loadTournamentsRef\.current\(\{ quiet: true \}\)/);
    expect(lobby).toMatch(/if \(seq !== loadSeqRef\.current\) return;\s*setTournaments\(mapped\)/);
  });
});

describe('the club tournament list re-reads itself', () => {
  it('polls the list while visible and clears the poll', () => {
    expect(clubPage).toMatch(/const listPoll = setInterval\(/);
    expect(clubPage).toMatch(/CLUB_TOURNAMENT_LIST_REFRESH_MS\)/);
    expect(clubPage).toMatch(/clearInterval\(listPoll\)/);
  });
});
