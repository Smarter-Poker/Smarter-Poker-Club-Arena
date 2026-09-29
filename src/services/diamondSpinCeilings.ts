/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DIAMOND SPIN ADVERTISES THE TOP OF ITS OWN TABLE (DIAMOND PHASE 9, 2026-09-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A filling Spin's card says "Win Up To" the top of the table it will draw
 * from. A chip Spin draws from the one compiled ladder (SPIN_MAX_MULTIPLIER).
 * A Diamond Spin draws from the table its creation pinned, which no browser
 * may read; `fn_poker_diamond_spin_ceilings` answers that table's top
 * multiplier to a signed-in player, and nothing for any other id.
 *
 * Which rows are Diamond Spins is the arena embed's answer
 * (TOURNAMENT_ARENA_EMBED through tournamentRowUnitCents, #5050), so a board
 * with no Diamond Spin on it asks nothing at all. A read that fails leaves the
 * rows as they were and says so: a Diamond Spin without its ceiling prints no
 * figure (spinCeilingMultiplier), never the chip ladder's.
 */
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import {
  tournamentRowUnitCents,
  type TournamentArenaEmbed,
} from '../components/tournament/details/types';
import { getTournamentFormatKind } from '../utils/tournamentPresentation';
import { DIAMOND_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

type SpinCeilingRow = TournamentArenaEmbed & { id: string; diamond_spin_ceiling?: number | null };

/** The rows, each Diamond Spin among them carrying its own table's top multiplier. */
export async function withDiamondSpinCeilings<T extends SpinCeilingRow>(rows: T[]): Promise<T[]> {
  const ids = rows
    .filter(
      (row) =>
        tournamentRowUnitCents(row) === DIAMOND_UNIT_CENTS &&
        getTournamentFormatKind(row) === 'spin'
    )
    .map((row) => row.id);
  if (ids.length === 0) return rows;
  try {
    const { data, error } = await supabase.rpc('fn_poker_diamond_spin_ceilings', {
      p_tournament_ids: ids,
    });
    if (error) {
      reportError(error, 'diamondSpinCeilings.unreadable', { count: ids.length });
      return rows;
    }
    const ceilings = new Map<string, number>();
    for (const answer of (Array.isArray(data) ? data : []) as Array<{
      tournament_id?: unknown;
      max_multiplier?: unknown;
    }>) {
      const top = Number(answer?.max_multiplier);
      if (typeof answer?.tournament_id === 'string' && Number.isFinite(top) && top > 0) {
        ceilings.set(answer.tournament_id, top);
      }
    }
    return rows.map((row) =>
      ceilings.has(row.id) ? { ...row, diamond_spin_ceiling: ceilings.get(row.id)! } : row
    );
  } catch (e) {
    reportError(e, 'diamondSpinCeilings.unreadable', { count: ids.length });
    return rows;
  }
}
