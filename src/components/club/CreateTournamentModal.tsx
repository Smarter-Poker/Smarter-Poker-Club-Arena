import React, { useState, useMemo, useEffect } from 'react';
import {
  tournamentService,
  BLIND_STRUCTURES,
  PAYOUT_STRUCTURES,
  SPIN_MULTIPLIERS,
} from '../../services/TournamentService';
import styles from './CreateTournamentModal.module.css';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import { supabase } from '../../lib/supabase';
import { resolveClubUUID } from '../../utils/clubIdResolver';

interface Props {
  clubId: string;
  unionId?: string; // If provided, this is a XMTT (union-level tournament)
  onClose: () => void;
  onSuccess: () => void;
}

type TournamentFormat =
  | 'mtt_freezeout'
  | 'mtt_rebuy'
  | 'mtt_reentry'
  | 'sng'
  | 'bounty'
  | 'progressive_bounty'
  | 'mystery_bounty'
  | 'spin'
  | 'satellite'
  | 'xmtt';

export default function CreateTournamentModal({ clubId, unionId, onClose, onSuccess }: Props) {
  const toast = useToast();
  const [visibleSections, setVisibleSections] = useState<boolean[]>([]);

  useEffect(() => {
    setVisibleSections([]);
    [0, 1, 2, 3, 4, 5].forEach((i) => {
      setTimeout(() => {
        setVisibleSections((prev) => [...prev, true]);
      }, i * 90);
    });
  }, []);

  // ── Core Config ──
  const [name, setName] = useState('');
  const [format, setFormat] = useState<TournamentFormat>('mtt_freezeout');
  const [gameVariant, setGameVariant] = useState<'NLH' | 'PLO4' | 'PLO5' | 'PLO8' | 'SHORT_DECK'>(
    'NLH'
  );
  const [buyIn, setBuyIn] = useState('10');
  // RAKE-AUDIT 2026-07-24: fee auto-tracks 10% of buy-in (house rule)
  const [rake, setRake] = useState('1');
  const [startingChips, setStartingChips] = useState('1500');
  const [maxPlayers, setMaxPlayers] = useState('50');
  const [blindSpeed, setBlindSpeed] = useState<'turbo' | 'regular' | 'deepStack'>('turbo');
  const [guaranteedPrize, setGuaranteedPrize] = useState('0');

  // ── Satellite target (the tournament winners earn a seat into) ──
  const [satelliteTargetId, setSatelliteTargetId] = useState('');
  const [satelliteSeats, setSatelliteSeats] = useState('1');
  const [satelliteTargets, setSatelliteTargets] = useState<{ id: string; name: string }[]>([]);

  // ── Start Time ──
  const [startTimeMode, setStartTimeMode] = useState<'now' | 'scheduled'>('now');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');

  // ── Late Registration (level-based, per tournament) ──
  // Late reg and rebuy/re-entry ALWAYS share the same cutoff level
  const [lateRegLevels, setLateRegLevels] = useState('8');

  // ── Rebuy / Re-Entry / Add-On ──
  // Note: isRebuy/isReentry are managed via format selection, but kept for backward compat
  const isRebuy = format === 'mtt_rebuy';
  const isReentry = format === 'mtt_reentry';
  const [rebuyCost, setRebuyCost] = useState('');
  const [rebuyChips, setRebuyChips] = useState('');
  // rebuyLevels is derived from lateRegLevels (always the same cutoff)
  // Auto-enable add-on for rebuy/reentry formats
  const [addOnAvailable, setAddOnAvailable] = useState(isRebuy || isReentry);
  const [addOnCost, setAddOnCost] = useState('');
  const [addOnChips, setAddOnChips] = useState('');
  const [addOnLevels, setAddOnLevels] = useState('1');

  // ── Bounty Config ──
  const [bountyAmount, setBountyAmount] = useState('5');

  // ── Mystery Bounty Config ──
  const [mysteryBountyMin, setMysteryBountyMin] = useState('1');
  const [mysteryBountyMax, setMysteryBountyMax] = useState('100');

  // ── Spin Config ──
  const [spinType, setSpinType] = useState<'standard' | 'hyper'>('standard');

  // ── Multi-Day Config ──
  const [isMultiDay, setIsMultiDay] = useState(false);
  const [totalDays, setTotalDays] = useState('2');

  const [isSubmitting, setIsSubmitting] = useState(false);

  // ── Auto-select payout structure ──
  // SNG/Spin: based on max players. MTT/Bounty/PKO/Mystery: default MTT structure (no max player cap)
  const payoutStructure = useMemo(() => {
    if (format === 'spin') return [{ place: 1, percentage: 100 }];
    const mp = parseInt(maxPlayers) || 0;
    if (format === 'sng') {
      if (mp <= 6) return PAYOUT_STRUCTURES.sng6;
      return PAYOUT_STRUCTURES.sng9;
    }
    // MTT / Bounty / PKO / Mystery / Satellite / XMTT — no max player limit, use standard MTT payouts
    return PAYOUT_STRUCTURES.mtt50;
  }, [maxPlayers, format]);

  const isSngOrSpin = format === 'sng' || format === 'spin';
  const isSatellite = format === 'satellite';
  const isXmtt = format === 'xmtt';

  // Load candidate target tournaments (upcoming, non-satellite in this club) once
  // the satellite format is chosen, so the organiser can pick what seats feed into.
  useEffect(() => {
    if (!isSatellite) return;
    let alive = true;
    (async () => {
      try {
        const resolved = await resolveClubUUID(clubId);
        const { data } = await supabase
          .from('tournaments')
          .select('id, name, tournament_type, status, start_time')
          .eq('club_id', resolved)
          .neq('tournament_type', 'satellite')
          .in('status', ['registering', 'scheduled', 'upcoming', 'announced', 'pending', 'open'])
          .order('start_time', { ascending: true })
          .limit(50);
        if (alive) setSatelliteTargets((data || []).map((t: any) => ({ id: t.id, name: t.name })));
      } catch (e) {
        reportError(e, 'CreateTournamentModal.loadSatelliteTargets');
      }
    })();
    return () => {
      alive = false;
    };
  }, [isSatellite, clubId]);

  // ── Auto-set defaults when format changes ──
  const handleFormatChange = (f: TournamentFormat) => {
    setFormat(f);
    switch (f) {
      case 'sng':
        setMaxPlayers('6');
        setLateRegLevels('0');
        setStartTimeMode('now');
        setIsMultiDay(false);
        setAddOnAvailable(false);
        break;
      case 'spin':
        setMaxPlayers('3');
        setLateRegLevels('0');
        setStartTimeMode('now');
        setIsMultiDay(false);
        setAddOnAvailable(false);
        break;
      case 'mtt_rebuy':
      case 'mtt_reentry':
        setMaxPlayers('0');
        setLateRegLevels('8');
        setAddOnAvailable(true);
        break;
      case 'bounty':
      case 'progressive_bounty':
      case 'mystery_bounty':
        setMaxPlayers('0'); // Unlimited
        setLateRegLevels('10');
        setAddOnAvailable(false);
        break;
      case 'satellite':
        setMaxPlayers('0'); // Unlimited
        setLateRegLevels('8');
        setAddOnAvailable(false);
        break;
      case 'xmtt':
        setMaxPlayers('0'); // Unlimited (union-level)
        setLateRegLevels('8');
        setAddOnAvailable(false);
        setIsMultiDay(true); // XMTTs are typically multi-day
        break;
      case 'mtt_freezeout':
      default:
        setMaxPlayers('0'); // Unlimited
        setLateRegLevels('8');
        setAddOnAvailable(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      // ── Satellite validation: without a target it silently becomes a cash
      // payout, defeating the point (winners should earn seats). ──
      if (isSatellite && !satelliteTargetId) {
        toast.error('Pick the target tournament this satellite awards seats into.');
        setIsSubmitting(false);
        return;
      }

      // ── Bounty validation (defense-in-depth) ──
      if (isBountyFormat) {
        const ba = parseFloat(bountyAmount);
        if (!ba || ba <= 0) {
          toast.error('Bounty amount is required for bounty tournaments');
          setIsSubmitting(false);
          return;
        }
        // The bounty is funded out of the buy-in, so bounty + 10% rake can
        // never exceed it — otherwise the prize pool would go negative and
        // registration would reject every entrant with 'misconfigured_bounty'.
        {
          const bi = parseFloat(buyIn) || 0;
          const rk = Math.round(bi * 0.1 * 100) / 100;
          if (ba + rk > bi) {
            toast.error(
              `Bounty ${ba} + ${rk} rake exceeds the ${bi} buy-in. Lower the bounty or raise the buy-in.`
            );
            setIsSubmitting(false);
            return;
          }
        }
        if (format === 'mystery_bounty') {
          const min = parseFloat(mysteryBountyMin);
          const max = parseFloat(mysteryBountyMax);
          if (!min || min <= 0 || !max || max <= 0) {
            toast.error('Mystery bounty min and max multipliers are required');
            setIsSubmitting(false);
            return;
          }
          if (max <= min) {
            toast.error('Mystery bounty max multiplier must be greater than min');
            setIsSubmitting(false);
            return;
          }
        }
      }

      const parsedBuyIn = parseFloat(buyIn);
      // RAKE-AUDIT 2026-07-24: fee is ALWAYS 10% of buy-in (house rule) —
      // computed at submit so a stale field value can never leak through.
      const parsedRake = Math.round((parsedBuyIn || 0) * 0.1 * 100) / 100;
      void rake;

      // Build start time
      let startTime: Date | undefined;
      if (startTimeMode === 'scheduled' && scheduledDate && scheduledTime) {
        startTime = new Date(`${scheduledDate}T${scheduledTime}`);
      } else {
        // Start 1 minute from now to allow last-second registrations
        startTime = new Date(Date.now() + 60 * 1000);
      }

      // Map new format types to internal service format
      const serviceFormat = format
        .replace('mtt_freezeout', 'mtt')
        .replace('mtt_rebuy', 'mtt')
        .replace('mtt_reentry', 'mtt')
        .replace('progressive_bounty', 'progressive_bounty')
        .replace('mystery_bounty', 'mystery_bounty')
        .replace('satellite', 'satellite')
        .replace('xmtt', 'mtt');

      await tournamentService.createTournament(clubId, {
        name,
        type: serviceFormat as import('../../services/TournamentService').TournamentType,
        gameVariant,
        buyIn: parsedBuyIn,
        rake: parsedRake,
        startingStack: parseInt(startingChips),
        maxPlayers: isSngOrSpin ? parseInt(maxPlayers) : 0, // 0 = unlimited for MTT/Bounty/PKO/Mystery/Satellite
        minPlayers: 3,
        blindStructure: BLIND_STRUCTURES[blindSpeed],
        payoutStructure,
        lateRegistrationLevels: parseInt(lateRegLevels) || 0,
        startTime,
        isRebuy,
        isReentry,
        // Rebuy/re-entry cutoff = late reg cutoff (always the same)
        rebuyLevels: isRebuy || isReentry ? parseInt(lateRegLevels) || 8 : undefined,
        rebuyChips:
          isRebuy || isReentry ? parseInt(rebuyChips) || parseInt(startingChips) : undefined,
        rebuyCost: isRebuy || isReentry ? parseFloat(rebuyCost) || parsedBuyIn : undefined,
        addOnAvailable,
        addOnChips: addOnAvailable ? parseInt(addOnChips) || parseInt(startingChips) : undefined,
        addOnCost: addOnAvailable ? parseFloat(addOnCost) || parsedBuyIn : undefined,
        addOnLevels: addOnAvailable ? parseInt(addOnLevels) || 1 : undefined,
        guaranteedPrize: parseFloat(guaranteedPrize) || 0,
        satelliteTarget:
          isSatellite && satelliteTargetId
            ? {
                tournamentId: satelliteTargetId,
                seatsAwarded: Math.max(1, parseInt(satelliteSeats) || 1),
              }
            : undefined,
        isMultiDay,
        totalDays: isMultiDay ? parseInt(totalDays) || 2 : undefined,
        isXmtt: !!unionId,
        unionId: unionId || undefined,
        bountyConfig:
          format === 'bounty' || format === 'progressive_bounty' || format === 'mystery_bounty'
            ? {
                bountyType:
                  format === 'bounty'
                    ? 'fixed'
                    : format === 'progressive_bounty'
                      ? 'progressive'
                      : 'mystery',
                baseBounty: parseFloat(bountyAmount) || 5,
                ...(format === 'mystery_bounty'
                  ? (() => {
                      const minMult = parseFloat(mysteryBountyMin) || 1;
                      const maxMult = parseFloat(mysteryBountyMax) || 100;
                      // Generate tiers from min to max with probability distribution
                      // Bottom tier (most common), middle tiers, top tier (rarest)
                      const tiers: Array<{
                        minMultiplier: number;
                        maxMultiplier: number;
                        probability: number;
                      }> = [];
                      tiers.push({
                        minMultiplier: minMult,
                        maxMultiplier: minMult,
                        probability: 60,
                      });
                      if (maxMult >= minMult * 2) {
                        tiers.push({
                          minMultiplier: minMult * 2,
                          maxMultiplier: minMult * 2,
                          probability: 25,
                        });
                      }
                      if (maxMult >= minMult * 5) {
                        tiers.push({
                          minMultiplier: minMult * 5,
                          maxMultiplier: minMult * 5,
                          probability: 10,
                        });
                      }
                      if (maxMult >= minMult * 10) {
                        tiers.push({
                          minMultiplier: minMult * 10,
                          maxMultiplier: minMult * 10,
                          probability: 4,
                        });
                      }
                      if (maxMult >= minMult * 50) {
                        tiers.push({
                          minMultiplier: Math.min(minMult * 50, maxMult),
                          maxMultiplier: Math.min(minMult * 50, maxMult),
                          probability: 0.9,
                        });
                      }
                      tiers.push({
                        minMultiplier: maxMult,
                        maxMultiplier: maxMult,
                        probability: 0.1,
                      });
                      return { mysteryTiers: tiers };
                    })()
                  : {}),
              }
            : undefined,
        spinType: format === 'spin' ? spinType : undefined,
        spinConfig:
          format === 'spin'
            ? {
                possibleMultipliers: SPIN_MULTIPLIERS[spinType] || SPIN_MULTIPLIERS.standard,
              }
            : undefined,
      });
      toast.success('Tournament created');
      onSuccess();
    } catch (error: any) {
      reportError(error, 'CreateTournamentModal.Failed_to_create_tournament');
      toast.error(error?.message || 'Failed to create tournament');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isBountyFormat =
    format === 'bounty' || format === 'progressive_bounty' || format === 'mystery_bounty';

  // ── Validation: ALL fields required before tournament can be created ──
  // DAN'S SPEC 2026-08-15: a bounty event's buy-in is the player's ALL-IN entry
  // cost and splits three ways at registration —
  //   rake (10%) + bounty pool (bounty x entrants) + prize pool (remainder).
  // "A $50 bounty tournament with a $25 bounty: $25 to the bounty pool, $5
  //  rake, $20 into the prize pool."
  // The bounty is therefore FUNDED, not minted, which means the owner cannot
  // configure a bounty that leaves nothing for the prize pool. Compute the
  // split here so the form can both block it and show the owner the breakdown.
  const bountySplit = (() => {
    const buyInNum = parseFloat(buyIn);
    if (!isBountyFormat || !buyInNum || buyInNum <= 0) return null;
    const bountyNum = parseFloat(bountyAmount) || 0;
    const rakeNum = Math.round(buyInNum * 0.1 * 100) / 100;
    const prizeNum = Math.round((buyInNum - rakeNum - bountyNum) * 100) / 100;
    return { buyIn: buyInNum, bounty: bountyNum, rake: rakeNum, prize: prizeNum };
  })();

  const bountyValid = (() => {
    if (!isBountyFormat) return true;
    const ba = parseFloat(bountyAmount);
    if (!ba || ba <= 0) return false;
    // The split must leave a non-negative prize pool.
    if (bountySplit && bountySplit.prize < 0) return false;
    if (format === 'mystery_bounty') {
      const min = parseFloat(mysteryBountyMin);
      const max = parseFloat(mysteryBountyMax);
      if (!min || min <= 0 || !max || max <= 0 || max <= min) return false;
    }
    return true;
  })();

  const coreValid = (() => {
    if (!name.trim()) return false;
    if (isNaN(parseFloat(buyIn)) || parseFloat(buyIn) <= 0) return false;
    if (isNaN(parseInt(startingChips)) || parseInt(startingChips) <= 0) return false;
    // Max players only required for SNG and Spin (they need a fixed table size)
    if (isSngOrSpin && parseInt(maxPlayers) < 2) return false;
    // Scheduled tournament must have date+time
    if (startTimeMode === 'scheduled' && (!scheduledDate || !scheduledTime)) return false;
    // Late reg levels must be valid if set
    if ((isRebuy || isReentry) && parseInt(lateRegLevels) <= 0) return false;
    return true;
  })();

  const canSubmit = coreValid && bountyValid && !isSubmitting;

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>{unionId ? 'Create Union Tournament (XMTT)' : 'Create Tournament'}</h2>
          <button className={styles.closeParams} onClick={onClose}>
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className={styles.formGroup}>
            <label>
              Tournament Name <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Saturday Night Turbo"
              required
              style={!name.trim() ? { borderColor: '#ef4444' } : undefined}
            />
          </div>

          {/* Format Selection */}
          <div className={styles.formGroup}>
            <label>
              Format <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <select
              className={styles.select}
              value={format}
              onChange={(e) => handleFormatChange(e.target.value as TournamentFormat)}
            >
              <optgroup label="Multi-Table Tournaments">
                <option value="mtt_freezeout">MTT (Freezeout)</option>
                <option value="mtt_rebuy">MTT (Rebuy)</option>
                <option value="mtt_reentry">MTT (Re-Entry)</option>
              </optgroup>
              <optgroup label="Heads Up">
                <option value="sng">Heads Up</option>
                <option value="spin">Spin & Go</option>
              </optgroup>
              <optgroup label="Bounty Tournaments">
                <option value="bounty">Bounty (KO)</option>
                <option value="progressive_bounty">Progressive KO (PKO)</option>
                <option value="mystery_bounty">Mystery Bounty</option>
              </optgroup>
              <optgroup label="Special Tournaments">
                <option value="satellite">Satellite</option>
                {unionId && <option value="xmtt">Union MTT (XMTT)</option>}
              </optgroup>
            </select>
          </div>

          {/* Game Variant Selection */}
          <div className={styles.formGroup}>
            <label>
              Game <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <select
              className={styles.select}
              value={gameVariant}
              onChange={(e) => setGameVariant(e.target.value as any)}
            >
              <option value="NLH">No-Limit Hold'em</option>
              <option value="PLO4">Pot-Limit Omaha (4-card)</option>
              <option value="PLO5">Pot-Limit Omaha (5-card)</option>
              <option value="PLO8">PLO Hi-Lo (8 or Better)</option>
              <option value="SHORT_DECK">Short Deck Hold'em</option>
            </select>
          </div>

          <div className={styles.row}>
            {/* Max Players — ONLY for SNG and Spin (they need a fixed table size to start) */}
            {format === 'spin' && (
              <div className={styles.col}>
                <div className={styles.formGroup}>
                  <label>Players</label>
                  <input
                    type="text"
                    className={styles.input}
                    value="3 Players (Fixed)"
                    disabled
                    style={{ opacity: 0.7 }}
                  />
                  <span className={styles.helperText}>Spins always start with 3 players</span>
                </div>
              </div>
            )}
            {format === 'spin' && (
              <div className={styles.col}>
                <div className={styles.formGroup}>
                  <label>Spin Type</label>
                  <select
                    className={styles.select}
                    value={spinType}
                    onChange={(e) => setSpinType(e.target.value as 'standard' | 'hyper')}
                  >
                    <option value="standard">Standard (EV: 2.24x)</option>
                    <option value="hyper">Hyper (EV: 2.33x)</option>
                  </select>
                  <span className={styles.helperText}>
                    Hyper spins have higher variance multipliers
                  </span>
                </div>
              </div>
            )}
            {format === 'sng' && (
              <div className={styles.col}>
                <div className={styles.formGroup}>
                  <label>
                    Max Players <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <select
                    className={styles.select}
                    value={maxPlayers}
                    onChange={(e) => setMaxPlayers(e.target.value)}
                  >
                    <option value="2">Heads Up (2)</option>
                    <option value="3">3 Players</option>
                    <option value="6">6-Max</option>
                    <option value="9">Full Ring (9)</option>
                  </select>
                </div>
              </div>
            )}
            <div className={styles.col}>
              <div className={styles.formGroup}>
                <label>
                  Speed <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <select
                  className={styles.select}
                  value={blindSpeed}
                  onChange={(e) => setBlindSpeed(e.target.value as any)}
                >
                  <option value="turbo">Turbo (3m)</option>
                  <option value="regular">Regular (8m)</option>
                  <option value="deepStack">Deep Stack (15m)</option>
                </select>
              </div>
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.col}>
              <div className={styles.formGroup}>
                <label>
                  Buy-in <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="number"
                  className={styles.input}
                  value={buyIn}
                  onChange={(e) => {
                    setBuyIn(e.target.value);
                    // RAKE-AUDIT 2026-07-24: fee auto-tracks 10% of buy-in
                    const b = parseFloat(e.target.value);
                    setRake(
                      Number.isFinite(b) && b > 0
                        ? (Math.round(b * 0.1 * 100) / 100).toString()
                        : '0'
                    );
                  }}
                  min="0"
                  step="0.01"
                />
              </div>
            </div>
            <div className={styles.col}>
              <div className={styles.formGroup}>
                {/* RAKE-AUDIT 2026-07-24: fee is the HOUSE RULE 10% of buy-in,
                    auto-computed and read-only. It was a free-form field (any
                    value incl. 0), so the platform-wide 10% rule was only a
                    coincidence of defaults. TournamentService.createTournament
                    also enforces 10% server-of-record side. */}
                <label>Fee (10% of buy-in)</label>
                <input
                  type="number"
                  className={styles.input}
                  value={rake}
                  readOnly
                  disabled
                  min="0"
                  step="0.01"
                />
              </div>
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.col}>
              <div className={styles.formGroup}>
                <label>
                  Starting Chips <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="number"
                  className={styles.input}
                  value={startingChips}
                  onChange={(e) => setStartingChips(e.target.value)}
                />
              </div>
            </div>
            <div className={styles.col}>
              <div className={styles.formGroup}>
                <label>Guaranteed Prize</label>
                <input
                  type="number"
                  className={styles.input}
                  value={guaranteedPrize}
                  onChange={(e) => setGuaranteedPrize(e.target.value)}
                  min="0"
                  step="0.01"
                />
                <span className={styles.helperText}>0 = no guarantee</span>
              </div>
            </div>
          </div>

          {/* ── Satellite Target ── */}
          {isSatellite && (
            <div className={styles.row}>
              <div className={styles.col}>
                <div className={styles.formGroup}>
                  <label>Awards Seats Into</label>
                  <select
                    className={styles.select}
                    value={satelliteTargetId}
                    onChange={(e) => setSatelliteTargetId(e.target.value)}
                  >
                    <option value="">Select target tournament…</option>
                    {satelliteTargets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <span className={styles.helperText}>
                    {satelliteTargets.length === 0
                      ? 'No upcoming tournaments to feed into - create one first.'
                      : 'Winners earn a seat into this tournament.'}
                  </span>
                </div>
              </div>
              <div className={styles.col}>
                <div className={styles.formGroup}>
                  <label>Seats Awarded</label>
                  <input
                    type="number"
                    className={styles.input}
                    value={satelliteSeats}
                    onChange={(e) => setSatelliteSeats(e.target.value)}
                    min="1"
                    step="1"
                  />
                  <span className={styles.helperText}>Top N finishers win a seat</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Start Time ── */}
          {format !== 'sng' && format !== 'spin' && !isSatellite && (
            <div className={styles.formGroup}>
              <label>Start Time</label>
              <div className={styles.row}>
                <div className={styles.col}>
                  <select
                    className={styles.select}
                    value={startTimeMode}
                    onChange={(e) => setStartTimeMode(e.target.value as any)}
                  >
                    <option value="now">Start in 1 min</option>
                    <option value="scheduled">Schedule</option>
                  </select>
                </div>
                {startTimeMode === 'scheduled' && (
                  <>
                    <div className={styles.col}>
                      <input
                        type="date"
                        className={styles.input}
                        value={scheduledDate}
                        onChange={(e) => setScheduledDate(e.target.value)}
                      />
                    </div>
                    <div className={styles.col}>
                      <input
                        type="time"
                        className={styles.input}
                        value={scheduledTime}
                        onChange={(e) => setScheduledTime(e.target.value)}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── Late Registration & Rebuy/Re-Entry Period (level-based) ── */}
          {format !== 'spin' && (
            <div className={styles.sectionDivider}>
              <span className={styles.sectionLabel}>Late Registration / Rebuy Period</span>
              <div className={styles.row}>
                <div className={styles.col}>
                  <div className={styles.formGroup}>
                    <label>Late Reg Cutoff (Levels)</label>
                    <select
                      className={styles.select}
                      value={lateRegLevels}
                      onChange={(e) => setLateRegLevels(e.target.value)}
                    >
                      <option value="0">No Late Registration</option>
                      {[...Array(20)].map((_, i) => (
                        <option key={i + 1} value={String(i + 1)}>
                          Through Level {i + 1}
                          {i + 1 >= 8 && i + 1 <= 12 ? ' (Recommended)' : ''}
                        </option>
                      ))}
                    </select>
                    <span className={styles.helperText}>
                      {parseInt(lateRegLevels) > 0
                        ? `Late reg, rebuys, and re-entries close after Level ${lateRegLevels}`
                        : 'No late registration - registration closes when tournament starts'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Bounty Config ── */}
          {isBountyFormat && (
            <div className={styles.sectionDivider}>
              <span className={styles.sectionLabel}>
                {format === 'bounty'
                  ? 'Bounty'
                  : format === 'progressive_bounty'
                    ? 'PKO'
                    : 'Mystery Bounty'}{' '}
                Settings
                <span style={{ color: '#ef4444', marginLeft: 4 }}>*</span>
              </span>
              <div className={styles.row}>
                <div className={styles.col}>
                  <div className={styles.formGroup}>
                    <label>
                      {format === 'mystery_bounty'
                        ? 'Base Bounty (chips)'
                        : 'Bounty Per KO (chips)'}{' '}
                      <span style={{ color: '#ef4444' }}>*</span>
                    </label>
                    <input
                      type="number"
                      className={styles.input}
                      value={bountyAmount}
                      onChange={(e) => setBountyAmount(e.target.value)}
                      min="0.01"
                      step="0.01"
                      required
                      style={
                        !bountyAmount || parseFloat(bountyAmount) <= 0
                          ? { borderColor: '#ef4444' }
                          : undefined
                      }
                    />
                    <span className={styles.helperText}>Amount awarded for each knockout</span>
                  </div>
                </div>
                {format === 'mystery_bounty' && (
                  <>
                    <div className={styles.col}>
                      <div className={styles.formGroup}>
                        <label>
                          Min Multiplier <span style={{ color: '#ef4444' }}>*</span>
                        </label>
                        <input
                          type="number"
                          className={styles.input}
                          value={mysteryBountyMin}
                          onChange={(e) => setMysteryBountyMin(e.target.value)}
                          min="1"
                          step="1"
                          required
                          style={
                            !mysteryBountyMin || parseFloat(mysteryBountyMin) <= 0
                              ? { borderColor: '#ef4444' }
                              : undefined
                          }
                        />
                        <span className={styles.helperText}>Lowest multiplier (e.g. 1x)</span>
                      </div>
                    </div>
                    <div className={styles.col}>
                      <div className={styles.formGroup}>
                        <label>
                          Max Multiplier <span style={{ color: '#ef4444' }}>*</span>
                        </label>
                        <input
                          type="number"
                          className={styles.input}
                          value={mysteryBountyMax}
                          onChange={(e) => setMysteryBountyMax(e.target.value)}
                          min="2"
                          step="1"
                          required
                          style={
                            parseFloat(mysteryBountyMax) <= parseFloat(mysteryBountyMin)
                              ? { borderColor: '#ef4444' }
                              : undefined
                          }
                        />
                        <span className={styles.helperText}>Highest multiplier (e.g. 100x)</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
              {format === 'bounty' && (
                <span className={styles.helperText}>
                  Full bounty amount is awarded to the knocker on each elimination
                </span>
              )}
              {format === 'progressive_bounty' && (
                <span className={styles.helperText}>
                  50% of bounty goes to knocker, 50% added to knocker's own bounty
                </span>
              )}
              {format === 'mystery_bounty' && (
                <span className={styles.helperText}>
                  Each head is sealed at registration from a jackpot ladder - 60% x0.5, 25% x1,
                  10% x2, 4% x3, 1% x13 of the bounty amount - and revealed on knockout. The
                  ladder averages exactly 1x, so the bounty pool always funds the heads.
                </span>
              )}
              {bountySplit && (
                <div
                  style={{
                    marginTop: 8,
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    fontSize: '0.75rem',
                    lineHeight: 1.6,
                  }}
                >
                  <strong style={{ color: '#ffd700' }}>Each {bountySplit.buyIn} entry splits:</strong>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 2 }}>
                    <span>
                      Bounty pool <strong>{bountySplit.bounty}</strong>
                    </span>
                    <span>
                      Rake <strong>{bountySplit.rake}</strong>
                    </span>
                    <span
                      style={{ color: bountySplit.prize < 0 ? '#ef4444' : undefined }}
                    >
                      Prize pool <strong>{bountySplit.prize}</strong>
                    </span>
                  </div>
                  <span style={{ opacity: 0.65 }}>
                    Bounty and prize pools are tracked separately; unclaimed bounty money goes to
                    the champion.
                  </span>
                </div>
              )}
              {!bountyValid && (
                <p style={{ color: '#ef4444', fontSize: '0.75rem', marginTop: 6 }}>
                  {!bountyAmount || parseFloat(bountyAmount) <= 0
                    ? 'Bounty amount is required and must be greater than 0'
                    : bountySplit && bountySplit.prize < 0
                      ? `Bounty ${bountySplit.bounty} + ${bountySplit.rake} rake exceeds the ${bountySplit.buyIn} buy-in - nothing left for the prize pool`
                      : 'Mystery max multiplier must be greater than min multiplier'}
                </p>
              )}
            </div>
          )}

          {/* ── Rebuy / Re-Entry / Add-On ── */}
          {format !== 'spin' && (
            <div className={styles.sectionDivider}>
              <span className={styles.sectionLabel}>Rebuy / Re-Entry / Add-On</span>
              <div className={styles.row}>
                <div className={styles.col}>
                  <div className={styles.formGroup}>
                    <label className={styles.toggleLabel}>
                      <input
                        type="checkbox"
                        checked={isRebuy}
                        disabled
                        className={styles.checkbox}
                      />
                      Allow Rebuys (same seat)
                    </label>
                    {!isRebuy && (
                      <span className={styles.helperText}>
                        Select "MTT (Rebuy)" format to enable
                      </span>
                    )}
                  </div>
                </div>
                <div className={styles.col}>
                  <div className={styles.formGroup}>
                    <label className={styles.toggleLabel}>
                      <input
                        type="checkbox"
                        checked={isReentry}
                        disabled
                        className={styles.checkbox}
                      />
                      Allow Re-Entry (new seat)
                    </label>
                    {!isReentry && (
                      <span className={styles.helperText}>
                        Select "MTT (Re-Entry)" format to enable
                      </span>
                    )}
                  </div>
                </div>
                <div className={styles.col}>
                  <div className={styles.formGroup}>
                    <label className={styles.toggleLabel}>
                      <input
                        type="checkbox"
                        checked={addOnAvailable}
                        onChange={(e) => setAddOnAvailable(e.target.checked)}
                        className={styles.checkbox}
                      />
                      Allow Add-Ons
                    </label>
                  </div>
                </div>
              </div>

              {(isRebuy || isReentry) && (
                <>
                  <div className={styles.row}>
                    <div className={styles.col}>
                      <div className={styles.formGroup}>
                        <label>{isRebuy ? 'Rebuy' : 'Re-Entry'} Cost</label>
                        <input
                          type="number"
                          className={styles.input}
                          value={rebuyCost}
                          onChange={(e) => setRebuyCost(e.target.value)}
                          placeholder={buyIn}
                          min="0"
                          step="0.01"
                        />
                        <span className={styles.helperText}>Blank = same as buy-in</span>
                      </div>
                    </div>
                    <div className={styles.col}>
                      <div className={styles.formGroup}>
                        <label>{isRebuy ? 'Rebuy' : 'Re-Entry'} Chips</label>
                        <input
                          type="number"
                          className={styles.input}
                          value={rebuyChips}
                          onChange={(e) => setRebuyChips(e.target.value)}
                          placeholder={startingChips}
                        />
                        <span className={styles.helperText}>Blank = starting stack</span>
                      </div>
                    </div>
                  </div>
                  <span className={styles.helperText} style={{ display: 'block', marginTop: 4 }}>
                    {isRebuy && isReentry
                      ? `Rebuy (same seat) and Re-Entry (new seat) both close after Level ${lateRegLevels || 0}`
                      : isRebuy
                        ? `Rebuy period closes after Level ${lateRegLevels || 0} (same as late registration)`
                        : `Re-Entry period closes after Level ${lateRegLevels || 0} (same as late registration)`}
                  </span>
                </>
              )}

              {addOnAvailable && (
                <div className={styles.row} style={{ marginTop: 8 }}>
                  <div className={styles.col}>
                    <div className={styles.formGroup}>
                      <label>Add-On Cost</label>
                      <input
                        type="number"
                        className={styles.input}
                        value={addOnCost}
                        onChange={(e) => setAddOnCost(e.target.value)}
                        placeholder={buyIn}
                        min="0"
                        step="0.01"
                      />
                      <span className={styles.helperText}>Blank = same as buy-in</span>
                    </div>
                  </div>
                  <div className={styles.col}>
                    <div className={styles.formGroup}>
                      <label>Add-On Chips</label>
                      <input
                        type="number"
                        className={styles.input}
                        value={addOnChips}
                        onChange={(e) => setAddOnChips(e.target.value)}
                        placeholder={startingChips}
                      />
                      <span className={styles.helperText}>Blank = starting stack</span>
                    </div>
                  </div>
                  <div className={styles.col}>
                    <div className={styles.formGroup}>
                      <label>Add-On Levels</label>
                      <select
                        className={styles.select}
                        value={addOnLevels}
                        onChange={(e) => setAddOnLevels(e.target.value)}
                      >
                        {[1, 2, 3].map((n) => (
                          <option key={n} value={String(n)}>
                            {n} Level{n > 1 ? 's' : ''} after rebuy period
                          </option>
                        ))}
                      </select>
                      <span className={styles.helperText}>
                        Add-on opens at Level {parseInt(lateRegLevels) || 0} through Level{' '}
                        {(parseInt(lateRegLevels) || 0) + (parseInt(addOnLevels) || 1)}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Multi-Day Toggle ── */}
          {(format === 'mtt_freezeout' || format === 'mtt_rebuy' || format === 'mtt_reentry') && (
            <div className={styles.row}>
              <div className={styles.col}>
                <div className={styles.formGroup}>
                  <label className={styles.toggleLabel}>
                    <input
                      type="checkbox"
                      checked={isMultiDay}
                      onChange={(e) => setIsMultiDay(e.target.checked)}
                      className={styles.checkbox}
                    />
                    Multi-Day Tournament
                  </label>
                </div>
              </div>
              {isMultiDay && (
                <div className={styles.col}>
                  <div className={styles.formGroup}>
                    <label>Total Days</label>
                    <input
                      type="number"
                      className={styles.input}
                      value={totalDays}
                      onChange={(e) => setTotalDays(e.target.value)}
                      min="2"
                      max="7"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Payout Info ── */}
          <div className={styles.payoutPreview}>
            <span className={styles.sectionLabel}>
              Payout Structure ({payoutStructure.length} places paid)
            </span>
            <div className={styles.payoutList}>
              {payoutStructure.map((p, i) => (
                <span key={i} className={styles.payoutItem}>
                  {p.place}
                  {p.place === 1 ? 'st' : p.place === 2 ? 'nd' : p.place === 3 ? 'rd' : 'th'}:{' '}
                  {p.percentage}%
                </span>
              ))}
            </div>
          </div>

          {/* ── Validation Summary ── */}
          {!canSubmit && !isSubmitting && (
            <div style={{ color: '#ef4444', fontSize: '0.75rem', padding: '4px 0' }}>
              {!name.trim() && <p>Tournament name is required</p>}
              {(isNaN(parseFloat(buyIn)) || parseFloat(buyIn) <= 0) && (
                <p>Buy-in must be greater than 0</p>
              )}
              {parseInt(startingChips) <= 0 && <p>Starting chips must be greater than 0</p>}
              {startTimeMode === 'scheduled' && (!scheduledDate || !scheduledTime) && (
                <p>Scheduled date and time are required</p>
              )}
              {(isRebuy || isReentry) && parseInt(lateRegLevels) <= 0 && (
                <p>Late reg levels must be set when rebuys/re-entries are enabled</p>
              )}
              {!bountyValid && isBountyFormat && <p>Bounty configuration is incomplete</p>}
            </div>
          )}

          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={styles.createBtn} disabled={!canSubmit}>
              {isSubmitting ? 'Creating...' : 'Create Tournament'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
