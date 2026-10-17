# The Union Roster Reads Past A Thousand

**Date:** 2026-10-17
**Found by:** Dan's sweep ("check for any and all bugs, gaps, stubs, errors, regressions or wiring issues")

Midway Union's Union Bank and Promo Wallet listed "3 Clubs · 1,000 Members", and the union dashboard's Players tab stopped at the same row. `fn_union_player_directory` has no LIMIT; the API answers at most 1,000 rows per request, so the first page was all anyone saw.

Both readers now go through `src/services/unionDirectory.ts`, which reads the roster in 1,000-row pages ordered by its unique `(club_id, user_id)` pair until a page comes back short. A failed page fails the whole read with the existing error line, never a partial roster shown as complete.

Pinned by `tests/unit/unionDirectoryPages.test.ts`; the modal, transport and dashboard route tests mock the paged builder.
