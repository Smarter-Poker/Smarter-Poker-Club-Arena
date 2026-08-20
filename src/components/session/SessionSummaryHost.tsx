/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SessionSummaryHost — the Session Complete popup, shown in the LOBBY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-18:
 *   "when you leave table, it should always auto take you to the lobby, your
 *    Session Complete should show up as a pop up in the lobby page. add an X
 *    off to this in the top right corner. and make this better looking and
 *    more dynamic, it looks very boring and basic at the moment."
 *
 * WHY IT LIVES AT THE APP ROOT
 *
 * Mounted once next to <ConfirmHost/>, OUTSIDE <Routes>. Two reasons: it
 * survives the navigate() away from the table (a route-level mount would be
 * torn down mid-transition), and "the lobby" is not one component - a player
 * can land on HomePage, ClubHomePage or ClubLobby depending on where they came
 * from. One root host covers all of them without editing any of them.
 *
 * The numbers arrive via services/pendingSessionSummary, because they used to
 * live in TablePage refs that die when it unmounts. See that file for why.
 *
 * ON "MORE DYNAMIC"
 *
 * The old version was a flat grid of grey boxes. This one earns the moment:
 * the P/L counts up on a spring curve, the tiles stagger in, a win gets a
 * sweep of light across the hero panel, and the card is colour-led by the
 * result instead of uniformly grey. It is all CSS-driven, and every animation
 * is disabled under prefers-reduced-motion.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  clearSessionSummary,
  peekSessionSummary,
  subscribeSessionSummary,
  type SessionSummaryPayload,
} from '../../services/pendingSessionSummary';
import { formatGameTitle } from '../../utils/formatGameTitle';
import './SessionSummaryHost.css';

/** Ease-out-back: overshoots slightly then settles. Reads as "landing". */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function useCountUp(target: number, durationMs: number, run: boolean): number {
  const [value, setValue] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!run) {
      setValue(target);
      return undefined;
    }
    // Respect the OS setting: no count-up under reduced motion, just the number.
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setValue(target);
      return undefined;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setValue(target * easeOutBack(t));
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, durationMs, run]);

  return value;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatChips(n: number): string {
  const v = Math.round(n);
  return Math.abs(v) >= 1000 ? v.toLocaleString() : String(v);
}

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 11 -> "11th", 22 -> "22nd". */
function ordinal(n: number): string {
  const abs = Math.abs(Math.round(n));
  const tens = abs % 100;
  if (tens >= 11 && tens <= 13) return `${abs}th`;
  switch (abs % 10) {
    case 1:
      return `${abs}st`;
    case 2:
      return `${abs}nd`;
    case 3:
      return `${abs}rd`;
    default:
      return `${abs}th`;
  }
}

export function SessionSummaryHost() {
  const [payload, setPayload] = useState<SessionSummaryPayload | null>(() => peekSessionSummary());

  useEffect(() => subscribeSessionSummary(setPayload), []);

  const close = useCallback(() => {
    clearSessionSummary();
  }, []);

  // Escape closes. The old modal had no keyboard dismissal at all.
  useEffect(() => {
    if (!payload) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [payload, close]);

  /* Dan 2026-08-20: "tournaments are never displayed by chips, only what place
     you finished and how much you made." The presence of the tournament block
     switches both the hero and the tiles. */
  const tourney = payload?.tournament;
  const isTournament = !!tourney;

  /* A tournament "wins" by cashing, not by ending with more chips than you sat
     down with — tournament chips are not money. */
  const totalWon = (tourney?.prize ?? 0) + (tourney?.bountyWinnings ?? 0);
  const isProfit = isTournament ? totalWon > 0 : (payload?.profitLoss ?? 0) >= 0;

  const heroTarget = isTournament ? totalWon : (payload?.profitLoss ?? 0);
  const displayPL = useCountUp(heroTarget, 900, !!payload);

  const stats = useMemo(() => {
    if (!payload) return [];
    const handsPerHour =
      payload.duration > 60 ? Math.round((payload.handsPlayed / payload.duration) * 3600) : 0;

    if (payload.tournament) {
      const t = payload.tournament;
      /* Deliberately no profit/loss, biggest pot, peak stack or win rate here.
         Every one of those is a chip statistic, and the screenshot that
         prompted this showed them as a wall of zeroes next to a meaningless
         "+265 profit" for a tournament seat. */
      const out = [
        {
          label: 'Finished',
          value: t.finishPlace != null ? ordinal(t.finishPlace) : '—',
        },
        { label: 'Entrants', value: t.entrants != null ? String(t.entrants) : '—' },
        { label: 'Prize', value: formatChips(t.prize) },
        { label: 'Duration', value: formatDuration(payload.duration) },
        { label: 'Hands played', value: String(payload.handsPlayed) },
        { label: 'Hands/hour', value: String(handsPerHour) },
      ];
      if (t.knockouts > 0) out.push({ label: 'Knockouts', value: String(t.knockouts) });
      if (t.bountyWinnings > 0) {
        out.push({ label: 'Bounties', value: formatChips(t.bountyWinnings) });
      }
      if (t.rebuys > 0) out.push({ label: 'Rebuys', value: String(t.rebuys) });
      if (t.addOns > 0) out.push({ label: 'Add-ons', value: String(t.addOns) });
      return out;
    }

    const winRate =
      payload.handsPlayed > 0 ? Math.round((payload.handsWon / payload.handsPlayed) * 100) : 0;

    const out = [
      { label: 'Duration', value: formatDuration(payload.duration) },
      { label: 'Hands played', value: String(payload.handsPlayed) },
      { label: 'Hands/hour', value: String(handsPerHour) },
      { label: 'Biggest pot', value: formatChips(payload.biggestPot) },
      { label: 'Peak stack', value: formatChips(payload.peakStack) },
      { label: 'Win rate', value: `${winRate}%` },
    ];
    if (payload.totalRebuys > 0) {
      out.push({ label: 'Rebuys', value: String(payload.totalRebuys) });
    }
    return out;
  }, [payload]);

  if (!payload) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="ssh-overlay" onClick={close} role="presentation">
      <div
        className={`ssh-card ${isProfit ? 'ssh-card--win' : 'ssh-card--loss'}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-title"
      >
        {/* Dan asked for an X in the top-right. The old modal could only be
            dismissed by the backdrop or the big button. */}
        <button className="ssh-close" onClick={close} aria-label="Close session summary">
          &times;
        </button>

        <header className="ssh-head">
          <span className="ssh-eyebrow">
            {isTournament ? 'Tournament Complete' : 'Session Complete'}
          </span>
          <h2 className="ssh-title" id="ssh-title">
            {formatGameTitle(
              (isTournament ? tourney?.name : undefined) ||
                payload.tableName ||
                (isTournament ? 'Tournament' : 'Table session')
            )}
          </h2>
        </header>

        {isTournament ? (
          /* The result IS the finish. Place leads, money follows — the reverse
             of the cash panel, where the money is the whole story. */
          <div className="ssh-hero ssh-hero--tourney">
            <span className="ssh-hero__label">
              {tourney?.finishPlace != null ? 'Finished' : 'Result'}
            </span>
            <span className="ssh-hero__value">
              {tourney?.finishPlace != null ? ordinal(tourney.finishPlace) : '—'}
            </span>
            {tourney?.entrants != null && tourney.entrants > 0 && (
              <span className="ssh-hero__sub">of {tourney.entrants.toLocaleString()} entrants</span>
            )}
            <span className="ssh-hero__sub ssh-hero__sub--money">
              {totalWon > 0 ? `Won ${formatChips(displayPL)}` : 'No prize'}
            </span>
            <span className="ssh-hero__sweep" aria-hidden="true" />
          </div>
        ) : (
          <div className="ssh-hero">
            <span className="ssh-hero__label">{isProfit ? 'Profit' : 'Loss'}</span>
            <span className="ssh-hero__value">
              {isProfit ? '+' : '-'}
              {formatChips(Math.abs(displayPL))}
            </span>
            <span className="ssh-hero__sweep" aria-hidden="true" />
          </div>
        )}

        <div className="ssh-grid">
          {stats.map((s, i) => (
            <div
              className="ssh-tile"
              key={s.label}
              /* Stagger: each tile lands a beat after the one before it. */
              style={{ animationDelay: `${120 + i * 55}ms` }}
            >
              <span className="ssh-tile__value">{s.value}</span>
              <span className="ssh-tile__label">{s.label}</span>
            </div>
          ))}
        </div>

        <button className="ssh-done" onClick={close}>
          Done
        </button>
      </div>
    </div>,
    document.body
  );
}

export default SessionSummaryHost;
