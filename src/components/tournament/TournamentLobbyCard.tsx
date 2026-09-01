/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT LOBBY CARD — Tournament Registration Display
 * Shows tournament info with registration countdown and join button
 * ═══════════════════════════════════════════════════════════════════════════════
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
import { chipsCompact } from './details/types';

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
        return 'HEADS UP';
      case 'mtt':
        return 'MTT';
      case 'satellite':
        return 'Satellite';
      case 'spin':
        return 'SPIN & GO';
      case 'bounty':
        return 'BOUNTY';
      case 'pko':
        return 'PKO';
      case 'mystery':
        return 'MYSTERY';
      default:
        return type.toUpperCase();
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'registering':
        return '#10b981'; // Green
      case 'running':
        return '#0a5dc2'; // Amber
      case 'finished':
        return '#6b7280'; // Gray
      case 'cancelled':
        return '#ef4444'; // Red
      default:
        return '#6b7280';
    }
  };

  const getStatusLabel = (status: string): string => {
    switch (status) {
      case 'registering':
        return 'Registering';
      case 'running':
        return 'In Progress';
      case 'finished':
        return 'Completed';
      case 'cancelled':
        return 'Cancelled';
      default:
        return status;
    }
  };

  const getSpeedTier = (tournament: Tournament): { tier: string; color: string } | null => {
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

    if (blindDuration <= 3) {
      return { tier: 'Hyper', color: '#ef4444' }; // red
    } else if (blindDuration <= 5) {
      return { tier: 'Turbo', color: '#1877f2' }; // orange
    } else if (blindDuration <= 10) {
      return null; // Regular - no badge needed
    } else {
      return { tier: 'Deep Stack', color: '#0ea5e9' }; // blue
    }
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
  const fillPct = hasMaxPlayers
    ? Math.min(100, Math.max(0, (tournament.registeredPlayers / tournament.maxPlayers) * 100))
    : 0;

  return (
    <div
      className={`${styles.card} ${tournament.isPinned ? styles.pinnedCard : ''}`}
      onClick={() => navigate(`/tournaments/${tournament.id}`)}
      style={{
        cursor: 'pointer',
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      {/* Header */}
      <div className={styles.header}>
        {tournament.isPinned && <span className={styles.pinnedBadge}>PINNED</span>}
        {tournament.isNew && <span className={styles.newBadge}>NEW</span>}
        {tournament.isVipOnly && <span className={styles.vipBadge}>VIP</span>}
        {tournament.isAllInOrFold && <span className={styles.aofBadge}>AoF</span>}
        <span className={styles.type}>{getTypeLabel(tournament.type)}</span>
        <span className={styles.status} style={{ color: getStatusColor(tournament.status) }}>
          {getStatusLabel(tournament.status)}
        </span>
        {(() => {
          const speedTier = getSpeedTier(tournament);
          return speedTier ? (
            <span className={styles.speedBadge} style={{ backgroundColor: speedTier.color }}>
              {speedTier.tier}
            </span>
          ) : null;
        })()}
        {isFreezout(tournament) && <span className={styles.freezeoutTag}>Freezeout</span>}
      </div>

      {/* Title */}
      <h3 className={styles.title}>
        {tournament.guaranteedPrize && tournament.guaranteedPrize > 0
          ? `${chipsCompact(tournament.guaranteedPrize)} GTD `
          : ''}
        {formatGameTitle(tournament.name)}
      </h3>

      {/* Info Grid */}
      <div className={styles.info}>
        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Buy-In</span>
          {/* Whole chips only (Dan 2026-08-20) - never a decimal buy-in. */}
          <span className={styles.infoValue}>{money(tournament.buyIn)}</span>
        </div>
        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Prize Pool</span>
          <span className={styles.infoValue}>
            {(() => {
              const gtd = tournament.guaranteedPrize || 0;
              const displayPool =
                gtd > 0 ? Math.max(tournament.prizePool, gtd) : tournament.prizePool;
              return money(displayPool);
            })()}
            {tournament.guaranteedPrize && tournament.guaranteedPrize > 0 && (
              <span className={styles.gtdBadge}>GTD</span>
            )}
          </span>
        </div>
        <div className={styles.infoItem}>
          {/* ENTRIES, NOT PLAYERS (2026-08-25). This number comes from
              tournaments.current_players, which is a REGISTRATION counter: it
              is incremented on entry and is never decremented on an
              unregistration or an elimination, so it drifts above the number of
              people actually sitting down. Labelling it "Players" presented a
              registration total as live seat truth. The seat truth lives in
              tournament_players and is what TournamentInfoPanel reads. */}
          <span className={styles.infoLabel}>Entries</span>
          <span className={styles.infoValue}>
            {tournament.registeredPlayers.toLocaleString()}
            {hasMaxPlayers ? `/${tournament.maxPlayers.toLocaleString()}` : ''}
          </span>
        </div>
        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Starting Chips</span>
          <span className={styles.infoValue}>
            {tournament.startingChips ? tournament.startingChips.toLocaleString() : '-'}
          </span>
        </div>
        {tournament.gameType && (
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Game</span>
            <span className={styles.infoValue}>
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
        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Structure</span>
          <span className={styles.infoValue}>{tournament.blindStructure}</span>
        </div>
      </div>

      {/* Feature Tags */}
      {(hasLateReg ||
        tournament.isRebuy ||
        tournament.isBounty ||
        tournament.isPko ||
        tournament.isMysteryBounty ||
        tournament.isMultiDay) && (
        <div className={styles.featureTags}>
          {tournament.isBounty && !tournament.isPko && !tournament.isMysteryBounty && (
            <span className={`${styles.featureTag} ${styles.bountyTag}`}>
              Bounty {tournament.bountyAmount ? tournament.bountyAmount : ''}
            </span>
          )}
          {tournament.isPko && <span className={`${styles.featureTag} ${styles.pkoTag}`}>PKO</span>}
          {tournament.isMysteryBounty && (
            <span className={`${styles.featureTag} ${styles.mysteryTag}`}>Mystery Bounty</span>
          )}
          {tournament.isMultiDay && (
            <span className={`${styles.featureTag} ${styles.multiDayTag}`}>Multi-Day</span>
          )}
          {tournament.status === 'running' && hasLateReg ? (
            <span
              className={`${styles.featureTag} ${styles.lateRegTag} ${!lateRegActive ? styles.lateRegClosed : ''} ${!lateRegActive ? styles.criticalWarning : ''}`}
            >
              Late Reg: {lateRegActive ? lateRegCountdown || 'Open' : 'Closed'}
            </span>
          ) : (
            tournament.status === 'registering' &&
            hasLateReg && (
              <span className={styles.featureTag}>
                {lateRegLevels > 0
                  ? `Late Reg Through Lvl ${lateRegLevels}`
                  : `Late Reg ${lateRegMinutes} Min`}
              </span>
            )
          )}
          {tournament.isRebuy && <span className={styles.featureTag}>Rebuy</span>}
        </div>
      )}

      {/* Countdown */}
      {tournament.startsAt && tournament.status === 'registering' && (
        <div className={`${styles.countdown} ${isCountdownCritical ? styles.critical : ''}`}>
          <span className={styles.countdownLabel}>Starts In</span>
          <span className={styles.countdownValue}>{countdown}</span>
        </div>
      )}

      {/* Progress Bar — only show for capped tournaments (SNG/Spin) */}
      {hasMaxPlayers ? (
        <>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${fillPct}%` }} />
          </div>
          <span className={styles.spotsLabel}>
            {isFull ? 'Tournament Full' : `${spotsRemaining.toLocaleString()} Spots Remaining`}
          </span>
        </>
      ) : (
        <span className={styles.spotsLabel}>
          {tournament.registeredPlayers.toLocaleString()} Registered - Open Entry
        </span>
      )}

      {/* Action Button */}
      <div className={styles.actions}>
        {tournament.status === 'registering' && regCheckFailed ? (
          // We could not ask whether this player is already in. Offering
          // "Register" here risks a duplicate paid entry; offering "Registered"
          // risks hiding the only way in. Say what is actually true.
          <button className={styles.registerBtn} disabled>
            Entry Status Unavailable
          </button>
        ) : null}
        {tournament.status === 'registering' &&
          !regCheckFailed &&
          (isRegistered ? (
            <button
              className={styles.unregisterBtn}
              onClick={(e) => {
                e.stopPropagation();
                handleUnregister();
              }}
            >
              Registered - Unregister?
            </button>
          ) : (
            <button
              className={styles.registerBtn}
              onClick={(e) => {
                e.stopPropagation();
                handleRegister();
              }}
              disabled={registering || isFull}
            >
              {registering
                ? 'Registering...'
                : isFull
                  ? 'Tournament Full'
                  : `Register (${money(tournament.buyIn)})`}
            </button>
          ))}
        {/* Dan 2026-08-25 (binding): "when I click on a tournament that's
            RUNNING I should be able to click a button and watch."
            This branch was gated on `isRegistered`, so a running tournament you
            were not in rendered NO action at all — the card was a dead end for
            exactly the player who wants to watch. Everyone gets a button now;
            only its wording differs, because "open the tournament you are
            playing" and "watch someone else's" are different intents. Both land
            on the tournament screen, whose footer carries WATCH straight to the
            featured table. */}
        {tournament.status === 'running' && (
          <button
            className={styles.playBtn}
            onClick={(e) => {
              e.stopPropagation();
              /* 2026-08-25, second audit: both labels navigated to the
                 details page, so a button that says "Watch" dropped the player
                 on a screen where they still had to find the real WATCH
                 button. This card has only a tournament id — it cannot know
                 which table is featured without a query per card — so it hands
                 the intent along in the URL and the details page acts on it
                 the moment its featured table resolves. */
              navigate(
                isRegistered
                  ? `/tournaments/${tournament.id}`
                  : `/tournaments/${tournament.id}?watch=1`
              );
            }}
          >
            {isRegistered ? 'Open Tournament' : 'Watch'}
          </button>
        )}
      </div>
    </div>
  );
}
export default memo(TournamentLobbyCardInner);
