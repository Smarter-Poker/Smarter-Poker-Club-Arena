# 2026-08-30 — Rake polish pack (all five items)

Dan: "go ahead and fully do all of these" — the five optional-polish items.

## 1. Player-facing weighted rake stats

- `ca_player_rake_stats` / `ca_player_hand_rake_share` RPCs (identity from
  auth.uid(), never a parameter; no cross-player exposure).
- `StatsFactsService.getRakeStats` / `.getHandRakeShare`.
- PlayerStatsPage: a Your Rake panel (rake paid, rake per 100 hands, rake in
  BB, raked hands, average per raked hand, cash hands counted). The `rake`
  tab was agent-only; it is now available to every profile owner, with the
  agent downline panel unchanged beneath it.
- HandDetailModal: a Your Rake On This Hand block in HandDetailView's
  EXISTING footer slot — contribution, returned uncalled, share %, your rake
  of the hand's rake, and your jackpot drop. Purely additive; no
  animation-bearing surface touched, no existing CSS rule modified.
- Both loaders are defensive: a missing service method or a rejected promise
  degrades to "no panel", never a crashed page (hostile-state doctrine).

## 2. The BBJ drift alarm stops crying wolf

`bbj_drift_since` windowed BOTH sides, so any slice banked more than six
hours after its hand — every back-dated self-heal — read as a shortfall. It
now joins by hand id. **Its own assert caught 9.63 chips of genuinely
unbanked money on the first attempt (24 hands inside the heal's 5-minute
grace) and refused to ship until the self-heal banked them.**

## 3. Second watchdog seat

`fn_rake_attribution_drift_audit` runs the drift check DB-side hourly at :47,
so it survives an engine outage — the case where attribution is most likely
to be broken and the engine-side watcher least likely to be running.

## 4. The settler reads the ledger

`RakebackSettlerService` now batch-loads `rake_attributions` (one query per
page, chunked 200 hand ids) and prefers the stored allocation, falling back
to the canonical allocator for hands without ledger rows — mirroring
`fn_rake_shares_for_record` on the SQL side. This removes the last dual
implementation of the money rule. A failed read is non-fatal: the fallback is
the allocator it used before.

## 5. Dead column

`bbj_contributions.player_id` (NULL on every row ever written, no writer,
already a trap that misled one page) dropped behind a guard that refuses if
any row ever held a value. The retired `hands` family is deliberately left
locked-and-commented rather than renamed — Dan's "after a quiet quarter".

## Verification

client tsc 0, server tsc 0; **9,247 client + 2,567 server tests, 0 failures**;
the rake/BBJ collection-law CI gate passes. Production after the changes:
BBJ drift 0.00 (8,401.94 booked = received), attribution drift 0, four guard
jobs on staggered schedules.
