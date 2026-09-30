# Diamond Phase 10: The Diamond Staff Desk

September 29, 2026. Phase 10 of the Diamond Arena build programme, line 4 ("Add staff-only game configuration, incident review and audited adjustments"), on screen: item 8 of the ordered build list in `docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md`. Every door the page calls was built first (#5618, #5619, #5620); this piece is the page, one staff read and the place the hourly health watch keeps its reading. Both switches stay closed.

## The Page

`/diamond-staff-desk` (`src/pages/admin/DiamondStaffDeskPage.tsx`), behind `AuthGuard` and `PlatformStaffGuard`, linked from the Financial Admin Hub for platform staff only (the hub's link is hidden from everyone else, and every door checks `fn_is_platform_admin()` again). It lives outside the arena's own paths, which render the safe shell for everybody, as `/financial-incidents` does. Four tabs:

- **Games.** The arena's cash tables: open one (`fn_poker_diamond_open_cash_table`), edit an empty one's name, stakes, buy-ins and seats (`fn_poker_diamond_edit_cash_table`), set straddle, run it twice and bomb pots (the three feature doors), and close one (`fn_poker_diamond_close_cash_table`). The arena's events: who is entered, remove a player (`fn_poker_diamond_remove_tournament_player`, the entry goes home) and cancel the event (`fn_poker_diamond_cancel_tournament`). Creating an event stays a door (`fn_poker_diamond_create_tournament`, `fn_poker_diamond_create_seat_first_board`): its configuration, blinds and payouts included, needs a form of its own, and no number is invented for it here.
- **Incidents.** The Diamond incident board by status, severity and family or rule, a page at a time, with every open row counted per family; one row's detail and trail, and acknowledge, comment, resolve and reopen with a written reason; and a whole family closed in one act with one reason, after a confirmation (`src/services/DiamondIncidentReviewService.ts`).
- **Health And Books.** The health report as the hourly watch last read it, with the time it was read; the register against supply (register, everything held, players, house, difference); and the trial balance, account by account, with each account's note on hover.
- **Adjustments.** Whether anything is authorized to pay for a correction, the count per status, a proposal form (a player's wallet or the house, signed whole Diamonds, a reason of at least 20 characters), and the queue: approve or reject a proposal with a note, settle an approved row after a confirmation, and each settled row's receipt (`src/services/DiamondAdjustmentService.ts`). Until Dan says what pays for a correction, Settle answers "Not Settled: What Pays For A Diamond Correction Has Not Been Authorized Yet, So Nothing Moved" (`diamond_correction_source_not_authorized`), and the tab says so before anyone presses it.

Every refusal is printed as the door named it, in Title Case. `src/services/DiamondStaffDeskService.ts` is the client of the game doors and the new read.

## The Database

Migration `staff_read_the_diamond_books` (`20260929231500`):

- `fn_ca_diamond_staff_books(p_view text)`, one platform-staff read, STABLE, writing nothing, granted to signed-in accounts and the service role and never to anonymous visitors, refusing every other caller by name (`platform_staff_only`, `unknown_view`). Views: `adjustments` (every Diamond row of `ca_manual_adjustments`, newest first, each with its receipt, the count per status, and the `ca_diamond_correction_source` row or null), `health` (the watch's last reading and its time) and `books` (`fn_ca_diamond_trial_balance()` over its own window and `fn_ca_diamond_register_vs_supply()`). Those tables and readers are service-role only, so no door listed them before.
- `ca_diamond_health_reading`, one row: the whole health report as the hourly watch (`fn_ca_diamond_health_watch`, pg_cron at minute 35) last read it. The report read in 4.0, 5.5, 7.8 and 19.1 seconds this evening, against the 8 second limit on a signed-in request, so a staff page cannot run it. The watch already reads it once an hour; it now keeps that reading, by asserted substitution against its pinned text, inside its own block, so a reading it cannot keep is a warning and the watch goes on. The report itself is not touched. No client grant.

## The Rehearsal

One rolled-back transaction on production through the real doors (two certification fixtures made staff inside it): a signed-in player was refused all four views by name and the service role was refused; staff read the queue, proposed a player credit and a house row, a second staff member approved the first and rejected the second, the settlement was refused `diamond_correction_source_not_authorized`, and the queue showed both rows with who did what; the books read 11 accounts with the register difference 0.00 in 3.9 seconds; the health view said no reading was kept yet; the watch then ran as pg_cron runs it (5.9 seconds) and staff read its reading, 14 areas, 11 ok, the one critical or unknown area matching the watch's own count; with a source authorized inside the transaction only, the approved row settled and the queue showed its receipt (supply moved 5). The supply identity read 0.00 before and after.

## Dan's Questions

None new. Settling stays refused until he answers decision 2 of the audit (what pays for a Diamond correction), and the page says so.

Law: staff-read-the-diamond-books.
