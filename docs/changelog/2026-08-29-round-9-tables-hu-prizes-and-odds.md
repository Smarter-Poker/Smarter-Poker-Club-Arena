# 2026-08-29 — Round 9: the last discarded reads, the HU audit, the prize the ledger proved, and the odds on the sheet

Continues round 8 (same day, PR #1722). Four workstreams, in the handoff's
remaining order: the last 23 discarded-error reads (TablePage 17,
TableService 3, ClubHomePage 3), the Heads-Up-specific audit (§9.5), the
§9.2 verifications production data can close, and the first piece of the
enhancement half.

## 1. Discarded-error reads — TablePage, TableService, ClubHomePage (23)

Pinned by `tests/unit/tablePagesAuditRound9.test.ts` (13 pins). The ones
that changed behaviour:

- **CRITICAL — TableService.leaveTable.** The table-context read decides
  WHICH MONEY PATH a leave takes (`!tableData?.tournament_id` selects the
  cash cash-out RPC), and a failed read was indistinguishable from "cash
  table". A money-path fork is never decided by a guess now: a failed read
  refuses the leave, retryably.
- **HIGH — the busted-player routing retry was DEFEATED.** PostgREST
  RESOLVES with `{error}` rather than throwing, so the 2026-08-26 retry loop
  broke on attempt 1 with no error recorded and the routing condition saw
  neither an elimination nor a failure - the player stayed parked on the
  dead table, the exact bug that fix claims closed. A resolved error now
  retries exactly like a thrown one. The same throws-vs-resolves seam was
  closed in the rebalance handler (a moved player got neither the redirect
  nor the refresh fallback) and both announcement fetches (final table,
  heads-up switch).
- **HIGH — a paid entrant is never demoted to Spectating by a timeout.** The
  tournament_players read that separates a paid entrant awaiting a seat from
  a spectator overwrote the awaiting flag with false on a failed read. It
  now keeps whatever the flag says and reports.
- **MED — TableService.getClubTables union resolve.** A failed union_clubs
  read demoted a union club to standalone and emptied the cash board - the
  third appearance of the "games disappear" shape. Now consults the same
  sessionStorage union-scope cache TournamentService uses (same key, shared
  deliberately).
- **MED — a failed profile read no longer clobbers the first-paint identity
  cache** with nulls (it used to propagate the failure to the NEXT table
  open); a failed bounty read no longer blanks every bounty badge (keeps the
  map the table has).
- **Reported, behaviour unchanged:** BBJ banner loads (x3), hole-card
  recovery poll, masthead viewer club, seat restore on reload, seat and
  waitlist profile joins, the buy-in seat pre-check (the RPC is the
  authority), deleteTable's counter fallback (both legs), ClubHomePage's
  union member counts, level re-read, and share-ref lookup.

## 2. Heads-Up audit (§9.5) — and what it caught platform-wide

HU production health is excellent: fill->start p50 4.32s (956 games/24h),
0 stuck, 0 full-but-unstarted; GameLobbyPanel's HU gate (`capacity <= 2`)
and the status badges are correct.

But the audit's one anomaly - a completed HU whose winner row read prize 0
while the wallet held the 95.00 - unravelled into a platform-wide record
defect: **833 (tournament, player) pairs all-time, 525 in 48h, 37,224.98
chips, were PAID prize money the ledger proves while every one of their
tournament_players rows read prize 0.** No money is missing; the record is.
Cause: `fn_tournament_payout_reconcile` pays from the ledger (correctly -
that is why it never double-paid; verified: zero duplicate place payments)
but never wrote the one column the result card, tournament history, and the
POY submission (winnings: player.prize) all read.

**Migration `20260829140000_reconciler_stamps_the_prize_it_pays.sql` -
APPLIED TO PRODUCTION.** The function now stamps the prize the ledger
proves (p_apply only; fills prize-0 holes only, never overwrites the
engine's stamp), and a backfill stamped every already-paid pair that still
has a row. Post-apply assertion passed; re-measured: the only remaining
48h "unstamped" pair is the clawed-back double-pay from Union PKO 4f42d847,
whose net is 0.00 - prize 0 is CORRECT for them. 290 ledger-only pairs
(rows deleted by e.g. cancellation) remain as ledger history by design.

## 3. §9.2 verifications closed from production data

- **Tournament showdowns are face up, observed in production.** Since the
  engine deploy finished (~2026-08-29 01:00Z): ZERO tournament showdown
  hands with a mucked card across ~11,200 hands in 12+ hours. The 181
  mucked hands after the merge timestamp all fall in the deploy-lag window
  (162 in the 23:00 hour, 19 in the 00:00 hour, none since).
- **Round-clock preconditions hold for every class.** 100% of RUNNING
  spins (49), heads-up (23) and MTT/SNG (1) carry blind_structure,
  current_level and level_started_at - the exact inputs the masthead clock
  reads, and the clock code is variant-agnostic.
- Still browser-only: the Show Cards popup's absence as seen from a chair,
  and useShellUpdateGate reloading a real stale client. Both remain pinned
  by tests and unobserved live.

## 4. Enhancement: the multiplier odds ladder on the Spin buy-in sheet

The seat-first confirmation sheet for a Spin now shows the full wheel -
prize pool at this stake, odds as "1 In N", payout split per tier - behind
a "Show Multiplier Odds" toggle (collapsed by default so the 375px sheet
keeps Buy In above the fold; resets closed on dismiss).

The design rule, pinned by `tests/unit/spinOddsOnBuyInSheet.test.ts`
(7 pins): every displayed number derives from SPIN_TIERS through the new
`spinOddsTable()` in spinSpec.ts (both mirrors updated together;
byte-identity test green). A hand-written odds table beside the real ladder
is how a wheel retune quietly becomes false advertising. Prize is
cost x multiplier: spin fee is 0 by construction (verified in production),
so the sheet's cost IS the buy-in the pool multiplies.

## Verification

- `npx tsc --noEmit` 0 errors, client and server
- Full client + server suites green (see PR checks)
- New pins: 13 (round-9 audit) + 7 (odds sheet); spinSpec suite 38 green
- Migration applied via Supabase MCP with post-apply assertion;
  `node scripts/ci/check-migrations-applied.mjs` OK

## Still open after this round

- §9.1 - the "spins disappear" report: never reproduced on any current
  build; three plausible causes fixed across rounds 7-9 (status drift,
  poisoned filters, the union-resolve demotions in BOTH services).
- Browser-only verifications listed above.
- Further enhancement ideas not reached: spin results/history surface, spin
  leaderboards, reveal sound design.
