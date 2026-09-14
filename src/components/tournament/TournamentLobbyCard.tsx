/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT LOBBY CARD — Tournament Registration Display
 * Shows tournament info with registration countdown and join button
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE CONSOLE (#ClubArenaConsole, 2026-09-08). The card was a rounded sheet
 * with a strip of coloured badge pills, a six-cell info GRID, a second strip of
 * feature pills, a gradient progress bar and a gradient button. Dan, on exactly
 * that shape: "I'M NOT A BIG FAN OF THESE CARDS. I DON'T LIKE THE 4 BOXES ...
 * I'D MUCH RATHER SEE THEM LOOK MORE LIKE [the plain console]."
 *
 * So it is Dan's approved spade master now: the format is the eyebrow, the
 * event name is engraved in the header well, the state (Open / Late Reg /
 * Running / Full) sits in the well's painted pill slot, every figure prints as
 * a row on the black glass - label in the master's lit blue on the left, value
 * in silver on the right, an engraved rule between rows - and the two actions
 * are the plates painted into the foot. Nothing is drawn: no badge pills, no
 * grid cells, no progress bar, no gradient button.
 *
 * THE FOOT PAINTS BOTH PLATES OR NEITHER, so this card always offers two: the
 * contextual action (Register / Take A Seat / Watch / Open Tournament) on the
 * blue glass, and Details on the steel - which is what tapping the card itself
 * has always done, now said out loud.
 *
 * Every behaviour is unchanged: the registration check and its three states,
 * the countdowns, the seat-first branch, the watch intent in the URL and the
 * useAppNavigate routing that keeps a seated player inside their lobby tab.
 */

import { useState, useEffect, memo } from 'react';
/* Dan 2026-08-28: this card is the SatellitesTab of TournamentDetails, which
   MultiTablePage renders inside a lobby tab. All three of its navigate calls
   target /tournaments/:id, and every one of them used to drop a seated player
   off /table/* - action bar and all. useAppNavigate keeps them in the tab and
   is plain useNavigate everywhere else. See InTabLobbyContext.tsx. */
import { useAppNavigate } from '../../context/InTabLobbyContext';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import styles from './TournamentLobbyCard.module.css';
import { reportError } from '../../utils/errorReporter';
import { formatGameTitle } from '../../utils/formatGameTitle';
// Whole-number tournament money (Dan 2026-08-20).
import { money } from '../../utils/buyIn';
import { compactChips } from '../../utils/format';
import { chipsCompact } from './details/types';
import { SpadeConsole, type ConsoleInk, type PlateButtonProps } from '../console/SpadeConsole';

interface Tournament {
  id: string;
  name: string;
  type: 'sng' | 'mtt' | 'satellite' | 'spin' | 'bounty' | 'pko' | 'mystery';
  /** The TOTAL a player pays, whole chips. Never the prize half on its own. */
  buyIn: number;
  prizePool: number;
  maxPlayers: number;
  registeredPlayers: number;
  startsAt?: string;
  status: 'registering' | 'running' | 'finished' | 'cancelled';
  blindStructure: string;
  gameType?: string;
  startingChips?: number;
  lateRegMins?: number;
  isRebuy?: boolean;
  guaranteedPrize?: number;
  isBounty?: boolean;
  isPko?: boolean;
  isMysteryBounty?: boolean;
  bountyAmount?: number;
  isMultiDay?: boolean;
  isPinned?: boolean;
  /** PokerBros parity (2026-08-22): label_as_new / is_vip_only / all_in_or_fold. */
  isNew?: boolean;
  isVipOnly?: boolean;
  isAllInOrFold?: boolean;
  blindDuration?: number;
  blindsUp?: number;
  rebuyAllowed?: boolean;
  addonAllowed?: boolean;
  spinMultiplier?: number;
  started_at?: string;
  late_reg_mins?: number;
  late_reg_levels?: number;
  current_level?: number;
  addon_levels?: number;
  is_reentry?: boolean;
}

interface TournamentLobbyCardProps {
  tournament: Tournament;
  onRegister?: (tournamentId: string) => void;
  /**
   * Whether the viewer is already registered, when the CALLER already knows.
   *
   * Every card otherwise runs its own `tournament_players` lookup on mount, so
   * a list of ten satellites cost eleven round trips while the parent was
   * holding the viewer's id the whole time. `useSatellites` answers all of them
   * with a single `.in()` query and hands the answer down here.
   *
   * Three states, and the third one matters: `undefined` means the caller does
   * not know, so the card queries for itself exactly as before (this is what
   * TournamentLobbyPage does). `true`/`false` is a real answer. `null` means
   * the caller's batch query FAILED — which is NOT "not registered". Rendering
   * a live Register button at an already-registered player is a second entry
   * attempt against real money, so a null falls back to the card's own lookup
   * and, if that fails too, to the refuses-to-guess branch below.
   */
  knownRegistration?: boolean | null;
}

/** Under five minutes to the gun. Exported so it can be pinned by a test. */
export const CRITICAL_WINDOW_MS = 5 * 60_000;

/**
 * The "about to start" flash used to be derived by parsing the FORMATTED
 * countdown back into a number: `countdown.includes('m') && parseInt(countdown)
 * < 5`. For "2h 30m" that reads 2, finds an 'm', and flashes a tournament two
 * and a half hours away as urgent. Format from the number, never the reverse.
 */
export function isStartingSoon(msToStart: number | null): boolean {
  return msToStart !== null && msToStart > 0 && msToStart < CRITICAL_WINDOW_MS;
}

export interface LateRegState {
  /** Registration is still open (or believed open). */
  active: boolean;
  /** What to print after "Late Reg:". Empty when there is no window at all. */
  label: string;
}

/**
 * LEVELS AND MINUTES ARE NOT THE SAME UNIT (2026-08-25).
 *
 * Every late-reg path in this card read `late_reg_levels || late_reg_mins` into
 * one variable called `lateRegLevels` and printed it under a "Lvl" label. The
 * only call site (TournamentLobbyPage) passes `lateRegMins` and passes NEITHER
 * `late_reg_levels` NOR `current_level`, so in production the card was:
 *
 *   - printing "Late Reg Through Lvl 45" for a 45-MINUTE window;
 *   - computing `levelsLeft = window - (current_level || 0)`, i.e. the whole
 *     window, forever, so the countdown never counted down and never closed.
 *
 * The units are kept apart here and neither is ever invented from the other:
 * when the input needed to measure the window is missing, this says "Open"
 * rather than printing a number nobody supplied.
 */
export function lateRegState(opts: {
  levels: number;
  minutes: number;
  currentLevel?: number | null;
  startedAtMs?: number | null;
  nowMs: number;
}): LateRegState {
  const { levels, minutes, currentLevel, startedAtMs, nowMs } = opts;

  if (levels > 0) {
    if (currentLevel == null) return { active: true, label: 'Open' };
    if (currentLevel >= levels) return { active: false, label: 'Closed' };
    const left = levels - currentLevel;
    return { active: true, label: `${left} Lvl${left !== 1 ? 's' : ''} Left` };
  }

  if (minutes > 0) {
    if (startedAtMs == null || !Number.isFinite(startedAtMs)) {
      return { active: true, label: 'Open' };
    }
    const msLeft = startedAtMs + minutes * 60_000 - nowMs;
    if (msLeft <= 0) return { active: false, label: 'Closed' };
    const minsLeft = Math.ceil(msLeft / 60_000);
    return { active: true, label: `${minsLeft} Min${minsLeft !== 1 ? 's' : ''} Left` };
  }

  return { active: false, label: '' };
}

function TournamentLobbyCardInner({
  tournament,
  onRegister,
  knownRegistration,
}: TournamentLobbyCardProps) {
  const navigate = useAppNavigate();
  const { user } = useAuthUser();
  const [registering, setRegistering] = useState(false);
  const [isRegistered, setIsRegistered] = useState(knownRegistration === true);
  /**
   * A FAILED REGISTRATION CHECK IS NOT "NOT REGISTERED" (2026-08-25).
   *
   * checkRegistration reported the error and then ran `setIsRegistered(!!data)`
   * anyway, with `data` null. An already-registered player whose check failed
   * was shown a live "Register (buy-in)" button. Pressing it is a second entry
   * attempt against real money. The unknown case now has its own state and the
   * button refuses to guess.
   */
  const [regCheckFailed, setRegCheckFailed] = useState(false);
  const [countdown, setCountdown] = useState<string>('');
  /** Real milliseconds to the start. The "critical" flash used to be parsed
   *  back out of the FORMATTED string: `countdown.includes('m') &&
   *  parseInt(countdown) < 5`. For "2h 30m" that reads 2, sees an 'm', and
   *  flashes a tournament two and a half hours away as if it were seconds from
   *  starting. Keep the number, format the string, never read one from the
   *  other. */
  const [msToStart, setMsToStart] = useState<number | null>(null);
  const [lateRegCountdown, setLateRegCountdown] = useState<string>('');
  const [lateRegActive, setLateRegActive] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  useEffect(() => {
    /* Only query when the caller has not already told us. `undefined` is "I
       do not know, go and look"; `null` is "my batch query failed", which is
       also a reason to look rather than to guess. See knownRegistration. */
    if (typeof knownRegistration === 'boolean') {
      setIsRegistered(knownRegistration);
      setRegCheckFailed(false);
    } else {
      checkRegistration();
    }
    if (tournament.startsAt) {
      updateCountdown();
      const interval = setInterval(updateCountdown, 1000);
      return () => clearInterval(interval);
    }
  }, [tournament.id, tournament.startsAt, knownRegistration]);

  // See lateRegState() above for why these two are not one variable.
  const lateRegLevels = tournament.late_reg_levels ?? 0;
  const lateRegMinutes = tournament.late_reg_mins ?? tournament.lateRegMins ?? 0;
  const hasLateReg = lateRegLevels > 0 || lateRegMinutes > 0;

  useEffect(() => {
    if (tournament.status === 'running' && hasLateReg) {
      updateLateRegCountdown();
      const interval = setInterval(updateLateRegCountdown, 10000);
      return () => clearInterval(interval);
    }
    setLateRegCountdown('');
    setLateRegActive(false);
  }, [
    tournament.status,
    tournament.late_reg_levels,
    tournament.late_reg_mins,
    tournament.lateRegMins,
    tournament.current_level,
    tournament.started_at,
  ]);

  const checkRegistration = async () => {
    if (!user?.id) return;
    const { data, error } = await supabase
      .from('tournament_players')
      .select('id')
      .eq('tournament_id', tournament.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) {
      reportError(error, 'TournamentLobbyCard.Registration_check_failed');
      setRegCheckFailed(true);
      return;
    }
    setRegCheckFailed(false);
    setIsRegistered(!!data);
  };

  const updateCountdown = () => {
    if (!tournament.startsAt) return;
    const now = new Date().getTime();
    const start = new Date(tournament.startsAt).getTime();
    if (!Number.isFinite(start)) {
      // An unparseable start_time used to render "NaNm NaNs" in the lobby.
      setCountdown('');
      setMsToStart(null);
      return;
    }
    const diff = start - now;
    setMsToStart(diff);

    if (diff <= 0) {
      setCountdown('Starting Now');
      return;
    }

    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);

    if (hours > 24) {
      const days = Math.floor(hours / 24);
      setCountdown(`${days}d ${hours % 24}h`);
    } else if (hours > 0) {
      setCountdown(`${hours}h ${minutes}m`);
    } else {
      setCountdown(`${minutes}m ${seconds}s`);
    }
  };

  const updateLateRegCountdown = () => {
    const startedAt = tournament.started_at ?? tournament.startsAt;
    const startedMs = startedAt ? new Date(startedAt).getTime() : null;
    const next = lateRegState({
      levels: lateRegLevels,
      minutes: lateRegMinutes,
      currentLevel: tournament.current_level,
      startedAtMs: startedMs,
      nowMs: Date.now(),
    });
    setLateRegActive(next.active);
    setLateRegCountdown(next.label);
  };

  const handleRegister = async () => {
    if (!user?.id || registering) return;
    setRegistering(true);

    try {
      // Use the onRegister prop to go through proper tournament service
      // (handles wallet deduction, validation, etc.)
      //
      // NO onRegister MEANT "REGISTERED" (2026-08-25). The flag was set outside
      // the `if`, so a card mounted without the prop - the whole registration
      // path missing - still flipped its own button to "Registered - Unregister?"
      // the instant it was pressed. Nothing had been bought. Only a call that
      // actually happened and actually resolved counts.
      if (!onRegister) {
        reportError(
          new Error('TournamentLobbyCard rendered without an onRegister handler'),
          'TournamentLobbyCard.Missing_onRegister'
        );
        return;
      }
      await onRegister(tournament.id);
      // 2026-08-27: the registration hook NEVER rejects - it resolves on
      // dialog cancel, on its re-entrancy guard, and on failures it swallows
      // into a toast. Setting isRegistered here therefore marked CANCELLED
      // registrations as Registered, directly under the comment saying only a
      // call that actually resolved counts. Ask the source of truth instead:
      // checkRegistration reads tournament_players and sets both flags.
      await checkRegistration();
    } catch (error) {
      reportError(error, 'TournamentLobbyCard.Failed_to_register');
    } finally {
      setRegistering(false);
    }
  };

  const handleUnregister = () => {
    // Navigate to tournament details for proper unregistration flow
    navigate(`/tournaments/${tournament.id}`);
  };

  const getTypeLabel = (type: string): string => {
    switch (type) {
      case 'sng':
        return 'Heads Up';
      case 'mtt':
        return 'MTT';
      case 'satellite':
        return 'Satellite';
      case 'spin':
        return 'Spin And Go';
      case 'bounty':
        return 'Bounty';
      case 'pko':
        return 'PKO';
      case 'mystery':
        return 'Mystery';
      default:
        return type.toUpperCase();
    }
  };

  /** The master's own inks. No hexes on this surface (Dan: house colours only). */
  const getStatusInk = (status: string): ConsoleInk => {
    switch (status) {
      case 'registering':
        return 'green';
      case 'running':
        return 'blue';
      case 'cancelled':
        return 'red';
      default:
        return 'muted';
    }
  };

  const getStatusLabel = (status: string): string => {
    switch (status) {
      case 'registering':
        return 'Open';
      case 'running':
        return 'Running';
      case 'finished':
        return 'Done';
      case 'cancelled':
        return 'Off';
      default:
        return status;
    }
  };

  const getSpeedTier = (tournament: Tournament): string | null => {
    // Get blind duration from blind_duration field or infer from blindStructure
    let blindDuration = tournament.blindDuration;

    if (!blindDuration && tournament.blindStructure) {
      // Try to parse blindStructure if it's a JSON string
      try {
        let structure = tournament.blindStructure;
        if (typeof structure === 'string') {
          // Only attempt JSON.parse if it looks like JSON (starts with [ or {)
          const trimmed = structure.trim();
          if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            structure = JSON.parse(trimmed);
          } else {
            return null; // Not parseable JSON — skip silently
          }
        }
        if (Array.isArray(structure) && structure.length > 0) {
          blindDuration = structure[0].durationMinutes || structure[0].duration_minutes;
        }
      } catch (e) {
        reportError(e, 'TournamentLobbyCard.getSpeedTier');
        // If parsing fails, return no badge (non-critical)
        return null;
      }
    }

    if (!blindDuration) return null;

    if (blindDuration <= 3) return 'Hyper';
    if (blindDuration <= 5) return 'Turbo';
    if (blindDuration <= 10) return null; // Regular - no tag needed
    return 'Deep Stack';
  };

  const isCountdownCritical = isStartingSoon(msToStart);

  /**
   * A freezeout is a tournament you cannot BUY BACK INTO: no rebuy, no add-on,
   * no re-entry. Late registration has nothing to do with it, and including it
   * here hid the Freezeout tag on every ordinary MTT, since practically all of
   * them run a late-reg window.
   */
  const isFreezout = (tournament: Tournament): boolean => {
    return (
      !tournament.isRebuy &&
      !tournament.rebuyAllowed &&
      !tournament.addonAllowed &&
      !tournament.is_reentry
    );
  };

  const hasMaxPlayers = tournament.maxPlayers > 0;
  // current_players drifts UP (see the Entries note below), so the subtraction
  // can go negative. "-3 spots remaining" is not a thing.
  const spotsRemaining = hasMaxPlayers
    ? Math.max(0, tournament.maxPlayers - tournament.registeredPlayers)
    : Infinity;
  const isFull = hasMaxPlayers && tournament.registeredPlayers >= tournament.maxPlayers;
  /* Seat-first: a Spin, or any game with two seats. Same rule as
     isSeatFirstFormat on the server and isSeatFirstTournament in the lobby. */
  const isSeatFirstCard =
    tournament.type === 'spin' || (tournament.maxPlayers > 0 && tournament.maxPlayers <= 2);

  const speedTier = getSpeedTier(tournament);
  const tags: string[] = [];
  if (tournament.isPinned) tags.push('Pinned');
  if (tournament.isNew) tags.push('New');
  if (tournament.isVipOnly) tags.push('VIP');
  if (tournament.isAllInOrFold) tags.push('All In Or Fold');
  if (speedTier) tags.push(speedTier);
  if (isFreezout(tournament)) tags.push('Freezeout');
  if (tournament.isBounty && !tournament.isPko && !tournament.isMysteryBounty) {
    tags.push(tournament.bountyAmount ? `Bounty ${money(tournament.bountyAmount)}` : 'Bounty');
  }
  if (tournament.isPko) tags.push('PKO');
  if (tournament.isMysteryBounty) tags.push('Mystery Bounty');
  if (tournament.isMultiDay) tags.push('Multi-Day');
  if (tournament.isRebuy) tags.push('Rebuy');

  /* THE PILL SLOT. One short word for the state a player is deciding on. */
  const pill =
    tournament.status === 'running' && hasLateReg && lateRegActive
      ? 'Late Reg'
      : tournament.status === 'registering' && isFull
        ? 'Full'
        : getStatusLabel(tournament.status);
  const pillInk: ConsoleInk =
    tournament.status === 'running' && hasLateReg && lateRegActive
      ? 'gold'
      : tournament.status === 'registering' && isFull
        ? 'red'
        : getStatusInk(tournament.status);

  /**
   * THE ACTION, on the blue glass. One branch per state, exactly the branches
   * this card has always had - only their chrome changed.
   */
  let primary: PlateButtonProps;
  if (tournament.status === 'registering' && regCheckFailed) {
    // We could not ask whether this player is already in. Offering
    // "Register" here risks a duplicate paid entry; offering "Registered"
    // risks hiding the only way in. Say what is actually true.
    primary = { label: 'Entry Status Unavailable', ink: 'muted', disabled: true };
  } else if (tournament.status === 'registering' && isSeatFirstCard) {
    /* A SEAT-FIRST GAME IS NOT REGISTERED, IT IS SAT AT (2026-09-03).
       Every row this card renders on a target's Satellites tab used to be
       a registerable MTT. The satellite heads-ups added today are two-seat
       games, and a two-seat game is entered by taking a seat at its table:
       fn_register_for_tournament refuses it outright with
       `seat_first_variant` ("This game is entered by taking a seat at its
       table"). Offering Register there is a button that cannot ever
       succeed - the same dead end lobbyEntries.isSeatFirstTournament was
       written to prevent on the main board, which this tab never learned.

       Seats are the test, as everywhere else: two or fewer, or a Spin. */
    primary = {
      label: `Take A Seat (${money(tournament.buyIn)})`,
      ink: 'white',
      onClick: (e) => {
        e.stopPropagation();
        navigate(`/tournaments/${tournament.id}?seat=1`);
      },
    };
  } else if (tournament.status === 'registering' && isRegistered) {
    primary = {
      label: 'Registered - Unregister?',
      ink: 'red',
      onClick: (e) => {
        e.stopPropagation();
        handleUnregister();
      },
    };
  } else if (tournament.status === 'registering') {
    primary = {
      label: registering
        ? 'Registering...'
        : isFull
          ? 'Tournament Full'
          : `Register (${money(tournament.buyIn)})`,
      ink: isFull ? 'muted' : 'white',
      disabled: registering || isFull,
      onClick: (e) => {
        e.stopPropagation();
        handleRegister();
      },
    };
  } else if (tournament.status === 'running') {
    /* Dan 2026-08-25 (binding): "when I click on a tournament that's
       RUNNING I should be able to click a button and watch."
       This branch was gated on `isRegistered`, so a running tournament you
       were not in rendered NO action at all — the card was a dead end for
       exactly the player who wants to watch. Everyone gets a button now;
       only its wording differs, because "open the tournament you are
       playing" and "watch someone else's" are different intents. Both land
       on the tournament screen, whose footer carries WATCH straight to the
       featured table. */
    primary = {
      label: isRegistered ? 'Open Tournament' : 'Watch',
      ink: 'white',
      onClick: (e) => {
        e.stopPropagation();
        /* 2026-08-25, second audit: both labels navigated to the
           details page, so a button that says "Watch" dropped the player
           on a screen where they still had to find the real WATCH
           button. This card has only a tournament id — it cannot know
           which table is featured without a query per card — so it hands
           the intent along in the URL and the details page acts on it
           the moment its featured table resolves. */
        navigate(
          isRegistered ? `/tournaments/${tournament.id}` : `/tournaments/${tournament.id}?watch=1`
        );
      },
    };
  } else {
    primary = { label: getStatusLabel(tournament.status), ink: 'muted', disabled: true };
  }

  return (
    <SpadeConsole
      as="div"
      className={styles.card}
      eyebrow={getTypeLabel(tournament.type)}
      /* The name, and only the name. Prefixing the guarantee pushed the title
         past the header well and truncated it ("5K GTD SUNDAY DEEPSTAC"); the
         guarantee already prints, in gold, on the PRIZE POOL row below. */
      title={formatGameTitle(tournament.name)}
      pill={pill}
      pillInk={pillInk}
      onClick={() => navigate(`/tournaments/${tournament.id}`)}
      style={{
        cursor: 'pointer',
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition:
          'opacity 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
      plates={{
        secondary: {
          label: 'Details',
          onClick: (e) => {
            e.stopPropagation();
            navigate(`/tournaments/${tournament.id}`);
          },
        },
        primary,
      }}
    >
      {tags.length > 0 && (
        <p className={styles.tags}>
          {tags.map((tag) => (
            <span key={tag} className={`${styles.tag} sc-label sc-ink--blue`}>
              {tag}
            </span>
          ))}
        </p>
      )}

      <div className={styles.rows}>
        <div className={styles.row}>
          <span className="sc-label sc-ink--blue">Buy-In</span>
          {/* Whole chips only (Dan 2026-08-20), and EXACT: this is the figure
              the server charges, so it is never abbreviated. */}
          <span className={`${styles.value} sc-ink--silver`}>{money(tournament.buyIn)}</span>
        </div>

        <div className={styles.row}>
          <span className="sc-label sc-ink--blue">Prize Pool</span>
          <span className={`${styles.value} sc-ink--silver`}>
            {(() => {
              const gtd = tournament.guaranteedPrize || 0;
              const displayPool =
                gtd > 0 ? Math.max(tournament.prizePool, gtd) : tournament.prizePool;
              return compactChips(displayPool);
            })()}
            {tournament.guaranteedPrize && tournament.guaranteedPrize > 0 && (
              <span className={`${styles.gtd} sc-ink--gold`}>GTD</span>
            )}
          </span>
        </div>

        <div className={styles.row}>
          {/* ENTRIES, NOT PLAYERS (2026-08-25). This number comes from
              tournaments.current_players, which is a REGISTRATION counter: it
              is incremented on entry and is never decremented on an
              unregistration or an elimination, so it drifts above the number of
              people actually sitting down. Labelling it "Players" presented a
              registration total as live seat truth. The seat truth lives in
              tournament_players and is what TournamentInfoPanel reads. */}
          <span className="sc-label sc-ink--blue">Entries</span>
          <span className={`${styles.value} sc-ink--silver`}>
            {tournament.registeredPlayers.toLocaleString()}
            {hasMaxPlayers ? `/${tournament.maxPlayers.toLocaleString()}` : ''}
          </span>
        </div>

        <div className={styles.row}>
          <span className="sc-label sc-ink--blue">Starting Chips</span>
          <span className={`${styles.value} sc-ink--silver`}>
            {tournament.startingChips ? compactChips(tournament.startingChips) : '-'}
          </span>
        </div>

        {tournament.gameType && (
          <div className={styles.row}>
            <span className="sc-label sc-ink--blue">Game</span>
            <span className={`${styles.value} sc-ink--silver`}>
              {(
                {
                  NLH: 'NLH',
                  FLH: 'FLH',
                  PLO4: 'PLO4',
                  PLO5: 'PLO5',
                  PLO6: 'PLO6',
                  PLO8: 'PLO8',
                  PLO_HILO: 'PLO Hi-Lo',
                  SHORT_DECK: 'Short Deck',
                  PINEAPPLE: 'Crazy Pineapple',
                  MIXED: 'Mixed',
                } as Record<string, string>
              )[tournament.gameType ?? ''] ?? tournament.gameType}
            </span>
          </div>
        )}

        <div className={styles.row}>
          <span className="sc-label sc-ink--blue">Structure</span>
          <span className={`${styles.value} sc-ink--silver`}>{tournament.blindStructure}</span>
        </div>

        {hasLateReg && (
          <div className={styles.row}>
            <span className="sc-label sc-ink--blue">Late Reg</span>
            <span
              className={`${styles.value} ${
                tournament.status === 'running' && !lateRegActive ? 'sc-ink--muted' : 'sc-ink--gold'
              }`}
            >
              {tournament.status === 'running'
                ? lateRegActive
                  ? lateRegCountdown || 'Open'
                  : 'Closed'
                : lateRegLevels > 0
                  ? `Through Lvl ${lateRegLevels}`
                  : `${lateRegMinutes} Min`}
            </span>
          </div>
        )}

        {tournament.startsAt && tournament.status === 'registering' && countdown && (
          <div className={styles.row}>
            <span className="sc-label sc-ink--blue">Starts In</span>
            <span
              className={`${styles.value} ${isCountdownCritical ? 'sc-ink--red' : 'sc-ink--silver'}`}
            >
              {countdown}
            </span>
          </div>
        )}

        <div className={styles.row}>
          <span className="sc-label sc-ink--blue">Seats</span>
          <span className={`${styles.value} sc-ink--silver`}>
            {hasMaxPlayers
              ? isFull
                ? 'Tournament Full'
                : `${spotsRemaining.toLocaleString()} Spots Remaining`
              : 'Open Entry'}
          </span>
        </div>
      </div>
    </SpadeConsole>
  );
}
export default memo(TournamentLobbyCardInner);
