/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT LOBBY CARD — Tournament Registration Display
 * Shows tournament info with registration countdown and join button
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import styles from './TournamentLobbyCard.module.css';
import { reportError } from '../../utils/errorReporter';
// Whole-number tournament money (Dan 2026-08-20).
import { money } from '../../utils/buyIn';
import { useTournamentRegistration } from '../../hooks/useTournamentRegistration';

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
}

function TournamentLobbyCardInner({ tournament, onRegister }: TournamentLobbyCardProps) {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const [registering, setRegistering] = useState(false);
  const [isRegistered, setIsRegistered] = useState(false);
  const [countdown, setCountdown] = useState<string>('');
  const [lateRegCountdown, setLateRegCountdown] = useState<string>('');
  const [lateRegActive, setLateRegActive] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  useEffect(() => {
    checkRegistration();
    if (tournament.startsAt) {
      updateCountdown();
      const interval = setInterval(updateCountdown, 1000);
      return () => clearInterval(interval);
    }
  }, [tournament.id, tournament.startsAt]);

  useEffect(() => {
    const lateRegLevels = tournament.late_reg_levels || tournament.late_reg_mins || 0;
    if (tournament.status === 'running' && lateRegLevels > 0) {
      updateLateRegCountdown();
      const interval = setInterval(updateLateRegCountdown, 10000);
      return () => clearInterval(interval);
    }
  }, [
    tournament.status,
    tournament.late_reg_levels,
    tournament.late_reg_mins,
    tournament.current_level,
  ]);

  const checkRegistration = async () => {
    if (!user?.id) return;
    const { data, error } = await supabase
      .from('tournament_players')
      .select('id')
      .eq('tournament_id', tournament.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) reportError(error, 'TournamentLobbyCard.Registration_check_failed');
    setIsRegistered(!!data);
  };

  const updateCountdown = () => {
    if (!tournament.startsAt) return;
    const now = new Date().getTime();
    const start = new Date(tournament.startsAt).getTime();
    const diff = start - now;

    if (diff <= 0) {
      setCountdown('Starting now!');
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
    const lateRegLevels = tournament.late_reg_levels || tournament.late_reg_mins || 0;
    if (lateRegLevels <= 0) return;

    const currentLevel = tournament.current_level || 0;
    if (currentLevel >= lateRegLevels) {
      setLateRegCountdown('Late Reg Closed');
      setLateRegActive(false);
      return;
    }

    setLateRegActive(true);
    const levelsLeft = lateRegLevels - currentLevel;
    setLateRegCountdown(`${levelsLeft} lvl${levelsLeft !== 1 ? 's' : ''} left`);
  };

  const handleRegister = async () => {
    if (!user?.id || registering) return;
    setRegistering(true);

    try {
      // Use the onRegister prop to go through proper tournament service
      // (handles wallet deduction, validation, etc.)
      if (onRegister) {
        await onRegister(tournament.id);
      }
      setIsRegistered(true);
    } catch (error) {
      reportError(error, 'TournamentLobbyCard.Failed_to_register');
    }
    setRegistering(false);
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
        return '#f59e0b'; // Amber
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
      return { tier: 'Turbo', color: '#f97316' }; // orange
    } else if (blindDuration <= 10) {
      return null; // Regular - no badge needed
    } else {
      return { tier: 'Deep Stack', color: '#0ea5e9' }; // blue
    }
  };

  const isCountdownCritical = countdown && countdown.includes('m') && parseInt(countdown) < 5;

  const isFreezout = (tournament: Tournament): boolean => {
    return (
      !tournament.isRebuy &&
      !tournament.rebuyAllowed &&
      !tournament.addonAllowed &&
      !tournament.lateRegMins
    );
  };

  const hasMaxPlayers = tournament.maxPlayers > 0;
  const spotsRemaining = hasMaxPlayers
    ? tournament.maxPlayers - tournament.registeredPlayers
    : Infinity;
  const isFull = hasMaxPlayers && spotsRemaining <= 0;

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
      <h3 className={styles.title}>{tournament.name}</h3>

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
          <span className={styles.infoLabel}>Players</span>
          <span className={styles.infoValue}>
            {tournament.registeredPlayers}
            {hasMaxPlayers ? `/${tournament.maxPlayers}` : ''}
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
                  PINEAPPLE: 'Pineapple',
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
      {(tournament.late_reg_levels ||
        tournament.lateRegMins ||
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
          {tournament.status === 'running' &&
          (tournament.late_reg_levels || tournament.lateRegMins) &&
          (tournament.late_reg_levels || tournament.lateRegMins || 0) > 0 ? (
            <span
              className={`${styles.featureTag} ${styles.lateRegTag} ${!lateRegActive ? styles.lateRegClosed : ''} ${lateRegCountdown === 'Late Reg Closed' ? styles.criticalWarning : ''}`}
            >
              Late Reg: {lateRegActive ? lateRegCountdown : 'Closed'}
            </span>
          ) : (
            tournament.status === 'registering' &&
            (tournament.late_reg_levels || tournament.lateRegMins) &&
            (tournament.late_reg_levels || tournament.lateRegMins || 0) > 0 && (
              <span className={styles.featureTag}>
                Late Reg Through Lvl {tournament.late_reg_levels || tournament.lateRegMins}
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
            <div
              className={styles.progressFill}
              style={{ width: `${(tournament.registeredPlayers / tournament.maxPlayers) * 100}%` }}
            />
          </div>
          <span className={styles.spotsLabel}>
            {isFull ? 'Tournament Full' : `${spotsRemaining} spots remaining`}
          </span>
        </>
      ) : (
        <span className={styles.spotsLabel}>
          {tournament.registeredPlayers} Registered - Open Entry
        </span>
      )}

      {/* Action Button */}
      <div className={styles.actions}>
        {tournament.status === 'registering' &&
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
        {tournament.status === 'running' && isRegistered && (
          <button
            className={styles.playBtn}
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/tournaments/${tournament.id}`);
            }}
          >
            Open Tournament
          </button>
        )}
      </div>
    </div>
  );
}
export default memo(TournamentLobbyCardInner);
