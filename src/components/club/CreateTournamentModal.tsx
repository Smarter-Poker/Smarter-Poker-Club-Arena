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
import { digitsOnly, isWholeBuyIn, money, splitBuyIn } from '../../utils/buyIn';

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
  // WHOLE-DOLLAR BUY-INS (Dan 2026-08-20): `buyIn` is the TOTAL the player
  // pays, always a positive whole number. The 10% house fee is a cut OUT of
  // that total, never a surcharge on top of it, so the advertised price is the
  // number typed here and nothing downstream ever holds a decimal. Every money
  // field in this form is digits-only for the same reason.
  const [buyIn, setBuyIn] = useState('10');
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

  // ── The buy-in, split ──
  // total = what the player pays (the typed whole number)
  // fee   = the 10% house cut, rounded to a whole number
  // prize = total - fee, what reaches the prize pool. Also whole.
  const split = useMemo(() => splitBuyIn(Number(buyIn) || 0), [buyIn]);

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

      // ── WHOLE-NUMBER MONEY BACKSTOP (Dan 2026-08-20) ──
      // The inputs already strip anything that is not a digit, so this can only
      // fire on a pasted or programmatically-set value. It refuses rather than
      // silently rounding: a club owner has to know the price changed.
      const wholeFields: Array<[string, string, boolean]> = [
        ['Buy-in', buyIn, true],
        ['Guaranteed prize', guaranteedPrize, false],
        ...((isRebuy || isReentry) && rebuyCost.trim()
          ? ([[isRebuy ? 'Rebuy cost' : 'Re-entry cost', rebuyCost, true]] as Array<
              [string, string, boolean]
            >)
          : []),
        ...(addOnAvailable && addOnCost.trim()
          ? ([['Add-on cost', addOnCost, true]] as Array<[string, string, boolean]>)
          : []),
        ...(isBountyFormat
          ? ([['Bounty amount', bountyAmount, true]] as Array<[string, string, boolean]>)
          : []),
      ];
      for (const [label, raw, mustBePositive] of wholeFields) {
        const value = raw.trim();
        if (!mustBePositive && (value === '' || Number(value) === 0)) continue;
        if (!isWholeBuyIn(value)) {
          toast.error(`${label} must be a whole number of chips, with no decimals.`);
          setIsSubmitting(false);
          return;
        }
      }

      const parsedBuyIn = Math.round(Number(buyIn));
      // The 10% house fee is a CUT OF the buy-in, not a surcharge on top. Both
      // halves are whole numbers, and prize + fee is exactly what the player
      // pays. fn_create_tournament recomputes the identical split server-side.
      const parsedRake = splitBuyIn(parsedBuyIn).fee;

      // ── Bounty validation (defense-in-depth) ──
      if (isBountyFormat) {
        const ba = Math.round(Number(bountyAmount));
        if (!ba || ba <= 0) {
          toast.error('Bounty amount is required for bounty tournaments');
          setIsSubmitting(false);
          return;
        }
        // The bounty is funded out of the buy-in, so it can never exceed the
        // prize half of the split — otherwise the prize pool would go negative
        // and registration would reject every entrant with
        // 'misconfigured_bounty'.
        if (ba > splitBuyIn(parsedBuyIn).prize) {
          toast.error(
            `Bounty ${money(ba)} plus the ${money(parsedRake)} fee exceeds the ${money(parsedBuyIn)} buy-in. Lower the bounty or raise the buy-in.`
          );
          setIsSubmitting(false);
          return;
        }
        if (format === 'mystery_bounty') {
          const min = Math.round(Number(mysteryBountyMin));
          const max = Math.round(Number(mysteryBountyMax));
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
        rebuyCost: isRebuy || isReentry ? Math.round(Number(rebuyCost)) || parsedBuyIn : undefined,
        addOnAvailable,
        addOnChips: addOnAvailable ? parseInt(addOnChips) || parseInt(startingChips) : undefined,
        addOnCost: addOnAvailable ? Math.round(Number(addOnCost)) || parsedBuyIn : undefined,
        addOnLevels: addOnAvailable ? parseInt(addOnLevels) || 1 : undefined,
        guaranteedPrize: Math.max(0, Math.round(Number(guaranteedPrize)) || 0),
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
                baseBounty: Math.round(Number(bountyAmount)) || 5,
                ...(format === 'mystery_bounty'
                  ? (() => {
                      const minMult = Math.round(Number(mysteryBountyMin)) || 1;
                      const maxMult = Math.round(Number(mysteryBountyMax)) || 100;
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
    if (!isBountyFormat || split.total <= 0) return null;
    const bountyNum = Math.round(Number(bountyAmount)) || 0;
    // Every figure here is a whole number of chips: the split itself is whole,
    // and the bounty input is digits-only.
    return {
      buyIn: split.total,
      bounty: bountyNum,
      rake: split.fee,
      prize: split.prize - bountyNum,
    };
  })();

  const bountyValid = (() => {
    if (!isBountyFormat) return true;
    if (!isWholeBuyIn(bountyAmount)) return false;
    // The split must leave a non-negative prize pool.
    if (bountySplit && bountySplit.prize < 0) return false;
    if (format === 'mystery_bounty') {
      const min = Math.round(Number(mysteryBountyMin));
      const max = Math.round(Number(mysteryBountyMax));
      if (!min || min <= 0 || !max || max <= 0 || max <= min) return false;
    }
    return true;
  })();

  const coreValid = (() => {
    if (!name.trim()) return false;
    // Whole numbers only — no decimal buy-ins on any tournament or SNG.
    if (!isWholeBuyIn(buyIn)) return false;
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
              <option value="PLO4">Pot-Limit Omaha (4-Card)</option>
              <option value="PLO5">Pot-Limit Omaha (5-Card)</option>
              <option value="PLO8">PLO Hi-Lo (8 Or Better)</option>
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
                  <span className={styles.helperText}>Spins Always Start With 3 Players</span>
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
                    <option value="standard">Standard (EV: 2.24X)</option>
                    <option value="hyper">Hyper (EV: 2.33X)</option>
                  </select>
                  <span className={styles.helperText}>
                    Hyper Spins Have Higher Variance Multipliers
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
                  <option value="turbo">Turbo (3M)</option>
                  <option value="regular">Regular (8M)</option>
                  <option value="deepStack">Deep Stack (15M)</option>
                </select>
              </div>
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.col}>
              <div className={styles.formGroup}>
                <label>
                  Buy-In <span style={{ color: '#ef4444' }}>*</span>
                </label>
                {/* WHOLE NUMBERS ONLY (Dan 2026-08-20). step/min/inputMode set
                    the browser and the mobile keypad, and digitsOnly stops a
                    decimal point being typed or pasted at all. */}
                <input
                  type="number"
                  className={styles.input}
                  value={buyIn}
                  onChange={(e) => setBuyIn(digitsOnly(e.target.value))}
                  min={1}
                  step={1}
                  inputMode="numeric"
                  style={!isWholeBuyIn(buyIn) ? { borderColor: '#ef4444' } : undefined}
                />
                <span className={styles.helperText}>
                  Whole Chips Only. This Is The Total The Player Pays.
                </span>
              </div>
            </div>
            <div className={styles.col}>
              <div className={styles.formGroup}>
                {/* RAKE-AUDIT 2026-07-24: fee is the HOUSE RULE 10% of buy-in,
                    auto-computed and read-only. It was a free-form field (any
                    value incl. 0), so the platform-wide 10% rule was only a
                    coincidence of defaults. fn_create_tournament recomputes the
                    same split server-of-record side.
                    2026-08-20: the fee is a CUT OUT OF the buy-in, rounded to a
                    whole number, so the player pays exactly the figure typed on
                    the left and never a decimal. */}
                <label>Fee (10% Of Buy-In)</label>
                <input
                  type="number"
                  className={styles.input}
                  value={split.fee}
                  readOnly
                  disabled
                  min={0}
                  step={1}
                />
                <span className={styles.helperText}>
                  {split.total > 0
                    ? `${money(split.total)} entry = ${money(split.prize)} to the prize pool + ${money(split.fee)} fee`
                    : 'Taken out of the buy-in, not added on top'}
                </span>
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
                  onChange={(e) => setGuaranteedPrize(digitsOnly(e.target.value))}
                  min={0}
                  step={1}
                  inputMode="numeric"
                />
                <span className={styles.helperText}>0 = No Guarantee</span>
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
                    <option value="">Select Target Tournament…</option>
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
                  <span className={styles.helperText}>Top N Finishers Win A Seat</span>
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
                    <option value="now">Start In 1 Min</option>
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
                      onChange={(e) => setBountyAmount(digitsOnly(e.target.value))}
                      min={1}
                      step={1}
                      inputMode="numeric"
                      required
                      style={!isWholeBuyIn(bountyAmount) ? { borderColor: '#ef4444' } : undefined}
                    />
                    <span className={styles.helperText}>Amount Awarded For Each Knockout</span>
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
                          onChange={(e) => setMysteryBountyMin(digitsOnly(e.target.value))}
                          min={1}
                          step={1}
                          inputMode="numeric"
                          required
                          style={
                            !isWholeBuyIn(mysteryBountyMin) ? { borderColor: '#ef4444' } : undefined
                          }
                        />
                        <span className={styles.helperText}>Lowest Multiplier (E.G. 1X)</span>
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
                          onChange={(e) => setMysteryBountyMax(digitsOnly(e.target.value))}
                          min={2}
                          step={1}
                          inputMode="numeric"
                          required
                          style={
                            Number(mysteryBountyMax) <= Number(mysteryBountyMin)
                              ? { borderColor: '#ef4444' }
                              : undefined
                          }
                        />
                        <span className={styles.helperText}>Highest Multiplier (E.G. 100X)</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
              {format === 'bounty' && (
                <span className={styles.helperText}>
                  Full Bounty Amount Is Awarded To The Knocker On Each Elimination
                </span>
              )}
              {format === 'progressive_bounty' && (
                <span className={styles.helperText}>
                  50% Of Bounty Goes To Knocker, 50% Added To Knocker's Own Bounty
                </span>
              )}
              {format === 'mystery_bounty' && (
                <span className={styles.helperText}>
                  Each Head Is Sealed At Registration From A Jackpot Ladder - 60% X0.5, 25% X1, 10%
                  X2, 4% X3, 1% X13 Of The Bounty Amount - And Revealed On Knockout. The Ladder
                  Averages Exactly 1X, So The Bounty Pool Always Funds The Heads.
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
                  <strong style={{ color: '#ffd700' }}>
                    Each {money(bountySplit.buyIn)} Entry Splits:
                  </strong>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 2 }}>
                    <span>
                      Bounty Pool <strong>{money(bountySplit.bounty)}</strong>
                    </span>
                    <span>
                      Rake <strong>{money(bountySplit.rake)}</strong>
                    </span>
                    <span style={{ color: bountySplit.prize < 0 ? '#ef4444' : undefined }}>
                      Prize Pool <strong>{money(bountySplit.prize)}</strong>
                    </span>
                  </div>
                  <span style={{ opacity: 0.65 }}>
                    Bounty And Prize Pools Are Tracked Separately; Unclaimed Bounty Money Goes To
                    The Champion.
                  </span>
                </div>
              )}
              {!bountyValid && (
                <p style={{ color: '#ef4444', fontSize: '0.75rem', marginTop: 6 }}>
                  {!isWholeBuyIn(bountyAmount)
                    ? 'Bounty amount is required and must be a whole number greater than 0'
                    : bountySplit && bountySplit.prize < 0
                      ? `Bounty ${money(bountySplit.bounty)} + ${money(bountySplit.rake)} rake exceeds the ${money(bountySplit.buyIn)} buy-in - nothing left for the prize pool`
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
                      Allow Rebuys (Same Seat)
                    </label>
                    {!isRebuy && (
                      <span className={styles.helperText}>
                        Select "MTT (Rebuy)" Format To Enable
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
                      Allow Re-Entry (New Seat)
                    </label>
                    {!isReentry && (
                      <span className={styles.helperText}>
                        Select "MTT (Re-Entry)" Format To Enable
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
                          onChange={(e) => setRebuyCost(digitsOnly(e.target.value))}
                          placeholder={buyIn}
                          min={1}
                          step={1}
                          inputMode="numeric"
                        />
                        <span className={styles.helperText}>Blank = Same As Buy-In</span>
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
                        <span className={styles.helperText}>Blank = Starting Stack</span>
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
                        onChange={(e) => setAddOnCost(digitsOnly(e.target.value))}
                        placeholder={buyIn}
                        min={1}
                        step={1}
                        inputMode="numeric"
                      />
                      <span className={styles.helperText}>Blank = Same As Buy-In</span>
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
                      <span className={styles.helperText}>Blank = Starting Stack</span>
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
                            {n} Level{n > 1 ? 's' : ''} After Rebuy Period
                          </option>
                        ))}
                      </select>
                      <span className={styles.helperText}>
                        Add-On Opens At Level {parseInt(lateRegLevels) || 0} Through Level{' '}
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
              Payout Structure ({payoutStructure.length} Places Paid)
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
              {!name.trim() && <p>Tournament Name Is Required</p>}
              {!isWholeBuyIn(buyIn) && <p>Buy-In Must Be A Whole Number Of Chips Greater Than 0</p>}
              {parseInt(startingChips) <= 0 && <p>Starting Chips Must Be Greater Than 0</p>}
              {startTimeMode === 'scheduled' && (!scheduledDate || !scheduledTime) && (
                <p>Scheduled Date And Time Are Required</p>
              )}
              {(isRebuy || isReentry) && parseInt(lateRegLevels) <= 0 && (
                <p>Late Reg Levels Must Be Set When Rebuys/Re-Entries Are Enabled</p>
              )}
              {!bountyValid && isBountyFormat && <p>Bounty Configuration Is Incomplete</p>}
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
