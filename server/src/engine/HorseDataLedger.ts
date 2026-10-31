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
 * prove is running. HorseDataLedger.test.ts checks source coverage; source presence alone
 * does not prove execution. Behavioral tests and accepted-action receipts
 * must separately prove use, and fn_audit_data_receipts turns the receipts
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
   *  (2026-09-05). A tag with consumer 'measurement' is recorded/reported but
   *  has no decision or candidate-adjustment reader. The daily audit keeps
   *  reporting high-volume measurement gaps; a helper definition is not use. */
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

/**
 * A RETIRED RECEIPT (2026-10-16). A telemetry key the brain no longer fires
 * because its code was renamed or removed. Registered so the daily audit
 * (fn_audit_layer_drift) reads its silence as the retirement it is, instead
 * of a layer that "was executing and is not any more": on 2026-10-15 about 110
 * of those warns were renamed or retired reason codes. Cadence legacy_unused,
 * no ratio, so fn_audit_data_receipts never judges it either. `retiredBy`
 * names the change that retired it; `source` means the key is gone from
 * server/src now (HorseDataLedger.test.ts proves it), anything else names a
 * change that has not landed on main yet and is proven when it does.
 */
export type RetiredBy = 'source' | 'policy_bundle_2026_10_16';
const retiredReceipt = (
  key: string,
  retiredBy: RetiredBy,
  note: string,
  since: string
): LedgerEntry => ({
  key,
  kind: 'receipt',
  source: 'horse_brain_telemetry (retired: no longer fired)',
  cadence: 'legacy_unused',
  consumer: `retired:${retiredBy}`,
  note,
  since,
});

/** Phase 12 pack reasons renamed when the round-3 pack replaced them (round3_*). */
export const RETIRED_PHASE12_REASONS = [
  'variant_protected_check',
  'variant_price_call',
  'variant_price_fold',
  'variant_value_bet',
  'variant_value_raise',
  'variant_draw_pressure',
  'preflop_defense',
  'preflop_entry_declined',
  'preflop_entry',
  'preflop_complete',
  'preflop_reraise',
  'preflop_call_off',
  'preflop_reshove',
  'split_price_call',
  'split_price_fold',
  'low_only_protected_check',
] as const;
const PHASE12_TELEMETRY_PREFIXES = [
  'phase12_',
  'phase12_short_deck_',
  'phase12_pineapple_',
  'phase12_flh_',
  'phase12_flo8_',
] as const;
const PHASE13_TELEMETRY_PREFIXES = [
  'phase13_',
  'phase13_nlh_',
  'phase13_plo4_',
  'phase13_plo5_',
  'phase13_plo6_',
  'phase13_plo8_',
  'phase13_short_deck_',
  'phase13_pineapple_',
  'phase13_flh_',
  'phase13_flo8_',
] as const;

export const RETIRED_RECEIPTS: LedgerEntry[] = [
  ...['horse_mind_mirror_learned', 'horse_mind_mirror_nothing_to_learn'].map((key) =>
    retiredReceipt(
      key,
      'source',
      'the pooled cross-shard mirror learner stopped on 2026-10-26 when live decisions moved to independent observer memory (2026-10-25-horse-observer-independent-memory); workerRuntime never invokes learnMirroredHand for live hands, so horse_mind_mirror_shed/_unavailable remain the only live mirror receipts',
      'V50'
    )
  ),
  retiredReceipt(
    'horse_opponent_memory_snapshot_applied',
    'source',
    'the pooled durable-profile snapshot import was removed on 2026-10-26 with independent observer memory; accepted public profiles now enter through the bounded worker cache (2026-10-26-horses-share-accepted-public-opponent-notes) and report under horse_opponent_memory_read_*',
    'V50'
  ),
  ...['horse_winner_read_hand', 'horse_winner_read_refused'].map((key) =>
    retiredReceipt(
      key,
      'source',
      'the floor-wide winner telemetry was replaced by individual original-participant completion receipts under horse_observer_*; the winner policy remains active inside each private observer sandbox',
      'V53'
    )
  ),
  ...PHASE12_TELEMETRY_PREFIXES.flatMap((prefix) =>
    RETIRED_PHASE12_REASONS.map((reason) =>
      retiredReceipt(
        `${prefix}reason_${reason}`,
        'source',
        `the pre-round-3 Phase 12 reason ${reason}; the round-3 pack names its outcomes round3_* (RemainingVariantLivePolicy) and never emits this one`,
        'Phase12'
      )
    )
  ),
  ...['phase10_', 'phase11_', 'phase11_plo5_', 'phase11_plo6_', 'phase11_plo8_'].map((prefix) =>
    retiredReceipt(
      `${prefix}reason_heads_up_big_blind_three_bet`,
      'source',
      'the heads-up big-blind three-bet reason of the earlier PLO packs; the round-3 packs name heads-up play heads_up_button_open / heads_up_position_stab',
      'Phase10'
    )
  ),
  retiredReceipt(
    'v44_declined_governor',
    'source',
    'the V44 second look no longer declines on the equity governor: the worker always decides at scale 1 and the second look is budgeted from the turn clock (2026-10-16)',
    'V44'
  ),
  // Retired by the 2026-10-16 policy bundle (a separate branch, hashed policy
  // files): the packs lose their wall-clock work budget and Phase 13 its
  // joint work budget. Registered here so the day they go silent is not ~20
  // warns; the ledger test proves them absent once the bundle is on main.
  ...PHASE13_TELEMETRY_PREFIXES.map((prefix) =>
    retiredReceipt(
      `${prefix}reason_work_budget`,
      'policy_bundle_2026_10_16',
      'the Phase 13 joint policy wall-clock work budget (JOINT_SAMPLE_WORK_BUDGET_MS), retired by the 2026-10-16 policy bundle',
      'Phase13'
    )
  ),
  ...[
    'phase10_',
    'phase11_',
    'phase11_plo5_',
    'phase11_plo6_',
    'phase11_plo8_',
    ...PHASE12_TELEMETRY_PREFIXES,
  ].map((prefix) =>
    retiredReceipt(
      `${prefix}reason_work_budget`,
      'policy_bundle_2026_10_16',
      'the policy pack wall-clock work budget (liveBudgetMs), retired by the 2026-10-16 policy bundle: an unavailable pack decision is now a sampler failure or missing evidence',
      'Phase10'
    )
  ),
];

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
 * that reads it, with measurement and diagnostic proposal boundaries explicit. EveryTagHasAConsumer.law.test.ts reads the detector source
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
  cadence: 'nightly',
  consumer,
  note:
    note +
    (consumer === 'measurement'
      ? '; measurement: nightly counts/study diagnostics only; no candidate-adjustment reader; no policy authority'
      : '; diagnostic proposal: runSelfTune reads rollups and calls diagnoseAndNudge; observational adapter retains the profile; no policy authority'),
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
  // Omaha stack-off diagnostics; proposals do not authorize policy adjustments.
  tag(
    'nonnut_flush_stackoff',
    'HorseSelfTuner.diagnoseAndNudge',
    'Omaha: cat-6 with two better flushes live; hold em: any better flush live',
    'V13'
  ),
  tag(
    'second_nut_flush_stackoff',
    'HorseSelfTuner.diagnoseAndNudge',
    'Omaha cat-6 with one better flush live',
    'V13'
  ),
  tag(
    'dominated_straight_stackoff',
    'HorseSelfTuner.diagnoseAndNudge',
    'Omaha non-nut straight at showdown',
    'V13'
  ),
  tag('coldcall_stackoff', 'measurement', 'cold-called a raise, lost 40bb+', 'V23'),
  tag(
    'plo_naked_trips_stackoff',
    'measurement',
    'trips on a paired board, no redraw, 100bb+',
    'V38'
  ),
  tag('plo_toppair_no_redraw_stackoff', 'measurement', 'top pair no redraw, 100bb+', 'V38'),
  // Hold em stack-off diagnostics (NLH_STACKOFF_TAGS).
  tag(
    'top_pair_weak_kicker_stackoff',
    'measurement',
    'top pair, kicker nine or worse, 40bb+',
    'V24'
  ),
  tag('weak_kicker_trips_stackoff', 'measurement', 'board trips, dominated kicker, 40bb+', 'V24'),
  tag(
    'one_pair_river_stackoff',
    'measurement',
    'one pair of hero own (overpair or a good-kicker hit) committed on the river on an unpaired, not three-suited board, 40bb+',
    'V24'
  ),
  tag(
    'one_pair_turn_stackoff',
    'measurement',
    'single-board showdown one-pair shape with turn commitment, mirrored on wins; not turn decision EV or strategy authority',
    'V24'
  ),
  tag(
    'board_paired_two_pair_stackoff',
    'measurement',
    'two pair where one pair is the board own, so board cards counterfeit or outkick it, 40bb+',
    'V24'
  ),
  tag(
    'plo_paired_board_nut_stackoff',
    'measurement',
    'Omaha nut flush or nut straight lost at showdown on a paired board, where every raise is a full house',
    'V15'
  ),
  tag(
    'straight_into_flush_stackoff',
    'measurement',
    'straight on a three-flush board - since 2026-09-13 also flagged in Omaha, where it is recorded and reviewed but deliberately NOT in PLO_STACKOFF_TAGS',
    'V21'
  ),
  tag('nonnut_straight_stackoff', 'measurement', 'non-nut straight at showdown', 'V21'),
  tag('underfull_stackoff', 'measurement', 'bottom boat', 'V21'),
  // River escalation diagnostics (RIVER_WAR_TAGS).
  tag('river_raise_war', 'measurement', 'two or more aggressive river actions, lost', 'V21'),
  tag('river_raise_paidoff', 'measurement', 'bet the river, called a raise, lost', 'V23'),
  // Limped-pot diagnostics (LIMP_BLOAT_TAGS).
  tag('limped_pot_bloat', 'measurement', 'entered for one blind, lost 40bb+', 'V23'),
  // Preflop audit proposals, including the historical tournament premium.
  tag(
    'preflop_stackoff',
    'HorseSelfTuner.diagnoseAndNudge',
    '40bb+ in with no postflop action',
    'V13'
  ),
  // fold family -> tuner bluff dial
  tag('big_bet_fold', 'HorseSelfTuner.diagnoseAndNudge', 'invested 20bb+ then folded', 'V13'),
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
    'ordinary value bets that ran into the top of the range; outcome totals compared with river_aggr_won by fn_audit_river_aggression_ev; those totals do not establish counterfactual EV',
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
    'Omaha bottom boat, 100bb+; historical V40 study category; no validated causal adjustment reader',
    'V40'
  ),
  tag(
    'plo_set_stackoff',
    'measurement',
    'split from plo_naked_trips on an unpaired board; recorded for investigation; no validated causal adjustment reader',
    'V40'
  ),

  // ── V49 FREQUENCY LEAKS. Emitted by SQL over horse_daily_play, read by the
  // nightly audit (fn_audit_frequency_leaks) and by the panel card. The same
  // bands HorseSelfTuner.BENCH tunes the dials against, so the audit and the
  // tuner cannot disagree about what a leak is.
  sqlTag(
    'freq_too_loose',
    'fn_audit_frequency_leaks',
    'VPIP over 32% across 1,000+ cash hands',
    'V49'
  ),
  sqlTag('freq_too_tight', 'fn_audit_frequency_leaks', 'VPIP under 19%', 'V49'),
  sqlTag(
    'freq_limp',
    'fn_audit_frequency_leaks',
    'under 55% of voluntary entries were raises - the rest are limps and cold calls',
    'V49'
  ),
  sqlTag(
    'freq_over_fold_3bet',
    'fn_audit_frequency_leaks',
    'folds over 62% of the time to a 3-bet',
    'V49'
  ),
  sqlTag('freq_sticky_vs_3bet', 'fn_audit_frequency_leaks', 'folds under 35% to a 3-bet', 'V49'),
  sqlTag(
    'freq_surrender_flops',
    'fn_audit_frequency_leaks',
    'wins under 40% of the flops it sees',
    'V49'
  ),
  sqlTag(
    'freq_passive_postflop',
    'fn_audit_frequency_leaks',
    'postflop aggression factor under 1.2',
    'V49'
  ),
  sqlTag(
    'freq_spewy_postflop',
    'fn_audit_frequency_leaks',
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
  {
    ...flag(
      'mindObservationHand',
      'worker-owned table/allocated-hand coordinate separates basic observation deduplication across tables; null refuses ingestion, omission preserves direct/offline legacy compatibility; not an accepted-hand UUID or learning authority',
      'Phase15',
      'HorseLogic.decide -> HorseMind.observe'
    ),
    source:
      'HorseDecisionWorkerRuntime.executeFast -> horseMindHandFromDecision(original request); caller options cannot supply it',
  },
  {
    ...flag(
      'mindPlanContext',
      'worker-owned hand namespace binds future-street plan reads/effects and FAST/DEEP replay; explicit unavailable hand prevents a live legacy-key fallback, omission preserves direct/offline compatibility; not controller acceptance authority',
      'Phase15',
      'HorseLogic.decidePostflop -> horsePlanHandKey -> HorseMind plan reads/effects'
    ),
    source:
      'HorseDecisionWorkerRuntime.executeFast/executeDeep -> horsePlanContextFromDecision(original request); caller options cannot supply it',
  },
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
  flag(
    'barrelContinuationOutlook',
    'default-off planned turn barrel records its private river outlook without re-rolling intent; requires incremental qualification',
    'Continuation outlook'
  ),
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
  flag(
    'v15Boats',
    'Omaha boat dominance: a full house a bigger boat beats calls a raise (default OFF, league plo5_v15_boats)',
    'V15'
  ),
  flag('v16Reads', 'deep reads: fold-to-c-bet, fold-to-3-bet, big-bet tells', 'V16'),
  flag('v16Icm', 'real ICM (Malmuth-Harville) in tournaments', 'V16'),
  flag(
    'v16Hu',
    'heads-up postflop overlay; DEFAULT OFF since 2026-10-05 (hu_v16_overlay -0.26 +/- 0.10 over 31 nights)',
    'V16'
  ),
  flag('v16Blockers', 'river unblocker bluffs', 'V16'),
  flag('v16SizeCond', 'big-bet-conditioned sampling', 'V16'),
  flag('v16PloPolar', 'PLO polarity read', 'V16'),
  flag(
    'v16Ratio',
    'DEFAULT OFF and DEAD BY PRECEDENCE since V38 (2026-09-03): both gates it rescales sit below the V38 call/fold return; league matchup retired 2026-09-05 after 0.00 +/- 0.00 over 12,000 hands',
    'V16'
  ),
  flag('v17Pos', 'players-behind bluff pressure', 'V17'),
  flag(
    'v17RiverProbe',
    'river probe into a capped field; DEFAULT OFF since 2026-10-16 (v17_river_probe -0.11 +/- 0.04 pooled over 8 nights)',
    'V17'
  ),
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
  flag('v23Variants', 'plo8 low-only draw discipline (plo8_v23_lowdraw)', 'V23'),
  flag(
    'v23ShortDeck',
    'the short-deck half of the V23 variant polish; DEFAULT OFF since 2026-10-16 (shortdeck_v23 -0.36 +/- 0.14 over 44 runs)',
    'V23'
  ),
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
  flag(
    'v32FacingDefense',
    'solver facing-bet defense; DEFAULT OFF since 2026-10-16 (v32_facing_defense -0.31 +/- 0.15 over 41 runs)',
    'V32'
  ),
  flag('v33DepthCeiling', 'solver depth ceiling (300bb)', 'V33'),
  flag('v37Satellite', 'satellite survival play', 'V37'),
  flag('v38Ev', 'the EV engine arbiter for solverless games and the MDF river', 'V38'),
  flag(
    'v40Omaha',
    'Omaha is not hold em: tiered sampler, pressure cap, small ball, tag loop',
    'V40'
  ),
  flag(
    'holdemPremiumAggression',
    'NLH premiums (QQ+, AK) never passive: raise preflop, keep betting postflop; dominated offsuit hands fold to a big 3-bet (Dan 2026-10-25); false only to ablate an older layer',
    'Hold em premium aggression'
  ),
  flag(
    'holdemDominatedFold',
    'internal: false skips the NLH dominated-hand 3-bet fold at the commit-time recheck, which has no opponent reads to honour the maniac law with',
    'Hold em premium aggression'
  ),
  flag(
    'ploPairedBoardFold',
    'PLO4/PLO5/PLO6 no full house on a paired flop, turn or river folds to a committing bet (Dan 2026-10-25); false only to ablate an older layer',
    'PLO paired-board fold'
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
    'v46ShortDeck',
    'the short-deck half of the V46 chart; DEFAULT OFF since 2026-10-05 (shortdeck_v46_classes -0.51 +/- 0.15 over 960k hands)',
    'V46'
  ),
  flag(
    'v51RiverFlat',
    'a committed river one-pair hand calls instead of jamming (league v51_river_flat)',
    'V51'
  ),
  flag(
    'smallPotNearNutRiverValue',
    'default-off PLO4/5/6 single-board small-pot near-nut river value candidate, qualification pending; only removes random call after existing value and safety gates',
    'Small-pot near-nut value'
  ),
  flag(
    'v55OmahaRiverTripsFlat',
    'river Omaha weak sets/trips retain call pricing without re-shoving; default off pending deep-cash league qualification',
    'V55'
  ),
  flag(
    'v56OmahaPressureRange',
    'river vulnerable set/trips versus tier-three pressure on one Omaha-high cash board; qualified fixed400bb cash card, explicit off arm retained',
    'V56'
  ),
  flag(
    'v57TournamentAggression',
    'Dan 2026-10-25 NLH tournament aggression: wider opens, 3-bets and big blind defence against the opener width, a shade wider 3-bet defence to 60bb, and more planned turn barrels; explicit off arm retained for the historical neutrality corpus',
    'V57'
  ),
  flag(
    'v61RiverOnePairShade',
    'Hold em one-pair (or board-paired two pair) river calls are shaded 6-12 equity points against the price unless the bettor reads as an over-bluffer; measured 14-day review stack-offs won 14-22% at prices demanding 20-40%; explicit off arm retained',
    'V61'
  ),
  flag(
    'v66BetRaisedOnePair',
    '2026-10-31 Hold em flop/turn bet-then-raised one pair (or air with no real draw): hero own wager this street no longer counts toward commitment, the call carries a raise shade of up to 0.10 equity scaled by the raise size, and the class calls or folds at that price without jamming; measured 7-day review calls won 33-36% at an average raise of 0.86 pot; explicit off arm retained',
    'V66'
  ),
  flag(
    'v67RiverBetRaisedOnePair',
    '2026-10-31 Hold em river bet-then-raised one pair (or board-paired two pair): the raiser is sampled from a river raise stratum (10% bluff, otherwise 75/22/3 two pair+/top pair/weaker), the call carries the V63 shade plus 0.10 (cap 0.25) even under a V62 polar read, and the class calls or folds at that price without the 0.42 floor or a jam; measured 7-day review calls/jams won 11.9% cash (n=226) and 19.2% MTT (n=125) at an average raise of 0.72 pot; explicit off arm retained',
    'V67'
  ),
  flag(
    'v67RiverRaiseShadeOverride',
    'league calibration arm (2026-10-31): overrides the V67 extra river raise shade for a league card; inert unless set; production never sets it',
    'V67-league'
  ),
  flag(
    'v64RiverRaiseNeedsTwoPair',
    '2026-10-31 Hold em river raise discipline: facing a river wager on one board, one pair, high card and board-paired two pair never value-raise or bluff-raise (a measured over-folder read keeps the blocker bluff-raise); they fall through to the V38 call verdict with the V61 shade. Live review: one-pair raises won 34% (-4,184bb cash), air raises 7% (-1,696bb cash), two pair+ raises about +16,000bb; explicit off arm retained',
    'V64'
  ),
  flag(
    'v63LargeRiverBetShade',
    '2026-10-31 the V61 one-pair river shade steepens past a half-pot wager and caps at 20 points from a pot-sized wager (0.7-pot: 12, V61 8); measured over the latest 19,933 NLH review hands large-wager one-pair calls won 13.3% (119/897) against a 41%+ price and medium 20.7% against 29-41%; league cards positive at 100-200bb, noise at 25-40bb; explicit off arm retained',
    'V63'
  ),
  flag(
    'v63RiverShadeShapeOverride',
    'league calibration arm (2026-10-31): overrides the V63 shade shape (slope, cap, knee) for a league card; inert unless set; production never sets it',
    'V63-league'
  ),
  flag(
    'v62RiverBettorPolarity',
    "2026-10-30 Hold'em river bettor polarity: a river wager's sampled hand is drawn from a bluff / two pair+ / top pair / weaker pair stratum by bet size; OPT-IN since 18:50 UTC after the mirror league resolved it negative against horses (-3.67 +/- 1.02 bb/100 at 200bb) while V61 alone resolved +1.30 +/- 0.41; re-enable only after a recalibrated stratum resolves positive",
    'V62'
  ),
  flag(
    'tournamentFlatBump',
    'league calibration arm (2026-10-30): tournament call bar facing a single open raised by 0 < x <= 0.2; inert unless set; +0.06 measured -1.11 +/- 0.51 bb/100 at 100bb and +0.41 +/- 0.31 at 40bb in the MTT mirror',
    'V62-league'
  ),
  flag(
    'v60CashPressure',
    'Dan 2026-10-24 NLH cash pressure: blinds and late position value 3-bet a single open from their measured hand shares, re-steal volume matches the tournament layer, and the opener defends a 3-bet from the top 10% in position and top 8% out of it up to 100bb; explicit off arm retained for the neutrality corpus',
    'V60'
  ),
  flag(
    'v65TurnOnePairShade',
    '2026-10-31 Hold em one-pair (or board-paired two pair) TURN calls of a wager hero did not initiate are shaded by the price, zero at a quarter-pot wager and 12 points from a pot-sized one, off the equity handed to the call test; draws, the raised-after-own-bet branch and a measured over-bluffer read are untouched; measured 7-day review hands: cash n=1,727 won 33% (about -308,000bb/week), tournament n=1,542 won 37% (about -185,000bb/week); explicit off arm retained',
    'V65'
  ),
  flag(
    'v65TurnShadeCapOverride',
    'League-only cap override for the V65 turn shade (0.12 shipped; 0.08 fallback cut); production never sets it',
    'V65-league'
  ),
  flag(
    'v68TurnAirDrawCalls',
    '2026-10-31 Hold em high-card TURN calls of a wager hero did not initiate: the implied-odds bonus is withheld facing 0.7 pot or more when the effective stack behind after the call is under 1.5x the pot after it, and high card with no real draw that V65 left unshaded (a gutshot or board-only shape) carries the V65 price shade unless the bettor reads as a measured over-bluffer; real draws keep their equity; measured 7-day review hands: cash n=494 won 29.6% (about -62,000bb/week), tournament n=383 won 36.8% (about -25,000bb/week); explicit off arm retained',
    'V68'
  ),
  flag(
    'v68AirShadeScaleOverride',
    'League-only scale on the V68 air shade (1 shipped; 0.5 half-strength fallback); production never sets it',
    'V68-league'
  ),
  flag(
    'v69TurnCallGaps',
    '2026-10-31 Hold em single-board TURN call gaps left by V65/V68: one-pair calls lose the implied-odds bonus facing 0.7 pot or more with under 1.5x the pot behind after the call, the V65 draw exemption counts only a draw a hole card is part of, and the opt-in V32 draw pass-through falls through to the normal line when there is no room to be paid; explicit off arm retained',
    'V69'
  ),
  flag(
    'v70GtoOpeningRanges',
    "2026-10-31 Hold'em raise-first-in (unopened, unlimped, two or more dealt in): the hand is read on its seat's own GTO reference order by dealt-in players behind (SB 1 .. 9-handed UTG 8) mapped onto the preflop score scale by combo share, against per-seat target widths (cash LJ 16, HJ 20.5, CO 26.5, BTN 43, SB 41 raise plus a limp band to 58; full-ring UTG 11/UTG+1 12.5/UTG+2 14; big blind ante LJ 23, HJ 26, CO 34, BTN 51, SB 48, UTG 17.5 before the ICM premium; three-handed BTN 47/54 and SB 44/50, heads-up SB 72/76 raise plus a limp band to 90/94); at four or more dealt the push/fold and orange/red M-zone jam-or-fold structure (<= 22bb) is untouched, while two- and three-handed jam-or-fold applies only at <= 15bb (the table-size-scaled M had put every heads-up and spin stack under 22bb into it); the SB opens ~3x without an ante deeper than 25bb; an ante-free tournament under 50bb keeps the old depth tighten; style tightness, ICM premium, bubble and maniac bars unchanged; explicit off arm retained",
    'V70'
  ),
  flag(
    'v52RangeAdvantage',
    'heads-up postflop public-range advantage drives the range c-bet, V38 initiative and PLO small sizes (league v52_range_advantage)',
    'V52'
  ),
  flag(
    'comboDrawPressure',
    'candidate-only legal heads-up cash flop/turn combo-draw pressure, priced against calling with the continuing-range/rake model; default off pending independent incremental qualification',
    'Combo draw pressure'
  ),
  flag(
    'multiwayRiverBluffCheckRaise',
    'separately unqualified default-off extension using exact original-dealt cash context and fully conserved public check/bet/raise/response snapshots; no guessed fold priors',
    'Multiway river check-raise'
  ),
  flag(
    'riverBluffCheckRaise',
    'candidate-only zero-showdown-equity priced 3x river check-raise using own-observer same-line fold responses; default off pending qualification',
    'River check-raise'
  ),
  flag(
    'riverPositionDefense',
    'candidate-only priced HU cash river defense against a credible wide entrant whose own public conditional last-to-act betting rate is excessive; default off pending independent qualification',
    'River position defense'
  ),
  flag(
    'v53PloTourneyIcm',
    'default-off candidate: PLO4/5/6 standard tournament preflop action-risk ICM shifts, requires independently qualified whole-tournament comparison',
    'V53'
  ),
  flag(
    'v53Pressure',
    'read-gated pressure on a credibly aggressive human: wider in-position 3-bets, flop/turn value and semi-bluff raises of a wide bettor, river bluffs into a credible over-folder (league v53_pressure)',
    'V53'
  ),
  flag(
    'v58Plo6RiverNuts',
    'PLO6 paired-board river nut discipline: facing a bet, fold a hand a random six-card hand beats 15% of the time unless the price is tiny, and call instead of raising one beaten 5% of the time (league plo6_v58_river_nuts)',
    'V58'
  ),
  flag(
    'v59Plo6RiverUnpaired',
    'PLO6 unpaired-board river discipline: facing a bet, fold a hand a random six-card hand beats 30% of the time unless the price is tiny, and call instead of raising one beaten 15% of the time (league plo6_v59_river_unpaired)',
    'V59'
  ),
  flag(
    'drawOutlookQuality',
    'NLH continuation planning excludes shared board improvements and dirty straight outs; false retains the historical outlook for paired offline comparisons',
    'Draw outlook quality'
  ),
  flag(
    'committedRaiseDiscipline',
    'the existing NLH raised-hand call-only rule also guards the earlier committed-stack branch; false isolates the historical branch for paired offline comparisons',
    'Committed raise discipline'
  ),
  flag(
    'callDeductionPricing',
    'canonical cash calls price actual capped rake and BBJ on matched awards after uncalled returns; false retains the historical marginal-rate approximation for offline comparisons',
    'Net call deductions'
  ),
  flag(
    'v54RiverBluff',
    'targeted heads-up river big bet / shove bluff with air, blockers, a value story, a capped non-station opponent; DEFAULT OFF until league v54_river_bluff and plo4/plo5/plo6_v54_river_bluff resolve positive',
    'V54'
  ),
  flag(
    'phase7Utility',
    'final action-specific tournament utility across payout, bounty and recovery components; defaults on and runs after every global strategy layer',
    'Phase7'
  ),
  flag(
    'phase8PolicyFamily',
    'internal Phase 8 family: isolated benchmark selection or worker-derived genuine protected guard authority; omitted from public live options and overwritten at the worker boundary',
    'Phase8'
  ),
  flag(
    'phase8Postflop',
    'tournament postflop counterfactual; shadow by default; live candidate mode only under protected-release qualified authority (worker-owned, never caller-supplied)',
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
    "separate Short Deck/Pineapple/FLH/FLO8 policies; shadow by default; live candidate only from the worker's own P12.3 pack authority (cash), never from a caller",
    'Phase12'
  ),
  flag(
    'phase12EvidenceMode',
    'offline fixed-work remaining-variant clock; rejected by the live decision worker',
    'Phase12'
  ),
  flag(
    'phase14',
    'caller may disable the worker-owned corrective functional policy; never requests candidate authority',
    'Phase14',
    'horseDecision/workerRuntime.phase14Admission'
  ),
  flag(
    'phase14Corrective',
    'branded worker-local original-state corrective capability; refused from IPC and unavailable without qualified catalog and current S4 composition',
    'Phase14',
    'HorseLogic corrective_policy node'
  ),
  flag(
    'phase13Joint',
    "joint multiway and bomb policy; shadow by default; live candidate only from the worker's own P13.3 authority for the decision's variant (cash), never from a caller",
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
    'diagnostic telemetry for ignored historical review fields; never authorizes policy or sampling changes',
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
    ] as const
  ).map(
    ([key, note]): LedgerEntry => ({
      key,
      kind: 'param',
      source: 'STYLE_PARAMS[style] resolved with HorseProfileMods in HorseLogic.decide',
      cadence: 'per_action',
      consumer: 'HorseLogic.decide / HorsePreflop.decidePreflopV7',
      note,
      since: key === 'familyBias' ? 'V18' : 'V2',
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
            ? 'HorseLogic.leakLoad (diagnostic only); HorseLogic.decide (ignored-evidence receipt)'
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
  mind(
    'riverCallSD',
    'shown hands whose last river action was a call (2026-10-25)',
    'HorseMind.riverCallLightTendency -> HorseLogic river bluff/thin-value read'
  ),
  mind(
    'riverCallSDWeak',
    '... shown as one pair or worse (a light river call)',
    'HorseMind.riverCallLightTendency -> HorseLogic river bluff/thin-value read'
  ),
  mind(
    'riverLastToActOpps',
    'own public observer-window last-to-act river opportunities, reconstructed from original accepted history; no pooled persistence claim',
    'HorseMind.riverLastToActRead / candidate riverPositionDefense'
  ),
  mind(
    'riverLastToActBets',
    'bets among those same last-to-act river opportunities, not a bluff count',
    'HorseMind.riverLastToActRead / candidate riverPositionDefense'
  ),
  mind(
    'riverTripleCheckRaiseOpps',
    'completed responses to exact 3x heads-up river check-raises in own public history',
    'HorseMind.riverTripleCheckRaiseRead / candidate riverBluffCheckRaise'
  ),
  mind(
    'riverTripleCheckRaiseFolds',
    'folds among the same exact 3x river check-raise responses',
    'HorseMind.riverTripleCheckRaiseRead / candidate riverBluffCheckRaise'
  ),
  mind(
    'riverHu',
    'at most 64 exact variant/asset/stakes/ante/original-census contexts with independent bet/check opportunity denominators and completed public raise responses, explicit overflow, no pooled persistence',
    'HorseMind.multiwayRiverRead / separate multiwayRiverBluffCheckRaise candidate'
  ),
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
  state(
    'humanUserIds',
    'PLO presumption: the seats a person plays, from the engine roster; server-side only'
  ),
  state('heroSeat', 'seat whose private cards and action are being decided'),
  state('currentPlayerSeat', 'authoritative HandController turn owner'),
  state('legalActions', 'authoritative action menu including reopen and structure rules'),
  state('toCall', 'authoritative amount owed by hero'),
  state('minRaiseTo', 'minimum absolute legal wager or raise-to'),
  state('maxRaiseTo', 'maximum absolute legal wager after structure and table caps'),
  state('bettingStructure', 'no-limit, pot-limit or fixed-limit rule selected by the live hand'),
  state('fixedBetSize', 'fixed-limit street bet; null in other structures'),
  state(
    'fixedLimitSmallBet',
    "the hand's effective fixed-limit small bet (raised on a kill hand); null in other structures"
  ),
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
  state('smallBlind', 'actual hand small blind for exact qualified feature economics'),
  state('bigBlind', 'stake'),
  state('dealerSeat', 'button (position reads)'),
  state(
    'blindSeats',
    'seats HandController posted the blinds from; small blind null when dead (tournament dead button). PLO4 pack positions',
    'Plo4LivePolicy.plo4CanonicalPosition'
  ),
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
    'Phase 6 context: tournament facts and actual dealt-hand blinds/census/M; immutable successful cache provenance is bound by the worker and v2 attribution through the accepted execution witness/journal. Provenance is observational and excluded from policy sampling; legacy v1 evidence remains unqualified for this new source join.',
    'HorseDecisionWorkerRuntime.assertPhase6TournamentSnapshot; HorseLogic.icmRisk / decidePreflopV7 / endgameAdjust / satelliteRead / evaluateTournamentUtility'
  ),

  // ─────────────────────────────────────────────────────────────────────────
  // TABLES. What the services compile and where it goes.
  // ─────────────────────────────────────────────────────────────────────────
  table(
    'horse_observation_discovery_epochs',
    'minute',
    'HorseObservationDiscovery via fn_discover_horse_observation_requests; fn_prune_horse_observation_discovery',
    'private bounded source-window discovery progress and retained gaps; roster discovery does not establish observation-time coverage, journal completion or model activation',
    'Phase14'
  ),
  table(
    'horse_observation_discovery_segments',
    'minute',
    'fn_discover_horse_observation_requests; fn_prune_horse_observation_discovery',
    'private source snapshots, atomic-hand and actor digests, frozen novel actors and bounded admission cursor; pending membership survives source removal and restart',
    'Phase14'
  ),
  table(
    'horse_observation_discovery_members',
    'minute',
    'fn_discover_horse_observation_requests through canonical fn_admit_horse_observation_capture; fn_prune_horse_observation_discovery',
    'private deduplicated actor-to-original-window request references; admission and membership commit together without financial or policy writes',
    'Phase14'
  ),
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
    'HorseObservationCapture via fn_finish_horse_observation_capture_witness and legacy fn_finish_horse_observation_capture; HorseCaptureEvidence via fn_horse_observation_capture_evidence; fn_prune_horse_observation_captures',
    'private immutable accepted-slice acknowledgments; exact source-read witnesses commit with journal admission and cursor advance; bounded revision-fenced evidence recovery compares independent journal receipts; legacy missing witnesses and unfinished gaps stay explicit without establishing source coverage',
    'Phase14'
  ),
  table(
    'horse_exploit_profiles',
    'per_hand',
    'HorseOpponentMemory via fn_horse_exploit_profiles_read; worker prerequisite read and monotonic import',
    'private public-action counters, retained across sessions by exact variant, cash/tournament and dealt size; accepted hand trigger owns persistence',
    'V50',
    { dayColumn: 'updated_at', freshnessDays: 1 }
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
    'HorseSelfTuner (unapplied review proposals); HorseTunerObservationalAudit (preserved profile)',
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
    'fn_audit_layer_silence_and_coverage, fn_audit_layer_drift, fn_audit_data_receipts (BrainTelemetryFlush writes through fn_horse_brain_flush_receipt)',
    'per-day fire counts per layer (BrainTelemetryFlush)',
    'V15',
    { dayColumn: 'day', freshnessDays: 1 }
  ),
  table(
    'horse_commitment_audit_days',
    'nightly',
    'fn_horse_commitment_audit_step',
    'durable eligibility-sweep counters and cursor; repeated recent-day passes are not complete source watermarks or completed GTO reviews',
    'Phase14'
  ),
  table(
    'horse_commitment_reviews',
    'nightly',
    'fn_horse_commitment_audit_step',
    'strictly over10BB cumulative commitment including refunds, or unknown eligibility; private diagnostics with unmatched replay/reference and no policy authority',
    'Phase14'
  ),
  table(
    'horse_commitment_audit_gaps',
    'nightly',
    'fn_horse_commitment_audit_step',
    'retained source/identity/fact gaps and conflicts observed during the independent daily eligibility sweep; no financial-source mutation',
    'Phase14'
  ),
  table(
    'horse_brain_flush_receipts',
    'nightly',
    'fn_horse_brain_flush_receipt via BrainTelemetryFlush and HorseBrainTelemetryPublisher',
    'private atomic batch deduplication with source identity; accepted batches only, not a complete decision ledger',
    'Phase15'
  ),
  table(
    'horse_journaled_model_sweep',
    'nightly',
    'fn_claim_horse_journaled_model_statistics and fn_finish_horse_journaled_model_statistics via HorseJournaledOpponentModels',
    'private leased cursor for bounded raw and retained sufficient-statistics diagnostic reconstruction; not a source watermark',
    'Phase14'
  ),
  table(
    'horse_journaled_opponent_models',
    'nightly',
    'fn_finish_horse_journaled_model_statistics via HorseJournaledOpponentModels',
    'private latest scoped frequency and holdout reports; no causal EV, source completeness or activation authority',
    'Phase14'
  ),
  table(
    'horse_decision_latency',
    'nightly',
    'the panel; fn_horse_brain_flush_receipt (BrainTelemetryFlush atomically writes counters and latency with source receipts)',
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
    'database-bound per-decision evidence for the promoted V31 runtime corpus: exact state, sampled and final action, execution match, reference mix, recomputed regret, and complete dataset/cell source seal. NO FRESHNESS WINDOW (2026-09-28): rows exist only while a gto_v31_datasets row is active, and none has ever been (0 rows, ever, on 2026-09-28). A two-day window filed data_stale critical every night for a pipeline that was never started; certified_v31_missing is the reader for that fact. Restore { dayColumn: run_date, freshnessDays: 2 } in the commit that commissions V31.',
    'Phase4'
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
  receipt(
    'horse_feature_authority_withdrawn_before_acceptance',
    'ServerTableEngineTurns qualified feature acceptance gate',
    'Rejects a prepared feature decision whose exact qualification authority was withdrawn before controller acceptance',
    'Feature authority'
  ),
  receipt(
    'horse_observer_history_*',
    'HorseOwnPublicHistory original observer load',
    'Unavailable original history and source/deadline/provider failures remain distinct from an empty learned read',
    'Individual public history'
  ),
  receipt(
    'horse_river_nodes_unavailable',
    'HorseOwnPublicHistory public node sidecar loader',
    'Original public history retained unchanged when source, binding, bounds or structural evidence is unavailable',
    'Multiway river reads'
  ),
  receipt(
    'horse_decision_refused_isolated',
    'LiveHorseDecisionWorkerClient.refuseDecision',
    'a worker decision whose receipt or effects the client refused; isolated to its own seat (check or fold), never engine-fatal',
    '2026-10-22'
  ),
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
    'gto_miss_* / gto_skip_too_deep / gto_served_beyond_depth_ceiling / gto_depth_fallback; NLH solver misses by reason',
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
    'vpip_floor_call_down',
    'HorseLogic (VPIP floor)',
    'under its target, called a small preflop price instead of folding (2026-10-17)',
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
  // No floor: v15Boats is default OFF, so silence is the expected state until
  // the plo5_v15_boats league matchup resolves and the default changes.
  receipt(
    'v15_boat_dominated',
    'HorseLogic (V15 boats)',
    'Omaha full house read as dominated by a bigger boat or quads',
    'V15'
  ),
  receipt(
    'v15_boat_gate',
    'HorseLogic (V15 boats)',
    'dominated boat raised after betting called instead of re-raising',
    'V15'
  ),
  // No floor: v16Hu is default OFF since 2026-10-05, so silence is expected
  // until a league matchup resolves positive and the default changes.
  receipt('v16_hu_overlay', 'HorseLogic (V16)', 'heads-up overlay; opt-in (v16Hu)', 'V16'),
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
    // 2026-10-05: per CASH decision. The tell needs a river bettor with a
    // big-bet showdown history, which is a cash-table read; per fleet decide
    // it swung 1.8-5.9 per 1,000 with the tournament share alone, per cash
    // decision it held 6.5-11.5 (2026-09-24..10-05).
    'big-bet showdown tell consulted; measured per cash decision',
    'V16',
    'phase13_utility_cash',
    0.004
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
  // No floor: v17RiverProbe is default OFF since 2026-10-16, so silence is
  // expected until a league matchup resolves positive and the default changes.
  receipt(
    'v17_river_probe',
    'HorseLogic (V17)',
    'river probe into a capped field; opt-in (v17RiverProbe)',
    'V17'
  ),
  receipt('v17_catch_block', 'HorseLogic (V17)', 'call-side blocker', 'V17', 'decide', 0.0005),
  // 2026-10-16 opponent exploit (HorseOpponentExploit). No floor: these fire
  // only against an opponent whose decayed read is credibly outside the
  // horse-population envelope, which horse-versus-horse play almost never is.
  // 2026-10-22 maniac pressure (HorseOpponentExploit.maniacRaiseWidth). No
  // floor: these fire only against an opponent read as a maniac, which no
  // horse-like read ever is.
  receipt(
    'maniac_pressure_preflop',
    'HorseLogic (maniac pressure)',
    "a maniac raised or is still to act: its shoves and re-raises priced by equity, opens capped to what continues, no bluff raises (Dan: 'NOT RAISE A HAND WITH THE INTENTION OF FOLDING')",
    'OPPX'
  ),
  receipt(
    'river_bluff_checkraise_evaluated',
    'HorseLogic.riverBluffCheckRaise',
    'priced candidate, not qualification or accepted action',
    'River check-raise'
  ),
  receipt(
    'river_bluff_checkraise_selected',
    'HorseLogic.riverBluffCheckRaise',
    'positive lower-bound bluff proposal; authoritative acceptance remains separate',
    'River check-raise'
  ),
  receipt(
    'river_position_defense_evaluated',
    'HorseLogic.maniacCallDown',
    'conditional public river rate admitted the existing range/price recovery; evaluation, not a bluff verdict or accepted-use proof',
    'River position defense'
  ),
  receipt(
    'river_position_defense_call',
    'HorseLogic.maniacCallDown',
    'the original fold became a priced call under the conditional river candidate; proposal only until authoritative action acceptance',
    'River position defense'
  ),
  receipt(
    'maniac_call_down_checked',
    'HorseLogic (maniac pressure)',
    "a fold facing a maniac's bet was re-checked against equity versus its preflop range",
    'OPPX'
  ),
  receipt(
    'postflop_maniac_call_down_checked',
    'HorseLogic (maniac pressure)',
    'a fold facing the bet of a player who limps and then pots every street was re-checked against equity (2026-10-22)',
    'OPPX'
  ),
  receipt(
    'maniac_short_stack_jam',
    'HorseLogic (maniac pressure)',
    'a short tournament stack opening into a maniac moved all in instead of raising to fold to the shove (2026-10-22)',
    'OPPX'
  ),
  receipt(
    'v58_short_stack_maniac_no_flat',
    'HorseLogic (maniac pressure)',
    'a push/fold tournament stack facing a wide raiser was priced for the jam, never the flat (Dan 2026-10-25, bubble hand 48403158)',
    'OPPX'
  ),
  receipt(
    'v58_short_stack_maniac_jam',
    'HorseLogic (maniac pressure)',
    'a push/fold tournament stack facing a wide raiser moved all in because its equity pays for the jam (2026-10-25)',
    'OPPX'
  ),
  receipt(
    'v58_short_stack_no_flat',
    'HorseLogic (maniac pressure)',
    'the preflop all-in price answered a push/fold tournament stack with the jam or the fold, never the flat (2026-10-25)',
    'OPPX'
  ),
  receipt(
    'v58_low_spr_stack_off',
    'HorseLogic (tournament aggression)',
    'a tournament holdem hand with at most one pot behind and the equity to want it all in moved all in instead of checking (2026-10-25)',
    'OPPX'
  ),
  receipt(
    'v58_one_card_low_flush_fold',
    'HorseLogic (tournament aggression)',
    'a one-card low flush on a four-flush board folded instead of calling off a tournament stack (2026-10-25)',
    'OPPX'
  ),
  receipt(
    'v58_made_hand_cell_skip',
    'HorseLogic (tournament aggression)',
    'a set, straight, flush or better was bet by the value ladder instead of following a hand-class-mean solver cell that cannot see it (2026-10-26)',
    'OPPX'
  ),
  receipt(
    'v57_turn_cell_initiative_skip',
    'HorseLogic (tournament aggression)',
    'a tournament flop bettor played the turn from its barrel plan, not the check-heavy turn cell keyed without initiative (2026-10-25)',
    'OPPX'
  ),
  receipt(
    'maniac_call_down',
    'HorseLogic (maniac pressure)',
    "a fold facing a maniac's bet became the call its equity pays for (Dan: 'CALL OFF LIGHTER')",
    'OPPX'
  ),
  receipt(
    'opponent_exploit_preflop',
    'HorseLogic (opponent exploit)',
    "a raiser or limper read outside the horse envelope moved a preflop bar (Dan: 'raising and potting at a 100% VPIP')",
    'OPPX'
  ),
  receipt(
    'opponent_exploit_postflop',
    'HorseLogic (opponent exploit)',
    'traps against a read aggressor or bigger value sizes into a read station',
    'OPPX'
  ),
  receipt(
    'opponent_exploit_calldown',
    'HorseLogic (opponent exploit)',
    "the current bettor's own read priced the call instead of the table average",
    'OPPX'
  ),
  receipt(
    'v58_plo6_river_fold',
    'HorseLogic (V58 PLO6 river nuts)',
    "a PLO6 river bet on a paired board was folded because a random hand beats the hand 15% of the time or more (Dan: 'IF ITS NOT THE NUTS, ITS PROBABLY NOT GOOD')",
    'V58'
  ),
  receipt(
    'v58_plo6_river_raise_to_call',
    'HorseLogic (V58 PLO6 river nuts)',
    'a PLO6 river raise on a paired board became a call because a better hand was possible',
    'V58'
  ),
  receipt(
    'v59_plo6_river_unpaired_fold',
    'HorseLogic (V59 PLO6 river, unpaired board)',
    'a PLO6 river bet on a board with no pair was folded because a random hand beats the hand 30% of the time or more',
    'V59'
  ),
  receipt(
    'v59_plo6_river_unpaired_raise_to_call',
    'HorseLogic (V59 PLO6 river, unpaired board)',
    'a PLO6 river raise on a board with no pair became a call because a random hand beats it 15% of the time or more',
    'V59'
  ),
  receipt(
    'opponent_exploit_corroborated',
    'HorseMind (opponent exploit)',
    "a statistic past every horse at this table size engaged because the same player's other table size engaged it (2026-10-25)",
    'OPPX'
  ),
  receipt(
    'plo_opponent_presumed_aggressive',
    'HorseMind (PLO presumption)',
    'an Omaha opponent received the shared aggressive raise prior before their own public hands proved otherwise (owner update 2026-10-27)',
    'OPPX'
  ),
  receipt(
    'plo_opponent_presumption_disproved',
    'HorseMind (PLO presumption)',
    "an opponent's own public hands disproved the shared Omaha raise presumption, identically for people and horses",
    'OPPX'
  ),
  retiredReceipt(
    'plo_human_presumed_aggressive',
    'source',
    "a person at an Omaha table read as an aggressive raiser before their own hands proved it (Dan: 'TAG THEM ALL FROM THE START')",
    'OPPX'
  ),
  retiredReceipt(
    'plo_human_presumption_disproved',
    'source',
    "a person's own hands showed raising no higher than the average horse, so the PLO presumption came off",
    'OPPX'
  ),
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
    'river_call_light_read',
    'HorseLogic (river call read)',
    'heads-up river vs a light river caller: fewer bluffs, thinner value',
    '2026-10-25'
  ),
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
    'v70_gto_open',
    'HorsePreflop (V70)',
    "Hold'em raise-first-in read on the seat's GTO reference order (unopened, unlimped, two or more dealt in)",
    'V70',
    'decide_nlh',
    0.01
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
  // No floor: v32FacingDefense is default OFF since 2026-10-16, so silence is
  // expected until a league matchup resolves positive and the default changes.
  receipt(
    'v32_*',
    'GtoFacingDefenseV32 (V32)',
    'facing-bet defense verdicts and misses; opt-in (v32FacingDefense)',
    'V32'
  ),
  // No floor: the V34 draw pass-through lives inside the V32 facing-bet block
  // (HorseLogic gates it on opts.v32FacingDefense === true), and V32 is default
  // OFF since 2026-10-16, so this receipt reads zero by design. A floor here
  // raised a false critical data_unread every night (2026-10-18 audit).
  receipt(
    'v34_defend_draw_passthrough',
    'HorseLogic (V34)',
    'solver draw call honored; opt-in with v32FacingDefense',
    'V34'
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
    'v61_river_one_pair_shade',
    'HorseLogic (V61)',
    'Hold em one-pair river call shaded against the price',
    'V61',
    'decide',
    0.001
  ),
  receipt(
    'v66_bet_raised_one_pair',
    'HorseLogic (V66)',
    'Hold em flop/turn one-pair call of a raise over hero own bet priced with the raise shade or released from commitment',
    'V66',
    'decide',
    0.001
  ),
  receipt(
    'v66_raise_stratum',
    'HorseLogic (V66) via HorseEval',
    'Hold em flop/turn raiser over hero own wager sampled from the raise stratum',
    'V66',
    'decide',
    0.001
  ),
  receipt(
    'v67_river_bet_raised_one_pair',
    'HorseLogic (V67)',
    'Hold em river one-pair call of a raise over hero own river bet priced with the V63 shade plus the raise shade',
    'V67',
    'decide',
    0.001
  ),
  receipt(
    'v67_river_raise_stratum',
    'HorseLogic (V67) via HorseEval',
    'Hold em river raiser over hero own wager sampled from the river raise stratum',
    'V67',
    'decide',
    0.001
  ),
  receipt(
    'v64_river_raise_needs_two_pair',
    'HorseLogic (V64)',
    'Hold em bluff-catch class redirected from a river raise to the call verdict',
    'V64',
    'decide',
    0.0001
  ),
  receipt(
    'v63_large_river_bet_shade',
    'HorseLogic (V63)',
    'Hold em one-pair river call shaded more than the V61 shape would have (steeper past a half-pot wager, cap 0.20)',
    'V63',
    'decide',
    0.0005
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
    'v65_turn_one_pair_shade',
    'HorseLogic (V65)',
    'Hold em one-pair turn call of a wager hero did not initiate, shaded against the price',
    'V65',
    'decide',
    0.001
  ),
  receipt(
    'v68_turn_air_draw_calls',
    'HorseLogic (V68)',
    'Hold em high-card turn call of a wager hero did not initiate, implied odds withheld or air shaded against the price',
    'V68',
    'decide',
    0.001
  ),
  receipt(
    'v69_turn_call_gaps',
    'HorseLogic (V69)',
    'Hold em turn call re-priced: one-pair implied odds withheld, board-only draw no longer exempting the V65 shade, or V32 draw pass-through withheld with no room to be paid',
    'V69',
    'decide',
    0.001
  ),
  receipt(
    'v38_preflop_allin_price',
    'HorseLogic.decidePreflop',
    'preflop all-in priced against the complete committed population with actor-aligned range bands',
    'V38',
    'decide',
    0.002
  ),
  receipt(
    'v38_preflop_price_unavailable',
    'HorseLogic.decidePreflop',
    'the committed-population price read failed or exceeded physical card capacity; range fallback retained without inventing an opponent or neutral equity',
    'V38'
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
    'holdem_dominated_3bet_fold',
    'HorseLogic.decide (HorseHoldemPremiumAggression)',
    'NLH offsuit dominated hand calling or raising a big 3-bet turned into a fold',
    'Hold em premium aggression'
  ),
  receipt(
    'holdem_premium_preflop_raise',
    'HorseLogic.decide (HorseHoldemPremiumAggression)',
    'NLH QQ+/AK limp, check or flat preflop turned into a standard raise',
    'Hold em premium aggression'
  ),
  receipt(
    'holdem_premium_postflop_bet',
    'HorseLogic.decide (HorseHoldemPremiumAggression)',
    'NLH overpair QQ+ or AK top pair check postflop turned into a value bet',
    'Hold em premium aggression'
  ),
  receipt(
    'short_all_in_call_floor',
    'HorseLogic.decide (HorseShortAllInCallFloor)',
    'Tournament fold facing an all in under 3 big blinds with 20+ big blinds behind turned into a call',
    'Short all-in call floor'
  ),
  receipt(
    'short_all_in_call_floor_commit',
    'ServerTableEngineTurns.scheduleHorseAction (HorseShortAllInCallFloor)',
    'The same floor at the commit door, after an authority withdrawal or a liveness fallback produced the fold',
    'Short all-in call floor'
  ),
  receipt(
    'plo_paired_board_fold',
    'HorseLogic.decide (HorsePloPairedBoardFold)',
    'PLO4/PLO5/PLO6 call, raise or jam without a full house on a paired flop, turn or river turned into a fold',
    'PLO paired-board fold'
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
    'phase14_review_signal_ignored',
    'HorseLogic.decide',
    'historical review fields were present and excluded from decision adjustments; diagnostic only',
    'Phase14'
  ),
  receipt(
    'phase14_accepted_roster_refused',
    'HorseDecisionWorkerRuntime.executeObservation',
    'a completed-hand observation carried an accepted actor roster transport that did not validate or bind to that hand; the hand was observed and journaled without it (explicit unknown); not a settlement fault',
    'Phase14'
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
    'phase10_range_*',
    'evaluatePlo4LivePolicy -> HorseLogic (P10.1 input binding)',
    'range status of every bound PLO4 proposal (not_consumed_preflop, unavailable, rejected_malformed, rejected_population, consumed_unattributed, consumed); counts only, never calibration or solver evidence',
    'Phase10',
    'phase10_eligible',
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
    'phase10_selection_*',
    'HorseLogic -> ServerTableEngineTurns (P10.3)',
    'none, shadow change (never applied), authority-backed cash selection, controller acceptance or withdrawal before acceptance; never a tournament objective selection',
    'Phase10'
  ),
  receipt(
    'phase10_authority_*',
    'HorsePhase10Authority (HorseQualifiedAuthority) -> workerRuntime / client / ServerTableEngineTurns (P10.3)',
    'protected-release PLO4 authority admission, local withdrawal and acceptance-time verdicts',
    'Phase10'
  ),
  receipt(
    'phase10_shadow_receipt_binding_dropped',
    'horseDecision/client (P10 audit F8)',
    'a shadow-only PLO4 receipt whose input binding failed the strict validator was dropped with its ownership record; the decision kept its actual action and the worker stayed up (an applied receipt still fails closed)',
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
    'phase11_range_*',
    'evaluateOmahaVariantPolicy -> HorseLogic (P11.1 input binding)',
    'range status of every bound PLO5/PLO6/PLO8 proposal (not_consumed_preflop, unavailable, rejected_malformed, rejected_population, consumed_unattributed, consumed); counts only, never calibration or solver evidence',
    'Phase11',
    'phase11_eligible',
    0.99
  ),
  receipt(
    'phase11_shadow_receipt_binding_dropped',
    'horseDecision/client (P11.1, the P10 audit F8 rule)',
    'a shadow-only PLO5/PLO6/PLO8 receipt whose input binding failed the strict validator was dropped with its ownership record; the decision kept its actual action and the worker stayed up (an applied receipt still fails closed)',
    'Phase11'
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
    'phase11_selection_*',
    'HorseLogic -> ServerTableEngineTurns (P11.3)',
    'none, shadow change (never applied), authority-backed cash selection of the deciding pack, controller acceptance or withdrawal before acceptance; never a tournament objective selection',
    'Phase11'
  ),
  receipt(
    'phase11_authority_*',
    'HorsePhase11Authority (HorseQualifiedAuthority, one gate per pack) -> workerRuntime / client / ServerTableEngineTurns (P11.3)',
    'protected-release PLO5/PLO6/PLO8 authority admission per pack, local withdrawal and acceptance-time verdicts',
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
    'phase12_range_*',
    'evaluateRemainingVariantPolicy -> HorseLogic (P12.1 input binding)',
    'range status of every bound Short Deck/Pineapple/FLH/FLO8 proposal (not_consumed_preflop, unavailable, rejected_malformed, rejected_population, consumed_unattributed, consumed); counts only, never calibration or solver evidence',
    'Phase12',
    'phase12_eligible',
    0.99
  ),
  receipt(
    'phase12_selection_*',
    'HorseLogic -> ServerTableEngineTurns (P12.3)',
    'none, shadow change (never applied), authority-backed cash selection of the deciding pack, controller acceptance or withdrawal before acceptance; never a tournament objective selection',
    'Phase12'
  ),
  receipt(
    'phase12_authority_*',
    'HorsePhase12Authority (HorseQualifiedAuthority, one gate per pack) -> workerRuntime / client / ServerTableEngineTurns (P12.3)',
    'protected-release Short Deck/Pineapple/FLH/FLO8 authority admission per pack, local withdrawal and acceptance-time verdicts',
    'Phase12'
  ),
  receipt(
    'phase12_shadow_receipt_binding_dropped',
    'horseDecision/client (P12.1, the P10 audit F8 rule)',
    'a shadow-only Short Deck/Pineapple/FLH/FLO8 receipt whose binding (P12.1 inputs or the P12-B net-action economics) failed the strict validator was dropped with its ownership record; the decision kept its actual action and the worker stayed up (an applied receipt still fails closed)',
    'Phase12'
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
    'phase13_range_*',
    'evaluateJointLivePolicy -> HorseLogic (P13.1 input binding)',
    'range status of every bound multiway or bomb-pot proposal (consumed, unavailable); counts only, never calibration or solver evidence',
    'Phase13',
    'phase13_eligible',
    0.99
  ),
  receipt(
    'phase13_response_*',
    'evaluateJointActions -> evaluateJointLivePolicy -> HorseLogic (P13-A, P13.1)',
    'response model that priced each fired proposal (one_response_then_showdown, bounded_raise_tree) and every named response-tree refusal (joint_response_branch_unavailable, joint_response_street_unavailable, joint_response_street_not_modeled, joint_response_illegal_simulated_action, joint_response_branch_mass); counts only, never calibration',
    'Phase13'
  ),
  receipt(
    'phase13_selection_refused_*',
    'HorseLogic (P13.1)',
    'an applied Phase 13 candidate refused before it could act: illegal_candidate (the legalizer would rewrite it) or earlier_phase_applied (a Phase 10/11/12 candidate already owned the action)',
    'Phase13'
  ),
  receipt(
    'phase13_selection_*',
    'HorseLogic -> ServerTableEngineTurns (P13.3)',
    "none, shadow change (never applied), authority-backed cash selection of the decision's variant, controller acceptance or withdrawal before acceptance; never a tournament objective selection, never on top of an applied Phase 10/11/12 candidate (the named refusals are phase13_selection_refused_*)",
    'Phase13'
  ),
  receipt(
    'phase14_original_reads_unavailable',
    'horseDecision/workerRuntime.executeFast',
    'an admitted corrective path could not capture its original private read frame; baseline retained',
    'Phase14'
  ),
  receipt(
    'phase14_authority_*',
    'HorsePhase14Authority -> worker/client/physical and Lightning acceptance',
    'per-domain protected authority/composition admission, withdrawal and acceptance/effect verdicts',
    'Phase14'
  ),
  receipt(
    'phase14_selection_*',
    'HorsePhase14Acceptance',
    'selection withdrawn before acceptance or exact controller-accepted correction; never submission proof',
    'Phase14'
  ),
  receipt(
    'phase14_execution_*',
    'HorsePhase14Acceptance after settleHorseExecutionWitness',
    'actual controller witness outcome for an original-state correction',
    'Phase14'
  ),
  receipt(
    'phase13_authority_*',
    'HorsePhase13Authority (HorseQualifiedAuthority, one gate per joint variant) -> workerRuntime / client / ServerTableEngineTurns (P13.3)',
    'protected-release joint authority admission per variant, local withdrawal and acceptance-time verdicts',
    'Phase13'
  ),
  receipt(
    'phase13_shadow_receipt_binding_dropped',
    'horseDecision/client (P13.1, the P10 audit F8 rule)',
    'a shadow-only Phase 13 receipt whose P13.1 binding failed the strict validator was dropped; the decision kept its actual action and the worker stayed up (an applied receipt still fails closed)',
    'Phase13'
  ),
  receipt(
    'phase8_family_catastrophe_guard_v1',
    'HorseLogic -> HorseTournamentCatastropheGuard',
    'an actual bounded guard assessment at the tournament continuation node, distinct from legacy continuation work',
    'Phase8'
  ),
  receipt(
    'phase8_work_kind_phase7_candidate_guard',
    'HorseLogic -> HorseTournamentCatastropheGuard',
    'a Phase 7 candidate guard assessment; no rollout, future-hand or continuation work is claimed',
    'Phase8'
  ),
  receipt(
    'phase8_seen',
    'HorseLogic -> HorseTournamentPostflop or HorseTournamentCatastropheGuard',
    'natural tournament postflop decisions entering the selected Phase 8 family; guard assessments carry an exact family and work-kind counter',
    'Phase8'
  ),
  receipt(
    'phase8_eligible',
    'HorseTournamentPostflop or HorseTournamentCatastropheGuard',
    'canonical NLH single-board decisions with action-specific utility admitted by the selected family',
    'Phase8'
  ),
  receipt(
    'phase8_fired',
    'HorseTournamentPostflop or HorseTournamentCatastropheGuard',
    'selected-family continuation evaluations or bounded guard assessments; the guard family claims no future-hand work',
    'Phase8'
  ),
  receipt(
    'phase8_completed',
    'HorseLogic -> HorseTournamentPostflop or HorseTournamentCatastropheGuard',
    'completed selected-family work: useful continuation or bounded guard assessment, never controller acceptance',
    'Phase8',
    'phase8_eligible'
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
    'objective partitions evaluated candidate attempts before final gates',
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
    'phase8_selection_*',
    'HorseLogic -> ServerTableEngineTurns',
    'none, shadow change (never applied), authority-backed selection, controller acceptance or withdrawal before acceptance',
    'Phase8'
  ),
  receipt(
    'phase8_authority_*',
    'HorseQualifiedAuthority -> workerRuntime / client / ServerTableEngineTurns',
    'protected-release authority admission, local withdrawal and acceptance-time verdicts',
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
  /*
   * WHY A TOURNAMENT DECISION HAD NO COMPLETE CONTEXT (2026-10-16). About
   * 10.5% of tournament decisions read phase6_tournament_context_incomplete
   * (163-167k a day) and nothing said which issue closed it. The engine names
   * every issue of an incomplete context once per decision
   * (ServerTableEngineTurns.noteTournamentContextIssues), from the list
   * TournamentBrainContext and the table projection build.
   */
  receipt(
    'phase6_context_issue_*',
    'ServerTableEngineTurns.noteTournamentContextIssues',
    'one per issue of a live tournament decision whose Phase 6 context was not complete: the TournamentBrainContext issue (tournament_context_warming, payout_or_ticket_structure_missing, level_timing_*, ...) or the table projection issue (blind_level_cache_lag, dealer_seat_missing, ...), and the context status (status_warming, status_stale, status_incomplete)',
    'Phase6'
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
    'HorseDecisionWorkerRuntime.executeDeep',
    'a second look completed at increased equity depth with the original HorseMind reads; declined, missing-read, cancelled and failed work is not a completed evaluation',
    'V44',
    'decide',
    0.001
  ),
  receipt(
    'phase15_hand_binding_*',
    'HorseCommittedDecisionTracker',
    'private memory-only decision-to-accepted-hand reconciliation; bound names the exact committed UUID and unfiltered action ordinal, while gaps/conflicts stay unavailable; not durable capture, source completeness or GTO correctness',
    'Phase15'
  ),
  receipt(
    'phase15_journal_*',
    'HorseDecisionJournalPublisher',
    'private host-local journal capture, queue admission, exact disk acknowledgement or explicit gap; enqueued is not durable, recorded is not complete coverage, full replay or a GTO verdict',
    'Phase15'
  ),
  // 2026-09-26: a named archive quota pauses capture instead of ending it.
  // These three keep paused-at-quota apart from failed (capture_unavailable).
  receipt(
    'phase15_journal_capture_paused_capacity',
    'HorseDecisionJournalPublisher.record',
    'a capture offered while the journal is paused at a named archive quota (archive_bytes, archive_segments, archive_catalog_capacity, archive_storage_capacity); the record is still queued within the same bound, and the same call also counts enqueued or queue_capacity; paused is not failed, and capture_unavailable still counts a journal that stopped for good',
    'Phase15'
  ),
  receipt(
    'phase15_journal_capacity_paused',
    'HorseDecisionJournalPublisher.pause',
    'the writer refused an append at a named archive quota and capture paused with its queue kept; the writer is probed read-only once a minute; not a failure, not a deletion and not a retry',
    'Phase15'
  ),
  receipt(
    'phase15_journal_capacity_resumed',
    'HorseDecisionJournalPublisher.capacityAnswer',
    'a capacity probe found room and capture resumed; the kept queue is replayed with the same event identities and digests, so a record already held is replayed, never written twice',
    'Phase15'
  ),
  receipt(
    'phase15_discard_capture_unavailable',
    'LiveHorseDecisionWorkerClient.observeDiscardExecution',
    'private accepted-discard evidence could not be queued or acknowledged; an explicit capture gap, not evidence that the controller discard failed',
    'Phase15'
  ),
  receipt(
    'phase15_telemetry_batch_expired',
    'BrainTelemetryFlush.flush',
    'a retained pending telemetry batch exceeded the 32-day receipt window and was explicitly refused without aggregation; this is an evidence gap',
    'Phase15'
  ),
  receipt(
    'phase15_brain_exception',
    'HorseLogic.decide',
    'a policy exception produced an explicit check/fold liveness fallback; the private error is not part of the action receipt',
    'Phase15'
  ),
  receipt(
    'phase15_second_look_reads_unavailable',
    'HorseDecisionWorkerRuntime.executeFast and executeDeep',
    'private original-read capture was refused, or a second-look frame was missing, invalid, expired, evicted, ambiguous, consumed or identity-mismatched; preserve the valid fast action and refuse a missing-read second look recoverably',
    'Phase15'
  ),
  receipt(
    'phase15_reference_plans_retired',
    'HorseDecisionWorkerRuntime.executeFast',
    'reference-layer future-street plans were discarded because their exact wager did not survive the final policy selection',
    'Phase15'
  ),
  receipt(
    'phase15_plan_issue_*',
    'HorseDecisionWorkerRuntime.executeFast',
    'finite original-batch issuance outcomes: issued, no_effects, capacity_unavailable or reissue_unavailable; the total bound stays 128 and pending ownership is not evicted; issuance is not accepted-wager or application proof',
    'Phase15'
  ),
  receipt(
    'phase15_plan_accepted_*',
    'ServerTableEngineTurns.scheduleHorseAction',
    'the original FAST wager was accepted with no_effects, capacity_unavailable or reissue_unavailable; no effects is distinct from an unavailable nonempty batch, and none of these outcomes claims successful plan application',
    'Phase15'
  ),
  receipt(
    'phase15_plan_refused_*',
    'HorseDecisionWorkerRuntime.executeEffectCommit/executeEffectRetirement',
    'finite refusal reasons: issue_absent, issue_ambiguous, issue_failed, issue_retired, no_effects, binding_mismatch or effects_mismatch; refusal applies no new effects and does not authorize retrying an accepted wager',
    'Phase15'
  ),
  receipt(
    'phase15_plan_retirement_*',
    'HorseDecisionWorkerRuntime.executeEffectRetirement / LiveHorseDecisionWorkerClient.retireDecisionEffects',
    'exact local retirement reports retired, already_retired, already_applied_volatile, issue_absent or issue_failed; client unconfirmed is a transport gap that may retain pending capacity, not proof of retirement or rollback of an applied batch',
    'Phase15'
  ),
  receipt(
    'phase15_plan_terminal_*',
    'HorseDecisionWorkerRuntime.issuePlanBatch',
    'expired or evicted terminal records are reclaimed within the existing bounded map; pending issued records are excluded; reclamation limits duplicate-ACK retention and does not establish durable recovery',
    'Phase15'
  ),
  receipt(
    'phase15_plan_applied_volatile',
    'HorseDecisionWorkerRuntime.executeEffectCommit',
    'the exact detached issued effects applied once in this worker before its ACK; not durable accepted-effect storage, restart recovery or historical replay',
    'Phase15'
  ),
  receipt(
    'phase15_plan_already_applied_volatile',
    'HorseDecisionWorkerRuntime.executeEffectCommit',
    'an exact same-process duplicate was acknowledged from a retained applied record without applying effects again; not fresh-process replay or a new application',
    'Phase15'
  ),
  receipt(
    'phase15_plan_apply_failed',
    'HorseDecisionWorkerRuntime.executeEffectCommit',
    'application threw and may have left partial volatile writes; the batch remains failed without a success ACK or automatic retry, and its materialized state is not certified complete',
    'Phase15'
  ),
  receipt(
    'phase15_plan_commit_posted',
    'LiveHorseDecisionWorkerClient.commitDecisionEffects',
    'Phase 15.1: an owned nonempty batch was posted for application with its exact controller-accepted wager; accepted intent in transit, not application and not durability',
    'Phase15'
  ),
  receipt(
    'phase15_plan_receipt_*',
    'HorseDecisionWorkerRuntime.recordPlanReceipt / HorseDecisionJournalPublisher',
    'Phase 15.1 durable accepted-effect receipt: applied or failed is the first terminal transition captured with its exact batch digest and accepted wager; unavailable means no journal sink or a refused receipt; durable counts only the private writer exact fsynced ACK of a receipt record, never enqueue',
    'Phase15'
  ),
  receipt(
    'phase15_plan_recovery_*',
    'HorseDecisionWorkerRuntime.recoverPlanReceipts',
    'Phase 15.1 fresh-process reconstruction outcome per receipt: replaced by keyed replacement into the same live hand, street and lease, or refused as invalid, conflict, failed_not_replayed, hand_not_live, table_mismatch, hand_superseded, lease_superseded, street_superseded, generation_expired or policy_withdrawn; owned_conflict is a batch this epoch already owns',
    'Phase15'
  ),
  receipt(
    'phase15_graph_*',
    'HorsePolicyGraph.run/finish',
    'live outer graph started, completed or failed; no claim of full internal distribution coverage or authoritative table execution',
    'Phase15'
  ),
  receipt(
    'phase15_node_*',
    'HorsePolicyGraph.run',
    'eight finite outer nodes count entry, completion, failure and produced/changed/retained actions; component duration is published through the existing bounded latency flush; invocation is not candidate eligibility',
    'Phase15'
  ),
  receipt(
    'phase15_policy_*',
    'HorseLogic.decide',
    'finite registered variant outcomes: reference, disabled, computed, outside_domain or unavailable; unregistered input refuses before policy execution',
    'Phase15'
  ),
  receipt(
    'phase15_reference_agreement_*',
    'fn_run_horse_reference_agreement (HorseReferenceAgreementReport, daily)',
    'one per validated live FAST decision: <variant>_<cash|tournament>_<exact|action|differ|unrecorded>, the final policy action against the action the graph reference node produced (HorsePolicyLedgerObserver); agreement with the reference is not strength and not GTO',
    'Phase15'
  ),
  receipt(
    'phase15_reference_divergence_*',
    'fn_run_horse_reference_agreement (HorseReferenceAgreementReport, daily)',
    'for a live FAST decision that left the reference action or amount, <variant>_<node>: the first policy graph node whose transition changed it',
    'Phase15'
  ),
  receipt(
    'phase15_deep_brain_exception_retired',
    'ServerTableEngineTurns.scheduleHorseAction',
    'a failed deep evaluation was retired while the original fast decision and its execution authority were retained',
    'Phase15'
  ),
  receipt(
    'phase15_execution_*',
    'HorseExecutionWitness.countFinal',
    'one terminal memory-witness outcome per returned decision, bound to the controller accepted record; not a durable decision ledger',
    'Phase15'
  ),
  ...(['fast', 'deep', 'worker_fallback'] as const).map((lane) =>
    receipt(
      `phase15_${lane}_execution_*`,
      'HorseExecutionWitness.countFinal',
      `terminal execution-witness outcomes from the ${lane} lane, and for not_executed the retirement reason (retired_<reason>); failed or discarded computation is distinct from accepted policy intent`,
      'Phase15'
    )
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
   * The planning gates are checked in order and exactly one receipt fires
   * per declined plan. An eligible plan can still be cancelled, fail or lose
   * its original read view, so those declines plus completed second looks do
   * not partition all decisions. No expectation is declared on any of
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
    'no second look: under 1500ms of the turn clock left (less the engine margin) when the fast answer arrived. Budgeted from the turn clock since 2026-10-16; a high count here is the worker queue eating the clock, which is capacity. (The governor gate, v44_declined_governor, was retired the same day: the worker always decides at scale 1)',
    'V44'
  ),
  /*
   * THE ACTION WAITS FOR THE DEEPER READ (2026-10-16). 96% of the deep looks
   * started on 2026-10-16 never acted because the think timer fired before
   * the answer came back. The action now waits for it inside the turn clock.
   * `awaited` counts actions that outlived their chosen think time to wait;
   * `hold_expired` counts the ones whose deep answer still did not arrive by
   * the clock budget, so the fast answer acted.
   */
  receipt(
    'v44_second_look_awaited',
    'ServerTableEngineTurns.scheduleHorseAction',
    'the chosen think time ended with the second look still out, so the action waited for it inside the turn clock',
    'V44'
  ),
  receipt(
    'v44_second_look_hold_expired',
    'ServerTableEngineTurns.scheduleHorseAction',
    'the second look did not land inside the turn-clock budget; the fast answer acted. A count here is worker capacity',
    'V44'
  ),
  /*
   * ONE FLOOR, ONE READ (2026-10-16). Every completed hand reaches every
   * decision-worker shard; the shards that do not own its table learn it
   * (horseDecision/mindMirror.ts). learned / duplicate / nothing_to_learn /
   * refused from the worker; shed (the client's bound) and unavailable (the
   * job failed or expired) from the client.
   */
  receipt(
    'horse_continuation_*',
    'HorseLogic premium 3-bet, terminal flop and call-side barrel budget',
    'real-card value raise, funded short-stack flop wager or next-street call budget; no holdings or player identifiers',
    'V50'
  ),
  receipt(
    'horse_observer_*',
    'HorseDecisionWorkerRuntime',
    'individual public-read admission, original-participant completion learning, unscoped-profile refusal and explicit missing-context/cutoff/capacity gaps; counters alone never prove independent fleet coverage or strategy qualification',
    'V45'
  ),
  receipt(
    'horse_opponent_memory_*',
    'HorseDecisionWorkerRuntime durable profile import',
    'authoritative public-action snapshot applied or refused; no player identifiers or cards leave the worker',
    'V50'
  ),
  {
    ...receipt(
      'horse_pooled_public_bootstrap_*',
      'HorseDecisionWorkerRuntime startup public-profile hydration',
      'boot-only observation: loaded means a finite saved public-profile batch was read, unavailable means the read failed or exceeded its bounds, and refused means cache admission rejected the batch; none proves decision consumption, independent history, complete fleet coverage or activation',
      'V50'
    ),
    cadence: 'boot',
  },
  receipt(
    'horse_mind_mirror_*',
    'LiveHorseDecisionWorkerPool.observeCompletedHand',
    'a bounded cross-shard completion delivery was shed or unavailable; a delivered mirror learns only for the original individual participants registered on that worker and never authorizes pooled reads',
    'V50'
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
  // No floor: the spot (committed, river, one pair, clearing the call bar)
  // is rare by construction; silence on a quiet day is not a dead layer.
  receipt(
    'small_pot_near_nut_value_flat_exception',
    'HorseLogic PLO6 final paired-board flat branch',
    'private original value-branch legal raise retained without intervening action changes below the unchanged fold threshold; accepted execution remains separate',
    'Small-pot near-nut value'
  ),
  receipt(
    'small_pot_near_nut_value_raise',
    'HorseLogic existing value raise band after original safety gates',
    'default-off structural candidate selected a raise instead of random call; selection only, controller acceptance and economic qualification remain separate',
    'Small-pot near-nut value'
  ),
  receipt(
    'v55_omaha_river_trips_flat',
    'HorseLogic committed and ordinary raise branches',
    'opt-in river Omaha weak set/trips flatted after clearing the unchanged call bar',
    'V55'
  ),
  receipt(
    'v62_river_bettor_polarity',
    "HorseLogic to HorseEval river-polar Hold'em sampler",
    "a river bettor's sampled hand was kept by the V62 size-class likelihood that a human bets it",
    'V62',
    'decide',
    0.001
  ),
  receipt(
    'v56_omaha_pressure_range',
    'HorseLogic to HorseEval pressure-conditioned Omaha reservoir',
    'a tier-three public river aggressor range used the direct value stratum for a vulnerable set/trips on one Omaha-high cash board',
    'V56'
  ),
  receipt(
    'v51_river_flat',
    'HorseLogic committed branch (V51)',
    'a committed river one-pair hand flatted where it used to jam',
    'V51'
  ),
  // No floor: every V53 receipt is read-gated on a credibly aggressive or
  // over-folding human, so a horse-only hour is silent by design.
  receipt(
    'v53_*',
    'HorseLogic / HorseOpponentExploit pressure on an aggressive human (V53)',
    "a wider 3-bet of a wide opener, a value or semi-bluff raise of a wide bettor, a river bluff into a credible over-folder (scare card or not), or a hold'em solver spot handed to the exploit layer",
    'V53'
  ),
  // No floor: v54RiverBluff is default OFF (2026-10-24), so silence is
  // expected until explicit qualified adoption. Once activated, v54_river_bluff
  // counts the bluffs fired and the skip family says why every other
  // heads-up river spot with air did not bluff.
  receipt(
    'v54_river_bluff',
    'HorseLogic not-facing-a-bet river (V54)',
    'a heads-up river big bet or shove bluff fired with air, blockers and a value story; opt-in (v54RiverBluff)',
    'V54'
  ),
  receipt(
    'v54_river_bluff_skip_*',
    'HorseLogic not-facing-a-bet river (V54)',
    'why a V54 river bluff did not fire: domain, tournament_context, multiway, multiboard, all_in, showdown_value, station, no_story, uncapped, no_blocker, short_stack, icm, illegal, frequency; opt-in (v54RiverBluff)',
    'V54'
  ),
  receipt(
    'combo_draw_pressure_evaluated',
    'HorseLogic facing flop/turn EV menu',
    'a physically strong draw against a public wide-bettor read evaluated permitted pressure raises as well as its call; proposal, not accepted-use proof',
    'Combo draw pressure'
  ),
  receipt(
    'combo_draw_pressure_raise',
    'HorseLogic facing flop/turn EV menu',
    'the chosen legal raise has positive modeled EV above calling at the same executed size; returned proposal, not accepted-use proof',
    'Combo draw pressure'
  ),
  receipt(
    'v46_class_read',
    'HorseHandClasses.handClassRead via HorseLogic (V46)',
    'the hand SHAPE priced a preflop decision; Omaha volume only (the short-deck chart is off by default since 2026-10-05)',
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
    'wager_rules_commit_correction',
    'ServerTableEngineTurns (final wager rules at commit)',
    'the fresh commit-time menu turned a passive river-nuts action into a legal raise, or a 90-100% pot wager into full pot',
    'RiverNuts'
  ),

  // TAGS. Every leak tag the review system emits, with its reader.
  ...RETIRED_RECEIPTS,
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
