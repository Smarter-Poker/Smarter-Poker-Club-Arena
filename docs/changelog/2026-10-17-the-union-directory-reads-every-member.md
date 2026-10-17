# The Union Directory Reads Every Member

**Date:** 2026-10-17
**Test:** `tests/union-directory-reads-every-member.test.tsx`

## What Was Wrong

Midway Union's Union Bank and Promo Wallet desks read "3 Clubs · 1,000
Members". The union's directory holds 1,744 rows (952 people across three
clubs, read on production). `fn_union_player_directory` has no LIMIT, but
PostgREST caps every response at max-rows (1,000), RPCs included, and says
nothing, so every member past the first 1,000 could not be found or picked.

## What Changed

`UnionWalletModal` reads the directory in pages of 1,000 on a total order
(`club_id`, then `user_id`, unique per membership) until a short page comes
back, and reads `union_clubs` the same way. The existing error handling and
stale-response guard are kept: a page that lands after the desk moved on is
dropped, and a failed page still reports Could Not Load The Union Roster. The
other reads in the desk files were checked: the union ledger and the Diamond
history already page, and the Spin Reserve preview is a deliberate 25 rows.
