# HORSE REAL-TIME BUILD PLAN (Dan, 2026-09-04, binding)

Dan: "Horses need to make real time decisions on 500 different data points in
real time, and need to be able to know how to access this data, what data they
are supposed to be consuming, how to consume it, how to process it and why to
process it in nano seconds." And: "All horses should be winning players, or
break even after rake at worst. We aren't playing to lose."

Constraints Dan set the same day:

- There are not enough humans yet. Most horses have never faced one. The fleet
  learns from self-play today and must be READY for humans on day one.
- Shared memory (HorseMind) STAYS SHARED. It is the asset that lets a horse
  that never met a human benefit from one that did.
- Every horse must be a winning player. In a closed self-play economy the fleet
  as a whole loses exactly the rake, so "winning" is measured per horse against
  a FROZEN BENCHMARK brain (the ladder, Phase 3), and against humans the moment
  there are enough of them.

This file is the contract every phase is built against. One phase at a time.
A phase is DONE only when: tsc clean, full server suite green, the phase's
own scenario tests green, no TODO/stub/dead code in the diff, every new datum
in the ledger with a consumer and a receipt, migration applied via the
Supabase MCP and declared in scripts/ci/schema-manifest.d/, PR merged by
Autopilot, and the change PROVEN LIVE (telemetry, a DB row, or a panel read).
Then and only then: "READY FOR PHASE N+1 OF 10".

Rules every phase obeys:

- No database read inside server/src/engine. The engine reads memory; services
  compile memory from tables ("compile, do not query").
- Every datum has four properties: SOURCE, CADENCE, CONSUMER, RECEIPT. The
  ledger test (Phase 1) fails when any is missing.
- Strategy changes ship flagged, with scenario tests and a league matchup;
  default-on only with |bb/100| > 2 stderr on 2+ nightly runs. Defect fixes
  ship default-on with the measurement that found them.
- Latency has a regression test; precision has a duplicate-deal test.
- Horses are players (CLAUDE.md 10.5). No emoji in source. Never "bots".
- AGENT-PLAYBOOK: own worktree, branch -> push -> PR, never merge yourself,
  never --no-verify, never leave work unpushed.

## Phase 1 - THE HORSE DATA LEDGER (foundation; proves what is consumed)

- server/src/engine/HorseDataLedger.ts: typed registry of every input the brain
  can touch: flags (opts.\*), style params, profile keys (horse_profile),
  HorseMind counters, DB tables (with the cadence and the reader), telemetry
  receipts with expected fire ratios.
- HorseDataLedger.test.ts (static analysis of source): every opts._ in the
  brain is registered and every registered flag exists in source; every
  noteFire key is registered (prefix families allowed); every horse*profile key
  the tuner writes is parsed by resolveHorseStyle; every HorseMind counter has
  a consumer; every horse*_ table is registered with a reader.
- DB: table horse_data_ledger (upserted by the engine at boot from the TS
  ledger), fn_audit_data_receipts(p_day) folded into fn_run_horse_daily_audit:
  data_unread findings when a receipt fires below its expected ratio, and
  data_stale findings when a nightly source table has no row for the day.
- RPC ca_horse_data_ledger(p_day) for the panel; World Hub
  pages/horses/hand-reviews.js gains "What The Horses Consumed" (ledger rows
  joined to yesterday's fires, proven-read yes/no).
- Daily-analysis prompt reads the receipts table.

## Phase 2 - EVERY REVIEW TAG REACHES A DECISION

- HorseLeakProfile.ts (pure): per-horse tag counts + reviewed-hand denominator
  - fleet baseline -> per-tag z-scores -> a `hooks` object.
- HorseSelfTuner writes the fleet baseline alongside counts; profile carries
  `leaks`, `leaksHands`, `leaksBaseline`.
- All 22 tags mapped to a branch and a correction (table in the 2026-09-04
  HORSE-REALTIME-DATA-PLAN): river aggression bars, big_bet_fold bluff ladder,
  big_fold_river MDF respect, limped_pot_bloat pot control, coldcall width,
  raise-war governor, bet_fold plans, preflop jam bands, NLH class caps via
  V11/V20/V21, PLO caps via V40.
- Receipts leak*hook*<tag>; scenario tests per hook; league matchups
  leak_hooks_nlh and plo6_leak_hooks (strategy: flagged, significance to
  default on).

## Phase 3 - THE WINNING-PLAYER LADDER AND THE ADVERSARIES

- Frozen benchmark brain: a snapshot of decide() options pinned as
  BENCHMARK_OPTS (never edited; a new benchmark is a new name) dealt into the
  league as the B side of a per-horse ladder matchup. Every horse's persona +
  dials must beat it; the daily audit raises horse_below_benchmark for any
  horse negative beyond 2 stderr over its rolling sample.
- Scripted adversaries in HorseLeague: station, maniac, nit, min-raise abuser,
  bot-hunter (probes timing/sizing tells). Matchups fleet*vs*<adversary>; a
  negative resolves as a critical league finding.
- Rake calibration audit: V10 rakeDrag vs each club's real schedule and caps
  (services/supabase/rake.ts); a finding when the brain's rake read differs
  from the club's.

## Phase 4 - MEMORY THAT IS READY FOR HUMANS

- HorseMind keeps human observations in a separately weighted store: a human
  hand moves the model with weight w_h (>= 5x a horse hand); the fleet-wide
  shared model remains shared (Dan's rule) and the human store is shared too.
- Archetype priors: a new human is seated with a prior (reg / rec / station /
  maniac / nit) chosen from the first 15-20 hands; bands and exploit reads
  start from the prior instead of from nothing.
- Persistence completeness audit: reads before restart == reads after
  (horse_mind_stats, horse_mind_pairs) - a daily finding when hydration loses
  rows.
- Retention: a compressed feature row per hand (cards, board, line, result,
  tags, a few hundred bytes) kept forever in horse_hand_features, so training
  data survives the 7-day prune.

## Phase 5 - THE HOT PATH

- HorseContext: one immutable snapshot per horse per hand (style, dials, leak
  hooks, persona, stake band, format, variant profile, table limit, session
  results, tournament structure). decide() receives it; nothing recomputes it.
- Profile hot-reload: seated horses re-read horse_profile every 5 minutes in
  one fleet query, so a tuner write is live within minutes, not at re-sit.
- BoardShape computed once per street and shared by every layer.
- Latency: p50/p95/p99 per variant in the daily audit with a
  latency_regression finding; omahaQuickCategory wherever only a category is
  needed; typed-array cards in the MC loop; adaptive exit tuned per variant;
  static Omaha preflop percentile tables. Targets p95 < 15 ms, max < 40 ms,
  with duplicate-deal precision tests on every lever.

## Phase 6 - SAME-SESSION LEARNING AND GUARDRAILS

- The tagger (HorseHandReview) pushes each tag into the horse's in-memory leak
  profile at settlement; the correction applies on the next hand.
- Session guardrails from HorseContext: variance-aware discipline when down 3
  buy-ins; no loosening when up big.
- Receipts leak*live*<tag>, session*guard*\*.

## Phase 7 - PERSONA, SEATING, CANARIES

- One HorsePersona record per horse (style, buy-in class, activity window,
  sizing family, preferred variants, stake band, table cap, aggression
  baseline, rebuy policy), written by onboarding, read by the fleet manager
  and the brain; hashes stay as the fallback. Coherence tests.
- Seating for humans: sit where humans are, leave 1-2 seats open, stay in a
  game a human just joined, cover the stakes humans want.
- Canary deploys: a brain flag routed by horse hash to 10% of the fleet for a
  day; the audit compares the canary's bb/100 to the rest before promotion.

## Phase 8 - PROOF FROM EVERY HAND

- Human-hand daily review: every hand a human played against horses is read
  and graded in the daily audit (complete, not sampled).
- Regression-test generator: any tagged review hand becomes a
  HorseLogic.decide scenario test (the #6046101 shape) with one command.
- Tournament league: ICM, PKO, satellite and bomb-pot layers measured, not
  only scenario-tested.

## Phase 9 - LEARNING FROM THE VOLUME

- Simulated humans: behavior models fitted from public hand histories and
  from the humans who have played here, dealt into the league.
- Parameter fitting: HorseLogic thresholds fitted from self-play outcomes
  nightly (flagged; league-gated), replacing typed constants.
- PLO texture buckets with self-play CFR frequencies (the Omaha equivalent of
  the NLH solver export); range-vs-range pricing in the EV engine.

## Phase 10 - THE LIVE BRAIN

- A live brain dashboard on the horses panel: decisions/sec, latency
  percentiles, layer fires, ladder standings, vs-adversary and vs-human
  bb/100 by variant and hour.
- Final audit of the ledger: every datum consumed, every receipt firing, and
  the 500-input count reported honestly.
