import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import './TournamentStartCountdown.css';

type StartRow = { status: string; start_time: string | null; format_contract: string | null };
export function scheduledTournamentStart(row: StartRow | null, nowMs = Date.now()): number | null {
  if (!row || !['REGISTERING', 'ANNOUNCED', 'RUNNING'].includes(row.status.toUpperCase()))
    return null;
  // Spins and Heads Up start when their seats fill, not at an advertised clock.
  if (!['mtt-v1', 'mtt-v2'].includes(row.format_contract ?? '')) return null;
  const at = Date.parse(row.start_time ?? '');
  // Pre-seating stamps RUNNING before the advertised first deal.
  if (row.status.toUpperCase() === 'RUNNING' && at <= nowMs) return null;
  return Number.isFinite(at) ? at : null;
}
export function startCountdownText(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (!seconds) return 'Starting Soon';
  const two = (n: number) =>
    n.toLocaleString('en-US', { minimumIntegerDigits: 2, useGrouping: false });
  const mins = Math.floor(seconds / 60);
  return mins >= 60
    ? `${Math.floor(mins / 60)}:${two(mins % 60)}:${two(seconds % 60)}`
    : `${two(mins)}:${two(seconds % 60)}`;
}
/** Read-only observer: tournaments is not in the realtime publication. */
export default function TournamentStartCountdown({
  tournamentId,
  hasLiveHand = false,
}: {
  tournamentId: string;
  hasLiveHand?: boolean;
}) {
  const [start, setStart] = useState<{ id: string; at: number } | null>(null);
  const [now, setNow] = useState(Date.now);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (hasLiveHand) return;
    let active = true;
    let clockOffset = 0;
    let refresh: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const { data, error } = await supabase
          .from('tournaments')
          .select('status, start_time, format_contract')
          .eq('id', tournamentId)
          .maybeSingle();
        if (!active) return;
        if (error) reportError(error, 'TournamentStartCountdown.read');
        else {
          const at = scheduledTournamentStart(data, Date.now() + clockOffset);
          setStart(at === null ? null : { id: tournamentId, at });
          if (data && !['REGISTERING', 'ANNOUNCED', 'RUNNING'].includes(data.status.toUpperCase()))
            return;
          if (data?.status.toUpperCase() === 'RUNNING' && at === null) return;
        }
      } catch (error) {
        if (active) reportError(error, 'TournamentStartCountdown.read');
      }
      if (active) refresh = setTimeout(() => void read(), 10_000);
    };
    const asked = Date.now();
    void Promise.resolve(supabase.rpc('fn_db_now'))
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          reportError(error, 'TournamentStartCountdown.clock');
          return;
        }
        const answered = Date.now();
        const at = typeof data === 'string' ? Date.parse(data) : NaN;
        if (Number.isFinite(at) && answered - asked < 5_000) {
          clockOffset = at - (asked + answered) / 2;
          setOffset(clockOffset);
        }
      })
      .catch((error) => {
        if (active) reportError(error, 'TournamentStartCountdown.clock');
      })
      .finally(() => {
        if (active) void read();
      });
    const tick = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNow(Date.now());
    }, 1000);

    const onVisible = () => {
      if (!document.hidden) setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      active = false;
      clearTimeout(refresh);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tournamentId, hasLiveHand]);
  if (hasLiveHand || start?.id !== tournamentId) return null;
  return (
    <div className="tournament-start-countdown" role="timer" aria-label="Tournament Starts In">
      <span className="tournament-start-countdown__label">Tournament Starts In</span>
      <span className="tournament-start-countdown__clock">
        {startCountdownText(start.at - (now + offset))}
      </span>
    </div>
  );
}
