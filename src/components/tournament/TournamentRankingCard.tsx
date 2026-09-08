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
import { CardImage } from '../table/CardImage';
import { formatGameTitle } from '../../utils/formatGameTitle';
import type { TournamentResult } from '../../services/pendingSessionSummary';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../../utils/playerDisplayName';
import './TournamentRankingCard.css';
import { publicOrigin } from '../../lib/appBase';

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

/**
 * PODIUM TROPHY (Dan 2026-08-23: "the '1' should be a 1st place trophy (if they
 * finished 2nd or 3rd add those trophies)").
 *
 * Drawn, not an image, for the same reason the medal always was: it has to sit
 * inside the medal ring at any size and take the ring's metal colour. The cup
 * is one shape in all three cases — the METAL is what says which place it is,
 * and the ordinal band directly beneath already spells it out in words. Places
 * outside the podium keep the numeral, because a 47th-place trophy is a lie.
 */
function PlacementTrophy({ place }: { place: number }) {
  return (
    <svg
      className="trc2__trophy"
      viewBox="0 0 48 48"
      role="img"
      aria-label={`${ordinal(place)} Place Trophy`}
    >
      {/* Handles */}
      <path
        d="M13 10H8a1 1 0 0 0-1 1v3a8 8 0 0 0 7 7.94"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d="M35 10h5a1 1 0 0 1 1 1v3a8 8 0 0 1-7 7.94"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      {/* Cup */}
      <path
        d="M13 7h22v11c0 6.08-4.92 11-11 11S13 24.08 13 18V7Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Stem and base */}
      <path
        d="M24 29v6M17 41h14a1 1 0 0 0 1-1v-1a4 4 0 0 0-4-4h-8a4 4 0 0 0-4 4v1a1 1 0 0 0 1 1Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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
  /* Desktop has no share sheet, so the button reports the clipboard copy on
     itself rather than assuming a toast provider above this portal. */
  const [shared, setShared] = useState(false);
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
          .select(`${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url, player_number`)
          .eq('id', uid)
          .maybeSingle();
        if (cancelled || !data) return;
        setProfile({
          /* Was `data.display_name || data.username`, which is how this card
             came to greet Dan as "Marcus Chen" - a seed-data value sitting in
             display_name while his actual preference (full_name -> "Dan
             Bekavac") went unread. playerDisplayName reads the preference
             first. See src/utils/playerDisplayName.ts. */
          /* 'arena' explicitly, though it is also the default: this card is a
             Club Arena tournament result, and Dan 2026-08-23 - "IM DAN BEKAVAC
             ON SOCIAL AND KINGFISH IN THE CLUB ARENA" - makes the table a
             handle-only surface. Passing it rather than relying on the default
             keeps the intent readable at the call site. */
          username: playerDisplayName(data, 'arena'),
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
  /* MYSTERY BOUNTY (section 43). Cents, and absent on any non-mystery event. */
  const mysteryBounties = Math.max(0, Number(result.mysteryBounties) || 0);
  const mysteryCents = Math.max(0, Math.round(Number(result.mysteryBountyCents) || 0));
  const largestMysteryCents = Math.max(
    0,
    Math.round(Number(result.largestMysteryBountyCents) || 0)
  );

  /* "FIDGET SPINNER #3(11)" — event, finishing place, field size.
     Dan 2026-08-23: "remove the (3) after Spin PLO6 #1". On a Spin the field
     is ALWAYS three, so the bracket carries no information and just clutters
     the line. An MTT keeps it: there "#3(128)" is most of the result. */
  const showEntrants = !result.isSpin && !!result.entrants;
  const eventLine =
    place != null
      ? `${eventName} #${place}${showEntrants ? `(${result.entrants})` : ''}`
      : eventName;

  /**
   * SHARE (Dan 2026-08-23: "REMOVE 'STAY OBSERVING' WITH A SHARE BUTTON").
   *
   * "Stay Observing" was the same action as the X and the backdrop — three
   * controls doing one thing, and the least interesting thing on the card.
   * A result is worth showing off, so this is the slot that earns its width.
   *
   * navigator.share is the native sheet on mobile, which is where this card is
   * read. Desktop has no sheet, so fall back to the clipboard and say so on
   * the button itself — a toast provider is not guaranteed at this portal.
   */
  const handleShare = async () => {
    const text =
      place != null
        ? `I finished ${ordinal(place)} in ${eventName} on Smarter.Poker` +
          (totalWon > 0 ? ` for ${formatMoney(totalWon)}.` : '.')
        : `I just played ${eventName} on Smarter.Poker.`;
    try {
      const nav = navigator as Navigator & {
        share?: (d: { title?: string; text?: string; url?: string }) => Promise<void>;
      };
      if (typeof nav.share === 'function') {
        await nav.share({
          title: 'Smarter.Poker',
          text,
          url: `${publicOrigin()}/hub/club-arena`,
        });
        return;
      }
      await navigator.clipboard.writeText(`${text} ${publicOrigin()}/hub/club-arena`);
      setShared(true);
      window.setTimeout(() => setShared(false), 2000);
    } catch {
      /* A cancelled share sheet throws. Nothing to report — the player closed it. */
    }
  };

  const handlePlayAgain = () => {
    if (onPlayAgain) {
      onPlayAgain();
      return;
    }
    onDismiss();
    navigate(result.isSpin ? '/tournaments?type=spin' : '/tournaments');
  };

  return createPortal(
    <div className="trc2" role="dialog" aria-modal="true" aria-label="Tournament Ranking">
      {/* Dan 2026-08-30: "USER MUST CLICK THE 'X' TO CLOSE IT." The backdrop
          used to be a third dismiss control; a stray tap while reading the
          result threw the card away. It is scenery now - the X (and Escape,
          for keyboards) are the only ways out. */}
      <div className="trc2__backdrop" />

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
          {/* Dan 2026-08-23: "remove the dots on the top." The marquee-bulb
              strip read as a rendering artefact rather than decoration. */}
          <div className="trc2__brand">
            SMARTER<span className="trc2__brand-accent">POKER</span>
            {/* AUDIT 2026-08-22: this said SPIN unconditionally, so a
                128-runner MTT finished under a Spin badge. `isSpin` is
                resolved from the tournament row by isSpinTournament, not
                guessed from the event name.
                Dan 2026-08-23: "remove the 'spin' after SmarterPoker" — the
                line below already names the game, so on a Spin the badge is
                pure repetition. An MTT keeps its badge. */}
            {!result.isSpin && <span className="trc2__brand-mark">TOURNAMENT</span>}
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
              {place != null && place <= 3 ? (
                <PlacementTrophy place={place} />
              ) : (
                <span className="trc2__medal-place">{place ?? '-'}</span>
              )}
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
            {/* Dan section 44: the champion's card must not imply the placement
                prize was the whole story. It never was on this card - "Reward"
                has always been prize + bounties - but a single opaque figure
                does not SAY so, and in a mystery bounty event the split is
                frequently most of the interest. The label names it as the
                total, and the line underneath shows the two halves whenever
                there are two. */}
            <span className="trc2__reward-label">Total Payout:</span>
            <span className="trc2__reward-value">{formatMoney(totalWon)}</span>
          </div>
        </div>

        {/* ── Winning hand (if applicable) ── */}
        {result.winningCards && result.winningCards.length > 0 && (
          <div className="trc2__winning-hand">
            <span className="trc2__winning-hand-label">Winning Hand</span>
            <div className="trc2__winning-cards">
              {result.winningCards.map((c, i) => (
                <CardImage key={i} card={c} size="lg" className="trc2__winning-card" />
              ))}
            </div>
          </div>
        )}

        {result.bountyWinnings > 0 && (
          <div className="trc2__payout-split">
            <span className="trc2__payout-part">
              Prize <strong>{formatMoney(result.prize || 0)}</strong>
            </span>
            <span className="trc2__payout-plus" aria-hidden="true">
              +
            </span>
            <span className="trc2__payout-part">
              Bounties <strong>{formatMoney(result.bountyWinnings)}</strong>
            </span>
          </div>
        )}

        {/* Knockouts only appear when there were any — the reference card has
            no room for a zero, and a zero says nothing. Same rule for rebuys
            and add-ons, which the payload has always carried and the card has
            never shown: in a rebuy event they are most of the story. */}
        {(result.knockouts > 0 ||
          result.bountyWinnings > 0 ||
          mysteryCents > 0 ||
          mysteryBounties > 0 ||
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
            {/* MYSTERY BOUNTY (Dan section 43). Three facts the bounty line
                above cannot carry: how many of those bounties were CHESTS, what
                they paid, and the biggest single one. In cents, so divided by
                100 here and nowhere else. */}
            {mysteryBounties > 0 && (
              <span className="trc2__extra">
                <strong>{mysteryBounties.toLocaleString('en-US')}</strong> Mystery Bount
                {mysteryBounties === 1 ? 'y' : 'ies'}
              </span>
            )}
            {mysteryCents > 0 && (
              <span className="trc2__extra">
                <strong>{formatMoney(mysteryCents / 100)}</strong> In Mystery Bounties
              </span>
            )}
            {largestMysteryCents > 0 && (
              <span className="trc2__extra">
                <strong>{formatMoney(largestMysteryCents / 100)}</strong> Largest Mystery Bounty
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
          <button className="trc2__btn" onClick={() => void handleShare()}>
            {shared ? 'Link Copied' : 'Share'}
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
