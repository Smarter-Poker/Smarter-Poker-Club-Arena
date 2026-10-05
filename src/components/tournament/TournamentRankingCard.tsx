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

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { readLocalSession } from '../../lib/authUtils';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { CardImage } from '../table/CardImage';
import { formatGameTitle } from '../../utils/formatGameTitle';
import type { TournamentResult } from '../../services/pendingSessionSummary';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../../utils/playerDisplayName';
import { SpadeConsole } from '../console/SpadeConsole';
import './TournamentRankingCard.css';
import { publicOrigin } from '../../lib/appBase';
import { downloadBlob } from '../../utils/downloadCsv';
import { paintRankingShareImage, TROPHY_PATHS, type ShareTier } from './rankingShareImage';
import { formatPrizeCentsAtUnit, moneySuffixAtUnit } from '../../utils/format';

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
  /**
   * THE GRID THIS EVENT PAID ON (2026-09-20). Every figure on this card is a
   * payout, and at a Diamond event `formatMoney`'s two forced decimal places
   * advertise a fraction of a Diamond that no door in this estate accepts.
   *
   * Required and undefaulted: `a-tournament-prize-knows-its-unit.law.test.ts`
   * exists because a defaulted unit made five surfaces look finished while
   * every one of them was still on the cent grid. The host reads it from the
   * session payload's own arena asset.
   */
  unitCents: number;
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

/**
 * The ordinal as two prints: the numeral, which is the result, and its suffix,
 * which is grammar. "1st" set as one string at one size gave the suffix the
 * same weight as the place itself (Dan 2026-10-05: "it looks pretty generic").
 */
function ordinalParts(n: number): { num: string; suffix: string } {
  const full = ordinal(n);
  return { num: full.slice(0, -2), suffix: full.slice(-2) };
}

/**
 * The word over the place. A podium finish is named for what it is; anything
 * else is simply where the run ended - never a consolation title.
 */
function placeTitle(place: number | null, qualified: boolean): string {
  if (qualified) return 'Satellite';
  if (place === 1) return 'Champion';
  if (place === 2) return 'Runner Up';
  if (place === 3) return 'Third Place';
  return 'Finished';
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
/* DEFECT FOUND AND FIXED 2026-09-14. These returned `trc2-medal--gold` - ONE
   dash, no BEM element - while the stylesheet has always declared
   `.trc2__medal--gold`. Nothing matched, so `--trc2-medal-face`,
   `--trc2-medal-edge`, `--trc2-medal-ink` and `--trc2-band` were never set on
   any card: every medal rendered as an empty ring with no metal, every trophy
   and numeral inherited the card's text colour, and EVERY place band fell
   through to its `#233355` fallback. First, second and third have been
   indistinguishable from 47th since the classes were written. The one thing
   this card exists to say - which place this was - was said by the numeral
   alone. */
function medalClass(place: number | null): string {
  if (place === 1) return 'trc2__medal--gold';
  if (place === 2) return 'trc2__medal--silver';
  if (place === 3) return 'trc2__medal--bronze';
  return 'trc2__medal--steel';
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
function PlacementTrophy({ label }: { label: string }) {
  return (
    <svg className="trc2__trophy" viewBox="0 0 48 48" role="img" aria-label={label}>
      {/* Handles */}
      <path
        d={TROPHY_PATHS.handleLeft}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d={TROPHY_PATHS.handleRight}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      {/* Cup */}
      <path
        d={TROPHY_PATHS.cup}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Stem and base */}
      <path
        d={TROPHY_PATHS.base}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * EVERY FIGURE ON THIS CARD, AT THE UNIT THE EVENT PAID ON (2026-10-05).
 *
 * This was a private `formatMoney` that forced two decimal places on every
 * chip figure, so a 120 chip prize read "120.00" and a 4,200 win
 * "4,200.00" - decimal points on a forward-facing page with nothing after
 * them but zeros, which Dan's ruling forbids ("NEVER USE DECIMAL POINTS ON ANY
 * FORWARD FACING PAGE"). It now goes through the estate's one prize rule in
 * the cents domain, `formatPrizeCentsAtUnit`, the same function the mystery
 * ladder prints with:
 *
 *   - a whole chip amount prints whole                          120   4,200
 *   - an amount with real cents keeps them, to the penny        1.90  12.05
 *     (Dan 2026-09-04: under a hundred, chip money is "ACCURATE TO THE
 *     PENNY"; and the no-decimals rule never licenses understating money)
 *   - a Diamond amount prints whole Diamonds, as before         17
 *
 * Rounded to the cent first, so float noise from a sum (0.1 + 0.2) can never
 * print as a third decimal or flip a whole number into a fraction.
 */
function moneyAtUnit(n: number, unitCents: number): string {
  return formatPrizeCentsAtUnit(Math.round((Number(n) || 0) * 100), unitCents);
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

/**
 * WHAT A SATELLITE WON, IN ONE WORD (2026-10-05). A qualification has no
 * finishing place, so the card used to leave the painted pill slot empty, put
 * a lone "-" in the medal and print "Qualified" twice. The pill now names the
 * prize's kind, the band says it was won, and the medal carries the cup in the
 * first-place metal, because winning a seat is winning the satellite.
 */
function deliveryWord(kind: 'seat' | 'ticket' | 'cash'): string {
  return kind === 'seat' ? 'Seat' : kind === 'ticket' ? 'Ticket' : 'Cash';
}

/**
 * A long event name, cut at a word and marked as cut. The subtitle zone fits
 * its line by shrinking to a floor and clips past it, and a real event name
 * runs past fifty characters ("SUNDAY DEEPSTACK BOUNTY HEADS UP TURBO ...")
 * - at 393px that printed microscopic and still lost its last letters.
 */
const SUBTITLE_MAX = 34;
function shortEventName(name: string): string {
  if (name.length <= SUBTITLE_MAX) return name;
  const cut = name.slice(0, SUBTITLE_MAX + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 12 ? cut.slice(0, space) : name.slice(0, SUBTITLE_MAX)).trimEnd()}\u2026`;
}

/** The metal of a finish, for the share image (the card uses medalClass). */
function shareTier(place: number | null, qualified: boolean): ShareTier {
  if (qualified || place === 1) return 'gold';
  if (place === 2) return 'silver';
  if (place === 3) return 'bronze';
  return 'steel';
}

/* THE REVEAL'S TIMING (2026-10-05). The card rises (0.4s), the medal lands at
   0.18s, the place at 0.5s, the payout appears at 0.75s and counts up from
   there. The stylesheet carries the same numbers; this one is the count's. */
const PAYOUT_COUNT_DELAY_MS = 800;
const PAYOUT_COUNT_MS = 900;

function wantsCount(targetCents: number): boolean {
  if (!(targetCents > 0)) return false;
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return false;
  }
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

/**
 * THE PAYOUT COUNTS UP (2026-10-05). Returns the running figure in cents while
 * it counts and null once it has landed. The final figure is ALWAYS in the
 * DOM (the card prints it underneath, held invisible while the count runs), so
 * a screen reader, a test and a player with reduced motion read the real
 * number from the first frame, and the count can never be the only place the
 * amount exists. Reduced motion skips the count entirely; it is decoration.
 */
function useCountUp(targetCents: number): number | null {
  const [value, setValue] = useState<number | null>(() => (wantsCount(targetCents) ? 0 : null));
  useEffect(() => {
    if (!wantsCount(targetCents)) return;
    let frame = 0;
    let start = 0;
    let live = true;
    const tick = (now: number) => {
      if (!live) return;
      if (!start) start = now;
      const t = (now - start - PAYOUT_COUNT_DELAY_MS) / PAYOUT_COUNT_MS;
      if (t >= 1) {
        setValue(null);
        return;
      }
      if (t > 0) {
        const running = targetCents * (1 - Math.pow(1 - t, 3));
        /* A whole figure counts in whole chips: a count that flickers through
           "2,511.27" on its way to "5,470" shows decimals the result has not
           got. Cents only appear when the result really carries them. */
        setValue(targetCents % 100 === 0 ? Math.round(running / 100) * 100 : Math.round(running));
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      live = false;
      window.cancelAnimationFrame(frame);
    };
  }, [targetCents]);
  return value;
}

export default function TournamentRankingCard({
  result,
  tableName,
  durationSeconds,
  handsPlayed,
  endedAt,
  onDismiss,
  onPlayAgain,
  unitCents,
}: TournamentRankingCardProps) {
  const navigate = useNavigate();
  /* Desktop has no share sheet, so the button reports the clipboard copy on
     itself rather than assuming a toast provider above this portal. */
  const [shared, setShared] = useState<null | 'copied' | 'saved'>(null);
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

  const qualification = result.satelliteQualification;
  const place = qualification ? null : result.finishPlace;
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
     the line. An MTT keeps it: there "#3(128)" is most of the result.

     ON THE CONSOLE the three facts are separated rather than concatenated: the
     event is the engraved title, the place is the word in the painted pill
     slot, and the field size joins the date in the subtitle. Same rule, same
     omission on a Spin. */
  const showEntrants = !result.isSpin && !!result.entrants;
  const eventSubtitle = [
    shortDate(endedAt ? new Date(endedAt) : new Date()),
    showEntrants ? `${result.entrants} Entrants` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  /* The headline figure and its label, once, for the card and the image. */
  const payoutAmount = qualification?.amount ?? totalWon;
  const payoutLabel = qualification
    ? qualification.deliveryKind === 'seat'
      ? 'Target Entry:'
      : qualification.deliveryKind === 'ticket'
        ? 'Entry Ticket:'
        : 'Cash Award:'
    : 'Total Payout:';
  const payoutCents = Math.round((Number(payoutAmount) || 0) * 100);
  const counting = useCountUp(payoutCents);

  /* THE SHARE IMAGE IS PAINTED BEFORE THE TAP (2026-10-05). iOS Safari only
     opens the share sheet inside the tap's own activation, and painting
     awaits image loads, so the PNG is made when the card opens and repainted
     if the player's name arrives after it. Share uses whatever is ready. */
  const shareImage = useRef<Blob | null>(null);
  const shareName = profile?.username ?? null;
  const placeWord = placeTitle(place, Boolean(qualification));
  const tier = qualification ? 'trc2__medal--gold' : medalClass(place);
  const pillText = qualification
    ? deliveryWord(qualification.deliveryKind)
    : place != null
      ? `#${place}`
      : null;
  const bandWord = qualification ? `${deliveryWord(qualification.deliveryKind)} Won` : 'Finished';
  const subtitleText = shortEventName(eventName);
  useEffect(() => {
    let live = true;
    void paintRankingShareImage({
      eyebrow: eventSubtitle,
      title: qualification ? 'Qualified' : 'Ranking',
      subtitle: subtitleText,
      pill: pillText,
      placeTitle: placeWord,
      place: qualification
        ? { word: bandWord }
        : place != null
          ? ordinalParts(place)
          : { word: 'Finished' },
      medal:
        qualification || (place != null && place <= 3)
          ? { trophy: true }
          : { trophy: false, text: place != null ? String(place) : '-' },
      tier: shareTier(place, Boolean(qualification)),
      payoutLabel: payoutLabel.replace(/:$/, ''),
      payoutValue: `${moneyAtUnit(payoutAmount, unitCents)}${moneySuffixAtUnit(unitCents)}`,
      username: shareName,
    })
      .then((blob) => {
        if (live) shareImage.current = blob;
      })
      .catch(() => {
        /* No image: Share sends the sentence, as it always did. */
      });
    return () => {
      live = false;
    };
  }, [
    eventSubtitle,
    eventName,
    qualification,
    place,
    placeWord,
    pillText,
    bandWord,
    subtitleText,
    payoutLabel,
    payoutAmount,
    unitCents,
    shareName,
  ]);

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
    const text = qualification
      ? `I qualified in ${eventName} on Smarter.Poker.`
      : place != null
        ? `I finished ${ordinal(place)} in ${eventName} on Smarter.Poker` +
          (totalWon > 0
            ? ` for ${moneyAtUnit(totalWon, unitCents)}${moneySuffixAtUnit(unitCents)}.`
            : '.')
        : `I just played ${eventName} on Smarter.Poker.`;
    const url = `${publicOrigin()}/hub/club-arena`;
    const flash = (what: 'copied' | 'saved') => {
      setShared(what);
      window.setTimeout(() => setShared(null), 2000);
    };
    const image = shareImage.current;
    const filename = 'smarter-poker-result.png';
    try {
      const nav = navigator as Navigator & {
        share?: (d: ShareData) => Promise<void>;
        canShare?: (d: ShareData) => boolean;
      };
      /* 1. The picture and the sentence, through the system sheet. The link
         rides in the text: most targets drop `url` once files are attached. */
      if (image && typeof nav.share === 'function' && typeof nav.canShare === 'function') {
        const file = new File([image], filename, { type: 'image/png' });
        const withImage: ShareData = {
          files: [file],
          title: 'Smarter.Poker',
          text: `${text} ${url}`,
        };
        if (nav.canShare(withImage)) {
          await nav.share(withImage);
          return;
        }
      }
      /* 2. A sheet that cannot carry files still carries the sentence. */
      if (typeof nav.share === 'function') {
        await nav.share({ title: 'Smarter.Poker', text, url });
        return;
      }
      /* 3. No sheet (desktop, Android's webview): the picture goes through the
         estate's one file door - an anchor on the web, the system share sheet
         in the app - and the sentence goes to the clipboard beside it. */
      if (image) {
        downloadBlob(filename, image);
        try {
          await navigator.clipboard.writeText(`${text} ${url}`);
        } catch {
          /* The image is the share; a refused clipboard costs only the link. */
        }
        flash('saved');
        return;
      }
      await navigator.clipboard.writeText(`${text} ${url}`);
      flash('copied');
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

  /* ═══════════════════════════════════════════════════════════════════════
     ON THE CONSOLE (#ClubArenaConsole, 2026-09-14) - the VIP crest, because
     this card is a finishing place.

     Re-rendered, not rewritten. The portal, the Escape handler, the profile
     read, the share sheet and its clipboard fallback, Play Again and its
     navigate fallback, every ordinal, every figure and the whole mystery
     bounty block are the ones that were here.

     WHAT WAS PAINTED INSTEAD OF DRAWN: the card's 18px radius, its 2px blue
     border, its navy gradient, the radial "arena" banner behind the medal, the
     round steel close button, the bordered player card, the cyan-outlined
     winning-hand box, the pill-shaped extra tags and the two gradient buttons.
     All of that is the master's now - the frame, the header well, the pill
     slot and the two action plates are painted, and this component prints into
     them.

     WHAT IS STILL DRAWN, AND WHY: the medal. No master contains a disc that
     can carry an arbitrary finishing place (128th) at any size in four metals,
     and Dan's trophy ruling (2026-08-23) is about what is inside that disc.
     It is the one illustration on the sheet, and its ramp is COOL metal only -
     tests/unit/rankingCardPalette.test.ts parses this stylesheet and fails on
     any warm hue, which is Dan's "NO BROWNS OR YELLOWS" written down.

     THE X IS THE ONLY WAY OUT (Dan 2026-08-30: "USER MUST CLICK THE 'X' TO
     CLOSE IT"). The backdrop is scenery and does not dismiss. The X is the
     console's own, painted in the head's corner (2026-10-05); the word Close
     that stood in for it at the foot of the glass is gone with Dan's go-ahead
     the same day, so the card has one close control in the one place every
     other popup has it. Escape still closes it for a keyboard. */
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="trc2" role="dialog" aria-modal="true" aria-label="Tournament Ranking">
      {/* Dan 2026-08-30: "USER MUST CLICK THE 'X' TO CLOSE IT." The backdrop
          used to be a third dismiss control; a stray tap while reading the
          result threw the card away. It is scenery now - the X (and Escape,
          for keyboards) are the only ways out. */}
      <div className="trc2__backdrop" />

      <div className="trc2__card">
        <SpadeConsole
          crest="vip"
          /* RANKING is the card's own name in Dan's reference, and it is what
             the engraved title says. The EVENT NAME is the long string here -
             a real one runs past thirty characters - so it prints as the
             subtitle, which has the full width of the well and does not sit
             beside the pill; the place goes in the pill slot, where "#3" was
             always going to fit. Putting the event in the title clipped it to
             "SUNDAY DEEPSTACK BOUNTY HU" at 393px. */
          eyebrow={eventSubtitle}
          title={qualification ? 'Qualified' : 'Ranking'}
          subtitle={subtitleText}
          pill={pillText ?? undefined}
          pillInk="silver"
          /* THE X (Dan 2026-10-05: "THE TOURNAMENT RESULT CARD HAS NO 'X' OFF
             ON IT TO CLOSE THIS OUT"). Every other popup took the console's
             painted X on 2026-09-23; this one was written into the law's
             no-X list on the claim that it "carries its own painted close
             control" - which was the word Close at the very bottom of the
             glass, under the stats, the one place the X ruling says a player
             must never have to go. The head's corner is where the X lives on
             every console, so it lives there here too, and the foot word is
             retired. */
          onClose={onDismiss}
          plates={{
            secondary: {
              label:
                shared === 'saved' ? 'Image Saved' : shared === 'copied' ? 'Link Copied' : 'Share',
              ink: 'silver',
              onClick: () => void handleShare(),
            },
            primary: { label: 'Play Again', ink: 'white', onClick: handlePlayAgain },
          }}
        >
          {/* ── The brand line ── */}
          {/* Dan 2026-08-23: "remove the dots on the top." The marquee-bulb
              strip read as a rendering artefact rather than decoration. */}
          <div className="trc2__brand">
            SMARTER<span className="trc2__brand-accent">POKER</span>
            {/* AUDIT 2026-08-22: this said SPIN unconditionally, so a
                128-runner MTT finished under a Spin badge. `isSpin` is
                resolved from the tournament row by isSpinTournament, not
                guessed from the event name.
                Dan 2026-08-23: "remove the 'spin' after SmarterPoker" — the
                title above already names the game, so on a Spin the badge is
                pure repetition. An MTT keeps its badge. */}
            {!result.isSpin && <span className="trc2__brand-mark">TOURNAMENT</span>}
          </div>

          {/* ── Medal ──
              The rays are the reference card's starburst, cast in the medal's
              own light: bright cool beams for the podium, a faint steel wash
              for everyone else. Light on the glass, not a shape on it. */}
          <div className={`trc2__medal ${tier}`}>
            <span className="trc2__medal-rays" aria-hidden="true" />
            <div className="trc2__medal-ring">
              {qualification ? (
                <PlacementTrophy label="Satellite Trophy" />
              ) : place != null && place <= 3 ? (
                <PlacementTrophy label={`${ordinal(place)} Place Trophy`} />
              ) : (
                <span className="trc2__medal-place">{place ?? '-'}</span>
              )}
            </div>
            <span className="trc2__medal-glow" aria-hidden="true" />
          </div>

          {/* ── Place band ──
              Was a flat blue slab with "1ST" centred in it, the one thing on
              the card that looked like every other app. The result is now
              set as the result: what the finish is called, lit, between two
              engraved rules, then the place itself in the master's engraved
              silver at the largest size on the sheet. The band colour is
              still the finish's metal; it is the light the numeral sits in. */}
          <div className={`trc2__placeband ${tier}`}>
            <span className="trc2__place-title sc-ink--blue">{placeWord}</span>
            {qualification ? (
              <span className="trc2__place-word sc-ink--silver">{bandWord}</span>
            ) : place != null ? (
              <span className="trc2__place-ordinal sc-ink--silver" aria-label={ordinal(place)}>
                <span className="trc2__place-num">{ordinalParts(place).num}</span>
                <span className="trc2__place-suffix">{ordinalParts(place).suffix}</span>
              </span>
            ) : (
              <span className="trc2__place-word sc-ink--silver">Finished</span>
            )}
          </div>

          {/* ── What it paid ──
              The figure a player came back to the card to read, so it is the
              second largest print on the sheet, directly under the place,
              rather than a corner of the player row. */}
          <div className="trc2__reward">
            {/* Dan section 44: the champion's card must not imply the placement
                prize was the whole story. It never was on this card - "Reward"
                has always been prize + bounties - but a single opaque figure
                does not SAY so, and in a mystery bounty event the split is
                frequently most of the interest. The label names it as the
                total, and the line underneath shows the two halves whenever
                there are two. */}
            <span className="trc2__reward-label">{payoutLabel}</span>
            <span className="trc2__reward-value sc-ink--silver">
              {/* The real figure is always here; while the count runs it is
                  held invisible (it still sets the width, so nothing shifts
                  when the count lands) and the running number prints over it,
                  hidden from assistive tech. */}
              <span
                className={
                  counting != null ? 'trc2__reward-final is-counting' : 'trc2__reward-final'
                }
              >
                {moneyAtUnit(payoutAmount, unitCents)}
                {/* The headline figure is otherwise a bare number, and a bare
                    number in the Diamond Arena does not say what was won. Adds
                    nothing at a chip event. */}
                {moneySuffixAtUnit(unitCents)}
              </span>
              {counting != null && (
                /* Printed by the stylesheet from data-count, not as a text
                   node: the running figure is never part of the card's text,
                   so nothing that reads the card (a screen reader, a copy, a
                   test) can catch it mid-count. */
                <span
                  className="trc2__reward-count"
                  aria-hidden="true"
                  data-count={`${formatPrizeCentsAtUnit(counting, unitCents)}${moneySuffixAtUnit(unitCents)}`}
                />
              )}
            </span>
          </div>

          {result.bountyWinnings > 0 && (
            <div className="trc2__payout-split">
              <span className="trc2__payout-part">
                Prize <strong>{moneyAtUnit(result.prize || 0, unitCents)}</strong>
              </span>
              <span className="trc2__payout-plus" aria-hidden="true">
                +
              </span>
              <span className="trc2__payout-part">
                Bounties <strong>{moneyAtUnit(result.bountyWinnings, unitCents)}</strong>
              </span>
            </div>
          )}

          {/* ── Player row: who this was ── */}
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
              <span className="trc2__username sc-ink--silver">{profile?.username ?? ' '}</span>
              {profile?.playerNumber != null && (
                /* "ID:", the label every other surface in the app prints this
                   number with (ClubProfileModal, the cashier). Bare, a "1"
                   directly under a "#1" finishing place read as a second
                   placing (2026-10-05). */
                <span className="trc2__playernum sc-ink--muted">ID: {profile.playerNumber}</span>
              )}
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
                  <strong>{moneyAtUnit(result.bountyWinnings, unitCents)}</strong> In Bounties
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
                  <strong>{moneyAtUnit(mysteryCents / 100, unitCents)}</strong> In Mystery Bounties
                </span>
              )}
              {largestMysteryCents > 0 && (
                <span className="trc2__extra">
                  <strong>{moneyAtUnit(largestMysteryCents / 100, unitCents)}</strong> Largest
                  Mystery Bounty
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
                  <span className="trc2__session-label sc-ink--blue">Duration</span>
                  <span className="trc2__session-value sc-ink--silver">
                    {formatDuration(durationSeconds)}
                  </span>
                </span>
              )}
              {handsPlayed != null && (
                <span className="trc2__session-stat">
                  <span className="trc2__session-label sc-ink--blue">Hands</span>
                  <span className="trc2__session-value sc-ink--silver">
                    {handsPlayed.toLocaleString()}
                  </span>
                </span>
              )}
            </div>
          )}
        </SpadeConsole>
      </div>
    </div>,
    document.body
  );
}
