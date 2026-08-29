/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ROUND 12 — PLAY AGAIN IS A SEAT, NOT A LIST (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ranking card's Play Again used to navigate to the tournaments list.
 * The supply audit proved the recycler keeps an open game at EVERY seat-first
 * stake x variant (48/48 combinations covered in production), so the honest
 * best answer is a seat: TournamentRankingHost now finds the open sibling -
 * same club, same buy-in, same game type, same seat-first class, the scoping
 * rule PR #1702 made law - resolves its live table through the same
 * occupancy election the engine uses, and lands the player on the felt.
 * Every miss falls back to the old list navigation.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBlockAfter, sliceEnclosingBlock } from '../helpers/sourceWindow';

const root = join(__dirname, '..', '..');
const HOST = readFileSync(
  join(root, 'src', 'components', 'tournament', 'TournamentRankingHost.tsx'),
  'utf8'
);
const PAYLOAD = readFileSync(join(root, 'src', 'services', 'pendingSessionSummary.ts'), 'utf8');
const TABLE_PAGE = readFileSync(join(root, 'src', 'pages', 'TablePage.tsx'), 'utf8');
const RESULTS = readFileSync(
  join(root, 'src', 'pages', 'tournament', 'TournamentResultsPage.tsx'),
  'utf8'
);

describe('the payload carries the finished tournament id', () => {
  it('is declared on TournamentResult and published by the exit path', () => {
    expect(PAYLOAD).toContain('tournamentId?: string');
    expect(TABLE_PAGE).toContain('tournamentId: tid || undefined');
  });
});

describe('the sibling lookup is scoped the way #1702 made law', () => {
  const lookup = sliceBlockAfter(HOST, 'const playAgain = useCallback');

  it('matches club, stake and game type from the ORIGIN row, never a guess', () => {
    expect(lookup).toContain(".eq('buy_in_amount', origin.buy_in_amount)");
    expect(lookup).toContain(".eq('game_type', origin.game_type)");
    expect(lookup).toContain("q.eq('club_id', origin.club_id)");
  });

  it('is seat-first only - an MTT keeps the list', () => {
    expect(lookup).toContain("String(origin.variant) === 'spin'");
    expect(lookup).toContain(".lte('max_players', 2)");
  });

  it('resolves the live table through the occupancy election, never a raw newest-table guess', () => {
    expect(lookup).toContain('resolveTournamentLiveTable');
  });

  it('every read is error-bound and every miss falls back to the list', () => {
    expect(lookup).toContain('if (originErr) throw originErr');
    expect(lookup).toContain('if (siblingErr) throw siblingErr');
    expect(lookup).toContain('play_again_sibling_lookup_failed');
    // The fallback appears for: no id, non-seat-first, no sibling, no table,
    // and the catch. Count the calls.
    const fallbacks = lookup.match(/fallback\(\)/g) || [];
    expect(fallbacks.length).toBeGreaterThanOrEqual(5);
  });

  it('a double tap cannot run two lookups', () => {
    expect(lookup).toContain('if (playAgainBusyRef.current) return');
  });
});

describe('round 12: the mine filter is a join, not a client scan', () => {
  const loader = sliceEnclosingBlock(RESULTS, 'tournament_players!inner', 0, 2);

  it('pushes the player filter into the query', () => {
    expect(loader).toContain('tournament_players!inner(user_id)');
    expect(loader).toContain("query.eq('tournament_players.user_id', user.id)");
  });

  it('the paged fetch-every-entry scan is gone', () => {
    // Assert on the CODE, not the comment that records the removal
    // (handoff trap 6): the import and the call are what must be gone.
    expect(RESULTS).not.toContain("from '../../utils/fetchAllRows'");
    expect(RESULTS).not.toContain('fetchAllRows(');
  });
});
