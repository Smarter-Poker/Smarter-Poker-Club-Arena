/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE DATA LEDGER (Phase 1 of the real-time build plan, Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "Horses need to make real time decisions on 500 different data points
 * in real time, and need to be able to know how to access this data, what
 * data they are supposed to be consuming, how to consume it, how to process
 * it and why to process it in nano seconds."
 *
 * This file is the contract. Every input the brain can touch is a row here
 * with four properties: SOURCE (where it comes from), CADENCE (when it is
 * refreshed into memory), CONSUMER (the function that reads it) and RECEIPT
 * (the telemetry that proves the read happened). A datum with a source and no
 * consumer is dead data; a consumer with no receipt is a layer nobody can
 * prove is running. HorseDataLedger.test.ts turns both into failing tests by
 * reading the engine source, and fn_audit_data_receipts turns the receipts
 * into daily findings by reading horse_brain_telemetry.
 *
 * "Compile, do not query": the engine reads memory (the game state it is
 * handed, HorseMind, the profile snapshot). Everything nightly is a compiler
 * that writes memory-shaped rows. No row here has cadence 'query' and none
 * ever will; a database read inside server/src/engine is a ledger violation.
 *
 * Pure data. No imports from the engine, so the sync service and the tests
 * can load it without the supabase client.
 */

export type LedgerKind =
  /** a HorseDecideOpts control read by decide() / decidePreflopV7; this also
   *  includes non-boolean offline evaluation selectors and evidence hooks */
  | 'flag'
  /** a StyleParams number the style + profile + persona resolve into */
  | 'param'
  /** a profiles.horse_profile key resolved by resolveHorseStyle */
  | 'profile'
  /** a HorseMind per-player counter */
  | 'mind'
  /** a HorseGameStateV2 field the engine hands the brain each decision */
  | 'state'
  /** a database table with a reader and a cadence (or a legacy one nobody reads) */
  | 'table'
  /** a telemetry key; `*` suffix = a family sharing a prefix */
  | 'receipt'
  /** a leak tag the review system emits, with the code that READS it
   *  (2026-09-05). A tag with consumer 'measurement' is counted and read by
   *  nobody, on purpose, and says why. The daily audit raises tag_unread for
   *  any tag that is neither. */
  | 'tag';

export type LedgerCadence =
  | 'per_action'
  | 'per_hand'
  | 'per_sit'
  | 'minute'
  | 'boot'
  | 'nightly'
  | 'legacy_unused';

export interface LedgerEntry {
  key: string;
  kind: LedgerKind;
  source: string;
  cadence: LedgerCadence;
  consumer: string;
  note: string;
  /** receipt entries: the fires this key is expected to be a fraction of */
  ratioOf?: string;
  /** receipt entries: fires(key) / fires(ratioOf) must be at least this on a
   *  normal fleet day (ratioOf fires >= 1000), else the audit raises
   *  data_unread. Omitted = the read depends on table mix (documented in
   *  note) and only a zero against a big denominator is reported. */
  minRatio?: number;
  /** table entries with a nightly cadence: the day column and how many days
   *  old the newest row may be before the audit raises data_stale */
  dayColumn?: string;
  freshnessDays?: number;
  /** the layer or date this datum first shipped */
  since: string;
}

const flag = (
  key: string,
  note: string,
  since: string,
  consumer = 'HorseLogic.decide'
): LedgerEntry => ({
  key,
  kind: 'flag',
  source: 'HorseDecideOpts (live worker snapshot; league ablation b-sides)',
  cadence: 'per_action',
  consumer,
  note,
  since,
});

const evaluationControl = (key: string, note: string): LedgerEntry => ({
  key,
  kind: 'flag',
  source:
    'Offline GtoV31CandidateEvaluation and HorseLeague only; excluded from live worker requests',
  cadence: 'per_action',
  consumer: 'HorseLogic.decide certified V31 candidate path',
  note,
  since: 'Phase4',
});

const receipt = (
  key: string,
  consumer: string,
  note: string,
  since: string,
  ratioOf?: string,
  minRatio?: number
): LedgerEntry => ({
  key,
  kind: 'receipt',
  source: 'horse_brain_telemetry (BrainTelemetry.noteFire, flushed per day)',
  cadence: 'per_action',
  consumer,
  note,
  since,
  ...(ratioOf ? { ratioOf } : {}),
  ...(minRatio != null ? { minRatio } : {}),
});

const mind = (key: string, note: string, consumer: string): LedgerEntry => ({
  key,
  kind: 'mind',
  source: 'HorseMind.OpponentStats (in-process; persisted to horse_mind_stats)',
  cadence: 'per_action',
  consumer,
  note,
  since: 'V3',
});

const state = (key: string, note: string, consumer = 'HorseLogic.decide'): LedgerEntry => ({
  key,
  kind: 'state',
  source: 'HorseGameStateV2 built by ServerTableEngineTurns.scheduleHorseAction',
  cadence: 'per_action',
  consumer,
  note,
  since: 'V2',
});

const table = (
  key: string,
  cadence: LedgerCadence,
  consumer: string,
  note: string,
  since: string,
  fresh?: { dayColumn: string; freshnessDays: number }
): LedgerEntry => ({
  key,
  kind: 'table',
  source: `public.${key}`,
  cadence,
  consumer,
  note,
  since,
  ...(fresh ?? {}),
});

/**
 * TAG CONSUMERS (2026-09-05). Dan: "there is absolutely no point to keep
 * upgrading and enhancing the logic of the horses if nothing reads the tags."
 * Every tag HorseHandReview.detectLeaks can emit is a row here with the code
 * that reads it. EveryTagHasAConsumer.law.test.ts reads the detector source
 * and fails on a tag with no row; the daily audit (fn_audit_tag_consumers)
 * reads this table and raises tag_unread on a tag with rows this week whose
 * consumer is 'measurement'. A measurement row must say why it is one.
 *
 * `_won` twins are the win side of the same detector (see the note over
 * `flag` in HorseHandReview); they are registered once, as the loss tag,
 * and the law test knows the twin rule.
 */
const tag = (key: string, consumer: string, note: string, since: string): LedgerEntry => ({
  key,
  kind: 'tag',
  source:
    'horse_hand_reviews.leak_tags (HorseHandReview.detectLeaks at settlement); horse_review_rollup.leak_counts nightly',
  cadence: 'per_hand',
  consumer,
  note,
  since,
});

/**
 * V49 (2026-09-05): a tag the SQL side emits, not the hand detector. The
 * frequency leaks are computed per horse per window from horse_daily_play by
 * fn_horse_frequency_leaks - no hand is read at all, because the leaks they
 * find (over-folding, never 3-betting, limping, passive postflop) never cost
 * 20bb in one pot and so cannot reach a hand tag. Registered here for the
 * same reason as every other tag: a name with no reader is the thing this
 * ledger exists to make impossible.
 */
const sqlTag = (key: string, consumer: string, note: string, since: string): LedgerEntry => ({
  key,
  kind: 'tag',
  source: 'fn_horse_frequency_leaks (SQL, per horse per 7-day window over horse_daily_play)',
  cadence: 'nightly',
  consumer,
  note,
  since,
});

export const TAG_CONSUMERS: LedgerEntry[] = [
  // Omaha stack-offs -> V40 pressure cap (PLO_STACKOFF_TAGS) + tuner dials
  tag(
    'nonnut_flush_stackoff',
    'HorseLogic.ploStackoffLoad / nlhStackoffLoad; HorseSelfTuner (stackoff gate)',
    'Omaha: cat-6 with two better flushes live; hold em: any better flush live',
    'V13'
  ),
  tag(
    'second_nut_flush_stackoff',
    'HorseLogic.ploStackoffLoad; HorseSelfTuner (stackoff gate)',
    'Omaha cat-6 with one better flush live',
    'V13'
  ),
  tag(
    'dominated_straight_stackoff',
    'HorseLogic.ploStackoffLoad; HorseSelfTuner (stackoff gate)',
    'Omaha non-nut straight at showdown',
    'V13'
  ),
  tag(
    'coldcall_stackoff',
    'HorseLogic.ploStackoffLoad / nlhStackoffLoad / tourneyStackoffLoad',
    'cold-called a raise, lost 40bb+',
    'V23'
  ),
  tag(
    'plo_naked_trips_stackoff',
    'HorseLogic.ploStackoffLoad / tourneyStackoffLoad',
    'trips on a paired board, no redraw, 100bb+',
    'V38'
  ),
  tag(
    'plo_toppair_no_redraw_stackoff',
    'HorseLogic.ploStackoffLoad / tourneyStackoffLoad',
    'top pair no redraw, 100bb+',
    'V38'
  ),
  // hold em stack-offs -> V41 heat into the V20 cap (NLH_STACKOFF_TAGS)
  tag(
    'top_pair_weak_kicker_stackoff',
    'HorseLogic.nlhStackoffLoad / tourneyStackoffLoad',
    'top pair, kicker nine or worse, 40bb+',
    'V24'
  ),
  tag(
    'weak_kicker_trips_stackoff',
    'HorseLogic.nlhStackoffLoad / tourneyStackoffLoad',
    'board trips, dominated kicker, 40bb+',
    'V24'
  ),
  tag(
    'straight_into_flush_stackoff',
    'HorseLogic.nlhStackoffLoad (hold em only; measurement-only in Omaha)',
    'straight on a three-flush board - since 2026-09-13 also flagged in Omaha, where it is recorded and reviewed but deliberately NOT in PLO_STACKOFF_TAGS',
    'V21'
  ),
  tag(
    'nonnut_straight_stackoff',
    'HorseLogic.nlhStackoffLoad',
    'non-nut straight at showdown',
    'V21'
  ),
  tag('underfull_stackoff', 'HorseLogic.nlhStackoffLoad', 'bottom boat', 'V21'),
  // river wars -> V41 respect + war gate (RIVER_WAR_TAGS)
  tag(
    'river_raise_war',
    'HorseLogic.riverWarLoad',
    'two or more aggressive river actions, lost',
    'V21'
  ),
  tag(
    'river_raise_paidoff',
    'HorseLogic.riverWarLoad',
    'bet the river, called a raise, lost',
    'V23'
  ),
  // limped pots -> V41 limped-pot cap (LIMP_BLOAT_TAGS)
  tag('limped_pot_bloat', 'HorseLogic.limpBloatLoad', 'entered for one blind, lost 40bb+', 'V23'),
  // preflop -> tuner tightness + V41 tournament premium
  tag(
    'preflop_stackoff',
    'HorseSelfTuner (preflop gate); HorseLogic.tourneyStackoffLoad',
    '40bb+ in with no postflop action',
    'V13'
  ),
  // fold family -> tuner bluff dial
  tag('big_bet_fold', 'HorseSelfTuner (big-bet-fold gate)', 'invested 20bb+ then folded', 'V13'),
  // measurement-only, with the reason
  tag(
    'big_fold_river',
    'measurement',
    'a river fold after a big investment: whether the fold was right is unknowable without the folded-to hand, so it steers nothing (the V23 split exists to keep it out of big_bet_fold)',
    'V23'
  ),
  tag(
    'big_fold_early',
    'measurement',
    'the early-street twin of big_fold_river; same reason',
    'V23'
  ),
  tag(
    'bet_fold_line',
    'measurement',
    'bet then folded the same street; a sizing/line study, no consumer yet',
    'V23'
  ),
  tag(
    'river_aggr_lost',
    'measurement',
    'ordinary value bets that ran into the top of the range; judged on EV with river_aggr_won by fn_audit_river_aggression_ev, not as a leak',
    'V13'
  ),
  tag(
    'river_aggr_won',
    'measurement',
    'the win side of river aggression (fn_audit_river_aggression_ev)',
    'V33'
  ),
  tag(
    'plo_underfull_stackoff',
    'measurement',
    'Omaha bottom boat, 100bb+; three baseline days then a V40 decision (2026-09-04 analysis)',
    'V40'
  ),
  tag(
    'plo_set_stackoff',
    'measurement',
    'split from plo_naked_trips on an unpaired board; measurement until the baseline says whether it belongs in the V40 loop',
    'V40'
  ),

  // ── V49 FREQUENCY LEAKS. Emitted by SQL over horse_daily_play, read by the
  // nightly audit (fn_audit_frequency_leaks) and by the panel card. The same
  // bands HorseSelfTuner.BENCH tunes the dials against, so the audit and the
  // tuner cannot disagree about what a leak is.
  sqlTag(
    'freq_too_loose',
    'fn_audit_frequency_leaks; HorseSelfTuner (vpip band)',
    'VPIP over 32% across 1,000+ cash hands',
    'V49'
  ),
  sqlTag(
    'freq_too_tight',
    'fn_audit_frequency_leaks; HorseSelfTuner (vpip band)',
    'VPIP under 19%',
    'V49'
  ),
  sqlTag(
    'freq_limp',
    'fn_audit_frequency_leaks; HorseSelfTuner (pfrOfVpip band)',
    'under 55% of voluntary entries were raises - the rest are limps and cold calls',
    'V49'
  ),
  sqlTag(
    'freq_no_3bet',
    'fn_audit_frequency_leaks',
    '3-bet under 3% of opportunities: a range nobody has to respect',
    'V49'
  ),
  sqlTag(
    'freq_over_fold_3bet',
    'fn_audit_frequency_leaks; HorseSelfTuner (foldTo3Bet band)',
    'folds over 62% of the time to a 3-bet',
    'V49'
  ),
  sqlTag(
    'freq_sticky_vs_3bet',
    'fn_audit_frequency_leaks; HorseSelfTuner (foldTo3Bet band)',
    'folds under 35% to a 3-bet',
    'V49'
  ),
  sqlTag(
    'freq_surrender_flops',
    'fn_audit_frequency_leaks; HorseSelfTuner (wwsf band)',
    'wins under 40% of the flops it sees',
    'V49'
  ),
  sqlTag(
    'freq_passive_postflop',
    'fn_audit_frequency_leaks; HorseSelfTuner (af band)',
    'postflop aggression factor under 1.2',
    'V49'
  ),
  sqlTag(
    'freq_spewy_postflop',
    'fn_audit_frequency_leaks; HorseSelfTuner (af band)',
    'postflop aggression factor over 3.5',
    'V49'
  ),
];

export const HORSE_DATA_LEDGER: LedgerEntry[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // HORSE DECISION CONTROLS. Boolean switches use off as the league b-side;
  // the two Phase 4 evaluation controls are offline-only and fail closed at
  // the live worker boundary.
  // ─────────────────────────────────────────────────────────────────────────
  flag(
    'decisionTimeMs',
    'turn-request epoch captured before worker FIFO wait; pins the hourly mood boundary',
    'V50',
    'HorseLogic.moodOf'
  ),
  flag('telemetry', 'live decisions only; arms noteFire for this decision', 'V15'),
  flag(
    'observeMind',
    'fast authoritative decisions capture opponent-memory effects; speculative deep replays read without observing twice',
    'V50'
  ),
  flag('mind', 'the whole opponent-intelligence layer (reads + writes)', 'V3'),
  flag('streetIQ', 'position/initiative/scare/texture reads', 'V4'),
  flag('handReading', 'street-by-street range narrowing from the full history', 'V5'),
  flag('v7', 'V7 master: barrels, size reads, counter-adaptation, adaptive MC, preflop', 'V7'),
  flag(
    'v7Preflop',
    'the V7 preflop engine (decidePreflopV7)',
    'V7',
    'HorsePreflop.decidePreflopV7'
  ),
  flag('v7Barrels', 'multi-street barrel plans', 'V7'),
  flag('v7SizeReads', 'bet-size-aware range narrowing', 'V7'),
  flag('v7CounterAdapt', 'recency blending against adapting opponents', 'V7'),
  flag('v7AdaptiveMC', 'Monte Carlo early exit when far from every threshold', 'V7'),
  flag('v8', 'V8 master: variant overlays, Omaha draws, hi-lo, NLH extras', 'V8'),
  flag('v8Draws', 'Omaha draw quality gating semi-bluffs', 'V8'),
  flag('v8HiLo', 'plo8 scoop/quarter decomposition', 'V8'),
  flag('v8Nlh', 'NLH-only bluff branches (scare-card check-raise, river blocker raise)', 'V8'),
  flag('v9', 'V9 master: sizing families, timing, mood', 'V9'),
  flag('v9Sizing', 'human size families for bets', 'V9'),
  flag('v9Timing', 'think-time distribution', 'V9'),
  flag('v9Mood', 'hourly mood gear-shift per horse', 'V9'),
  flag('v10', 'V10 master: c-bet read, SPR, rake, thin value, limp iso', 'V10'),
  flag('v10Cbet', 'range-advantage c-bet read', 'V10'),
  flag('v10Spr', 'SPR-aware raise bars', 'V10'),
  flag('v10Rake', 'rake drag on marginal pots (rakeDrag)', 'V10'),
  flag('v10ThinValue', 'capped-range thin value', 'V10'),
  flag('v10Iso', 'limp isolation', 'V10', 'HorsePreflop.decidePreflopV7'),
  flag('v11', 'V11: board domination discipline, initiative gate, no donk leads', 'V11'),
  flag('v12', 'V12 master: board-conditioned ranges, river polish', 'V12'),
  flag('v12Ranges', 'board-contact conditioning of sampled opponent hands', 'V12'),
  flag('v12River', 'OOP block bets, nut overbets, blocker catches', 'V12'),
  flag('v13', 'V13 position read (actsLastPostflop) and preflop chart depth', 'V13'),
  flag('v15', 'Omaha nut discipline: which flush/straight, caps, small ball', 'V15'),
  flag('v16Reads', 'deep reads: fold-to-c-bet, fold-to-3-bet, big-bet tells', 'V16'),
  flag('v16Icm', 'real ICM (Malmuth-Harville) in tournaments', 'V16'),
  flag('v16Hu', 'heads-up overlay', 'V16'),
  flag('v16Blockers', 'river unblocker bluffs', 'V16'),
  flag('v16SizeCond', 'big-bet-conditioned sampling', 'V16'),
  flag('v16PloPolar', 'PLO polarity read', 'V16'),
  flag(
    'v16Ratio',
    'DEFAULT OFF and DEAD BY PRECEDENCE since V38 (2026-09-03): both gates it rescales sit below the V38 call/fold return; league matchup retired 2026-09-05 after 0.00 +/- 0.00 over 12,000 hands',
    'V16'
  ),
  flag('v17Pos', 'players-behind bluff pressure', 'V17'),
  flag('v17RiverProbe', 'river probe into a capped field', 'V17'),
  flag('v17CatchBlock', 'call-side blocker on missed-flush rivers', 'V17'),
  flag('v17ShortDeck', 'short deck multiway tightening', 'V17'),
  flag('v18Straddle', 'straddle read as unopened', 'V18', 'HorsePreflop.decidePreflopV7'),
  flag('v18Squeeze', 'squeeze response', 'V18', 'HorsePreflop.decidePreflopV7'),
  flag('v18SelfImage', 'own image feeds bluff volume', 'V18'),
  flag('v18ExploitSize', 'station/nit-scaled river raise size', 'V18'),
  flag('v18Families', 'per-horse sizing-family personality', 'V18'),
  flag('v20Multiway', 'multiway pressure read and caps', 'V20'),
  flag('v20Mzone', 'tournament M-zone layer', 'V20'),
  flag('v21River', 'NLH nut status, dominated caps, raise-war governor', 'V21'),
  flag(
    'v21Deep',
    'deep-stack preflop discipline past 120bb',
    'V21',
    'HorsePreflop.decidePreflopV7'
  ),
  flag('v23Endgame', 'tournament endgame adjust (bounties, prizes)', 'V23'),
  flag('v23Plan', 'raise-response plans decided at bet time', 'V23'),
  flag('v23Reads', 'river reads', 'V23'),
  flag('v23Variants', 'plo8 low-only draws, short deck draw credit', 'V23'),
  flag('v23Spin', 'spin format overlay', 'V23'),
  flag('v24Bounty', 'PKO bounty pull', 'V24'),
  flag(
    'v24PloDefense',
    'PLO price defense against pot-sized preflop raises',
    'V24',
    'HorsePreflop.decidePreflopV7'
  ),
  flag('v25PloTourney', 'PLO tournament commitment law', 'V25', 'HorsePreflop.decidePreflopV7'),
  flag('v26Prizes', 'prize landscape scale (mystery chests)', 'V26'),
  flag('v27GtoCharts', 'NLH preflop solver charts', 'V27', 'HorsePreflop.decidePreflopV7'),
  flag('v29GtoFlop', 'NLH flop solver cells', 'V29'),
  flag('v30GtoTurnRiver', 'NLH turn/river solver cells', 'V30'),
  flag('v31GtoSuitAware', 'suit-aware solver lookups', 'V31'),
  evaluationControl(
    'gtoV31DatasetChecksum',
    'selects one exact sealed candidate checksum without changing the active live store'
  ),
  evaluationControl(
    'onGtoV31Decision',
    'captures decision-level source receipts for paired replay and league reconciliation'
  ),
  flag('v32FacingDefense', 'solver facing-bet defense', 'V32'),
  flag('v33DepthCeiling', 'solver depth ceiling (300bb)', 'V33'),
  flag('v37Satellite', 'satellite survival play', 'V37'),
  flag('v38Ev', 'the EV engine arbiter for solverless games and the MDF river', 'V38'),
  flag(
    'v40Omaha',
    'Omaha is not hold em: tiered sampler, pressure cap, small ball, tag loop',
    'V40'
  ),
  flag(
    'deepEquity',
    'V44 second look: every Monte Carlo read at this multiple of its sample; set only by the engine replay inside the think time',
    'V44'
  ),
  flag(
    'v46Charts',
    'the Omaha / short-deck hand-class chart: AAxx double-suited 3-bets, a rundown flats, AAA-x folds',
    'V46'
  ),
  flag(
    'phase7Utility',
    'final action-specific tournament utility across payout, bounty and recovery components; defaults on and runs after every global strategy layer',
    'Phase7'
  ),
  flag(
    'phase8Postflop',
    'tournament postflop counterfactual; shadow by default; candidate mode is offline promotion only',
    'Phase8'
  ),
  flag(
    'phase10Plo4',
    'bounded PLO4 policy for every street; shadow by default; candidate mode is offline promotion only',
    'Phase10'
  ),
  flag(
    'phase10EvidenceMode',
    'offline fixed-work PLO4 evidence clock; rejected by the live decision worker',
    'Phase10'
  ),
  flag(
    'phase11Omaha',
    'separate PLO5/PLO6/PLO8 policy; shadow by default; candidate selection is offline only',
    'Phase11'
  ),
  flag(
    'phase11EvidenceMode',
    'offline fixed-work variant evidence clock; rejected by the live decision worker',
    'Phase11'
  ),
  flag(
    'phase12Remaining',
    'separate Short Deck/Pineapple/FLH/FLO8 policies; shadow by default; candidate selection is offline only',
    'Phase12'
  ),
  flag(
    'phase12EvidenceMode',
    'offline fixed-work remaining-variant clock; rejected by the live decision worker',
    'Phase12'
  ),
  flag(
    'phase13Joint',
    'joint multiway and bomb policy; live shadow with offline-only candidate selection',
    'Phase13'
  ),
  flag(
    'phase13EvidenceMode',
    'offline fixed-work joint evaluation; rejected by the live worker',
    'Phase13'
  ),
  flag(
    'v43Tempo',
    'tempo reads: a river big bet priced by how fast it was made against what this player shows down at that tempo',
    'V43'
  ),
  flag(
    'v41Leaks',
    'the rest of the tag table reaches a decision: hold em stack-off load, river-war load, limp-bloat load, by variant family',
    'V41'
  ),

  // ─────────────────────────────────────────────────────────────────────────
  // STYLE PARAMS. base style x profile dials x variant overlay x persona.
  // ─────────────────────────────────────────────────────────────────────────
  ...(
    [
      ['tightness', 'preflop width multiplier (profile dial x variant tightnessMul)'],
      ['aggression', 'bet/raise volume multiplier (profile dial x mood)'],
      ['bluffFreq', 'bluff volume multiplier (profile dial x variant bluffMul x mood)'],
      ['sizingMultiplier', 'bet size multiplier (profile dial)'],
      ['slowplayFreq', 'monster trap frequency (variant slowplayMul; balanced capped 0.14)'],
      ['checkRaiseFreq', 'OOP check-raise lean (variant checkRaiseMul)'],
      ['thinkRange', 'think-time band for V9 timing'],
      ['callRespect', 'variant call respect offset (HorseVariantProfile)'],
      ['familyBias', 'V18 sizing family hashed from the horse id'],
      [
        'ploStackoffLoad',
        'V40: this horse own Omaha stack-off tag rate (profile leaks / leaksHands)',
      ],
      ['nlhStackoffLoad', 'V41: this horse own hold em stack-off tag rate (leaksHoldem)'],
      ['riverWarLoad', 'V41: river raise-war / paid-off tag rate for this hand family'],
      ['limpBloatLoad', 'V41: limped-pot bloat tag rate for this hand family'],
      [
        'tourneyLeakPremium',
        'V41: extra ICM survival premium for a horse tagged for event stack-offs (leaksTournament)',
      ],
    ] as const
  ).map(
    ([key, note]): LedgerEntry => ({
      key,
      kind: 'param',
      source: 'STYLE_PARAMS[style] resolved with HorseProfileMods in HorseLogic.decide',
      cadence: 'per_action',
      consumer: 'HorseLogic.decide / HorsePreflop.decidePreflopV7',
      note,
      since:
        key === 'ploStackoffLoad'
          ? 'V40'
          : key === 'nlhStackoffLoad' ||
              key === 'riverWarLoad' ||
              key === 'limpBloatLoad' ||
              key === 'tourneyLeakPremium'
            ? 'V41'
            : key === 'familyBias'
              ? 'V18'
              : 'V2',
    })
  ),

  // ─────────────────────────────────────────────────────────────────────────
  // PROFILE KEYS. profiles.horse_profile (jsonb). Read at sit-down today
  // (Phase 5 adds the 5-minute hot reload). Written by onboarding and by
  // HorseSelfTuner nightly.
  // ─────────────────────────────────────────────────────────────────────────
  ...(
    [
      [
        'style',
        'style name (tag/lag/balanced/tricky/grinder + legacy aliases); hashed fallback',
        'V2',
      ],
      ['aggression', 'dial, clamped [0.6, 1.5] at the read boundary', 'V8'],
      ['tightness', 'dial, clamped [0.6, 1.5]', 'V8'],
      ['bluffFreq', 'dial, clamped [0.6, 1.5] (bluff_freq accepted)', 'V8'],
      ['sizingMultiplier', 'dial, clamped [0.6, 1.5] (sizing_multiplier accepted)', 'V8'],
      ['leaks', 'V40: this horse leak-tag counts over the tuner window (review verdicts)', 'V40'],
      ['leaksHands', 'V40: reviewed hands the counts were taken over (the denominator)', 'V40'],
      ['leaksOmaha', 'V41: the Omaha-family share of the counts', 'V41'],
      ['leaksHandsOmaha', 'V41: reviewed Omaha hands (the denominator)', 'V41'],
      ['leaksHoldem', 'V41: the hold em-family share of the counts', 'V41'],
      ['leaksHandsHoldem', 'V41: reviewed hold em hands (the denominator)', 'V41'],
      [
        'leaksTournament',
        'V41: the tournament-format share, from fn_horse_tournament_leaks',
        'V41',
      ],
      ['leaksHandsTournament', 'V41: reviewed tournament hands (the denominator)', 'V41'],
      [
        'persona',
        'V48: the AUTHORED persona (straddleRate -> the straddle round, gtoAdherence -> the GTO consult), bounded at the read boundary. The self-tuner never writes it - see ThePersonaSurvivesTheTuner.law.test.ts',
        'V48',
      ],
    ] as const
  ).map(
    ([key, note, since]): LedgerEntry => ({
      key,
      kind: 'profile',
      source: 'profiles.horse_profile (jsonb) via resolveHorseStyle',
      cadence: 'per_sit',
      consumer:
        key === 'persona'
          ? 'HorsePersona.resolvePersona (ServerTableEngineDealing straddle round); HorseLogic.followsSolver (the GTO consult)'
          : key.startsWith('leaks')
            ? 'HorseLogic.leakLoad'
            : 'HorseLogic.decide',
      note,
      since,
    })
  ),

  // ─────────────────────────────────────────────────────────────────────────
  // HORSEMIND COUNTERS. One OpponentStats per observed player, shared by the
  // whole fleet (Dan 2026-09-04: shared memory stays shared).
  // ─────────────────────────────────────────────────────────────────────────
  mind('hands', 'distinct hands observed', 'HorseMind.bandFor / tableExploit (confidence)'),
  mind('vpip', 'voluntarily put money in preflop', 'HorseMind.bandFor (limp/call reads)'),
  mind('pfr', 'first voluntary preflop action was a raise', 'HorseMind.bandFor (open/3-bet reads)'),
  mind('threeBet', 're-raised preflop', 'HorseMind.tableExploit'),
  mind('aggr', 'aggressive actions, all streets', 'HorseMind.tableExploit (bluffMod/callDownMod)'),
  mind('passive', 'calls, all streets', 'HorseMind.tableExploit'),
  mind('folds', 'folds observed', 'HorseMind.tableExploit (fold-to-aggression)'),
  mind('facedAggr', 'times they faced aggression', 'HorseMind.tableExploit'),
  mind('cbetOpps', 'called preflop then faced a c-bet', 'HorseMind.foldToCbetOf (V16)'),
  mind('cbetFolds', '... and folded to it', 'HorseMind.foldToCbetOf (V16)'),
  mind('f3bOpps', 'their open got 3-bet', 'HorseMind.foldTo3BetOf (V16)'),
  mind('f3bFolds', '... and they folded', 'HorseMind.foldTo3BetOf (V16)'),
  mind('bigBetSD', 'big bets that reached showdown', 'HorseMind.bigBetValueTendency (V16)'),
  mind(
    'snapBetSD',
    'V43: river big bets made within 1.5s that reached showdown',
    'HorseMind.snapBetValueTendency (V43)'
  ),
  mind(
    'snapBetSDStrong',
    'V43: ... shown as two pair or better',
    'HorseMind.snapBetValueTendency (V43)'
  ),
  mind(
    'tankBetSD',
    'V43: river big bets made after 8s or more that reached showdown',
    'HorseMind.tankBetValueTendency (V43)'
  ),
  mind(
    'tankBetSDStrong',
    'V43: ... shown as two pair or better',
    'HorseMind.tankBetValueTendency (V43)'
  ),
  mind('bigBetSDStrong', '... that showed real strength', 'HorseMind.bigBetValueTendency (V16)'),
  mind('riverBetOpps', 'river bet opportunities', 'HorseMind.tableExploit (river reads)'),
  mind('riverBetFolds', 'river bets folded to', 'HorseMind.tableExploit (river reads)'),
  mind('rHands', 'recency window: hands', 'HorseMind counter-adaptation blend (V7)'),
  mind('rFolds', 'recency window: folds', 'HorseMind counter-adaptation blend (V7)'),
  mind('rFacedAggr', 'recency window: faced aggression', 'HorseMind counter-adaptation blend (V7)'),
  mind('rAggr', 'recency window: aggressive actions', 'HorseMind counter-adaptation blend (V7)'),
  mind('rPassive', 'recency window: calls', 'HorseMind counter-adaptation blend (V7)'),
  mind('checks', 'checks observed', 'HorseMind.tableExploit (passivity)'),
  mind('postAggr', 'postflop aggressive actions', 'HorseMind.tableExploit (AF)'),
  mind('postPassive', 'postflop passive actions', 'HorseMind.tableExploit (AF)'),
  mind('rChecks', 'recency window: checks', 'HorseMind counter-adaptation blend (V7)'),

  // ─────────────────────────────────────────────────────────────────────────
  // GAME STATE. What the engine hands the brain every decision.
  // ─────────────────────────────────────────────────────────────────────────
  state(
    'players',
    'every public seat: stack, bet, folded/all-in/sitting-out, totalInvested; private cards are always empty here and hero cards travel separately'
  ),
  state('stateSchemaVersion', 'canonical live decision schema; production requires version 1'),
  state('heroSeat', 'seat whose private cards and action are being decided'),
  state('currentPlayerSeat', 'authoritative HandController turn owner'),
  state('legalActions', 'authoritative action menu including reopen and structure rules'),
  state('toCall', 'authoritative amount owed by hero'),
  state('minRaiseTo', 'minimum absolute legal wager or raise-to'),
  state('maxRaiseTo', 'maximum absolute legal wager after structure and table caps'),
  state('bettingStructure', 'no-limit, pot-limit or fixed-limit rule selected by the live hand'),
  state('fixedBetSize', 'fixed-limit street bet; null in other structures'),
  state('wagersCapped', 'fixed-limit wager cap reached on this street'),
  state(
    'commitmentCapRemaining',
    'table per-hand commitment ceiling remaining; null when disabled'
  ),
  state('pots', 'live side-pot layers and exact eligible player ids'),
  state('rakeConfig', 'exact active per-hand rake percent and player-count cap schedule'),
  state('bbjConfig', 'active hand jackpot fee configuration; null explicitly disables deductions'),
  state(
    'chipUnit',
    'controller settlement unit: whole tournament or Diamond chips, cent-unit cash chips'
  ),
  state('asset', 'controller chip or Diamond asset, governing fee and precision rules'),
  state('dealtSeatIds', 'public original dealt-seat census; folded deals still occupy the deck'),
  state('variantRules', 'explicit hole-card, board-use, deck and hi-lo rules'),
  state('communityCards', 'board 1'),
  state('communityCards2', 'board 2 (bomb pots)'),
  state('communityCards3', 'board 3 (bomb pots)'),
  state('pot', 'pot including the bet faced'),
  state(
    'contestablePot',
    "pot hero can actually win after the effective call, excluding hero's uncommitted call"
  ),
  state('currentBet', 'the street bet to match'),
  state('minRaise', 'legal raise increment'),
  state('lastRaise', 'last raise size (legalize)'),
  state('stage', 'street'),
  state('gameVariant', 'nlh / plo4 / plo5 / plo6 / plo8 / short_deck / pineapple / fixed limit'),
  state('bigBlind', 'stake'),
  state('dealerSeat', 'button (position reads)'),
  state(
    'actionHistory',
    'this hand, every action with stage and amount (range reads, barrels, plans)'
  ),
  state('gameMode', 'cash / tournament'),
  state('format', 'cash / mtt / sng / spin / hu_sng'),
  state('ante', 'ante per hand'),
  state('bigBlindAnte', 'BB-ante structure'),
  state('allInOrFold', 'all-in-or-fold table'),
  state('straddleActive', 'a straddle is posted (V18)'),
  state('bombPot', 'this hand is a bomb pot (V36)'),
  state('boardCount', 'boards dealt (V36)'),
  state(
    'vpipFloor',
    'the table VPIP floor a seat is stood up under after ten hands (Dan 2026-09-04)',
    // Two consumers, and the second one is the point (2026-09-06): the floor
    // does not only widen the brain, it travels to settlement and keys the
    // horse_daily_play row apart, so no band ever judges required-loose play.
    'HorseLogic.vpipFloorMul; ServerTableEngineSettlement -> HorseHandReview (horse_daily_play.floored)'
  ),
  state(
    'ownVpip',
    'this seat: hands and judged VPIP this sitting, from fn_nit_status - the eviction query',
    'HorseLogic.vpipFloorMul'
  ),
  state(
    'tournament',
    'Phase 6 schema-v1 context: tournament type, seats, stacks, payouts/tickets, funded prize/bounty pools, buy-in/start-stack recovery terms, bounty inventory, registration/re-entry/rebuy/add-on state, exact level clock, hand-for-hand, M and atlas coordinates',
    'HorseDecisionWorkerRuntime.assertPhase6TournamentSnapshot; HorseLogic.icmRisk / decidePreflopV7 / endgameAdjust / satelliteRead / evaluateTournamentUtility'
  ),

  // ─────────────────────────────────────────────────────────────────────────
  // TABLES. What the services compile and where it goes.
  // ─────────────────────────────────────────────────────────────────────────
  table(
    'horse_observation_capture_work',
    'minute',
    'HorseObservationCapture via fn_claim_horse_observation_capture; HorseLearningQueueHealth via fn_horse_learning_work_health',
    'private durable actor/window acquisition requests; bounded sequential cursor recovery in one queue slot and retained gaps; not source coverage or model activation',
    'Phase14'
  ),
  table(
    'horse_observation_capture_receipts',
    'minute',
    'HorseObservationCapture via fn_finish_horse_observation_capture; fn_prune_horse_observation_captures',
    'private immutable accepted-slice acknowledgments; exact retry after a newer lease, atomic journal admission and cursor advance; unfinished gap evidence is retained',
    'Phase14'
  ),
  table(
    'horse_mind_stats',
    'boot',
    'HorseMindPersistence (load at boot, save on a timer)',
    'the shared PlayerStats memory, persisted',
    'V13',
    { dayColumn: 'updated_at', freshnessDays: 1 }
  ),
  table(
    'horse_mind_stats_scoped',
    'boot',
    'HorseMindPersistence (hydrateHorseMindScopedFromDb at boot, flushHorseMindScoped on the timer); HorseMind.readStats prefers it at 40 hands',
    'V45: the same counters per (player, card family x table size) - a PLO6 VPIP no longer reads as an NLH VPIP',
    'V45',
    { dayColumn: 'updated_at', freshnessDays: 1 }
  ),
  table(
    'horse_mind_pairs',
    'boot',
    'HorseMindPersistence (load at boot, save on a timer)',
    'pairwise targeting/hunting reads',
    'V13',
    { dayColumn: 'updated_at', freshnessDays: 1 }
  ),
  table(
    'horse_hand_reviews',
    'per_hand',
    'HorseHandReview (write at settlement); fn_run_horse_daily_audit; HorseSelfTuner via horse_review_rollup',
    'every 20bb+ pot a horse played, tagged',
    'V13',
    { dayColumn: 'played_at', freshnessDays: 1 }
  ),
  table(
    'horse_review_rollup',
    'nightly',
    'HorseSelfTuner (leak counts -> dials and the V40 leak profile)',
    'per horse/day/variant tag counts',
    'V18',
    { dayColumn: 'day', freshnessDays: 2 }
  ),
  table(
    'horse_tournament_daily',
    'nightly',
    'fn_audit_tournament_results (the daily audit); ca_horse_tournament_card (the panel); compiled by fn_horse_tournament_daily_compile from fn_run_horse_daily_audit',
    'per horse/day/type/variant tournament results: entries, invested, won, ITM, finish percentile',
    '2026-09-05',
    { dayColumn: 'day', freshnessDays: 2 }
  ),
  table(
    'horse_daily_nets',
    'nightly',
    'HorseSelfTuner (real bb/100 and, since 2026-09-05, rake_bb and, since 2026-09-06, bbj_bb -> the DROP-adjusted regression rule and fleetQuartile); fn_run_horse_daily_audit; fn_audit_fleet_drop_identity (the closed-system assertion)',
    'exact settlement nets + weighted-contributed rake AND bad-beat-jackpot drop per horse per day. net_bb + rake_bb + bbj_bb is the result before the house took anything, and on 2026-09-06 it came to zero over 31,186 seat-hands - the fleet plays itself, so it must',
    'V16',
    { dayColumn: 'day', freshnessDays: 1 }
  ),
  table(
    'horse_daily_play',
    'nightly',
    'HorseSelfTuner (loadPlayRows: every horse studied from its own rows, floored = false only; HorseHandReview compiles them at settlement with HorsePlayStats); fn_horse_frequency_leaks; fn_audit_frequency_leaks (which reports the floored share so the exclusion stays visible)',
    'per horse/day/format/floored VPIP, PFR, 3-bet, fold-to-3-bet, saw flop, WWSF, postflop aggression. `floored` splits play at a VPIP-floored table, where the horse was REQUIRED to be loose, away from play the winning-player bands may judge (2026-09-06)',
    '2026-09-05',
    { dayColumn: 'day', freshnessDays: 1 }
  ),
  table(
    'horse_self_tune_log',
    'nightly',
    'fn_complete_horse_tuner_study via HorseTunerStudyCompletion; HorseDailyAudit; the panel',
    'what the tuner did to each horse and why; an individual row is only partial nightly progress',
    'V8',
    { dayColumn: 'run_date', freshnessDays: 2 }
  ),
  table(
    'horse_brain_telemetry',
    'nightly',
    'fn_audit_layer_silence_and_coverage, fn_audit_layer_drift, fn_audit_data_receipts (BrainTelemetryFlush writes through fn_brain_telemetry_add)',
    'per-day fire counts per layer (BrainTelemetryFlush)',
    'V15',
    { dayColumn: 'day', freshnessDays: 1 }
  ),
  table(
    'horse_decision_latency',
    'nightly',
    'the panel; fn_horse_decision_latency_add (BrainTelemetryFlush writes through the RPC)',
    'per-day decision latency histograms',
    'V28',
    { dayColumn: 'day', freshnessDays: 1 }
  ),
  table(
    'horse_solver_agreement',
    'nightly',
    'fn_audit_solver_agreement (the daily audit); written by HorseLeague after the matchups via fn_horse_solver_agreement_add',
    'reference-specific absolute scores: V47 hold em push/fold chart agreement and Phase 4 certified V31 postflop execution agreement; neither is exploitability',
    'V47',
    { dayColumn: 'run_date', freshnessDays: 2 }
  ),
  table(
    'horse_solver_agreement_decisions',
    'nightly',
    'fn_audit_solver_agreement; ca_horse_solver_agreement_decisions',
    'reconciled per-decision evidence behind the nightly chart-agreement summary, including the final action, reference mix, regret availability, and source seal',
    'Phase4',
    { dayColumn: 'run_date', freshnessDays: 2 }
  ),
  table(
    'horse_solver_agreement_v31_decisions',
    'nightly',
    'fn_audit_solver_agreement; ca_horse_solver_agreement_decisions; ca_horse_solver_agreement_v31_decisions',
    'database-bound per-decision evidence for the promoted V31 runtime corpus: exact state, sampled and final action, execution match, reference mix, recomputed regret, and complete dataset/cell source seal',
    'Phase4',
    { dayColumn: 'run_date', freshnessDays: 2 }
  ),
  table(
    'gto_v31_runtime_cells',
    'boot',
    'GtoPostflopV31Loader via fn_gto_v31_active_cells',
    'the only certified postflop policy cells the live action path may load',
    'Phase4'
  ),
  table(
    'gto_v31_datasets',
    'nightly',
    'fn_audit_gto_v31_certified',
    'candidate and active corpus release seals, held-out metrics, replay gate, and league gate',
    'Phase4'
  ),
  table(
    'gto_v31_cell_source_receipts',
    'nightly',
    'fn_gto_v31_mark_candidate',
    'immutable lineage from each compact cell to its independently attributed source nodes',
    'Phase4'
  ),
  table(
    'solver_worker_liveness',
    'minute',
    'fn_audit_solver_pipeline_liveness',
    'latest monotonic M1 and M2 progress, provenance, rate, ETA, invalid rows, and artifact receipt',
    'Phase4'
  ),
  table(
    'solver_compact_liveness',
    'minute',
    'fn_audit_solver_pipeline_liveness',
    'latest certified compact-build state and source lag',
    'Phase4'
  ),
  table(
    'horse_league_results',
    'nightly',
    'fn_run_horse_daily_audit (league_layer_negative); the panel',
    'the ablation card',
    'V12',
    { dayColumn: 'run_date', freshnessDays: 2 }
  ),
  table(
    'horse_daily_audit',
    'nightly',
    'the panel; the daily analysis prompt',
    'findings + agent analysis per day',
    'V13',
    { dayColumn: 'day', freshnessDays: 2 }
  ),
  table(
    'horse_tuner_write_receipts',
    'nightly',
    'fn_horse_tuner_recorded_horses via HorseTunerStudyCompletion',
    'immutable per-horse daily writes let an interrupted study resume without retuning accepted horses',
    'Phase14'
  ),
  table(
    'horse_tuner_study_rosters',
    'nightly',
    'fn_prepare_horse_tuner_study via HorseTunerStudyCompletion',
    'durable original eligible membership prevents a resumed study from silently dropping unfinished horses',
    'Phase14'
  ),
  table(
    'horse_tuner_study_completions',
    'nightly',
    'HorseLeague / HorseSelfTuner',
    'one execution receipt after every member of the captured eligible cohort has an atomic audit receipt; not causal validation',
    'Phase14'
  ),
  table(
    'horse_job_runs',
    'nightly',
    'HorseLeague / HorseSelfTuner / HorseDailyAudit claims; fn_audit_nightly_job_health',
    'single-runner claims per job per day',
    'V23'
  ),
  table(
    'horse_data_ledger',
    'boot',
    'fn_audit_data_receipts; ca_horse_data_ledger (the panel)',
    'this ledger, upserted by HorseDataLedgerSync at boot',
    'P1',
    { dayColumn: 'updated_at', freshnessDays: 3 }
  ),
  table(
    'ca_horse_fleet_state',
    'minute',
    'HorseFleetManager via fn_ca_fleet_state_upsert; fn_ca_fleet_overview / fn_ca_fleet_pnl (the panel)',
    'per-horse seat/table/session state',
    'fleet'
  ),
  table(
    'ca_horse_fleet_register',
    'nightly',
    'SQL only: fn_ca_fleet_register_sync, fn_ca_fleet_isolation_report, fn_ca_fleet_overview',
    'the roster as the database sees it',
    'fleet'
  ),
  table(
    'ca_horse_fleet_policy',
    'minute',
    'HorseFleetPolicy via fn_ca_fleet_policy_effective',
    'floor policy row',
    'fleet'
  ),
  table(
    'ca_horse_fleet_heartbeat',
    'minute',
    'SQL only: fn_ca_fleet_overview (the panel reads the leader heartbeat)',
    'leader/standby heartbeat',
    'fleet'
  ),
  // Legacy: exist in the schema, zero rows, zero writes, no reader in
  // server/src. Registered so the test fails the day something starts
  // reading one without moving it above (a datum with a reader is not
  // legacy) and so the panel can show them as what they are.
  ...[
    'horse_analytics',
    'horse_error_log',
    'horse_hand_history',
    'horse_memory',
    'horse_opponent_journals',
    'horse_opponent_reads',
    'horse_personality',
    'horse_relationships',
    'horse_session_analytics',
    'horse_session_stats',
    'horse_source_assignments',
    'horse_sports_source_assignments',
    'horse_table_presence',
    'horse_threat_intel',
    'horse_topic_cooldowns',
    'horses',
  ].map((t) =>
    table(
      t,
      'legacy_unused',
      'none',
      'zero rows, zero writes, no reader in server/src as of 2026-09-04',
      'legacy'
    )
  ),

  // ─────────────────────────────────────────────────────────────────────────
  // RECEIPTS. Telemetry keys, with the ratio the daily audit expects on a
  // normal fleet day. Ratios are set from 2026-09-03 production fires
  // (decide 3.67M; decide_omaha 1.90M; decide_nlh 1.50M) with a wide margin,
  // so a healthy day never trips them and a dead layer always does.
  // ─────────────────────────────────────────────────────────────────────────
  receipt('decide', 'HorseLogic.decide', 'every live decision', 'V15'),
  receipt('decide_tournament', 'HorseLogic.decide', 'every live tournament decision', 'Phase6'),
  receipt(
    'decide_tournament_preflop',
    'HorseLogic.decide',
    'every live tournament preflop decision',
    'Phase6',
    'decide_tournament',
    0.05
  ),
  receipt(
    'decide_omaha',
    'HorseLogic.decide',
    'Omaha-family decisions (plo4/5/6/8, flo8)',
    'V15',
    'decide',
    0.1
  ),
  receipt(
    'decide_nlh',
    'HorseLogic.decide',
    'hold em-family decisions (nlh, pineapple, fixed limit)',
    'V15',
    'decide',
    0.1
  ),
  receipt(
    'decide_short_deck',
    'HorseLogic.decide',
    'short deck decisions; needs short-deck tables',
    'V15'
  ),
  receipt(
    'preflop_v7',
    'HorsePreflop.decidePreflopV7',
    'V7 preflop engine took the decision',
    'V7',
    'decide',
    0.4
  ),
  receipt(
    'plo_pot_preflop_size',
    'HorsePreflop',
    'PLO pot-sized preflop raise',
    'V24',
    'decide_omaha',
    0.001
  ),
  receipt(
    'banded_mc_omaha',
    'HorseEval.simulateEquity via HorseMind.bandsForOpponents',
    'range-conditioned MC ran (Omaha)',
    'V3',
    'decide_omaha',
    0.2
  ),
  receipt(
    'banded_mc_nlh',
    'HorseEval.simulateEquity via HorseMind.bandsForOpponents',
    'range-conditioned MC ran (NLH)',
    'V3',
    'decide_nlh',
    0.2
  ),
  receipt(
    'icm_*',
    'HorseLogic.icmRisk',
    'icm_real / icm_spin_cev / icm_warming / icm_legacy; tournament volume only',
    'V16'
  ),
  receipt(
    'gto_*',
    'HorseLogic (solver lookups)',
    'gto_miss_* / gto_skip_too_deep / gto_depth_fallback; NLH solver misses by reason',
    'V27'
  ),
  receipt(
    'vpip_floor',
    'HorseLogic (VPIP floor)',
    'a floored table steered this decision (Dan 2026-09-04)',
    'VPIP',
    'decide'
  ),
  receipt(
    'vpip_floor_prior',
    'HorseLogic (VPIP floor)',
    'steering on the prior - under three hands, no judged sample yet',
    'VPIP',
    'vpip_floor'
  ),
  receipt(
    'vpip_floor_closing',
    'HorseLogic (VPIP floor)',
    'closing the loop on the judged VPIP and still widening',
    'VPIP',
    'vpip_floor'
  ),
  receipt(
    'vpip_floor_satisfied',
    'HorseLogic (VPIP floor)',
    'over the floor; the horse own style is back in charge',
    'VPIP',
    'vpip_floor'
  ),
  receipt(
    'vpip_floor_clamped',
    'HorseLogic (VPIP floor)',
    'pinned at the 0.35 widening limit - the floor cannot be reached by widening, so the table churns',
    'VPIP',
    'vpip_floor'
  ),
  receipt(
    'v15_nut_status',
    'HorseLogic (V15)',
    'Omaha cat 5/6 nut read',
    'V15',
    'decide_omaha',
    0.02
  ),
  receipt(
    'v15_eq_capped',
    'HorseLogic (V15)',
    'dominated flush/straight equity capped',
    'V15',
    'decide_omaha',
    0.0005
  ),
  receipt(
    'v15_raise_gate',
    'HorseLogic (V15)',
    'dominated hand refused to raise',
    'V15',
    'decide_omaha',
    0.0003
  ),
  receipt(
    'v16_hu_overlay',
    'HorseLogic (V16)',
    'heads-up overlay; depends on HU volume',
    'V16',
    'decide',
    0.05
  ),
  receipt(
    'v16_reads_f3b',
    'HorseLogic (V16)',
    'fold-to-3-bet read consulted',
    'V16',
    'decide',
    0.1
  ),
  receipt(
    'v16_reads_cbet',
    'HorseLogic (V16)',
    'fold-to-c-bet read consulted',
    'V16',
    'decide',
    0.005
  ),
  receipt(
    'v16_reads_tell',
    'HorseLogic (V16)',
    'big-bet showdown tell consulted',
    'V16',
    'decide',
    0.002
  ),
  receipt(
    'v16_sizecond_bigbet',
    'HorseLogic (V16)',
    'big-bet-conditioned sampling',
    'V16',
    'decide',
    0.005
  ),
  receipt(
    'v16_unblocker',
    'HorseLogic (V16)',
    'river unblocker bluff boost',
    'V16',
    'decide',
    0.002
  ),
  receipt('v17_pos_behind', 'HorseLogic (V17)', 'players-behind pressure', 'V17', 'decide', 0.1),
  receipt(
    'v17_river_probe',
    'HorseLogic (V17)',
    'river probe into a capped field',
    'V17',
    'decide',
    0.0002
  ),
  receipt('v17_catch_block', 'HorseLogic (V17)', 'call-side blocker', 'V17', 'decide', 0.0005),
  receipt(
    'v17_short_deck',
    'HorseLogic (V17)',
    'short deck tightening; needs short-deck tables',
    'V17',
    'decide_short_deck',
    0.2
  ),
  receipt(
    'v18_straddle',
    'HorsePreflop (V18)',
    'straddle read as unopened; needs straddle tables',
    'V18'
  ),
  receipt(
    'v18_self_image',
    'HorseLogic (V18)',
    'own image fed bluff volume',
    'V18',
    'decide',
    0.05
  ),
  receipt(
    'v18_exploit_size',
    'HorseLogic (V18)',
    'station/nit river raise sizing',
    'V18',
    'decide',
    0.00005
  ),
  receipt(
    'v19_overbet_polarity',
    'HorseLogic (V19)',
    'overbet respect shift',
    'V19',
    'decide',
    0.0005
  ),
  receipt(
    'v19_river_bigbet_cap',
    'HorseLogic (V15/V19)',
    'big river bet into a dominated Omaha hand',
    'V19',
    'decide_omaha',
    0.0005
  ),
  receipt(
    'v20_mzone_wired',
    'HorseLogic (V20)',
    'tournament M-zone consulted; tournament volume',
    'V20'
  ),
  receipt(
    'v20_pressure_read',
    'HorseLogic (V20)',
    'multiway pressure counted',
    'V20',
    'decide',
    0.005
  ),
  receipt(
    'v20_pressure_cap',
    'HorseLogic (V20)',
    'NLH pressure cap applied',
    'V20',
    'decide_nlh',
    0.0005
  ),
  receipt(
    'v20_weak2p_demote',
    'HorseLogic (V20)',
    'weak two pair on a paired board demoted',
    'V20',
    'decide_nlh',
    0.002
  ),
  receipt(
    'v20_commit_bar',
    'HorseLogic (V20)',
    'commit bar raised multiway',
    'V20',
    'decide',
    0.0005
  ),
  receipt('v21_nut_status', 'HorseLogic (V21)', 'NLH nut status read', 'V21', 'decide_nlh', 0.01),
  receipt(
    'v21_dominated_cap',
    'HorseLogic (V21)',
    'board-dominated NLH hand capped',
    'V21',
    'decide_nlh',
    0.0002
  ),
  receipt('v21_scare_cap', 'HorseLogic (V21)', 'scare-runout cap', 'V21', 'decide_nlh', 0.00005),
  receipt(
    'v21_scare_commit',
    'HorseLogic (V21)',
    'scare premium in the committed branch',
    'V21',
    'decide',
    0.0002
  ),
  receipt('v21_war_gate', 'HorseLogic (V21)', 'river raise-war governor', 'V21', 'decide', 0.0002),
  receipt('v23_river_read', 'HorseLogic (V23)', 'river read consulted', 'V23', 'decide', 0.01),
  receipt(
    'v23_plan_callonce',
    'HorseLogic (V23)',
    'raise plan: call once honored',
    'V23',
    'decide',
    0.001
  ),
  receipt('v23_plan_fold', 'HorseLogic (V23)', 'raise plan: fold honored', 'V23', 'decide', 0.0001),
  receipt('v23_bounty_call', 'HorseLogic (V23)', 'bounty priced into a call; PKO volume', 'V23'),
  receipt('v23_spin', 'HorseLogic (V23)', 'spin overlay; spin volume', 'V23'),
  receipt('v24_bounty_pull', 'HorsePreflop (V24)', 'PKO bounty pull; PKO volume', 'V24'),
  receipt(
    'v26_prize_read',
    'HorseLogic (V26)',
    'mystery prize landscape; chest tournaments only',
    'V26'
  ),
  receipt(
    'v27_gto_open_jam',
    'HorsePreflop (V27)',
    'solver open/jam chart hit',
    'V27',
    'decide_nlh',
    0.01
  ),
  receipt(
    'v27_gto_bb_defend',
    'HorsePreflop (V27)',
    'solver BB defend chart hit',
    'V27',
    'decide_nlh',
    0.005
  ),
  receipt('v29_*', 'GtoPostflop (V29)', 'flop solver cells and misses', 'V29', 'decide_nlh', 0.002),
  receipt(
    'v30_*',
    'GtoPostflop (V30)',
    'turn/river solver cells and misses',
    'V30',
    'decide_nlh',
    0.002
  ),
  receipt(
    'v31_*',
    'GtoPostflopV31 (V31)',
    'suit-aware solver hits and misses by depth/street',
    'V31',
    'decide_nlh',
    0.002
  ),
  receipt(
    'v32_*',
    'GtoFacingDefenseV32 (V32)',
    'facing-bet defense verdicts and misses',
    'V32',
    'decide_nlh',
    0.002
  ),
  receipt(
    'v34_defend_draw_passthrough',
    'HorseLogic (V34)',
    'solver draw call honored',
    'V34',
    'decide_nlh',
    0.0002
  ),
  receipt('v36_*', 'HorseLogic (V36)', 'bomb pot layers; bomb-pot volume', 'V36'),
  receipt(
    'v37_*',
    'HorseLogic (V37)',
    'satellite / bubble / bounty layers; tournament volume',
    'V37'
  ),
  receipt(
    'v38_ev_check',
    'HorseEvEngine via HorseLogic (V38)',
    'EV engine chose check',
    'V38',
    'decide_omaha',
    0.02
  ),
  receipt(
    'v38_ev_call',
    'HorseEvEngine via HorseLogic (V38)',
    'EV engine chose call',
    'V38',
    'decide_omaha',
    0.02
  ),
  receipt(
    'v38_ev_fold',
    'HorseEvEngine via HorseLogic (V38)',
    'EV engine chose fold',
    'V38',
    'decide_omaha',
    0.01
  ),
  receipt(
    'v38_ev_bet',
    'HorseEvEngine via HorseLogic (V38)',
    'EV engine chose bet',
    'V38',
    'decide_omaha',
    0.003
  ),
  receipt(
    'v38_river_call',
    'HorseEvEngine via HorseLogic (V38)',
    'MDF river call',
    'V38',
    'decide',
    0.002
  ),
  receipt(
    'v38_river_fold',
    'HorseEvEngine via HorseLogic (V38)',
    'MDF river fold',
    'V38',
    'decide',
    0.002
  ),
  receipt(
    'v38_preflop_allin_price',
    'HorsePreflop (V38)',
    'preflop all-in priced by EV',
    'V38',
    'decide',
    0.002
  ),
  receipt(
    'v39_outlook_*',
    'HorseLogic (V39)',
    'next-card outlook recorded / good / blank / scare',
    'V39',
    'decide',
    0.005
  ),
  receipt(
    'v40_made_*',
    'HorseLogic (V40)',
    'Omaha made-hand class read for cat 1-4',
    'V40',
    'decide_omaha',
    0.05
  ),
  receipt(
    'v40_omaha_pressure_cap',
    'HorseLogic (V40)',
    'Omaha pair/two-pair/trips capped under pressure',
    'V40',
    'decide_omaha',
    0.0005
  ),
  receipt(
    'v40_small_ball',
    'HorseLogic (V40)',
    'weak-class Omaha value bet sized down',
    'V40',
    'decide_omaha',
    0.0002
  ),
  receipt(
    'v40_no_third_barrel',
    'HorseLogic (V40)',
    'weak-class hand declined the third barrel',
    'V40',
    'decide_omaha',
    0.0001
  ),
  receipt(
    'v40_leak_profile_read',
    'HorseLogic (V40)',
    'the horse own review tags changed a decision; needs tuner-written leaks',
    'V40'
  ),
  receipt(
    'v41_nlh_leak_read',
    'HorseLogic (V41)',
    'a hold em horse tagged for stack-offs read a single big bet as pressure; needs tuner-written leaksHoldem',
    'V41'
  ),
  receipt(
    'v41_river_war_read',
    'HorseLogic (V41)',
    'a horse tagged for river raise wars gave a river raise more respect; needs tuner-written leaks',
    'V41'
  ),
  receipt(
    'phase5_canonical_state',
    'HorseDecisionWorkerRuntime.executeFast',
    'a schema-v1 state passed the worker privacy, legality, side-pot, rake and variant-rule boundary',
    'Phase5',
    'decide',
    0.99
  ),
  receipt(
    'phase6_tournament_context',
    'HorseLogic (Phase6)',
    'a live tournament decision received the schema-v1 tournament context',
    'Phase6',
    'decide_tournament',
    0.99
  ),
  receipt(
    'phase6_tournament_context_*',
    'HorseLogic (Phase6)',
    'complete and explicit-incomplete outcomes partition every Phase 6 context read',
    'Phase6',
    'phase6_tournament_context',
    0.99
  ),
  receipt(
    'phase6_tournament_context_complete',
    'HorseLogic (Phase6)',
    'the schema-v1 tournament context passed the complete-context contract',
    'Phase6',
    'phase6_tournament_context'
  ),
  receipt(
    'phase6_m_engine',
    'HorseLogic (Phase6)',
    'real, effective, projected, velocity and covering-opponent M were present',
    'Phase6',
    'phase6_tournament_context',
    0.99
  ),
  receipt(
    'phase6_tournament_preflop',
    'HorseLogic (Phase6)',
    'a live tournament preflop decision resolved an atlas coordinate',
    'Phase6',
    'decide_tournament_preflop',
    0.99
  ),
  receipt(
    'phase6_route_*',
    'HorseLogic (Phase6)',
    'solver, atlas, and solverless-variant routes partition actual tournament preflop returns',
    'Phase6',
    'phase6_tournament_preflop',
    0.99
  ),
  receipt(
    'phase6_branch_*',
    'HorseLogic (Phase6)',
    'the branch attached to the actual tournament preflop return',
    'Phase6',
    'phase6_tournament_preflop',
    0.99
  ),
  receipt(
    'phase6_route_atlas',
    'HorseLogic (Phase6)',
    'an actual tournament preflop return used the Phase 6 atlas path',
    'Phase6'
  ),
  receipt(
    'phase6_atlas_*',
    'HorseLogic (Phase6)',
    'baseline and labeled-fallback outcomes partition actual atlas returns',
    'Phase6',
    'phase6_route_atlas',
    0.99
  ),
  receipt(
    'phase7_tournament_utility',
    'HorseLogic -> HorseTournamentUtility',
    'a complete-context tournament decision compared its legal action families by resulting stack-vector utility and attached the component ledger',
    'Phase7',
    'phase6_tournament_context_complete',
    0.99
  ),
  receipt(
    'phase10_seen',
    'HorseLogic -> evaluatePlo4LivePolicy',
    'natural PLO4 decisions entering the versioned policy',
    'Phase10'
  ),
  receipt(
    'phase10_eligible',
    'evaluatePlo4LivePolicy',
    'complete supported single-board PLO4 nodes',
    'Phase10'
  ),
  receipt(
    'phase10_fired',
    'evaluatePlo4LivePolicy',
    'completed bounded PLO4 policy evaluation',
    'Phase10'
  ),
  receipt(
    'phase10_shadow_changed',
    'evaluatePlo4LivePolicy',
    'proposal differs from baseline; not a live action claim',
    'Phase10'
  ),
  receipt(
    'phase10_applied',
    'HorseLogic',
    'approved policy proposal accepted before final utility and enforcement',
    'Phase10'
  ),
  receipt(
    'phase10_baseline_retained',
    'HorseLogic',
    'shadow or unavailable policy retained the existing action',
    'Phase10'
  ),
  receipt(
    'phase10_reason_*',
    'evaluatePlo4LivePolicy',
    'exact selection or unavailable reason',
    'Phase10',
    'phase10_seen',
    0.99
  ),
  receipt(
    'phase10_street_*',
    'evaluatePlo4LivePolicy',
    'street coverage for completed policy evaluations',
    'Phase10',
    'phase10_fired',
    0.99
  ),
  receipt(
    'phase10_unavailable_utility_*',
    'HorseLogic -> HorseTournamentUtility',
    'exact reason the existing tournament utility owner refused evaluation',
    'Phase10'
  ),
  receipt(
    'phase10_utility_*',
    'HorseLogic -> HorseTournamentUtility',
    'cash or existing tournament utility ownership',
    'Phase10',
    'phase10_seen',
    0.99
  ),
  receipt(
    'phase10_execution_*',
    'ServerTableEngineTurns',
    'authoritative action or retired decision accounting',
    'Phase10'
  ),
  receipt(
    'phase11_seen',
    'HorseLogic -> evaluateOmahaVariantPolicy',
    'natural PLO5/PLO6/PLO8 decisions entering the versioned policy',
    'Phase11'
  ),
  receipt(
    'phase11_eligible',
    'evaluateOmahaVariantPolicy',
    'complete supported single-board PLO5/PLO6/PLO8 nodes',
    'Phase11'
  ),
  receipt(
    'phase11_fired',
    'evaluateOmahaVariantPolicy',
    'completed bounded PLO5/PLO6/PLO8 policy evaluation',
    'Phase11'
  ),
  receipt(
    'phase11_shadow_changed',
    'evaluateOmahaVariantPolicy',
    'proposal differs from baseline; not a live action claim',
    'Phase11'
  ),
  receipt(
    'phase11_applied',
    'HorseLogic',
    'approved policy proposal accepted before final utility and enforcement',
    'Phase11'
  ),
  receipt(
    'phase11_baseline_retained',
    'HorseLogic',
    'shadow or unavailable policy retained the existing action',
    'Phase11'
  ),
  receipt(
    'phase11_reason_*',
    'evaluateOmahaVariantPolicy',
    'exact selection or unavailable reason',
    'Phase11',
    'phase11_seen',
    0.99
  ),
  receipt(
    'phase11_street_*',
    'evaluateOmahaVariantPolicy',
    'street coverage for completed policy evaluations',
    'Phase11',
    'phase11_fired',
    0.99
  ),
  receipt(
    'phase11_unavailable_utility_*',
    'HorseLogic -> HorseTournamentUtility',
    'exact reason the existing tournament utility owner refused evaluation',
    'Phase11'
  ),
  receipt(
    'phase11_utility_*',
    'HorseLogic -> HorseTournamentUtility',
    'cash or existing tournament utility ownership',
    'Phase11',
    'phase11_seen',
    0.99
  ),
  receipt(
    'phase11_execution_*',
    'ServerTableEngineTurns',
    'authoritative action or retired decision accounting',
    'Phase11'
  ),
  receipt(
    'phase11_variant_*',
    'HorseLogic',
    'partition entering decisions by exact variant',
    'Phase11',
    'phase11_seen',
    0.99
  ),
  ...(['plo5', 'plo6', 'plo8'] as const).map((variant) =>
    receipt(
      `phase11_${variant}_*`,
      'HorseLogic; ServerTableEngineTurns',
      'per-variant eligibility, completion, reason and final execution; depends on table mix',
      'Phase11'
    )
  ),
  receipt(
    'phase12_seen',
    'HorseLogic -> evaluateRemainingVariantPolicy',
    'natural Short Deck/Pineapple/FLH/FLO8 decisions entering the versioned policy',
    'Phase12'
  ),
  receipt(
    'phase12_eligible',
    'evaluateRemainingVariantPolicy',
    'complete supported single-board Short Deck/Pineapple/FLH/FLO8 nodes',
    'Phase12'
  ),
  receipt(
    'phase12_fired',
    'evaluateRemainingVariantPolicy',
    'completed bounded Short Deck/Pineapple/FLH/FLO8 policy evaluation',
    'Phase12'
  ),
  receipt(
    'phase12_shadow_changed',
    'evaluateRemainingVariantPolicy',
    'proposal differs from baseline; not a live action claim',
    'Phase12'
  ),
  receipt(
    'phase12_applied',
    'HorseLogic',
    'approved policy proposal accepted before final utility and enforcement',
    'Phase12'
  ),
  receipt(
    'phase12_baseline_retained',
    'HorseLogic',
    'shadow or unavailable policy retained the existing action',
    'Phase12'
  ),
  receipt(
    'phase12_reason_*',
    'evaluateRemainingVariantPolicy',
    'exact selection or unavailable reason',
    'Phase12',
    'phase12_seen',
    0.99
  ),
  receipt(
    'phase12_street_*',
    'evaluateRemainingVariantPolicy',
    'street coverage for completed policy evaluations',
    'Phase12',
    'phase12_fired',
    0.99
  ),
  receipt(
    'phase12_unavailable_utility_*',
    'HorseLogic -> HorseTournamentUtility',
    'exact reason the existing tournament utility owner refused evaluation',
    'Phase12'
  ),
  receipt(
    'phase12_utility_*',
    'HorseLogic -> HorseTournamentUtility',
    'cash or existing tournament utility ownership',
    'Phase12',
    'phase12_seen',
    0.99
  ),
  receipt(
    'phase12_execution_*',
    'ServerTableEngineTurns',
    'authoritative action or retired decision accounting',
    'Phase12'
  ),
  receipt(
    'phase12_variant_*',
    'HorseLogic',
    'partition entering decisions by exact variant',
    'Phase12',
    'phase12_seen',
    0.99
  ),
  ...(['short_deck', 'pineapple', 'flh', 'flo8'] as const).map((variant) =>
    receipt(
      `phase12_${variant}_*`,
      'HorseLogic; ServerTableEngineTurns',
      'per-variant eligibility, completion, reason and final execution; depends on table mix',
      'Phase12'
    )
  ),
  receipt(
    'phase13_seen',
    'HorseLogic -> evaluateJointLivePolicy',
    'natural multiway and bomb-pot decisions entering the versioned policy',
    'Phase13'
  ),
  receipt(
    'phase13_eligible',
    'evaluateJointLivePolicy',
    'complete supported multiway and bomb-pot nodes',
    'Phase13'
  ),
  receipt(
    'phase13_fired',
    'evaluateJointLivePolicy',
    'completed bounded multiway and bomb-pot policy evaluation',
    'Phase13'
  ),
  receipt(
    'phase13_shadow_changed',
    'evaluateJointLivePolicy',
    'proposal differs from baseline; not a live action claim',
    'Phase13'
  ),
  receipt(
    'phase13_applied',
    'HorseLogic',
    'approved policy proposal accepted before final utility and enforcement',
    'Phase13'
  ),
  receipt(
    'phase13_baseline_retained',
    'HorseLogic',
    'shadow or unavailable policy retained the existing action',
    'Phase13'
  ),
  receipt(
    'phase13_reason_*',
    'evaluateJointLivePolicy',
    'exact selection or unavailable reason',
    'Phase13',
    'phase13_seen',
    0.99
  ),
  receipt(
    'phase13_street_*',
    'evaluateJointLivePolicy',
    'street coverage for completed policy evaluations',
    'Phase13',
    'phase13_fired',
    0.99
  ),
  receipt(
    'phase13_utility_*',
    'HorseLogic -> HorseTournamentUtility',
    'cash or existing tournament utility ownership',
    'Phase13',
    'phase13_seen',
    0.99
  ),
  receipt(
    'phase13_execution_*',
    'ServerTableEngineTurns',
    'authoritative action or retired decision accounting',
    'Phase13'
  ),
  receipt(
    'phase13_unavailable_utility_*',
    'HorseLogic -> HorseTournamentUtility',
    'explicit utility refusal, budget, context or legalization failure',
    'Phase13'
  ),
  receipt(
    'phase13_variant_*',
    'HorseLogic',
    'partition entering decisions by exact variant',
    'Phase13',
    'phase13_seen',
    0.99
  ),
  ...(
    ['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'short_deck', 'pineapple', 'flh', 'flo8'] as const
  ).map((variant) =>
    receipt(
      `phase13_${variant}_*`,
      'HorseLogic; ServerTableEngineTurns',
      'per-variant eligibility, completion, reason and final execution; depends on table mix',
      'Phase13'
    )
  ),
  receipt(
    'phase13_board_*',
    'HorseLogic',
    'actual controller board-count coverage',
    'Phase13',
    'phase13_seen',
    0.99
  ),
  receipt(
    'phase8_seen',
    'HorseLogic -> HorseTournamentPostflop',
    'natural tournament postflop decisions entering the Phase 8 gate',
    'Phase8'
  ),
  receipt(
    'phase8_eligible',
    'HorseTournamentPostflop',
    'canonical NLH single-board decisions with action-specific utility',
    'Phase8'
  ),
  receipt(
    'phase8_fired',
    'HorseTournamentPostflop',
    'completed bounded continuation evaluations',
    'Phase8'
  ),
  receipt(
    'phase8_shadow_changed',
    'HorseTournamentPostflop',
    'counterfactual differs from accepted baseline; not proof of changed play',
    'Phase8'
  ),
  receipt(
    'phase8_applied',
    'HorseTournamentPostflop',
    'promoted candidate accepted before authoritative enforcement',
    'Phase8'
  ),
  receipt(
    'phase8_baseline_retained',
    'HorseTournamentPostflop',
    'shadow or unavailable candidate preserves baseline',
    'Phase8'
  ),
  receipt(
    'phase8_reason_*',
    'HorseTournamentPostflop',
    'one explicit selection or fallback reason per observed decision',
    'Phase8',
    'phase8_seen',
    0.99
  ),
  receipt(
    'phase8_objective_*',
    'HorseTournamentPostflop',
    'objective partitions completed candidate evaluations',
    'Phase8',
    'phase8_fired',
    0.99
  ),
  receipt(
    'phase8_feature_*',
    'HorseTournamentPostflop',
    'specific geometry and objective evidence, not independent overwrites',
    'Phase8'
  ),
  receipt(
    'phase8_format_*',
    'HorseLogic',
    'format partitions every observed tournament postflop gate',
    'Phase8',
    'phase8_seen',
    0.99
  ),
  receipt(
    'phase8_execution_*',
    'ServerTableEngineTurns',
    'authoritative action acceptance, coercion, fallback or retired request',
    'Phase8'
  ),
  receipt(
    'phase7_objective_*',
    'HorseTournamentUtility.objectiveOf',
    'dedicated MTT, satellite, PKO, mystery, SNG and Spin objectives partition Phase 7 decisions',
    'Phase7',
    'phase7_tournament_utility',
    0.99
  ),
  receipt(
    'phase7_icm_*',
    'IcmModel.createIcmEquityEstimator',
    'exact final-table MH or direct bounded Plackett-Luce Monte Carlo method used by the selected utility ledger',
    'Phase7',
    'phase7_tournament_utility',
    0.99
  ),
  receipt(
    'phase7_utility_override',
    'HorseTournamentUtility.evaluateTournamentUtility',
    'action-specific utility overrode the legacy heuristic or solver proposal',
    'Phase7'
  ),
  receipt(
    'phase7_utility_skip_incomplete',
    'HorseLogic',
    'Phase 7 failed closed because the Phase 6 context was explicitly incomplete',
    'Phase7'
  ),
  receipt(
    'phase7_utility_unavailable',
    'HorseLogic',
    'a nominally complete betting decision could not produce a Phase 7 ledger; any live fire requires investigation',
    'Phase7'
  ),
  receipt(
    'phase7_unavailable_*',
    'HorseLogic -> HorseTournamentUtility',
    'the bounded fail-closed reason partitions every Phase 7 utility-unavailable receipt for production diagnosis',
    'Phase7',
    'phase7_utility_unavailable',
    0.99
  ),
  receipt(
    'phase7_utility_committed',
    'ServerTableEngineTurns.scheduleHorseAction',
    'the exact action selected by the Phase 7 ledger was accepted by the authoritative hand controller',
    'Phase7',
    'phase7_tournament_utility'
  ),
  receipt(
    'phase7_utility_coerced',
    'ServerTableEngineTurns.scheduleHorseAction',
    'a final legality belt changed the Phase 7-selected action before acceptance; every fire requires investigation',
    'Phase7'
  ),
  receipt(
    'phase7_utility_fallback',
    'ServerTableEngineTurns.scheduleHorseAction',
    'the Phase 7-selected action was rejected and the controller accepted the check/fold fallback; every fire requires investigation',
    'Phase7'
  ),
  receipt(
    'phase7_utility_not_executed',
    'ServerTableEngineTurns.scheduleHorseAction',
    'a Phase 7 evaluation did not reach an accepted action under its authority fence',
    'Phase7'
  ),
  receipt(
    'phase7_side_pot',
    'HorseTournamentUtility',
    'at least one evaluated action produced multiple canonical pot layers',
    'Phase7'
  ),
  receipt(
    'phase7_players_behind',
    'HorseLogic.phase7PlayersBehind',
    'the utility receipt included live actionable players behind hero',
    'Phase7'
  ),
  receipt(
    'phase7_bounty_utility',
    'HorseTournamentUtility',
    'PKO or bounty ownership and denial entered action utility',
    'Phase7'
  ),
  receipt(
    'v44_second_look',
    'ServerTableEngineTurns.scheduleHorseAction',
    'a close call/fold/all-in was replayed at 6x the equity sample inside the think time. When this reads 0, the v44_declined_* receipts below say WHICH gate closed - they partition every decision, so they and this one sum to `decide`',
    'V44',
    'decide',
    0.001
  ),
  receipt(
    'v44_second_look_flipped',
    'ServerTableEngineTurns.scheduleHorseAction',
    'the deeper read overturned the fast answer',
    'V44'
  ),
  /*
   * WHY THE SECOND LOOK DID NOT HAPPEN (2026-09-06).
   *
   * On 2026-09-05 this ledger's own data_unread rule reported
   * `v44_second_look fired 0 times against 2,121,841 decides (0.000%, expects
   * >= 0.100%)`. It caught the dead layer, and then nobody could say WHICH of
   * the five gates in secondLookPlan was closing - the plan returned a bare
   * null. The five reasons want opposite fixes (governor = capacity;
   * no_think_time = the tempo model; small_pot / action_shape = this ledger's
   * 0.1% expectation being wrong), so guessing between them is how a layer
   * stays dark for a week.
   *
   * They partition every horse decision: the gates are checked in order and
   * exactly one receipt fires per declined decision, so the five counts plus
   * v44_second_look sum to `decide`. No expectation is declared on any of
   * them - a decline is an observation, not a promise.
   */
  receipt(
    'v44_declined_not_facing_bet',
    'ServerTableEngineTurns.secondLookPlan',
    'no second look: the horse was not facing a bet, so there was no close call to re-read',
    'V44'
  ),
  receipt(
    'v44_declined_small_pot',
    'ServerTableEngineTurns.secondLookPlan',
    'no second look: the pot was under 20bb and not worth the deeper sample',
    'V44'
  ),
  receipt(
    'v44_declined_action_shape',
    'ServerTableEngineTurns.secondLookPlan',
    'no second look: the fast answer was a bet or raise, which the equity sample does not decide',
    'V44'
  ),
  receipt(
    'v44_declined_no_think_time',
    'ServerTableEngineTurns.secondLookPlan',
    'no second look: under 1500ms of think time to spend. A high count here is the tempo model, not the layer',
    'V44'
  ),
  receipt(
    'v44_declined_governor',
    'ServerTableEngineTurns.secondLookPlan',
    'no second look: EquityLoadGovernor was already shedding load (event-loop p50 over 40ms). A high count here is capacity, and it is the ONLY visibility the governor has outside the GameServer status payload',
    'V44'
  ),
  receipt(
    'v48_gto_deviation',
    'HorseLogic (V48) via HorsePersona.followsSolver',
    'a horse declined the solver consult on this spot; needs a persona with gtoAdherence under 1',
    'V48'
  ),
  receipt(
    'v48_straddle_enrolled',
    'ServerTableEngineDealing (V48) via HorsePersona.wantsStraddle',
    'a horse posted a VOLUNTARY straddle; straddle-enabled tables only',
    'V48'
  ),
  receipt(
    'v46_class_read',
    'HorseHandClasses.handClassRead via HorseLogic (V46)',
    'the hand SHAPE priced a preflop decision; Omaha and short-deck volume only',
    'V46'
  ),
  receipt(
    'v46_class_never_3bet',
    'HorsePreflop (V46)',
    'a rundown / broadway / dangler flatted where the bars said 3-bet',
    'V46'
  ),
  receipt(
    'v46_class_fold',
    'HorsePreflop (V46)',
    'trips or trash folded: the percentile rated a hand the game rates at zero',
    'V46'
  ),
  receipt(
    'v43_tempo_read',
    'HorseLogic (V43)',
    'a river big bet was priced by its tempo; needs a player with five snap or tank showdowns',
    'V43'
  ),
  receipt(
    'v41_tourney_leak_read',
    'HorseLogic (V41)',
    'a horse tagged for event stack-offs paid extra ICM premium; tournament volume only, needs tuner-written leaksTournament',
    'V41'
  ),
  receipt(
    'v41_limp_bloat_*',
    'HorseLogic (V41)',
    'read / cap: a horse tagged for limped-pot bloat, in a limped pot, facing a big bet; needs tuner-written leaks',
    'V41'
  ),
  // TAGS. Every leak tag the review system emits, with its reader.
  ...TAG_CONSUMERS,
];

/** Receipt families: `prefix_*` entries cover every telemetry key sharing the prefix. */
export function ledgerReceiptFor(feature: string): LedgerEntry | undefined {
  const exact = HORSE_DATA_LEDGER.find((e) => e.kind === 'receipt' && e.key === feature);
  if (exact) return exact;
  return HORSE_DATA_LEDGER.find(
    (e) => e.kind === 'receipt' && e.key.endsWith('*') && feature.startsWith(e.key.slice(0, -1))
  );
}

export function ledgerByKind(kind: LedgerKind): LedgerEntry[] {
  return HORSE_DATA_LEDGER.filter((e) => e.kind === kind);
}

/** The row shape horse_data_ledger stores (HorseDataLedgerSync upserts it). */
export interface LedgerRow {
  key: string;
  kind: LedgerKind;
  source: string;
  cadence: LedgerCadence;
  consumer: string;
  note: string;
  ratio_of: string | null;
  min_ratio: number | null;
  day_column: string | null;
  freshness_days: number | null;
  since: string;
}

export function ledgerRows(): LedgerRow[] {
  return HORSE_DATA_LEDGER.map((e) => ({
    key: `${e.kind}:${e.key}`,
    kind: e.kind,
    source: e.source,
    cadence: e.cadence,
    consumer: e.consumer,
    note: e.note,
    ratio_of: e.ratioOf ?? null,
    min_ratio: e.minRatio ?? null,
    day_column: e.dayColumn ?? null,
    freshness_days: e.freshnessDays ?? null,
    since: e.since,
  }));
}
