# 2026-09-05 - Bad Beat Jackpot: full audit, end to end

Dan, 2026-09-04: "WE NEED TO DO A FULL AUDIT AND REVIEW OF THE BBJ. WE NEED TO
FIND OUT IF ITS FULLY BUILT OUT AND WORKING. WE NEED TO KNOW THAT IF IT DOES
HIT AT A TABLE, THAT IT ACTUALLY GETS TRIGGERED AND WORKS EXACTLY AS ITS
SUPPOSED TO."

Branch `agent/cowork-bbj-audit/fix/bbj-full-audit`. Two migrations, both
applied to production before this was pushed (CHECK 17).

## What was audited, and what was found working

Every surface between a showdown and the Previous Winners page was read, and
the money path was executed against the live union pool inside a transaction
that was rolled back (CLAUDE.md 11.5). Verified working, with the evidence:

- **Collection.** 63,176 contributions / $19,579.71 banked in the 24 hours
  before the audit. `fn_bbj_conservation_check` on the current epoch:
  `healthy: true, unexplained_since_opening: 0.00`.
- **Detection** (`detectBBJHit`, server RakeConfig). The published rules are
  the enforced rules: AAAJJ+ must lose to quads or a straight flush, the
  loser must hold an Ace, BOTH hole cards must play for loser and winner,
  quad kings+ for the Omaha family, 8-high SF+ for PLO5, 3+ dealt, pot over
  10 BB, no double-board bomb pots, first runout only. Every quads-or-better
  showdown of the last 16 days was replayed from `hand_history`: none
  qualified, and each refusal was correct (board-made quads, no Ace in hand,
  heads-up). The 16-day gap since the last hit is the rules being strict, not
  the detector being broken; before the 2026-08-18 fixes 25 of 39 payouts had
  been boat-over-boat.
- **Payout** (`bbj_atomic_payout_v2`). Atomic, idempotent on (pool, table,
  hand), pays from main only, credits seated stacks and departed wallets in
  the same transaction, writes `bbj_payouts`, `bbj_payout_recipients` and the
  `bbj_winners` row, reseeds main from backup after a 100% hit, raises an
  incident if the reserve is empty. Horses are paid identically to humans.
  Rolled-back probe on NLH 0.10/0.25 Classic, 7 dealt in, 2 departed: pool
  debit 26,099.19 = seats credited 23,489.27 (13,049.59 + 6,524.80 + 3 x
  1,304.96) + wallets credited 2,609.92 (2 x 1,304.96), exactly; 7 recipient
  rows summing to the total; replay returned `already_paid` with no second
  credit.
- **Hitting table.** `bbj_hit` then `bbj_payout_complete` over the engine
  socket, ten-second `BBJCelebration` overlay, fanfare, per-seat gold floats,
  stacks updated, replay-safe via `shouldAnnounceBbjHit`. Pinned by
  `animations-always-play.law.test.ts`.
- **Previous Winners page.** `BBJRecentHits` reads `fn_bbj_recent_hits`
  (SECURITY DEFINER over the ledger) with a cursor; returned all 5 union
  hits.

## What was broken, and what this ships

### A. A union jackpot with a departed recipient did not pay at all (money)

Found by the probe, not by reading. `bbj_credit_one_recipient` resolved a
departed recipient's wallet as `tables.club_id` FIRST. On a union table that
is the union's shell club (Midway Union); the player bought in from SHARK
CLUB or Club JAQK (`table_seats.club_id` says which) and has no membership in
the shell club; the wallet UPDATE matched nothing; the function RAISED; and
because every credit runs inside the payout's single transaction, the WHOLE
jackpot rolled back unpaid - no `bbj_payouts` row, nothing for any reconciler
to see, one `reportError` in the engine log. A retry would have failed the
same way.

Fixed in `20260905011253_a_union_jackpot_pays_and_shows_its_winners.sql`
(generated rewrite with a round-trip assertion, as 20260903122000 did): the
wallet is resolved in the order the chips flow - the seat's club where the
player is an active member, then the table's club if they are a member
there, then the home club. Re-probed after the rewrite: both departed
players paid to their OWN clubs (JAQK and SHARK), chip_transactions rows
written, conservation exact.

### B. A union jackpot's winners were visible to nobody

`bbj_atomic_payout_v2` stamped `bbj_winners.club_id` from `bbj_pools.club_id`,
which is NULL for a union pool. The SELECT policy required a club match. As
a union member, `SELECT count(*) FROM bbj_winners WHERE pool_id = <union
pool>` returned 0 while the RPC returned 5. So for every union: the lobby
ticker (`BBJTicker` reads the table directly) listed no hits, ever, and the
Realtime `bbj_winners` INSERT that refreshes the ticker, the Recent Hits list
and the BBJ page reached nobody, because Realtime applies the same RLS.

Same migration: the policy becomes `USING (true)`, matching `bbj_pools` and
Dan's 2026-08-25 ruling that the jackpot is the same for everyone who can see
the lobby (the RPC already returned more than this table holds); the RPC
stamps the hitting table's club; the 5 NULL rows are backfilled. Verified as
a union member after apply: 5 rows visible.

### C. A detected jackpot could be dropped by one transient error (money)

`processBBJPayout` made one RPC call and returned null on any error. The
engine remembers a hit for one hand, so a schema-cache reload, a dropped
socket or the :55 freeze refusing the write meant a jackpot that had been
detected AND announced (`bbj_hit` goes out first) was never paid, recorded or
retried.

Now: four attempts with backoff on transient errors (the RPC is idempotent, so
a retry after a lost response returns `already_paid` and re-drives any missing
credit); non-retryable refusals and an empty pool stop immediately; when every
attempt fails the full parameter set is QUEUED in `pending_fee_distributions`
as kind `bbj_payout` (`20260905012341_a_detected_jackpot_is_paid_or_queued_never_dropped.sql`)
and a CRITICAL financial alert carries every parameter. `FeeReconciler`'s
5-minute drain re-drives it, re-reading who is still seated at that moment,
and notifies every recipient because the table has moved on. In delta mode a
seat credit that lands from the queue is preserved by the next hand's write.
`server/src/services/supabase/BBJPayoutIsPaidOrQueued.test.ts` (17 tests).

### D. The club/union-wide pop-up rode a stream that can run a minute behind

Other tables learned of a hit only through a Supabase Realtime subscription
on the pool row - the WAL stream ClubHomePage measured a minute or more
behind at peak - and then refused anything older than 90 seconds as a replay.
The announcement raced its own freshness gate.

Now the engine fans `bbj_hit_global` out over the socket to every live cash
table in the club, or in every club of the union
(`resolveJackpotSiblingClubIds` + `ServerTableEngineBase.liveCashTableIdsInClubs`,
read from the same registry that decides which engine is authoritative), the
instant the payout lands. The client forwards it to `BBJ_HIT_GLOBAL` with the
same identity the Realtime path uses, so whichever arrives first announces
and the other is dropped. Realtime stays as the fallback for a table this
process does not host. Never a money step: wrapped so it cannot fail the
settlement.

### E. Multi-table: the pop-up could be drawn into a hidden slot

MultiTablePage keeps up to four TablePages mounted, inactive ones
`display:none`. Every one subscribed to `BBJ_HIT_GLOBAL`; the gate marks a
hit seen for the first subscriber; when that was a hidden slot the card was
drawn where nobody could see it and the visible table was told "already
announced". The card is now rendered ONCE by `BBJHitAnnouncer`, mounted in
`PersistentTableLayer` beside the container - the same reasoning that put
`PortraitLock` there - outside the table ErrorBoundary. It skips the table on
screen (that one plays the full celebration) and still announces off-route:
a player in the cashier with tables open is still playing.
`tests/bbj-hit-announcer.test.tsx` (10 tests) pins the behaviour and the
ownership.

### F. Screen readers heard the formatter

`BBJHitNotification`'s aria-label interpolated `money` (the function) instead
of `amountText`. Fixed.

## Still open, deliberately not touched here

- `fn_bbj_recent_hits` names the bad-beat holder as
  `COALESCE(display_name, username, ...)` while the winners snapshot uses
  `fn_arena_name` - two surfaces, two names for the same player. Not a
  money issue; flagged for the naming law's owner.
- The pre-existing warnings (`FeeReconciler.bbj_unlinkable` ~3.5 chips/day of
  rake rows with no hand_id; `fn_bbj_promo_bank_check` drift, which
  20260902222851 attributes to the club promo wallet) are unchanged by this
  work and remain in the sweep.
- 24 `fn_bbj_orphaned_payouts` rows are all on the retired pool `0867a7fd`
  whose hands were pruned before jackpot hands became unprunable. History.
