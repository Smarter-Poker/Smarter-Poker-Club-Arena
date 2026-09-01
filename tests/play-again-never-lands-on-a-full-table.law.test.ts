/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAY AGAIN NEVER LANDS YOU ON A FULL TABLE — LAW (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The sibling lookup behind "Play Again" filtered on status, club, stake, game
 * and class — and not on capacity. Every other surface goes through
 * `seatFirstJoinable`, whose entire job is `players >= capacity`.
 *
 * Spins fill in seconds. The most likely sibling of the game you just finished
 * is one that filled while you were watching the podium, so the button walked
 * the player into "That Seat Was Just Taken".
 *
 * Its fallback was `/tournaments?type=spin`, and `TournamentPage` reads
 * `useParams()` only — its filter state is 'all' | 'freeroll' | 'micro' |
 * 'highroller'. The query string was carried for nobody.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const host = readFileSync(
  join(ROOT, 'src/components/tournament/TournamentRankingHost.tsx'),
  'utf8'
);

describe('play again never lands you on a full table', () => {
  it('reads the capacity columns it needs', () => {
    expect(host).toContain(".select('id, current_players, max_players')");
  });

  it('rejects a sibling that is already full', () => {
    expect(host).toContain('const max = Number(row?.max_players) || 0;');
    expect(host).toContain('return max <= 0 || seated < max;');
  });

  it('looks past the first row, because the first row may be the full one', () => {
    expect(host).toContain('.limit(8)');
    expect(host).not.toContain('const sibling = siblings?.[0];');
  });

  it('does not navigate to a filter nothing reads', () => {
    expect(host).not.toContain("'/tournaments?type=spin'");
    expect(host).toContain("navigate('/tournaments');");
  });

  it('keeps the club and stake scoping that PR #1702 made law', () => {
    // Capacity is an ADDITIONAL predicate. Losing the scoping would seat a
    // player in a stranger's club, which is the incident that wrote it.
    expect(host).toContain("q.eq('club_id', origin.club_id)");
    expect(host).toContain("eq('buy_in_amount', origin.buy_in_amount)");
  });
});
