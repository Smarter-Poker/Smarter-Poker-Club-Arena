import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { GamePanel } from './GameConsole';
import { diamondGameTitle } from '../../utils/diamondGameTitles';

interface Average {
  game: 'wheel' | 'mines' | 'crossing' | 'crash' | 'plinko';
  rounds: number;
  average_return: number | null;
  average_safe_steps: number | null;
  losses: number;
  average_before_loss: number | null;
  average_crash: number | null;
}
export default function GameLifetimeAverages({
  clubId,
  revision,
}: {
  clubId: string | null;
  revision?: string | null;
}) {
  const [rows, setRows] = useState<Average[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setRows(null);
    setFailed(false);
    if (!clubId) return;
    void (async () => {
      try {
        const { data, error } = await supabase.rpc(
          'fn_diamond_game_lifetime' as never,
          { p_club_id: clubId } as never
        );
        if (error) throw error;
        const value = data as unknown as { ok?: boolean; games?: Average[] };
        const games = ['wheel', 'mines', 'crossing', 'crash', 'plinko'];
        if (
          !value?.ok ||
          !Array.isArray(value.games) ||
          value.games.length !== games.length ||
          new Set(value.games.map((r) => r.game)).size !== games.length ||
          value.games.some(
            (r) =>
              !games.includes(r.game) ||
              !Number.isSafeInteger(r.rounds) ||
              r.rounds < 0 ||
              !Number.isSafeInteger(r.losses) ||
              r.losses < 0 ||
              r.losses > r.rounds ||
              [r.average_return, r.average_safe_steps, r.average_before_loss, r.average_crash].some(
                (n) => n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
              )
          )
        )
          throw new Error('Lifetime Averages Could Not Be Verified');
        if (live) setRows(value.games);
      } catch (error) {
        reportError(error, 'GameLifetimeAverages');
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [clubId, revision]);
  const average = (n: number | null, suffix = '') =>
    n === null
      ? 'No Measured Results'
      : `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
  return (
    <GamePanel title="Lifetime Game Averages">
      <p className="sc-copy">
        This Host’s Recorded Games. Test Games Excluded. Averages Describe Past Games, Not Your Next
        Result. Wheel Prize Values Exclude Later Bonus Game Payouts.
      </p>
      {!rows ? (
        <p className="sc-copy" role="status">
          {failed ? 'Lifetime Averages Are Unavailable' : 'Loading Lifetime Averages'}
        </p>
      ) : (
        rows.map((row) => (
          <div className="sc-row" key={row.game}>
            <span className="sc-label">
              {row.game === 'wheel' ? 'Diamond Spins' : diamondGameTitle(row.game)} ·{' '}
              {row.rounds.toLocaleString()}{' '}
              {row.game === 'plinko' ? 'Runs And Standalone Drops' : 'Completed Games'}
            </span>
            <span className="sc-value">
              {row.game === 'crash'
                ? `Average Crash Point ${average(row.average_crash, 'x')}`
                : row.game === 'mines' || row.game === 'crossing'
                  ? `Average ${row.game === 'mines' ? 'Diamonds Found' : 'Streets Crossed'} ${average(row.average_safe_steps)}. Before A ${row.game === 'mines' ? 'Mine' : 'Hit'}: ${average(row.average_before_loss)} (${row.losses.toLocaleString()} Losses)`
                  : `${row.game === 'wheel' ? 'Average Wheel Prize Value' : 'Average Paid Return'} ${average(row.average_return, 'x')}`}
            </span>
          </div>
        ))
      )}
    </GamePanel>
  );
}
