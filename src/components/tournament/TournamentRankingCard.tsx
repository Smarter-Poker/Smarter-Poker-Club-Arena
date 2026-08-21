/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT RANKING CARD — where a busted player lands (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, with a reference screenshot: "this is what the tournament card should
 * look like after you bust a tournament."
 *
 * The reference is the industry-standard ranking card, and its ordering is the
 * whole point — a tournament result is a PLACE, and the place is the largest
 * thing on the card. Top to bottom:
 *
 *   RANKING                     title bar, X to dismiss
 *   <event banner>              date + event name + #place(entrants)
 *   <medal>                     the finishing place, as a medal
 *   3rd                         the place again, in words, on a coloured band
 *   avatar / name / number      who this was, and
 *   Reward: 0.00                what it paid
 *   Stay Observing | Play Again
 *
 * WHY IT IS A HOST, NOT A ROUTE
 *
 * It renders from pendingSessionSummary at the app root, the same carrier the
 * cash Session Complete popup uses, because the previous attempt at this card
 * shipped as router state to `/clubs/:clubId` — and the only reader of that
 * state was ClubLobby, which is `/clubs/:clubId/lobby`. It never rendered once.
 * "The lobby" is three different pages depending on where the player came
 * from; only an app-root host covers all of them.
 *
 * The medal is drawn, not an image: it has to carry an arbitrary finishing
 * place (128th) at any size, and gold/silver/bronze/steel by rank.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { formatGameTitle } from '../../utils/formatGameTitle';
import type { TournamentResult } from '../../services/pendingSessionSummary';
import './TournamentRankingCard.css';

export interface TournamentRankingCardProps {
  result: TournamentResult;
  /** Falls back to the tournament name when the event has no separate title. */
  tableName?: string;
  onDismiss: () => void;
  /** "Play Again" — where to send them. Usually the club's tournament list. */
  onPlayAgain?: () => void;
}

/** 1 -> "1st", 22 -> "22nd", 111 -> "111th". */
function ordinal(n: number): string {
  const v = Math.abs(Math.floor(n));
  const tens = v % 100;
  if (tens >= 11 && tens <= 13) return `${v}th`;
  switch (v % 10) {
    case 1:
      return `${v}st`;
    case 2:
      return `${v}nd`;
    case 3:
      return `${v}rd`;
    default:
      return `${v}th`;
  }
}

/** "20-Aug" — the reference card's date format. */
function shortDate(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = d.toLocaleString('en-US', { month: 'short' });
  return `${day}-${month}`;
}

/**
 * Medal palette by finish. Gold/silver/bronze are the podium; everything else
 * is steel, so 4th does not get a participation medal that looks like a prize.
 */
function medalClass(place: number | null): string {
  if (place === 1) return 'trc2-medal--gold';
  if (place === 2) return 'trc2-medal--silver';
  if (place === 3) return 'trc2-medal--bronze';
  return 'trc2-medal--steel';
}

function formatMoney(n: number): string {
  return (Math.round(n * 100) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function TournamentRankingCard({
  result,
  tableName,
  onDismiss,
  onPlayAgain,
}: TournamentRankingCardProps) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<{
    username: string;
    avatarUrl: string;
    playerNumber: number | null;
  } | null>(null);

  /* The card names the player, so it needs the player. One query, on show —
     the payload comes from the table and does not carry profile fields, and
     threading them through every publish site would couple the two for the
     sake of three strings. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth?.user?.id;
        if (!uid) return;
        const { data } = await supabase
          .from('profiles')
          .select('username, display_name, avatar_url, player_number')
          .eq('id', uid)
          .maybeSingle();
        if (cancelled || !data) return;
        setProfile({
          username: data.display_name || data.username || 'Player',
          avatarUrl: data.avatar_url || generateDefaultAvatar(),
          playerNumber: data.player_number ?? null,
        });
      } catch {
        /* The card is still worth showing without a name on it. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Escape dismisses, like every other modal in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  if (typeof document === 'undefined') return null;

  const place = result.finishPlace;
  const eventName = formatGameTitle(result.name || tableName || 'Tournament');
  const totalWon = (result.prize || 0) + (result.bountyWinnings || 0);

  /* "FIDGET SPINNER #3(11)" — event, finishing place, field size. The field
     size is in brackets exactly as the reference has it, so the place reads as
     "3 of 11" without spelling it out. */
  const eventLine =
    place != null
      ? `${eventName} #${place}${result.entrants ? `(${result.entrants})` : ''}`
      : eventName;

  const handlePlayAgain = () => {
    if (onPlayAgain) {
      onPlayAgain();
      return;
    }
    onDismiss();
    navigate('/tournaments');
  };

  return createPortal(
    <div className="trc2" role="dialog" aria-modal="true" aria-label="Tournament ranking">
      <div className="trc2__backdrop" onClick={onDismiss} />

      <div className="trc2__card">
        {/* ── Title bar ── */}
        <div className="trc2__titlebar">
          <span className="trc2__title">RANKING</span>
          <button className="trc2__close" onClick={onDismiss} aria-label="Close">
            ×
          </button>
        </div>

        {/* ── Event banner ── */}
        <div className="trc2__banner">
          <div className="trc2__banner-lights" aria-hidden="true" />
          <div className="trc2__brand">
            SMARTER<span className="trc2__brand-accent">POKER</span>
            <span className="trc2__brand-mark">SPIN</span>
          </div>
          <div className="trc2__event">
            <span className="trc2__event-date">{shortDate(new Date())}</span>{' '}
            <span className="trc2__event-name">{eventLine}</span>
          </div>

          {/* ── Medal ── */}
          <div className={`trc2__medal ${medalClass(place)}`}>
            <div className="trc2__medal-ring">
              <span className="trc2__medal-place">{place ?? '-'}</span>
            </div>
            <span className="trc2__medal-glow" aria-hidden="true" />
          </div>
        </div>

        {/* ── Place band ── */}
        <div className={`trc2__placeband ${medalClass(place)}`}>
          {place != null ? ordinal(place) : 'Finished'}
        </div>

        {/* ── Player row ── */}
        <div className="trc2__player">
          <img
            className="trc2__avatar"
            src={profile?.avatarUrl || generateDefaultAvatar()}
            alt=""
            onError={(e) => {
              (e.target as HTMLImageElement).src = generateDefaultAvatar();
            }}
          />
          <div className="trc2__identity">
            <span className="trc2__username">{profile?.username ?? ' '}</span>
            {profile?.playerNumber != null && (
              <span className="trc2__playernum">{profile.playerNumber}</span>
            )}
          </div>
          <div className="trc2__reward">
            <span className="trc2__reward-label">Reward:</span>
            <span className="trc2__reward-value">{formatMoney(totalWon)}</span>
          </div>
        </div>

        {/* Knockouts only appear when there were any — the reference card has
            no room for a zero, and a zero says nothing. */}
        {(result.knockouts > 0 || result.bountyWinnings > 0) && (
          <div className="trc2__extras">
            {result.knockouts > 0 && (
              <span className="trc2__extra">
                <strong>{result.knockouts}</strong> knockout{result.knockouts === 1 ? '' : 's'}
              </span>
            )}
            {result.bountyWinnings > 0 && (
              <span className="trc2__extra">
                <strong>{formatMoney(result.bountyWinnings)}</strong> in bounties
              </span>
            )}
          </div>
        )}

        {/* ── Actions ── */}
        <div className="trc2__actions">
          <button className="trc2__btn" onClick={onDismiss}>
            Stay Observing
          </button>
          <button className="trc2__btn trc2__btn--primary" onClick={handlePlayAgain}>
            Play Again
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
