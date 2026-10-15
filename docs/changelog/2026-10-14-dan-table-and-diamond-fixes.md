# 2026-10-14 Dan's Table And Diamond Games Fixes

Dan's report of 2026-10-14 (23:00 Chicago), item by item, with the root cause read from production and the fix.

## 1. Donkey Cross Never Gets Past Street 2

Checked, not changed. Every contract-6 round (the fair coin Dan ordered on 2026-10-11, migration 20261012113806) was replayed from its own seeds with `fn_choice_road_coins_v6`; the server outcome matches the coins on every round. 4,000 random seed draws give street 1 safe 50.0%, street 2 safe 49.0%, past street 2 24.1%. Only three live contract-6 rounds exist (died on street 2, street 1, street 2), which is what a true 50/50 coin does three quarters of the time. No code defect.

## 2. Paying Out Way Too Many Chips

The money was right; the games page said otherwise. Nothing over 15 chips was credited for Dan's last games (chip_ledger: plinko 14.28 and 13.62, mines 10.00, crossing 11.00, wheel 10.00 and 1.00). The Recent Wins and This Week's Biggest Wins lists showed "Diamond Wheel 1739.50 Chips" for wheel spins that landed on a BONUS GAME: `wheel_spins.prize_value_chips` there is the bonus game's top prize, a potential. The same field inflated "Average Wheel Prize Value" (65.35x). Fixed in `20261015044735_a_bonus_game_award_is_not_a_chip_win_on_the_floor.sql`.

## 3. Maintenance Break Pill Under The Hero

A closed break is now a masthead line directly under the bomb pot clock (`MaintenanceBreakLine`), tap to reopen. Supersedes the 2026-09-23 bottom pill.

## 4. Lobby Renders Zoomed And Unstyled

Two defects in chunk recovery (`src/utils/lazyWithRetry.ts`): a failed stylesheet `<link>` stayed in the document and Vite's preloader treats a present link as loaded, so the retry rendered the route with no CSS; and the two-reload budget lived in sessionStorage and was never returned, so a tab open across a day of publishes had no recovery left. Failed links are now removed, a CSS failure is never cancelled into an unstyled render, and the budget is returned after a minute of clean running.

## 5. Seat Offer Expired Notification

The device push was already skipped; the row itself still landed in the inbox. Both writers removed and existing rows deleted: `20261015044258_a_seat_offer_that_lapses_is_never_a_notification.sql`.

## 6. Checking Balance Popup, Silent Failure On +

A tap before the table's funding read no longer shows a popup and is no longer thrown away; it is replayed when the read lands. A read balance below the minimum buy-in answers the + tap with "You Do Not Have Enough Chips For This Game" naming the minimum and the balance (`src/lib/seatTapBalance.ts`).

## 7. Seat Change Button

Pinned to the left edge (`.hud-seat-change-dock`), never the upper right.

## 8. Mini BBJ Under The BBJ

The client already draws the MINI BBJ row; its feed `fn_bbj_mini_for_club` returned HTTP 500 for every player since 2026-10-12 (about 12 s per call against the 8 s timeout) because the reporting views from 20261012181905 called a SECURITY DEFINER function per row (~319,000 rows). Views now compute each pool's start once (3.8 s to 174 ms measured); rates are computed for staff only. `20261015042155_the_mini_jackpot_read_answers_players_in_milliseconds.sql`.

## 9. All-In Hand Order

An all-in or showdown snapshot carries the hero's cards in dealt order and replaced the sorted row. `heroDisplayHoleCards` keeps the row's order when the set is unchanged and sorts otherwise.
