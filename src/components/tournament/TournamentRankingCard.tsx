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
import { readLocalSession } from '../../lib/authUtils';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { formatGameTitle } from '../../utils/formatGameTitle';
import type { TournamentResult } from '../../services/pendingSessionSummary';
import './TournamentRankingCard.css';

export interface TournamentRankingCardProps {
  result: TournamentResult;
  /** Falls back to the tournament name when the event has no separate title. */
  tableName?: string;
  /**
   * Session length in SECONDS and hands dealt, straight off the payload.
   *
   * AUDIT 2026-08-22: the payload has carried both since the card was written
   * and the card read neither, so a Spin that ran twenty hands over four
   * minutes reported nothing about itself. The cash Session Complete card was
   * given real stats in #243; this one was left with a place and a number.
   */
  durationSeconds?: number;
  handsPlayed?: number;
  /**
   * When the session ended, for the banner date. Defaults to now.
   *
   * `new Date()` was hard-coded, which is right in the moment and wrong the
   * instant anything renders this from a stored result — the date would follow
   * the clock instead of the event.
   */
  endedAt?: number;
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

/** 185 -> "3m 05s", 3725 -> "1h 02m". Never prints a unit that is zero. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export default function TournamentRankingCard({
  result,
  tableName,
  durationSeconds,
  handsPlayed,
  endedAt,
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
        // readLocalSession, not a GoTrue round trip: the house rule (enforced
        // by .husky/pre-push) is that no component blocks on the auth server
        // for an id the JWT already sitting in localStorage carries. Same
        // value, no network, no hang when GoTrue is slow.
        const uid = readLocalSession()?.userId;
        if (!uid) return;
        const { data } = await supabase
          .from('profiles')
          .select('username, display_name, avatar_url:arena_avatar_url, player_number')
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
            {/* AUDIT 2026-08-22: this said SPIN unconditionally, so a
                128-runner MTT finished under a Spin badge. `isSpin` is
                resolved from the tournament row by isSpinTournament, not
                guessed from the event name. */}
            <span className="trc2__brand-mark">{result.isSpin ? 'SPIN' : 'TOURNAMENT'}</span>
          </div>
          <div className="trc2__event">
            <span className="trc2__event-date">
              {shortDate(endedAt ? new Date(endedAt) : new Date())}
            </span>{' '}
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
            no room for a zero, and a zero says nothing. Same rule for rebuys
            and add-ons, which the payload has always carried and the card has
            never shown: in a rebuy event they are most of the story. */}
        {(result.knockouts > 0 ||
          result.bountyWinnings > 0 ||
          result.rebuys > 0 ||
          result.addOns > 0) && (
          <div className="trc2__extras">
            {result.knockouts > 0 && (
              <span className="trc2__extra">
                <strong>{result.knockouts}</strong> Knockout{result.knockouts === 1 ? '' : 's'}
              </span>
            )}
            {result.bountyWinnings > 0 && (
              <span className="trc2__extra">
                <strong>{formatMoney(result.bountyWinnings)}</strong> In Bounties
              </span>
            )}
            {result.rebuys > 0 && (
              <span className="trc2__extra">
                <strong>{result.rebuys}</strong> Rebuy{result.rebuys === 1 ? '' : 's'}
              </span>
            )}
            {result.addOns > 0 && (
              <span className="trc2__extra">
                <strong>{result.addOns}</strong> Add-On{result.addOns === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}

        {/* ── How the session actually went ──
            Two facts the payload has always carried and this card threw away.
            Deliberately NOT chips: Dan, "tournaments are never displayed by
            chips, only what place you finished and how much you made." Time
            and hands are neither — they are what you did, and on a Spin they
            are the difference between a cooler and a grind. Rendered only when
            known, so an older payload shows no empty row. */}
        {(durationSeconds != null || handsPlayed != null) && (
          <div className="trc2__session">
            {durationSeconds != null && (
              <span className="trc2__session-stat">
                <span className="trc2__session-label">Duration</span>
                <span className="trc2__session-value">{formatDuration(durationSeconds)}</span>
              </span>
            )}
            {handsPlayed != null && (
              <span className="trc2__session-stat">
                <span className="trc2__session-label">Hands</span>
                <span className="trc2__session-value">{handsPlayed.toLocaleString()}</span>
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
