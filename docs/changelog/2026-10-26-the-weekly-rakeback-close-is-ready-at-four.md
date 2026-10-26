# The weekly rakeback close is ready at four (2026-10-26)

## What Dan saw

Auto rakeback was not in agents' and players' wallets at 4:00 AM Monday.

## What happened (read from production, times Chicago)

- 2:40 AM: the first close tick of the week began building the week's balance
  snapshot (the "inventory seal"). Every payout waits for it. It is built in 28
  six-hour pieces, about two per 5-minute tick, and pauses from :45 to :00.
- 4:00 AM: the due tick landed inside the daily engine maintenance freeze
  (04:00-04:05 since October 20). The Midway horse promo was refused, then
  deadlocked with live play twice, and paid at 4:20.
- 5:01 AM: last snapshot piece; 6:43 AM: snapshot sealed.
- From 4:40 AM the close was only called at :40 each hour, one club or union
  per call. The first visit of the week was 7:40 AM (Lightning Internal Pilot,
  which failed on a lock). Midway Union's first visit would have been 8:40 AM,
  Deep Stack Society's 9:40 AM.
- The two previous weeks closed late the same way (Midway: due 10-19, done
  10-22; due 10-12, done 10-18).

## Root causes and the fix

1. The whole snapshot was built after the week ended. Each piece only depends
   on what happened inside its six hours, so the new hourly job
   `union-pnl-inventory-layer-precompute` builds each piece during the week as
   soon as its window has settled (no transaction that started before the end
   of the window is still running). On Monday only the last piece and the final
   write remain, and the close starts them at 2:00 AM.
2. After 4:40 AM the close only ran once an hour. Job 272 now runs it every
   5 minutes until every club and union active in the last two weeks has had its
   first visit of the week (capped at 12 hours).
3. The 4:00 AM freeze collision is left as is (4:00 AM is Dan's payout time);
   with change 2 the 4:05 tick picks the work up.

No amount, rate or payee changes. The new job writes only snapshot staging.

Migration: `20261026131306_the_weekly_rakeback_close_is_ready_at_four.sql`.
Law: `tests/the-weekly-rakeback-close-is-ready-at-four.law.test.ts`.
