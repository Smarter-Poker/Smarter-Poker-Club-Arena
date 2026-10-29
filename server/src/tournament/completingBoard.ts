import { supabase } from '../services/supabase.js';
import { fetchAllRows } from '../services/supabase/pagination.js';
import { reportError } from '../services/errorReporter.js';

/** A partial board cannot remove dwell clocks or certify a recovery scan. */
export async function readCompletingBoard<T extends Record<string, unknown>>(
  columns: string,
  options: { tournamentId?: string; shouldContinue?: () => boolean } = {}
): Promise<T[] | null> {
  try {
    const page = await fetchAllRows<T>(
      (cursor, want) => {
        let query = supabase
          .from('tournaments')
          .select(columns)
          .eq('status', 'COMPLETING')
          .order('id', { ascending: true })
          .limit(want);
        if (options.tournamentId) query = query.eq('id', options.tournamentId);
        if (cursor) query = query.gt('id', cursor);
        return query as unknown as PromiseLike<{ data: T[] | null; error: unknown }>;
      },
      {
        label: 'GameServer.completingBoard',
        pageAttempts: 1,
        shouldContinue: options.shouldContinue,
      }
    );
    return page.complete ? page.rows : null;
  } catch (error) {
    reportError(error, 'GameServer.completingBoard.threw');
    return null;
  }
}
