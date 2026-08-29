# 2026-08-29 — Round 8: TournamentService stops answering questions it could not answer

Continuation of the 2026-08-28 seat-first sweep (rounds 1-7, PRs #1602-#1702),
picking up the handoff's recommended order: baseline re-check, the untested
refund path, the TournamentService.ts audit (§9.3, its named next target), and
the spin-draw reconciliation gap (§9.4).

## Baseline re-check (handoff §5) — HOLDS

Measured 2026-08-29 ~07:10Z against production:

| Metric                                  | Handoff | Now            |
| --------------------------------------- | ------- | -------------- |
| Spin fill -> start p50 (6h window)      | 4.78 s  | 4.98 s (n=597) |
| Spin fill -> start p90                  | 6.85 s  | 7.33 s         |
| Ghost seats on finished tournaments     | 0       | 0              |
| fn_unaccounted_seat_exits()             | 0       | 0              |
| Spins stuck RUNNING > 30 min            | 0       | 0              |
| Started spins with NULL spin_multiplier | 0       | 0              |
| Clubs running spins                     | 1       | 1              |

## Seat-first refund path — VERIFIED (handoff §9.2, its "highest-value live

## verification left")

No real pre-start seat-first leave has occurred in production since PR #1666
deployed, so there was no organic evidence. Probed instead under §11.5: one
transaction as Dan's own account, `fn_take_seat_and_buy_in` then
`fn_leave_seat_and_refund` on the same REGISTERING spin table, measurements
extracted through the exception message, everything ROLLED BACK. Zero chips
moved.

Result: take charged 1.00 and reserved the seat; leave returned
`{"ok": true, "refunded": 1.00}` and vacated it. One finding worth recording:
the tournament's `club_id` is the UNION pseudo-club (`fade0000...`, Midway
Union) while both legs of the money settle against the player's HOME club
wallet (Club JAQK) — symmetric and correct, but anyone verifying a refund by
watching the union-keyed `club_members` row will see nothing move. Watch the
home-club row.

## §9.4 spin-draw reconciliation — ALREADY CLOSED, handoff was stale

The handoff says a failed spin draw write "depends on a human reading a log"
with "no automated repair and no alert". That was already false when it was
written. Since migration `20260822191000_spin_null_multiplier_repair.sql`:

- `fn_spin_repair_missing_multiplier` reconstructs the multiplier from the
  prize actually paid (only when the ratio lands exactly on a SPIN_TIERS
  tier — it never invents one) and files a `financial_alerts` row either way,
  critical and deduped when it cannot reconstruct;
- `fn_spin_sweep_unbooked` runs the repair FIRST on every pass;
- Open Claw fires `/api/cron/spin-sweep` every 15 minutes;
- `tests/config/spinNullMultiplierRepair.test.ts` pins all of it.

Verified live this session: `fn_spin_repair_missing_multiplier(1440)` returned
`{repaired: 0, unreconstructable: 0}`. An engine-side hourly caller was
written, then deliberately REVERTED — a second scheduler for an Open Claw job
is the drift §11 of the World Hub CLAUDE.md exists to prevent. Nothing to
build here; future agents can strike §9.4 from the handoff's open list.

## The audit: 23 discarded-error reads in TournamentService.ts

Round 7 closed twelve places where the PAGES substituted a convenient answer
for one they could not obtain. This service — what those pages call — carried
the same shape 20+ times: `const { data } = await supabase...` with the error
never bound, so a failed query was indistinguishable from an empty result.
Every site below now binds the error and answers honestly. Pinned by
`tests/unit/tournamentServiceAuditRound8.test.ts` (22 pins,
structure-bounded windows).

Severity-ordered:

1. **CRITICAL — startTournament roster read.** A failed read fell into
   'No players registered', and a failure resolving to an empty array would
   have sailed into the `< 3` branch, which CANCELS the tournament and
   refunds everyone — destruction of a healthy tournament on the strength of
   a timeout. Now: report + retryable error before any player-count logic.
2. **HIGH — union settings read (getTournaments).** The 2026-08-28 fix made
   the cross-club permission check fail closed on a PARSE failure but left
   the READ failure open: `.maybeSingle()` returns `{data: null}` for a
   failed query too, so a timeout skipped the settings block and
   `allowCrossClub` kept its default `true`. Same rule, same hole — a read
   error now fails closed and reports.
3. **HIGH — createFinalTable lookup.** A failed lookup was indistinguishable
   from "no final table yet" and fell into the CREATE branch — a transient
   timeout minted a duplicate Final Table beside the real one. Now stands
   down and lets the next consolidation tick retry.
4. **HIGH — add-on and re-entry duplicate gates.** Money actions whose
   client-side gates (one add-on per player; no re-entry with an active
   entry; must actually be eliminated) all failed OPEN on a read error, and
   the eliminated check failed open into the lie 'You have not been
   eliminated in this tournament'. All three now fail closed with a
   retryable message.
5. **MED — union resolver fallback (getTournaments).** The `clubs.union_id`
   fallback read discarded its own error, so when `union_clubs` came back
   empty and the `clubs` read failed, the cached union scope was never
   consulted AND was cleared — demoting a union club to standalone and
   destroying the one thing that could rescue the next load. Either read
   failing now counts as "cannot conclude standalone".
6. **MED — createTournament union verify.** A failed read threw 'Union not
   found' — a permanent-sounding verdict for a transient failure. Now a
   distinct retryable message.
7. **MED — created-tournament refetch.** Returned `data` bare from a method
   typed `Promise<Tournament>`, so a transient refetch failure made a
   SUCCESSFUL creation look failed — and a creator who believed it made the
   same tournament twice. Now throws a message that says the tournament WAS
   created.
8. **MED — canRebuy stack read.** Failed read answered 'Player not found' to
   a player demonstrably in the tournament. Now a retryable message.
9. **MED — waitlist join.** A failed duplicate check waved the join through;
   a failed count minted position 1 for whoever joined during the outage.
   Both now fail closed.
10. **LOW (reported, behaviour unchanged)** — the SNG autostart nudge read,
    the pre-cancel roster read (BALANCE_UPDATED nudges), both total_rake
    fallback reads (silent rake under-report), the POY placements read (an
    event vanishing from the race), checkBalanceNeeded / checkTableMerge,
    the final-table insert, getPlayerBounties' confident 0, and the waitlist
    position display's confident null. Each keeps its safe fallback but now
    leaves a trace through reportError.

## Verification

- `npx tsc --noEmit` — 0 errors (client and server)
- `npx vitest run tests/` — full client suite green (see PR checks)
- New pins: 22 in `tests/unit/tournamentServiceAuditRound8.test.ts`
- No emoji, no em dashes in any player-facing message; all toasts flow
  through the central Toast transform.

## Still open from the handoff (unchanged by this round)

- §9.1 — Dan's "spins disappear from the lobby" report, never reproduced.
- §9.2 — round clock on live MTT/HU, live tournament showdown, and the
  shell-update gate, all still unverified in a live browser.
- §9.3 — TablePage.tsx (17), TableService.ts (3), ClubHomePage.tsx (3)
  discarded-error reads remain untriaged; TournamentService.ts is done.
- §9.5 — the Heads-Up-specific audit and the entire enhancement half.
